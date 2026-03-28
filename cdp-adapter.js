/**
 * Piggy — Chrome DevTools Protocol Adapter
 * Connects to Brave/Chrome via CDP for DOM extraction and page control.
 * Uses raw WebSocket over Node's net module — zero npm dependencies.
 *
 * Usage: Launch browser with --remote-debugging-port=9222
 *   open -a "Brave Browser" --args --remote-debugging-port=9222
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// ── State ────────────────────────────────────────────────

let socket = null;
let connected = false;
let cmdId = 0;
const pending = new Map();  // id → { resolve, reject }
const emitter = new EventEmitter();
let recvBuffer = Buffer.alloc(0);
let targetInfo = null;

// ── Raw WebSocket (RFC 6455) ─────────────────────────────

/**
 * Open a WebSocket connection to a CDP endpoint.
 *
 * @param {string} wsUrl — ws://127.0.0.1:9222/devtools/page/...
 * @returns {Promise<void>}
 */
function openWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');

    const sock = net.createConnection({ host: url.hostname, port: parseInt(url.port) }, () => {
      // HTTP upgrade request
      const req = [
        `GET ${url.pathname} HTTP/1.1`,
        `Host: ${url.host}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: 13`,
        '', ''
      ].join('\r\n');
      sock.write(req);
    });

    let upgraded = false;

    sock.on('data', (data) => {
      if (!upgraded) {
        const str = data.toString();
        if (str.includes('101 Switching Protocols')) {
          upgraded = true;
          socket = sock;
          connected = true;
          // Process any remaining data after headers
          const bodyStart = str.indexOf('\r\n\r\n');
          if (bodyStart >= 0) {
            const remaining = data.slice(bodyStart + 4);
            if (remaining.length > 0) processData(remaining);
          }
          resolve();
        } else {
          reject(new Error('WebSocket upgrade failed: ' + str.substring(0, 100)));
          sock.destroy();
        }
        return;
      }
      processData(data);
    });

    sock.on('error', (err) => {
      if (!upgraded) reject(err);
      else emitter.emit('error', err);
    });

    sock.on('close', () => {
      connected = false;
      socket = null;
      // Reject all pending commands
      for (const [id, { reject: rej }] of pending.entries()) {
        rej(new Error('Connection closed'));
        pending.delete(id);
      }
      emitter.emit('close');
    });

    setTimeout(() => {
      if (!upgraded) {
        reject(new Error('WebSocket connection timeout'));
        sock.destroy();
      }
    }, 10000);
  });
}

/**
 * Process incoming WebSocket data.
 */
function processData(data) {
  recvBuffer = Buffer.concat([recvBuffer, data]);

  while (recvBuffer.length >= 2) {
    const firstByte = recvBuffer[0];
    const secondByte = recvBuffer[1];
    const opcode = firstByte & 0x0F;
    const payloadLen = secondByte & 0x7F;

    let offset = 2;
    let actualLen = payloadLen;

    if (payloadLen === 126) {
      if (recvBuffer.length < 4) break;
      actualLen = recvBuffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (recvBuffer.length < 10) break;
      actualLen = Number(recvBuffer.readBigUInt64BE(2));
      offset = 10;
    }

    if (recvBuffer.length < offset + actualLen) break;

    const payload = recvBuffer.slice(offset, offset + actualLen);
    recvBuffer = recvBuffer.slice(offset + actualLen);

    // Handle frame types
    if (opcode === 0x1) {
      // Text frame
      handleMessage(payload.toString('utf8'));
    } else if (opcode === 0x8) {
      // Close frame
      if (socket) socket.destroy();
    } else if (opcode === 0x9) {
      // Ping → send pong
      sendFrame(0xA, payload);
    }
  }
}

/**
 * Send a WebSocket frame with client masking.
 */
function sendFrame(opcode, payload) {
  if (!socket) return;

  const mask = crypto.randomBytes(4);
  const payloadBuf = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const len = payloadBuf.length;

  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN + opcode
    header[1] = 0x80 | len;    // MASK + length
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  // Mask the payload
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    masked[i] = payloadBuf[i] ^ mask[i % 4];
  }

  socket.write(Buffer.concat([header, mask, masked]));
}

/**
 * Handle a CDP JSON message.
 */
function handleMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  // Command response
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) {
      reject(new Error(msg.error.message || 'CDP error'));
    } else {
      resolve(msg.result || {});
    }
  }

  // Event
  if (msg.method) {
    emitter.emit(msg.method, msg.params || {});
  }
}

