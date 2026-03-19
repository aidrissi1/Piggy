/**
 * Piggy — AI Controller
 * Vision-based autonomous loop: screenshot → model → action → repeat.
 *
 * Connects any OpenAI-compatible vision model to the executor.
 * The model sees the screen, decides what to do, and Piggy does it.
 *
 * @author Idrissi
 * @license MIT
 */

'use strict';

const OpenAI = require('openai');
const { executeMove, executeClick, executeScroll } = require('./executor');

let client      = null;
let running     = false;
let currentTask = null;

const SYSTEM_PROMPT = `You are an AI agent controlling a computer mouse. You see screenshots of the full screen.

Respond with EXACTLY one JSON object per turn — no markdown, no explanation.

Available actions:
  {"action":"move","x":500,"y":300}
  {"action":"click","x":500,"y":300}
  {"action":"right_click","x":500,"y":300}
  {"action":"scroll","direction":"down","amount":3}
  {"action":"done","reason":"task completed"}
  {"action":"fail","reason":"description"}

Rules:
- Coordinates are screen pixels (0,0 = top-left).
- Identify UI elements visually before acting.
- One action per response. After each action you will receive a new screenshot.
- If an action had no visible effect, try an alternative approach.
- Respond with ONLY valid JSON.`;

/** Point the controller at an OpenAI-compatible API. */
function init(apiKey) {
  client = new OpenAI({ apiKey });
}

/**
 * Send a screenshot to the model and get one action back.
 * @private
 */
async function askModel(base64, ctx) {
  const userText = [
    `Task: ${ctx.task}`,
    `Screen: ${ctx.screenW}x${ctx.screenH}`,
    `Cursor: (${ctx.cursorX}, ${ctx.cursorY})`,
    `Step: ${ctx.step}/${ctx.maxSteps}`
  ].join('\n');

  const res = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 200,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: 'high' } }
        ]
      }
    ]
  });

  const raw = res.choices[0]?.message?.content?.trim();
  const match = raw?.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);

  return { action: 'fail', reason: `Unparseable model output: ${raw?.slice(0, 120)}` };
}

/**
 * Run the full autonomous loop for a given task.
 *
 * @param {string} task - Natural-language instruction
 * @param {object} opts
 * @param {function} opts.captureScreen - async () → {base64, width, height}
 * @param {function} opts.getCursorPos  - () → {x, y}
 * @param {function} [opts.onStep]      - (info) → UI status updates
 * @param {function} [opts.onMouseMove] - (x, y, progress) → 3D visualisation
 * @param {number}   [opts.maxSteps=15]
 * @returns {Promise<{success: boolean, steps: number, reason: string}>}
 */
async function runTask(task, opts = {}) {
  if (!client) return { success: false, reason: 'No API key configured.' };

  running     = true;
  currentTask = task;
  const max   = opts.maxSteps || 15;

  for (let step = 1; step <= max; step++) {
    if (!running) return { success: false, steps: step, reason: 'Stopped by user' };

    // 1 — observe
    const shot   = await opts.captureScreen();
    const cursor = opts.getCursorPos();

    if (opts.onStep) opts.onStep({ step, maxSteps: max, status: 'thinking', task });

    // 2 — decide
    let action;
    try {
      action = await askModel(shot.base64, {
        task, screenW: shot.width, screenH: shot.height,
        cursorX: cursor.x, cursorY: cursor.y, step, maxSteps: max
      });
    } catch (err) {
      if (opts.onStep) opts.onStep({ step, maxSteps: max, status: 'error', error: err.message });
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    if (opts.onStep) opts.onStep({ step, maxSteps: max, status: 'acting', action });

    // 3 — act
    const moveCb = { onStep: (x, y, p) => { if (opts.onMouseMove) opts.onMouseMove(x, y, p); } };

    switch (action.action) {
      case 'done':
        running = false;
        if (opts.onStep) opts.onStep({ step, maxSteps: max, status: 'done', reason: action.reason });
        return { success: true, steps: step, reason: action.reason };

      case 'fail':
        running = false;
        if (opts.onStep) opts.onStep({ step, maxSteps: max, status: 'failed', reason: action.reason });
        return { success: false, steps: step, reason: action.reason };

      case 'move':
        await executeMove(action.x, action.y, moveCb);
        break;

      case 'click':
      case 'right_click':
        await executeClick(action.x, action.y, action.action === 'right_click' ? 'right' : 'left', moveCb);
        break;

      case 'scroll':
        executeScroll(action.direction === 'up' ? -(action.amount || 3) : (action.amount || 3));
        break;
    }

    // 4 — let the screen settle before next observation
    await new Promise(r => setTimeout(r, 800));
  }

  running = false;
  return { success: false, steps: max, reason: 'Step limit reached' };
}

function stop()    { running = false; currentTask = null; }
function status()  { return { running, task: currentTask }; }

module.exports = { init, runTask, stop, status };
