/**
 * Piggy — Vision Module
 * Manages a scanner worker process that runs outside Electron's restrictions.
 * Supports Safari (AppleScript via worker) and Brave/Chrome (CDP direct).
 * Caches element maps and only re-scans when needed.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const { fork } = require('child_process');
const path = require('path');
const cdp = require('./cdp-adapter');

let worker = null;
let ready = false;
let requestId = 0;
const pending = new Map(); // requestId → { resolve }

// Cached scan results
let cachedElements = [];
let cachedMap = '';
let cachedApp = null;

/** Check if the app is a Chromium-based browser that supports CDP. */
function isCDPBrowser(appName) {
  if (!appName) return false;
  const lower = appName.toLowerCase();
  return lower.includes('brave') || lower.includes('chrome') || lower.includes('chromium') || lower.includes('edge');
}

/**
 * Start the scanner worker process.
 */
function start() {
  if (worker) return;

  worker = fork(path.join(__dirname, 'scanner-worker.js'), [], {
    silent: false // let worker log to console
  });

  worker.on('message', (msg) => {
    if (msg.type === 'ready') {
      ready = true;
      console.log('[Piggy Vision] Scanner worker ready');
    }

    if (msg.type === 'scan-result') {
      const req = pending.get(msg.requestId);
      if (req) {
        pending.delete(msg.requestId);
        cachedElements = msg.elements;
        cachedMap = msg.map;
        req.resolve({
          elements: msg.elements,
          map: msg.map,
          count: msg.count,
          error: msg.error
        });
      }
    }

    if (msg.type === 'read-page-result' || msg.type === 'navigate-result') {
      const req = pending.get(msg.requestId);
      if (req) {
        pending.delete(msg.requestId);
        req.resolve(msg);
      }
    }
  });

  worker.on('exit', (code) => {
    console.log(`[Piggy Vision] Scanner worker exited (code ${code})`);
    worker = null;
    ready = false;
  });

  worker.on('error', (err) => {
    console.warn('[Piggy Vision] Scanner worker error:', err.message);
  });
}

/**
 * Scan the screen. Uses CDP for Brave/Chrome, worker process for Safari.
 * Caches results — pass force=true to re-scan.
 *
 * @param {string} appName — the focused app
 * @param {boolean} [force=false] — force re-scan even if cached
 * @returns {Promise<{elements: Array, map: string, count: number}>}
 */
async function scan(appName, force = false) {
  // Return cache if same app and not forced
  if (!force && cachedApp === appName && cachedElements.length > 0) {
    console.log(`[Piggy Vision] Using cached ${cachedElements.length} elements from ${appName}`);
    return { elements: cachedElements, map: cachedMap, count: cachedElements.length };
  }

  cachedApp = appName;

  // ── CDP path for Brave/Chrome ──
  if (isCDPBrowser(appName)) {
    return scanViaCDP();
  }

  // ── Worker path for Safari ──
  return scanViaWorker(appName);
}

/**
 * Scan via CDP (Brave/Chrome). Connects if not already connected.
 */
async function scanViaCDP() {
  try {
    if (!cdp.isConnected()) {
      console.log('[Piggy Vision] Connecting to CDP...');
      await cdp.connect();
    }

    const elements = await cdp.scanElements(80);
    const map = cdp.buildMap(elements);

    cachedElements = elements;
    cachedMap = map;

    console.log(`[Piggy Vision] CDP scan: ${elements.length} elements`);
    return { elements, map, count: elements.length };
  } catch (err) {
    console.warn(`[Piggy Vision] CDP scan failed: ${err.message}`);
    return { elements: [], map: `CDP scan failed: ${err.message}`, count: 0, error: err.message };
  }
}

/**
 * Scan via the forked worker process (Safari / AppleScript).
 */
async function scanViaWorker(appName) {
  // Start worker if needed
  if (!worker) start();

  // Wait for worker to be ready (max 3s)
  if (!ready) {
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (ready) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 3000);
    });
  }

  if (!worker || !ready) {
    return { elements: [], map: 'Scanner not available.', count: 0 };
  }

  return new Promise((resolve) => {
    const id = ++requestId;
    pending.set(id, { resolve });

    worker.send({ type: 'scan', app: appName, requestId: id });

    // Timeout after 20 seconds
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ elements: [], map: 'Scan timed out.', count: 0 });
      }
    }, 20000);
  });
}

/**
 * Invalidate cache — call after page-changing actions (navigation, link clicks).
 */
function invalidate() {
  cachedElements = [];
  cachedMap = '';
  cachedApp = null;
}

/**
 * Get coordinates for a specific element by ID from cache.
 *
 * @param {number} id — element ID
 * @returns {{found: boolean, cx: number, cy: number, element: object|null}}
 */
function getById(id) {
  const el = cachedElements.find(e => e.id === id);
  if (!el) return { found: false, cx: 0, cy: 0, element: null };
  return { found: true, cx: el.cx, cy: el.cy, element: el };
}

/**
 * Read the current page content (text, title, URL).
 * Uses CDP for Brave/Chrome, worker process for Safari.
 *
 * @param {string} [appName] — optional app name to pick the right backend
 * @returns {Promise<{success: boolean, title: string, url: string, text: string, wordCount: number}>}
 */
async function readPage(appName) {
  const app = appName || cachedApp;

  // ── CDP path for Brave/Chrome ──
  if (isCDPBrowser(app)) {
    return readPageViaCDP();
  }

  // ── Worker path for Safari ──
  return readPageViaWorker();
}

/**
 * Read page via CDP (Brave/Chrome).
 */
async function readPageViaCDP() {
  try {
    if (!cdp.isConnected()) await cdp.connect();
    return await cdp.readPage();
  } catch (err) {
    console.warn(`[Piggy Vision] CDP readPage failed: ${err.message}`);
    return { success: false, text: '', title: '', url: '', wordCount: 0, error: err.message };
  }
}

/**
 * Read page via worker process (Safari).
 */
async function readPageViaWorker() {
  if (!worker) start();
  if (!ready) {
    await new Promise((resolve) => {
      const check = setInterval(() => { if (ready) { clearInterval(check); resolve(); } }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 3000);
    });
  }
  if (!worker || !ready) return { success: false, text: '', title: '', url: '', wordCount: 0 };

  return new Promise((resolve) => {
    const id = ++requestId;
    pending.set(id, { resolve });
    worker.send({ type: 'read-page', requestId: id });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ success: false, text: '', title: '', url: '', wordCount: 0 }); }
    }, 20000);
  });
}

/**
 * Stop the scanner worker.
 */
function stop() {
  if (worker) {
    worker.send({ type: 'exit' });
    worker = null;
    ready = false;
  }
}

function clearPageCache() {
  invalidate();
}

module.exports = { start, scan, invalidate, clearPageCache, getById, readPage, stop, isCDPBrowser };
