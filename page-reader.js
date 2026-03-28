/**
 * Piggy — Page Reader
 * Extracts text content from web pages for the AI to read, summarize, and report.
 * Handles Safari via AppleScript and Brave/Chrome via CDP.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_SCRIPT = path.join(os.tmpdir(), 'piggy-reader.scpt');

// ── Safari page reading ──────────────────────────────────

/**
 * Extract all visible text from the current Safari page.
 *
 * @returns {Promise<{success: boolean, text: string, title: string, url: string, wordCount: number}>}
 */
function readSafariPage() {
  const script = `tell application "Safari"
  if (count of windows) = 0 then return "ERROR|No windows"
  if (count of tabs of window 1) = 0 then return "ERROR|No tabs"
  set pageTitle to name of current tab of window 1
  set pageURL to URL of current tab of window 1
  set pageText to do JavaScript "
    (function() {
      // Remove scripts, styles, nav, footer, ads
      var clone = document.body.cloneNode(true);
      var remove = clone.querySelectorAll('script, style, nav, footer, header, aside, [role=navigation], [role=banner], [role=contentinfo], .ad, .ads, .advertisement, .sidebar, .cookie-banner, .popup');
      for (var i = 0; i < remove.length; i++) remove[i].remove();

      // Get clean text
      var text = clone.innerText || clone.textContent || '';

      // Clean up whitespace
      text = text.replace(/\\t/g, ' ');
      text = text.replace(/ {2,}/g, ' ');
      text = text.replace(/\\n{3,}/g, '\\n\\n');
      text = text.trim();

      // Limit to ~5000 chars to fit in context
      if (text.length > 5000) text = text.substring(0, 5000) + '... [truncated]';

      return text;
    })()
  " in current tab of window 1
  return pageTitle & "|SPLIT|" & pageURL & "|SPLIT|" & pageText
end tell`;

  fs.writeFileSync(TMP_SCRIPT, script);

  return new Promise((resolve) => {
    exec(`osascript "${TMP_SCRIPT}"`, { encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
      if (err) {
        resolve({ success: false, text: '', title: '', url: '', wordCount: 0, error: err.message?.substring(0, 100) });
        return;
      }

      const raw = (stdout || '').trim();
      if (raw.startsWith('ERROR|')) {
        resolve({ success: false, text: '', title: '', url: '', wordCount: 0, error: raw.split('|')[1] });
        return;
      }

      const parts = raw.split('|SPLIT|');
      const title = (parts[0] || '').trim();
      const url = (parts[1] || '').trim();
      const text = (parts[2] || '').trim();

      resolve({
        success: true,
        title,
        url,
        text,
        wordCount: text.split(/\s+/).filter(Boolean).length
      });
    });
  });
}

/**
 * Extract structured data from the current Safari page.
 * Gets headings, links, and main content separately.
 *
 * @returns {Promise<{success: boolean, title: string, url: string, headings: string[], links: Array<{text: string, href: string}>, mainContent: string}>}
 */
function readSafariStructured() {
  const script = `tell application "Safari"
  if (count of windows) = 0 then return "ERROR|No windows"
  if (count of tabs of window 1) = 0 then return "ERROR|No tabs"
  set pageTitle to name of current tab of window 1
  set pageURL to URL of current tab of window 1
  set pageData to do JavaScript "
    (function() {
      var data = {};

      // Headings
      var headings = [];
      document.querySelectorAll('h1, h2, h3').forEach(function(h) {
        var t = h.textContent.trim().substring(0, 100);
        if (t) headings.push(h.tagName + ': ' + t);
      });
      data.headings = headings.slice(0, 20).join('|||');

      // Links (top 20 meaningful ones)
      var links = [];
      document.querySelectorAll('a[href]').forEach(function(a) {
        var t = a.textContent.trim().substring(0, 80);
        var h = a.href;
        if (t && t.length > 2 && !h.startsWith('javascript:')) {
          links.push(t + '>>>' + h);
        }
      });
      data.links = links.slice(0, 20).join('|||');

      // Main content (article or main tag, fallback to body)
      var main = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role=main]');
      if (!main) main = document.body;
      var clone = main.cloneNode(true);
      clone.querySelectorAll('script, style, nav, footer, aside').forEach(function(el) { el.remove(); });
      var text = (clone.innerText || '').trim();
      text = text.replace(/\\t/g, ' ').replace(/ {2,}/g, ' ').replace(/\\n{3,}/g, '\\n\\n');
      if (text.length > 4000) text = text.substring(0, 4000) + '... [truncated]';
      data.content = text;

      return JSON.stringify(data);
    })()
  " in current tab of window 1
  return pageTitle & "|SPLIT|" & pageURL & "|SPLIT|" & pageData
end tell`;

  fs.writeFileSync(TMP_SCRIPT, script);

  return new Promise((resolve) => {
    exec(`osascript "${TMP_SCRIPT}"`, { encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
      if (err) {
        resolve({ success: false, title: '', url: '', headings: [], links: [], mainContent: '', error: err.message?.substring(0, 100) });
        return;
      }

      const raw = (stdout || '').trim();
      if (raw.startsWith('ERROR|')) {
        resolve({ success: false, title: '', url: '', headings: [], links: [], mainContent: '', error: raw.split('|')[1] });
        return;
      }

      const parts = raw.split('|SPLIT|');
      const title = (parts[0] || '').trim();
      const url = (parts[1] || '').trim();

      let headings = [], links = [], mainContent = '';
      try {
        const data = JSON.parse(parts[2] || '{}');
        headings = (data.headings || '').split('|||').filter(Boolean);
        links = (data.links || '').split('|||').filter(Boolean).map(l => {
          const [text, href] = l.split('>>>');
          return { text: text || '', href: href || '' };
        });
        mainContent = data.content || '';
      } catch {}

      resolve({ success: true, title, url, headings, links, mainContent });
    });
  });
}