/**
 * Send a CDP command and wait for response.
 *
 * @param {string} method — e.g. 'Runtime.evaluate'
 * @param {object} [params={}]
 * @returns {Promise<object>}
 */
function sendCommand(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!connected || !socket) {
      reject(new Error('Not connected'));
      return;
    }

    const id = ++cmdId;
    pending.set(id, { resolve, reject });

    const msg = JSON.stringify({ id, method, params });
    sendFrame(0x1, msg);

    // Timeout after 15s
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }
    }, 15000);
  });
}

// ── Public API ───────────────────────────────────────────

/**
 * Connect to a Brave/Chrome instance via CDP.
 *
 * @param {number} [port=9222] — remote debugging port
 * @returns {Promise<{url: string, title: string}>}
 */
async function connect(port = 9222) {
  // Discover targets
  const targets = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON from CDP')); }
      });
    });
    req.on('error', (err) => reject(new Error(`Cannot connect to CDP on port ${port}: ${err.message}`)));
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('CDP target discovery timeout')); });
  });

  // Find first page target
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('No page target found');
  if (!page.webSocketDebuggerUrl) throw new Error('No WebSocket URL for target');

  targetInfo = page;

  // Connect WebSocket
  await openWebSocket(page.webSocketDebuggerUrl);

  // Enable domains
  await sendCommand('Page.enable');
  await sendCommand('Runtime.enable');

  console.log(`[Piggy CDP] Connected to: ${page.title} (${page.url})`);
  return { url: page.url, title: page.title };
}

/**
 * Disconnect from CDP.
 */
function disconnect() {
  if (socket) {
    try { sendFrame(0x8, Buffer.alloc(0)); } catch {}
    socket.destroy();
    socket = null;
  }
  connected = false;
  targetInfo = null;
  recvBuffer = Buffer.alloc(0);
  for (const [id, { reject }] of pending.entries()) {
    reject(new Error('Disconnected'));
    pending.delete(id);
  }
  emitter.removeAllListeners();
  console.log('[Piggy CDP] Disconnected');
}

/**
 * Scan all interactive elements on the current page.
 * Returns elements with screen coordinates.
 *
 * @param {number} [maxElements=80]
 * @returns {Promise<Array<{id: number, source: string, tag: string, role: string, name: string, x: number, y: number, w: number, h: number, cx: number, cy: number}>>}
 */
async function scanElements(maxElements = 80) {
  if (!connected) throw new Error('Not connected to CDP');

  // Get window bounds
  let screenX = 0, screenY = 0, chromeHeight = 0;
  try {
    const bounds = await sendCommand('Runtime.evaluate', {
      expression: `JSON.stringify({
        screenX: window.screenX,
        screenY: window.screenY,
        outerW: window.outerWidth,
        outerH: window.outerHeight,
        innerW: window.innerWidth,
        innerH: window.innerHeight
      })`,
      returnByValue: true
    });
    const win = JSON.parse(bounds.result.value);
    screenX = win.screenX;
    screenY = win.screenY;
    chromeHeight = win.outerH - win.innerH; // tabs + address bar height
  } catch (err) {
    console.warn('[Piggy CDP] Could not get window bounds:', err.message);
  }

  // Inject JS to collect interactive elements
  const js = `(function() {
    var items = [];
    var els = document.querySelectorAll('a, button, input, textarea, select, [role="button"], [onclick], [tabindex]');
    for (var i = 0; i < els.length && i < ${maxElements}; i++) {
      var el = els[i];
      var rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) continue;
      if (rect.y + rect.height < 0 || rect.y > window.innerHeight) continue;
      var tag = el.tagName.toLowerCase();
      var text = (el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().substring(0, 80);
      text = text.replace(/[|\\n\\r]/g, ' ').replace(/\\s+/g, ' ');
      var type = el.type || '';
      var role = tag;
      if (tag === 'input') role = type || 'input';
      if (tag === 'a') role = 'link';
      if (el.getAttribute('role') === 'button') role = 'button';
      items.push({
        tag: tag, role: role, name: text,
        x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.width), h: Math.round(rect.height)
      });
    }
    return JSON.stringify(items);
  })()`;

  const result = await sendCommand('Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });

  if (!result.result || !result.result.value) return [];

  let rawElements;
  try { rawElements = JSON.parse(result.result.value); } catch { return []; }

  // Convert viewport coordinates to screen coordinates
  const elements = [];
  let id = 1;
  for (const el of rawElements) {
    const x = screenX + el.x;
    const y = screenY + chromeHeight + el.y;
    elements.push({
      id: id++,
      source: 'cdp',
      tag: el.tag,
      role: el.role,
      name: el.name,
      x, y,
      w: el.w, h: el.h,
      cx: x + Math.round(el.w / 2),
      cy: y + Math.round(el.h / 2)
    });
  }

  return elements;
}

/**
 * Navigate to a URL.
 *
 * @param {string} url
 * @returns {Promise<{url: string, loadTime: number}>}
 */
async function navigateTo(url) {
  if (!connected) throw new Error('Not connected to CDP');

  const start = Date.now();

  // Navigate
  await sendCommand('Page.navigate', { url });

  // Wait for load
  await new Promise((resolve) => {
    const handler = () => {
      emitter.removeListener('Page.loadEventFired', handler);
      resolve();
    };
    emitter.on('Page.loadEventFired', handler);
    setTimeout(resolve, 10000); // max 10s wait
  });

  const loadTime = Date.now() - start;
  const finalURL = await getPageURL();

  return { url: finalURL, loadTime };
}

/**
 * Get the current page URL.
 *
 * @returns {Promise<string>}
 */
async function getPageURL() {
  if (!connected) return '';
  try {
    const result = await sendCommand('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true
    });
    return result.result?.value || '';
  } catch {
    return '';
  }
}

