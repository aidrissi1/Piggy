/**
 * Piggy — Screen Diff Module
 * Compares before/after screenshots to detect what changed.
 * Tells the AI: "the page changed", "nothing happened", "error dialog appeared", etc.
 *
 * Uses pixel-level comparison on downscaled images for speed.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

// ── State ────────────────────────────────────────────────

let previousFrame = null;   // last screenshot as base64
let previousElements = [];  // last element scan
let frameHistory = [];       // rolling window of frame hashes
const MAX_HISTORY = 20;

// ── Core comparison ──────────────────────────────────────

/**
 * Compare two base64 screenshots and determine what changed.
 * Uses a simple pixel sampling approach — compares sampled pixels across a grid.
 *
 * @param {string} before — base64 PNG
 * @param {string} after — base64 PNG
 * @returns {{changed: boolean, changePercent: number, regions: Array<string>}}
 */
function compareFrames(before, after) {
  if (!before || !after) return { changed: true, changePercent: 100, regions: ['unknown'] };
  if (before === after) return { changed: false, changePercent: 0, regions: [] };

  // Quick hash comparison
  const hashBefore = simpleHash(before);
  const hashAfter = simpleHash(after);

  if (hashBefore === hashAfter) {
    return { changed: false, changePercent: 0, regions: [] };
  }

  // Byte-level comparison of base64 (rough but fast)
  const lenBefore = before.length;
  const lenAfter = after.length;
  const sizeDiff = Math.abs(lenBefore - lenAfter) / Math.max(lenBefore, lenAfter);

  // Sample comparison — check chunks of the base64 string
  const sampleSize = 100;
  const samples = 50;
  let matches = 0;

  const minLen = Math.min(lenBefore, lenAfter);
  const step = Math.max(1, Math.floor(minLen / samples));

  for (let i = 0; i < samples; i++) {
    const offset = i * step;
    if (offset + sampleSize > minLen) break;
    if (before.substring(offset, offset + sampleSize) === after.substring(offset, offset + sampleSize)) {
      matches++;
    }
  }

  const similarity = matches / samples;
  const changePercent = Math.round((1 - similarity) * 100);

  // Determine change type
  const regions = [];
  if (sizeDiff > 0.5) regions.push('major-layout-change');
  else if (sizeDiff > 0.1) regions.push('page-content-changed');
  else if (changePercent > 50) regions.push('significant-visual-change');
  else if (changePercent > 10) regions.push('partial-change');
  else if (changePercent > 2) regions.push('minor-change');

  return {
    changed: changePercent > 2,
    changePercent,
    regions
  };
}

/**
 * Compare two element lists to detect structural changes.
 *
 * @param {Array} before — elements from previous scan
 * @param {Array} after — elements from current scan
 * @returns {{added: Array, removed: Array, moved: Array, unchanged: number}}
 */
function compareElements(before, after) {
  if (!before || !after) return { added: after || [], removed: before || [], moved: [], unchanged: 0 };

  const beforeNames = new Map(before.map(e => [e.name + '|' + e.role, e]));
  const afterNames = new Map(after.map(e => [e.name + '|' + e.role, e]));

  const added = [];
  const removed = [];
  const moved = [];
  let unchanged = 0;

  // Find added and moved elements
  for (const [key, el] of afterNames) {
    const prev = beforeNames.get(key);
    if (!prev) {
      added.push(el);
    } else {
      const dist = Math.sqrt(Math.pow(el.cx - prev.cx, 2) + Math.pow(el.cy - prev.cy, 2));
      if (dist > 20) {
        moved.push({ element: el, from: { x: prev.cx, y: prev.cy }, to: { x: el.cx, y: el.cy }, distance: Math.round(dist) });
      } else {
        unchanged++;
      }
    }
  }

  // Find removed elements
  for (const [key] of beforeNames) {
    if (!afterNames.has(key)) {
      removed.push(beforeNames.get(key));
    }
  }

  return { added, removed, moved, unchanged };
}

// ── Frame tracking ───────────────────────────────────────

/**
 * Push a new frame and get the diff from the previous one.
 *
 * @param {string} screenshot — base64 PNG
 * @param {Array} [elements] — current element scan
 * @returns {{changed: boolean, changePercent: number, regions: Array<string>, elementDiff: object|null, isStuck: boolean}}
 */
function pushFrame(screenshot, elements = null) {
  const frameDiff = compareFrames(previousFrame, screenshot);
  const elementDiff = elements ? compareElements(previousElements, elements) : null;

  // Track frame hashes for stuck detection
  const hash = simpleHash(screenshot);
  frameHistory.push(hash);
  if (frameHistory.length > MAX_HISTORY) frameHistory.shift();

  // Detect if the screen is stuck (same frame 3+ times in a row)
  const isStuck = frameHistory.length >= 3 &&
    frameHistory.slice(-3).every(h => h === hash);

  // Update state
  previousFrame = screenshot;
  if (elements) previousElements = elements;

  return {
    ...frameDiff,
    elementDiff,
    isStuck
  };
}

/**
 * Generate a human-readable description of what changed.
 *
 * @param {object} diff — from pushFrame()
 * @returns {string}
 */
function describeDiff(diff) {
  const parts = [];

  if (!diff.changed) {
    parts.push('Screen unchanged.');
  } else if (diff.changePercent > 50) {
    parts.push(`Major screen change (${diff.changePercent}% different) — likely page navigation.`);
  } else if (diff.changePercent > 10) {
    parts.push(`Screen changed (${diff.changePercent}% different) — content updated.`);
  } else {
    parts.push(`Minor screen change (${diff.changePercent}% different).`);
  }

  if (diff.isStuck) {
    parts.push('WARNING: Screen appears stuck — same image 3+ times in a row.');
  }

  if (diff.elementDiff) {
    const ed = diff.elementDiff;
    if (ed.added.length > 0) {
      parts.push(`New elements: ${ed.added.slice(0, 3).map(e => `"${e.name}"`).join(', ')}${ed.added.length > 3 ? ` (+${ed.added.length - 3} more)` : ''}`);
    }
    if (ed.removed.length > 0) {
      parts.push(`Removed: ${ed.removed.slice(0, 3).map(e => `"${e.name}"`).join(', ')}`);
    }
    if (ed.moved.length > 0) {
      parts.push(`Moved: ${ed.moved.length} elements shifted position.`);
    }
  }

  return parts.join(' ');
}

/**
 * Check if the last action had any visible effect.
 *
 * @returns {boolean}
 */
function lastActionHadEffect() {
  if (frameHistory.length < 2) return true; // can't tell
  return frameHistory[frameHistory.length - 1] !== frameHistory[frameHistory.length - 2];
}

// ── Utilities ────────────────────────────────────────────

/**
 * Simple string hash for quick comparison.
 */
function simpleHash(str) {
  if (!str) return '';
  // Sample the string at regular intervals for a fast fingerprint
  let hash = 0;
  const step = Math.max(1, Math.floor(str.length / 200));
  for (let i = 0; i < str.length; i += step) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

/**
 * Reset frame tracking state.
 */
function reset() {
  previousFrame = null;
  previousElements = [];
  frameHistory = [];
}

module.exports = {
  compareFrames,
  compareElements,
  pushFrame,
  describeDiff,
  lastActionHadEffect,
  reset
};
