/**
 * Piggy — Path Engine
 * Generates human-like mouse movement paths using quadratic bezier curves.
 *
 * @author Idrissi
 * @license MIT
 */

'use strict';

/**
 * Generate a human-like path between two screen coordinates.
 *
 * Uses a quadratic bezier with a perpendicular control point offset
 * for natural arcing motion. Each waypoint includes micro-jitter and
 * ease-in-out timing to replicate imperfect human hand movement.
 *
 * @param {number} startX - Origin X
 * @param {number} startY - Origin Y
 * @param {number} endX   - Destination X
 * @param {number} endY   - Destination Y
 * @param {object} [opts]
 * @param {number} [opts.steps]              - Fixed step count (default: auto from distance)
 * @param {number} [opts.curvature=0.3]      - Arc intensity 0–1
 * @param {number} [opts.jitter=1.5]         - Per-step noise in px
 * @param {number} [opts.checkpointInterval=5] - Supervision screenshot every N steps
 * @returns {Array<{x: number, y: number, delay: number, isCheckpoint: boolean}>}
 */
function generatePath(startX, startY, endX, endY, opts = {}) {
  const dx = endX - startX;
  const dy = endY - startY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  const steps     = opts.steps || Math.max(10, Math.min(50, Math.round(dist / 15)));
  const curvature = opts.curvature ?? 0.3;
  const jitter    = opts.jitter ?? 1.5;
  const cpInterval = opts.checkpointInterval || 5;

  // Perpendicular control-point offset → natural arc
  const perpX   = -dy;
  const perpY   = dx;
  const perpLen = Math.sqrt(perpX * perpX + perpY * perpY) || 1;
  const offset  = dist * curvature * (Math.random() - 0.5) * 2;

  const ctrlX = (startX + endX) / 2 + (perpX / perpLen) * offset;
  const ctrlY = (startY + endY) / 2 + (perpY / perpLen) * offset;

  const points = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;

    // Quadratic bezier: B(t) = (1-t)²·P₀ + 2(1-t)t·P₁ + t²·P₂
    const bx = (1 - t) ** 2 * startX + 2 * (1 - t) * t * ctrlX + t ** 2 * endX;
    const by = (1 - t) ** 2 * startY + 2 * (1 - t) * t * ctrlY + t ** 2 * endY;

    const isEndpoint = i === 0 || i === steps;
    const jx = isEndpoint ? 0 : (Math.random() - 0.5) * jitter * 2;
    const jy = isEndpoint ? 0 : (Math.random() - 0.5) * jitter * 2;

    // Sine ease-in-out: slow edges, fast center
    const delay = 5 + 12 * (1 - Math.sin(t * Math.PI));

    points.push({
      x:  Math.round(bx + jx),
      y:  Math.round(by + jy),
      delay: Math.round(delay + Math.random() * 3),
      isCheckpoint: (!isEndpoint && i % cpInterval === 0)
    });
  }

  return points;
}

/** Sum of all waypoint delays in ms. */
function estimateDuration(path) {
  return path.reduce((sum, p) => sum + p.delay, 0);
}

module.exports = { generatePath, estimateDuration };