/**
 * Register a callback for page navigation events.
 *
 * @param {Function} callback — (url, frameId) => void
 * @returns {Function} — unsubscribe function
 */
function onNavigate(callback) {
  const handler = (params) => {
    if (params.frame && (!params.frame.parentId)) {
      callback(params.frame.url, params.frame.id);
    }
  };
  emitter.on('Page.frameNavigated', handler);
  return () => emitter.removeListener('Page.frameNavigated', handler);
}

/**
 * Check if connected to CDP.
 *
 * @returns {boolean}
 */
function isConnected() {
  return connected;
}

/**
 * Build element map string for the AI prompt.
 *
 * @param {Array} elements — from scanElements()
 * @returns {string}
 */
function buildMap(elements) {
  if (!elements || elements.length === 0) return 'CDP: No elements found on page.';
  const lines = elements.map(el => {
    const label = el.name ? `"${el.name}"` : `(${el.role})`;
    return `  [${el.id}] ${el.role} — ${label} at (${el.cx}, ${el.cy})`;
  });
  return `ELEMENTS ON SCREEN (click by number):\n${lines.join('\n')}`;
}

/**
 * Read the full text content of the current page.
 *
 * @returns {Promise<{success: boolean, title: string, url: string, text: string, wordCount: number}>}
 */
async function readPage() {
  if (!connected) return { success: false, title: '', url: '', text: '', wordCount: 0, error: 'Not connected' };

  try {
    const result = await sendCommand('Runtime.evaluate', {
      expression: `(function() {
        var title = document.title || '';
        var url = location.href || '';
        var clone = document.body.cloneNode(true);
        var remove = clone.querySelectorAll('script, style, nav, footer, header, aside, [role=navigation], [role=banner], [role=contentinfo], .ad, .ads, .advertisement, .sidebar, .cookie-banner, .popup');
        for (var i = 0; i < remove.length; i++) remove[i].remove();
        var text = (clone.innerText || clone.textContent || '').trim();
        text = text.replace(/\\t/g, ' ').replace(/ {2,}/g, ' ').replace(/\\n{3,}/g, '\\n\\n');
        if (text.length > 5000) text = text.substring(0, 5000) + '... [truncated]';
        return JSON.stringify({ title: title, url: url, text: text });
      })()`,
      returnByValue: true
    });

    const data = JSON.parse(result.result.value);
    return {
      success: true,
      title: data.title,
      url: data.url,
      text: data.text,
      wordCount: data.text.split(/\s+/).filter(Boolean).length
    };
  } catch (err) {
    return { success: false, title: '', url: '', text: '', wordCount: 0, error: err.message };
  }
}

module.exports = {
  connect,
  disconnect,
  scanElements,
  navigateTo,
  getPageURL,
  onNavigate,
  isConnected,
  buildMap,
  readPage,
  sendCommand
};
