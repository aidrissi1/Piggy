/**
 * Piggy — Scanner Worker
 * Runs as a separate Node process to avoid Electron's shell restrictions.
 * Receives scan requests via process messaging, returns element maps.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_SCRIPT = path.join(os.tmpdir(), 'piggy-scanner.scpt');

/**
 * Navigate Safari to a URL via AppleScript.
 */
function navigateSafari(url) {
  return new Promise((resolve) => {
    exec(`osascript -e 'tell application "Safari" to set URL of current tab of window 1 to "${url}"'`, {
      encoding: 'utf8', timeout: 5000
    }, () => setTimeout(resolve, 2500));
  });
}

/**
 * Check if Safari is on a real page or blank.
 */
function getSafariURL() {
  return new Promise((resolve) => {
    exec(`osascript -e 'tell application "Safari" to get URL of current tab of window 1'`, {
      encoding: 'utf8', timeout: 5000
    }, (err, stdout) => resolve((stdout || '').trim()));
  });
}

/**
 * Extract DOM elements from Safari via JavaScript injection.
 */
function scanSafariDOM() {
  const appleScript = `tell application "Safari"
  if (count of windows) = 0 then return ""
  if (count of tabs of window 1) = 0 then return ""
  set winBounds to bounds of window 1
  set winX to item 1 of winBounds
  set winY to item 2 of winBounds
  set jsCode to "var items=[];var els=document.querySelectorAll('a,button,input,textarea,select,[role=button],[onclick],[tabindex]');for(var i=0;i<els.length&&i<80;i++){var el=els[i];var rect=el.getBoundingClientRect();if(rect.width<5||rect.height<5)continue;if(rect.y+rect.height<0||rect.y>window.innerHeight)continue;var tag=el.tagName.toLowerCase();var text=(el.textContent||el.value||el.placeholder||el.getAttribute('aria-label')||'').trim().substring(0,80);text=text.replace(/[|]/g,' ').replace(/\\\\s+/g,' ');var type=el.type||'';var role=tag;if(tag==='input')role=type||'input';if(tag==='a')role='link';if(el.getAttribute('role')==='button')role='button';items.push(tag+'|'+role+'|'+text+'|'+Math.round(rect.x)+'|'+Math.round(rect.y)+'|'+Math.round(rect.width)+'|'+Math.round(rect.height));}items.join('\\\\n');"
  set domData to do JavaScript jsCode in current tab of window 1
  return (winX as text) & "|" & (winY as text) & "\\n" & domData
end tell`;

  fs.writeFileSync(TMP_SCRIPT, appleScript);

  return new Promise((resolve) => {
    exec(`osascript "${TMP_SCRIPT}"`, { encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
      if (err) {
        resolve({ elements: [], error: err.message?.substring(0, 100) });
        return;
      }

      const raw = (stdout || '').trim();
      if (!raw) { resolve({ elements: [] }); return; }

      const lines = raw.split('\n').filter(Boolean);
      if (lines.length < 1) { resolve({ elements: [] }); return; }

      const [winXStr, winYStr] = lines[0].split('|');
      const winX = parseInt(winXStr) || 0;
      const winY = parseInt(winYStr) || 0;
      const toolbarOffset = 75;

      const elements = [];
      let id = 1;
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split('|');
        if (parts.length < 7) continue;
        const [tag, role, name, dx, dy, dw, dh] = parts;
        const relX = parseInt(dx), relY = parseInt(dy);
        const w = parseInt(dw), h = parseInt(dh);
        const x = winX + relX;
        const y = winY + toolbarOffset + relY;

        elements.push({
          id, source: 'dom', tag, role,
          name: name.trim(),
          x, y, w, h,
          cx: x + Math.round(w / 2),
          cy: y + Math.round(h / 2)
        });
        id++;
      }
      resolve({ elements });
    });
  });
}

/**
 * Build the element map string for the AI.
 */
function buildMap(elements) {
  if (elements.length === 0) return 'NO ELEMENTS FOUND on page.';
  const lines = elements.map(el => {
    const label = el.name ? `"${el.name}"` : `(${el.role})`;
    return `  [${el.id}] ${el.role} — ${label} at (${el.cx}, ${el.cy})`;
  });
  return `ELEMENTS ON SCREEN (click by number):\n${lines.join('\n')}`;
}

/**
 * Read the full text content of the current Safari page.
 */
function readSafariPage() {
  const script = `tell application "Safari"
  if (count of windows) = 0 then return "ERROR|No windows"
  if (count of tabs of window 1) = 0 then return "ERROR|No tabs"
  set pageTitle to name of current tab of window 1
  set pageURL to URL of current tab of window 1
  set pageText to do JavaScript "
    (function() {
      var clone = document.body.cloneNode(true);
      var remove = clone.querySelectorAll('script, style, nav, footer, header, aside, [role=navigation], [role=banner], .ad, .ads, .sidebar, .cookie-banner, .popup');
      for (var i = 0; i < remove.length; i++) remove[i].remove();
      var text = clone.innerText || clone.textContent || '';
      text = text.replace(/\\t/g, ' ').replace(/ {2,}/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
      if (text.length > 5000) text = text.substring(0, 5000) + '... [truncated]';
      return text;
    })()
  " in current tab of window 1
  return pageTitle & "|SPLIT|" & pageURL & "|SPLIT|" & pageText
end tell`;

  const tmpFile = path.join(os.tmpdir(), 'piggy-read.scpt');
  fs.writeFileSync(tmpFile, script);

  return new Promise((resolve) => {
    exec(`osascript "${tmpFile}"`, { encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
      if (err) {
        resolve({ success: false, text: '', title: '', url: '', error: err.message?.substring(0, 100) });
        return;
      }
      const raw = (stdout || '').trim();
      if (raw.startsWith('ERROR|')) {
        resolve({ success: false, text: '', title: '', url: '', error: raw.split('|')[1] });
        return;
      }
      const parts = raw.split('|SPLIT|');
      const title = (parts[0] || '').trim();
      const url = (parts[1] || '').trim();
      const text = (parts[2] || '').trim();
      resolve({ success: true, title, url, text, wordCount: text.split(/\s+/).filter(Boolean).length });
    });
  });
}

// ── Message handler ──────────────────────────────────────

process.on('message', async (msg) => {
  if (msg.type === 'scan') {
    const app = msg.app;

    // For Safari: ensure we're on a real page
    if (app === 'Safari') {
      const url = await getSafariURL();
      if (!url || url === '' || url.startsWith('favorites:')) {
        await navigateSafari('https://www.google.com');
      }
    }

    // Scan
    const result = app === 'Safari'
      ? await scanSafariDOM()
      : { elements: [] };

    const map = buildMap(result.elements);

    process.send({
      type: 'scan-result',
      requestId: msg.requestId,
      elements: result.elements,
      map,
      count: result.elements.length,
      error: result.error || null
    });
  }

  if (msg.type === 'read-page') {
    const readResult = await readSafariPage();
    process.send({
      type: 'read-page-result',
      requestId: msg.requestId,
      ...readResult
    });
  }

  if (msg.type === 'navigate') {
    await navigateSafari(msg.url);
    process.send({
      type: 'navigate-result',
      requestId: msg.requestId,
      url: msg.url
    });
  }

  if (msg.type === 'exit') {
    process.exit(0);
  }
});

process.send({ type: 'ready' });