/**
 * Check if Safari page is fully loaded.
 *
 * @returns {Promise<{loaded: boolean, state: string}>}
 */
function isSafariLoaded() {
  return new Promise((resolve) => {
    exec(`osascript -e 'tell application "Safari" to do JavaScript "document.readyState" in current tab of window 1'`, {
      encoding: 'utf8', timeout: 5000
    }, (err, stdout) => {
      const state = (stdout || '').trim();
      resolve({ loaded: state === 'complete', state: state || 'unknown' });
    });
  });
}

/**
 * Wait until Safari page is fully loaded.
 *
 * @param {number} [maxWait=10000] — max ms to wait
 * @param {number} [checkInterval=500] — ms between checks
 * @returns {Promise<boolean>} — true if loaded, false if timeout
 */
async function waitForSafariLoad(maxWait = 10000, checkInterval = 500) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const { loaded } = await isSafariLoaded();
    if (loaded) return true;
    await new Promise(r => setTimeout(r, checkInterval));
  }
  return false;
}

// ── Tab management ───────────────────────────────────────

/**
 * Get all open Safari tabs.
 *
 * @returns {Promise<Array<{index: number, title: string, url: string}>>}
 */
function getSafariTabs() {
  return new Promise((resolve) => {
    exec(`osascript -e '
      tell application "Safari"
        set tabList to ""
        repeat with i from 1 to count of tabs of window 1
          set t to tab i of window 1
          set tabList to tabList & i & "|" & name of t & "|" & URL of t & "\\n"
        end repeat
        return tabList
      end tell'`, { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const tabs = (stdout || '').trim().split('\n').filter(Boolean).map(line => {
        const [index, title, url] = line.split('|');
        return { index: parseInt(index), title: title || '', url: url || '' };
      });
      resolve(tabs);
    });
  });
}

/**
 * Switch to a Safari tab by index.
 *
 * @param {number} index — 1-based tab index
 * @returns {Promise<boolean>}
 */
function switchSafariTab(index) {
  return new Promise((resolve) => {
    exec(`osascript -e 'tell application "Safari" to set current tab of window 1 to tab ${index} of window 1'`, {
      encoding: 'utf8', timeout: 3000
    }, (err) => resolve(!err));
  });
}

/**
 * Open a new Safari tab with a URL.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
function openSafariTab(url) {
  return new Promise((resolve) => {
    const safe = url.replace(/'/g, '');
    exec(`osascript -e 'tell application "Safari" to make new tab at end of tabs of window 1 with properties {URL:"${safe}"}'`, {
      encoding: 'utf8', timeout: 5000
    }, (err) => resolve(!err));
  });
}

/**
 * Close the current Safari tab.
 *
 * @returns {Promise<boolean>}
 */
function closeSafariTab() {
  return new Promise((resolve) => {
    exec(`osascript -e 'tell application "Safari" to close current tab of window 1'`, {
      encoding: 'utf8', timeout: 3000
    }, (err) => resolve(!err));
  });
}

// ── Clipboard ────────────────────────────────────────────

