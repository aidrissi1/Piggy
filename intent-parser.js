/**
 * Piggy — Intent Parser
 * Translates plain English model responses into executable actions.
 * The model describes WHAT it wants. This module figures out HOW.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

// ── Intent types ─────────────────────────────────────────

const INTENTS = {
  CLICK:      'click',
  TYPE:       'type',
  CLICK_TYPE: 'click_type',
  KEY:        'key',
  SCROLL:     'scroll',
  FOCUS:      'focus',
  READ:       'read',
  NAVIGATE:   'navigate',
  DONE:       'done',
  FAIL:       'fail',
  WAIT:       'wait'
};

// ── Parse model response ─────────────────────────────────

/**
 * Parse a plain English model response into executable actions.
 * The model says things like:
 *   "click the search bar and type 'hello'"
 *   "press enter"
 *   "scroll down"
 *   "I'm done, the page loaded"
 *   "read the page content"
 *
 * @param {string} text — model's plain English response
 * @param {Array} elements — current screen elements from vision scan
 * @param {string} [app] — current focused app
 * @returns {Array<{action: string, x?: number, y?: number, text?: string, key?: string, app?: string, reason?: string, report?: string}>}
 */
function parse(text, elements = [], app = null) {
  if (!text || typeof text !== 'string') return [{ action: 'fail', reason: 'Empty response' }];

  // Strip narration: find the last sentence that looks like a command
  const cleaned = stripNarration(text);
  const lower = cleaned.toLowerCase().trim();
  const actions = [];

  // Check for done/fail first
  if (isDone(lower)) {
    return [{ action: 'done', reason: extractReason(text), report: extractReport(text) }];
  }
  if (isFail(lower)) {
    return [{ action: 'fail', reason: extractReason(text) }];
  }

  // Check for address bar / URL bar mention — always use Cmd+L (most reliable)
  if (/\b(address bar|url bar|address field)\b/.test(lower)) {
    return [{ action: 'shortcut', key: 'l', modifiers: ['command'] }];
  }

  // Check for read intent
  if (isRead(lower)) {
    actions.push({ action: 'read' });
    return actions;
  }

  // Check for wait intent
  if (isWait(lower)) {
    actions.push({ action: 'wait' });
    return actions;
  }

  // Check for focus intent
  const focusApp = extractFocusApp(lower);
  if (focusApp) {
    actions.push({ action: 'focus', app: focusApp });
  }

  // Check for navigate intent — but NOT if it starts with "click"
  // "Click the Razer https://www.razer.com" should be a click, not navigate
  if (!/^click/i.test(lower)) {
    const navURL = extractURL(cleaned);
    if (navURL) {
      actions.push({ action: 'navigate', url: navURL });
      return actions;
    }
  }

  // Check for scroll intent
  if (isScroll(lower)) {
    const dir = /\bup\b/.test(lower) ? 'up' : 'down';
    actions.push({ action: 'scroll', direction: dir, amount: 3 });
    return actions;
  }

  // Check for key press intent
  const keyPress = extractKeyPress(lower);
  if (keyPress && !extractClickTarget(lower, elements)) {
    actions.push(keyPress);
    return actions.length > 0 ? actions : [keyPress];
  }

  // Check for click + type intent (e.g., "click the search bar and type hello")
  const clickTypeIntent = extractClickType(text, lower, elements);
  if (clickTypeIntent) {
    actions.push(clickTypeIntent);
    // Check if there's also a key press after (e.g., "and press enter")
    if (keyPress) actions.push(keyPress);
    return actions;
  }

  // Check for click intent
  const clickTarget = extractClickTarget(lower, elements);
  if (clickTarget) {
    actions.push(clickTarget);
    return actions;
  }

  // Check for type intent (no click, just type)
  const typeText = extractTypeText(text, lower);
  if (typeText) {
    actions.push({ action: 'type', text: typeText });
    if (keyPress) actions.push(keyPress);
    return actions;
  }

  // If we have a key press but nothing else matched
  if (keyPress) {
    return [keyPress];
  }

  // Fallback: the model narrated instead of giving a command.
  // Try to extract intent from the narration.
  const lower2 = lower;

  // "I need to open Safari" / "I should focus Safari" / "Let me open Safari"
  for (const [pattern, appName] of Object.entries({
    'safari': 'Safari', 'brave': 'Brave Browser', 'chrome': 'Google Chrome',
    'firefox': 'Firefox', 'terminal': 'Terminal', 'finder': 'Finder'
  })) {
    if (lower2.includes('open ' + pattern) || lower2.includes('focus ' + pattern) || lower2.includes('launch ' + pattern)) {
      return [{ action: 'focus', app: appName }];
    }
  }

  // Mentions "address bar" / "search bar" / "url bar" → use Cmd+L (most reliable)
  if (/\b(address bar|url bar)\b/.test(lower2)) {
    return [{ action: 'shortcut', key: 'l', modifiers: ['command'] }];
  }

  // "I'll click on the search" / "I need to click"
  if (/\b(click|tap)\b/.test(lower2) || /\b(search bar)\b/.test(lower2)) {
    const target = extractClickTarget(lower2, elements);
    if (target) return [target];
  }

  // "I'll type" / "I need to type" — only if quoted text found
  if (/\b(type|write)\b/.test(lower2)) {
    const typeText = extractTypeText(text, lower2);
    if (typeText && typeText.length < 100) return [{ action: 'type', text: typeText }];
  }

  // "press enter" buried in narration
  const keyInNarration = extractKeyPress(lower2);
  if (keyInNarration) return [keyInNarration];

  // "scroll down" buried in narration
  if (/scroll/i.test(lower2)) {
    return [{ action: 'scroll', direction: /up/.test(lower2) ? 'up' : 'down', amount: 3 }];
  }

  // "read the page" buried in narration
  if (/read the page|extract.+content|get the text/i.test(lower2)) {
    return [{ action: 'read' }];
  }

  // Last resort: if model mentions it needs to search/navigate, try focus
  if (/\bbrave\b/i.test(lower2)) {
    return [{ action: 'focus', app: 'Brave Browser' }];
  }
  if (/\b(safari|browser)\b/i.test(lower2)) {
    return [{ action: 'focus', app: 'Safari' }];
  }

  return [{ action: 'wait' }]; // can't parse — wait and retry
}

