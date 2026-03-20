/**
 * Piggy — Movement Executor
 * Moves the real cursor along a planned path with optional AI supervision.
 *
 * At checkpoint waypoints the executor pauses, captures a screenshot,
 * and waits for the supervisor (AI or human) to approve, stop, or
 * redirect before resuming.
 *
 * @author Idrissi
 * @license MIT
 */

'use strict';

const input = require('./input');
const { generatePath } = require('./path-engine');

let taskSeq    = 0;   // monotonic — bump to cancel current task
let executing  = false;

/**
 * Follow a bezier path from the current cursor position to (targetX, targetY).
 *
 * @param {number} targetX
 * @param {number} targetY
 * @param {object} [opts]
 * @param {function} [opts.onStep]        - (x, y, progress) → update 3D scene
 * @param {function} [opts.onCheckpoint]  - async (screenshot, info) → 'continue'|'stop'|{adjustX,adjustY}
 * @param {function} [opts.captureScreen] - async () → screenshot object
 * @param {object}   [opts.pathOptions]   - forwarded to generatePath
 * @returns {Promise<{completed: boolean, cancelled: boolean, stopped: boolean, position: {x,y}}>}
 */
async function executeMove(targetX, targetY, opts = {}) {
  const id = ++taskSeq;
  executing = true;

  const start  = input.getMousePos();
  const points = generatePath(start.x, start.y, targetX, targetY, opts.pathOptions || {});

  for (let i = 0; i < points.length; i++) {
    if (taskSeq !== id) {
      executing = false;
      return { completed: false, cancelled: true, stopped: false, position: input.getMousePos() };
    }

    const pt = points[i];
    input.moveMouse(pt.x, pt.y);

    if (opts.onStep) opts.onStep(pt.x, pt.y, i / points.length);

    // Supervision checkpoint
    if (pt.isCheckpoint && opts.onCheckpoint && opts.captureScreen) {
      const shot = await opts.captureScreen();
      const decision = await opts.onCheckpoint(shot, {
        progress: i / points.length,
        currentX: pt.x, currentY: pt.y,
        targetX, targetY,
        step: i, totalSteps: points.length
      });

      if (decision === 'stop') {
        executing = false;
        return { completed: false, cancelled: false, stopped: true, position: { x: pt.x, y: pt.y } };
      }
      if (decision && typeof decision === 'object' && decision.adjustX !== undefined) {
        executing = false;
        return executeMove(decision.adjustX, decision.adjustY, opts);
      }
    }

    await new Promise(r => setTimeout(r, pt.delay));
  }

  executing = false;
  return { completed: true, cancelled: false, stopped: false, position: { x: targetX, y: targetY } };
}

/**
 * Move to (x, y) then click.
 */
async function executeClick(x, y, button = 'left', opts = {}) {
  const result = await executeMove(x, y, opts);
  if (result.completed) {
    await new Promise(r => setTimeout(r, 30 + Math.random() * 50));
    input.clickMouse(x, y, button === 'right' ? 1 : 0);
    return { ...result, clicked: true };
  }
  return { ...result, clicked: false };
}

/** Scroll by amount (positive = down). */
function executeScroll(amount) {
  input.scrollMouse(amount);
  return { scrolled: true, amount };
}

/**
 * Type text key-by-key with human-like delays.
 * Each character is a separate keypress — not a paste.
 *
 * @param {string} text - Text to type
 * @param {object} [opts]
 * @param {function} [opts.onKey] - (char, index, total) → update 3D keyboard
 * @returns {Promise<{typed: boolean, text: string, chars: number}>}
 */
async function executeType(text, opts = {}) {
  const id = ++taskSeq;
  executing = true;

  for (let i = 0; i < text.length; i++) {
    if (taskSeq !== id) {
      executing = false;
      return { typed: false, cancelled: true, text: text.slice(0, i), chars: i };
    }

    const char = text[i];
    if (char === '\n') {
      input.keyTap('enter');
    } else if (char === '\t') {
      input.keyTap('tab');
    } else {
      // typeChar handles all characters via CoreGraphics Unicode
      input.typeChar(char);
    }

    if (opts.onKey) opts.onKey(char, i, text.length);

    // Human-like delay: 25-80ms between keys, occasional brief pause
    const pause = Math.random() < 0.08
      ? 100 + Math.random() * 80    // occasional thinking pause
      : 25 + Math.random() * 55;    // fast but natural typing
    await new Promise(r => setTimeout(r, pause));
  }

  executing = false;
  return { typed: true, cancelled: false, text, chars: text.length };
}

/**
 * Press a single key or key combination.
 *
 * @param {string} key - Key name ('enter', 'tab', 'escape', 'backspace', etc.)
 * @param {string[]} [modifiers] - Modifier keys (['command'], ['control', 'shift'], etc.)
 * @param {object} [opts]
 * @param {function} [opts.onKey] - (key) → update 3D keyboard
 * @returns {{pressed: boolean, key: string}}
 */
function executeKeyPress(key, modifiers = [], opts = {}) {
  input.keyTap(key, modifiers);

  if (opts.onKey) opts.onKey(key);

  return { pressed: true, key, modifiers };
}

/** Cancel any in-progress movement. */
function stopMovement() {
  taskSeq++;
  executing = false;
  return { stopped: true, position: input.getMousePos() };
}

/** Current executor state. */
function getStatus() {
  return { executing, cursor: input.getMousePos() };
}

module.exports = { executeMove, executeClick, executeScroll, executeType, executeKeyPress, stopMovement, getStatus };
