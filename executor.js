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

const robot = require('robotjs');
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

  const start  = robot.getMousePos();
  const points = generatePath(start.x, start.y, targetX, targetY, opts.pathOptions || {});

  for (let i = 0; i < points.length; i++) {
    if (taskSeq !== id) {
      executing = false;
      return { completed: false, cancelled: true, stopped: false, position: robot.getMousePos() };
    }

    const pt = points[i];
    robot.moveMouse(pt.x, pt.y);

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
    robot.mouseClick(button);
    return { ...result, clicked: true };
  }
  return { ...result, clicked: false };
}

/** Scroll by amount (positive = down). */
function executeScroll(amount) {
  robot.scrollMouse(0, amount);
  return { scrolled: true, amount };
}

/** Teleport cursor (no path, instant). */
function moveInstant(x, y) {
  robot.moveMouse(x, y);
  return { x, y };
}

/** Cancel any in-progress movement. */
function stopMovement() {
  taskSeq++;
  executing = false;
  return { stopped: true, position: robot.getMousePos() };
}

/** Current executor state. */
function getStatus() {
  return { executing, cursor: robot.getMousePos() };
}

module.exports = { executeMove, executeClick, executeScroll, moveInstant, stopMovement, getStatus };