// ── Narration stripping ──────────────────────────────────

/**
 * Strip narration from model response.
 * Models say: "Perfect! I can see Safari is open. Click the Search bar and type 'cats'"
 * We want: "Click the Search bar and type 'cats'"
 *
 * Strategy: split into sentences, find the one that starts with an action verb.
 */
function stripNarration(text) {
  if (!text) return '';

  // Split on sentence boundaries
  const sentences = text.split(/(?<=[.!])\s+|(?<=\n)/).map(s => s.trim()).filter(s => s.length > 2);

  // Action verbs that indicate a command
  const actionPattern = /^(focus|open|launch|click|tap|press|hit|type|write|enter|scroll|read|done|cannot|can't|wait)/i;

  // Find the LAST sentence that starts with an action verb (model often puts command at end)
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (actionPattern.test(sentences[i])) {
      return sentences[i];
    }
  }

  // Also check for "I'll click" / "I need to click" / "Let me click" patterns
  const intentPattern = /(?:i'll|i will|i need to|i should|let me|i'm going to|now i'll|i want to|i can|i have to)\s+(click|type|press|scroll|open|focus|read|navigate|go to)/i;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const match = sentences[i].match(intentPattern);
    if (match) {
      // Rewrite "I'll click the search" → "click the search"
      const idx = sentences[i].toLowerCase().indexOf(match[1].toLowerCase());
      return sentences[i].substring(idx);
    }
  }

  // No clear command found — return the full text for fallback parsing
  return text;
}