/**
 * Copy text to the system clipboard.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
function copyToClipboard(text) {
  return new Promise((resolve) => {
    const safe = text.replace(/'/g, "'\\''");
    exec(`osascript -e 'set the clipboard to "${safe}"'`, {
      encoding: 'utf8', timeout: 3000
    }, (err) => resolve(!err));
  });
}

/**
 * Get text from the system clipboard.
 *
 * @returns {Promise<string>}
 */
function getClipboard() {
  return new Promise((resolve) => {
    exec(`osascript -e 'the clipboard'`, {
      encoding: 'utf8', timeout: 3000
    }, (err, stdout) => resolve((stdout || '').trim()));
  });
}

// ── Navigate ─────────────────────────────────────────────

/**
 * Navigate Safari to a URL and wait for load.
 *
 * @param {string} url
 * @param {number} [maxWait=10000]
 * @returns {Promise<{success: boolean, url: string, loadTime: number}>}
 */
async function navigateSafari(url, maxWait = 10000) {
  const start = Date.now();
  const safe = url.replace(/'/g, '');

  return new Promise((resolve) => {
    exec(`osascript -e 'tell application "Safari" to set URL of current tab of window 1 to "${safe}"'`, {
      encoding: 'utf8', timeout: 5000
    }, async (err) => {
      if (err) {
        resolve({ success: false, url, loadTime: 0, error: err.message });
        return;
      }
      const loaded = await waitForSafariLoad(maxWait);
      resolve({ success: true, url, loadTime: Date.now() - start, loaded });
    });
  });
}

// ── Scroll and read ──────────────────────────────────────

/**
 * Scroll down the Safari page and extract content progressively.
 * For long articles that don't fit in one screen.
 *
 * @param {number} [scrolls=3] — number of times to scroll down
 * @param {number} [delayBetween=1000] — ms between scrolls
 * @returns {Promise<{success: boolean, text: string, wordCount: number}>}
 */
async function scrollAndRead(scrolls = 3, delayBetween = 1000) {
  let allText = '';

  for (let i = 0; i <= scrolls; i++) {
    // Read current viewport content
    const page = await readSafariPage();
    if (page.success && page.text) {
      // Append only new content
      const newContent = page.text.substring(allText.length > 0 ? Math.max(0, allText.length - 200) : 0);
      if (newContent.length > 50) allText += '\n' + newContent;
    }

    // Scroll down (except on last iteration)
    if (i < scrolls) {
      await new Promise((resolve) => {
        exec(`osascript -e 'tell application "Safari" to do JavaScript "window.scrollBy(0, window.innerHeight * 0.8)" in current tab of window 1'`, {
          encoding: 'utf8', timeout: 3000
        }, () => resolve());
      });
      await new Promise(r => setTimeout(r, delayBetween));
    }
  }

  // Clean up and deduplicate
  allText = allText.trim();
  if (allText.length > 10000) allText = allText.substring(0, 10000) + '\n... [truncated]';

  return {
    success: allText.length > 0,
    text: allText,
    wordCount: allText.split(/\s+/).filter(Boolean).length
  };
}

// ── Build context for AI ─────────────────────────────────

/**
 * Build a formatted context block from page content for the AI prompt.
 *
 * @param {object} pageData — from readSafariPage() or readSafariStructured()
 * @returns {string}
 */
function buildPageContext(pageData) {
  if (!pageData.success) return 'PAGE READ FAILED: ' + (pageData.error || 'unknown error');

  const parts = [`PAGE CONTENT from "${pageData.title || 'Unknown'}":`];
  if (pageData.url) parts.push(`URL: ${pageData.url}`);

  if (pageData.headings && pageData.headings.length > 0) {
    parts.push('\nHEADINGS:');
    pageData.headings.forEach(h => parts.push(`  ${h}`));
  }

  if (pageData.mainContent) {
    parts.push('\nCONTENT:');
    parts.push(pageData.mainContent);
  } else if (pageData.text) {
    parts.push('\nCONTENT:');
    parts.push(pageData.text);
  }

  if (pageData.links && pageData.links.length > 0) {
    parts.push('\nLINKS:');
    pageData.links.slice(0, 10).forEach(l => parts.push(`  "${l.text}" → ${l.href}`));
  }

  return parts.join('\n');
}

module.exports = {
  readSafariPage,
  readSafariStructured,
  isSafariLoaded,
  waitForSafariLoad,
  getSafariTabs,
  switchSafariTab,
  openSafariTab,
  closeSafariTab,
  copyToClipboard,
  getClipboard,
  navigateSafari,
  scrollAndRead,
  buildPageContext
};