// ── Intent detection ─────────────────────────────────────

function isDone(text) {
  // Must START with "done" — not just contain the word
  return /^done\b/i.test(text.trim());
}

function isFail(text) {
  // Must START with "cannot complete" / "can't complete" / "fail"
  return /^(cannot complete|can't complete|cannot proceed|fail)/i.test(text.trim());
}

function isRead(text) {
  return /\b(read|extract|get.?content|get.?text|scrape|what.?does.?it.?say|summarize.?the.?page|page.?content)\b/.test(text);
}

function isWait(text) {
  // Only match explicit wait commands, NOT narration about needing to navigate
  if (/\b(address bar|search bar|url bar|click|type|navigate)\b/.test(text)) return false;
  return /\b(wait|loading|still.?loading|page.?is.?loading|let.?it.?load)\b/.test(text) &&
    !/\bdon't wait\b/.test(text);
}

function isScroll(text) {
  return /\b(scroll)\b/.test(text);
}

// ── Extraction helpers ───────────────────────────────────

/**
 * Extract which app to focus from text.
 */
function extractFocusApp(text) {
  // Only match explicit "Focus/Open [AppName]" at the START of the text
  // Must match a known app name — don't accept arbitrary text
  const KNOWN_APPS = {
    'safari': 'Safari',
    'brave': 'Brave Browser',
    'brave browser': 'Brave Browser',
    'chrome': 'Google Chrome',
    'google chrome': 'Google Chrome',
    'firefox': 'Firefox',
    'terminal': 'Terminal',
    'finder': 'Finder',
    'notes': 'Notes',
    'textedit': 'TextEdit',
    'mail': 'Mail',
    'messages': 'Messages',
    'system preferences': 'System Preferences',
    'system settings': 'System Settings'
  };

  // Must start with a focus verb
  if (!/^(focus|open|launch|switch to|bring up)\b/i.test(text)) return null;

  // Check each known app
  const lower = text.toLowerCase();
  for (const [pattern, appName] of Object.entries(KNOWN_APPS)) {
    if (lower.includes(pattern)) return appName;
  }

  return null;
}

/**
 * Extract a URL from text.
 */
function extractURL(text) {
  // Explicit URL — clean trailing punctuation/JSON artifacts
  const urlMatch = text.match(/(https?:\/\/[\w.-]+(?:\/[\w./?&=#%-]*)?)/i);
  if (urlMatch) {
    return urlMatch[1].replace(/[}"'\]>]+$/, ''); // strip trailing garbage
  }

  // "go to X.com" pattern
  const goToMatch = text.match(/(?:go to|navigate to|open|visit)\s+([\w.-]+\.(?:com|org|net|io|dev|ai|edu|gov|co)[\w/]*)/i);
  if (goToMatch) {
    const url = goToMatch[1].replace(/[}"'\]>]+$/, '');
    return url.startsWith('http') ? url : 'https://' + url;
  }

  return null;
}

/**
 * Extract key press from text.
 */
function extractKeyPress(text) {
  if (/\b(press|hit)\s+enter\b/.test(text) || /\bthen\s+enter\b/.test(text)) {
    return { action: 'key', key: 'enter' };
  }
  if (/\b(press|hit)\s+tab\b/.test(text)) return { action: 'key', key: 'tab' };
  if (/\b(press|hit)\s+escape\b/.test(text)) return { action: 'key', key: 'escape' };
  if (/\b(press|hit)\s+backspace\b/.test(text)) return { action: 'key', key: 'backspace' };
  if (/\b(press|hit)\s+space\b/.test(text)) return { action: 'key', key: 'space' };

  // Shortcuts
  if (/\bcmd\s*\+\s*l\b/i.test(text)) return { action: 'shortcut', key: 'l', modifiers: ['command'] };
  if (/\bcmd\s*\+\s*t\b/i.test(text)) return { action: 'shortcut', key: 't', modifiers: ['command'] };
  if (/\bcmd\s*\+\s*w\b/i.test(text)) return { action: 'shortcut', key: 'w', modifiers: ['command'] };
  if (/\bcmd\s*\+\s*r\b/i.test(text)) return { action: 'shortcut', key: 'r', modifiers: ['command'] };

  return null;
}

/**
 * Extract click target from text and match to an element.
 */
function extractClickTarget(text, elements) {
  if (!elements || elements.length === 0) return null;

  // "click (on) the X" / "click X" / "select X" / "tap X"
  const clickMatch = text.match(/(?:click|tap|select|press|hit|choose)\s+(?:on\s+)?(?:the\s+)?["']?(.+?)["']?(?:\s+button|\s+link|\s+and|\s+then|$)/i);
  if (!clickMatch) return null;

  const target = clickMatch[1].trim().toLowerCase();
  const element = findBestMatch(target, elements);

  if (element) {
    return { action: 'click', x: element.cx, y: element.cy, _matched: element.name };
  }

  // Try "first result" / "first link" / "second result" etc.
  const ordinalMatch = target.match(/^(first|second|third|1st|2nd|3rd)\s+(result|link|item|option)/i);
  if (ordinalMatch) {
    const ordinal = ordinalMatch[1].toLowerCase();
    const type = ordinalMatch[2].toLowerCase();
    const links = elements.filter(e => e.role === 'link' && e.name && e.name.length > 5);
    const idx = ordinal === 'first' || ordinal === '1st' ? 0 :
                ordinal === 'second' || ordinal === '2nd' ? 1 : 2;
    if (links[idx]) {
      return { action: 'click', x: links[idx].cx, y: links[idx].cy, _matched: links[idx].name };
    }
  }

  return null;
}

/**
 * Extract click + type intent.
 * "click the search bar and type hello"
 * "type hello in the search bar"
 */
function extractClickType(origText, text, elements) {
  if (!elements || elements.length === 0) return null;

  // "click X and type 'Y'" — require quoted text
  const clickTypeQuoted = text.match(/(?:click|tap)\s+(?:on\s+)?(?:the\s+)?(.+?)\s+(?:and|then)\s+(?:type|write|enter)\s+['"](.+?)['"]/i);
  if (clickTypeQuoted) {
    const target = clickTypeQuoted[1].trim().toLowerCase();
    const typeText = clickTypeQuoted[2].trim();
    const element = findBestMatch(target, elements);
    if (element) {
      return { action: 'click_type', x: element.cx, y: element.cy, text: typeText, _matched: element.name };
    }
  }

  // "click X and type Y" — unquoted but short (max 50 chars, no narration words)
  const clickTypeUnquoted = text.match(/(?:click|tap)\s+(?:on\s+)?(?:the\s+)?(.+?)\s+(?:and|then)\s+(?:type|write|enter)\s+(\S.{2,50})$/i);
  if (clickTypeUnquoted && !/\b(i need|i should|the page|click|navigate)\b/i.test(clickTypeUnquoted[2])) {
    const target = clickTypeUnquoted[1].trim().toLowerCase();
    const typeText = clickTypeUnquoted[2].trim().replace(/["']+$/, '');
    const element = findBestMatch(target, elements);
    if (element) {
      return { action: 'click_type', x: element.cx, y: element.cy, text: typeText, _matched: element.name };
    }
  }

  // "type 'Y' in the X"
  const typeInMatch = text.match(/(?:type|write|enter)\s+['"](.+?)['"]\s+(?:in|into)\s+(?:the\s+)?(.+?)(?:\s+and|\s+then|$)/i);
  if (typeInMatch) {
    const typeText = typeInMatch[1].trim();
    const target = typeInMatch[2].trim().toLowerCase();
    const element = findBestMatch(target, elements);
    if (element) {
      return { action: 'click_type', x: element.cx, y: element.cy, text: typeText, _matched: element.name };
    }
  }

  return null;
}

/**
 * Extract plain type text.
 */
function extractTypeText(origText, text) {
  // ONLY match text in quotes — never extract unquoted narration
  const quoted = origText.match(/(?:type|write|enter)\s+["'](.+?)["']/i);
  if (quoted) return quoted[1].trim();

  // Also match after "type" if it's a short, clean phrase (no "I need to" etc.)
  const clean = origText.match(/^(?:type|write|enter)\s+(\S.{2,40})$/i);
  if (clean && !/\b(i need|i should|i can|i will|the page|click|navigate)\b/i.test(clean[1])) {
    return clean[1].trim();
  }

  return null;
}

/**
 * Extract reason from done/fail text.
 */
function extractReason(text) {
  // After "because" / "reason:" / dash
  const match = text.match(/(?:because|reason:|—|-)(.+)/i);
  return match ? match[1].trim() : text.substring(0, 100);
}

/**
 * Extract report from done text (findings the model wants to share).
 */
function extractReport(text) {
  // Look for substantial content after done declaration
  const parts = text.split(/\n/);
  if (parts.length > 1) {
    return parts.slice(1).join('\n').trim();
  }
  return '';
}

// ── Element matching ─────────────────────────────────────

/**
 * Find the best matching element for a text description.
 *
 * @param {string} target — what the model wants to click (lowercase)
 * @param {Array} elements — available elements
 * @returns {object|null} — best matching element
 */
function findBestMatch(target, elements) {
  if (!target || !elements || elements.length === 0) return null;

  // Common close/dismiss patterns
  const closePatterns = /^(x|close|dismiss|exit|cancel|no thanks|not now|got it|ok|accept)$/i;

  let bestElement = null;
  let bestScore = 0;

  for (const el of elements) {
    const name = (el.name || '').toLowerCase();
    const role = (el.role || '').toLowerCase();

    let score = 0;

    // Exact match (case-insensitive)
    if (name === target) {
      score = 1.0;
    }
    // Close/dismiss button matching — "X", "close", "exit", etc.
    else if (closePatterns.test(target) && closePatterns.test(name)) {
      score = 0.9;
    }
    // Target is "X" or similar short — match any close/exit/dismiss button
    else if (/^x$/i.test(target) && /\b(close|exit|dismiss|x)\b/i.test(name)) {
      score = 0.8;
    }
    // Name contains target
    else if (name.includes(target) && target.length > 1) {
      score = 0.8 * (target.length / Math.max(name.length, 1));
    }
    // Target contains name (even short names)
    else if (target.includes(name) && name.length > 0) {
      score = 0.6 * (name.length / Math.max(target.length, 1));
    }
    // Word overlap
    else {
      const targetWords = target.split(/\s+/).filter(w => w.length > 1);
      const nameWords = name.split(/\s+/).filter(w => w.length > 1);
      const matches = targetWords.filter(tw => nameWords.some(nw => nw.includes(tw) || tw.includes(nw)));
      if (matches.length > 0) {
        score = 0.5 * (matches.length / Math.max(targetWords.length, 1));
      }
    }

    // Role match bonus
    if (target.includes('button') && role === 'button') score += 0.1;
    if (target.includes('link') && role === 'link') score += 0.1;
    if (target.includes('search') && (role === 'textarea' || role === 'search' || name.includes('search'))) score += 0.2;
    if (target.includes('input') && (el.tag === 'input' || el.tag === 'textarea')) score += 0.1;
    // Close button bonus
    if (/^(x|close|exit|dismiss)$/i.test(target) && (role === 'button' || el.tag === 'button')) score += 0.15;

    if (score > bestScore) {
      bestScore = score;
      bestElement = el;
    }
  }

  // Minimum threshold
  return bestScore > 0.2 ? bestElement : null;
}

module.exports = { parse, findBestMatch, INTENTS };
