/**
 * Piggy — AI Controller
 * Vision-based autonomous loop with conversation history.
 *
 * Each step's screenshot and decision are kept in a messages array
 * so the model remembers what it already tried during the current task.
 * History clears when the task completes or is stopped.
 *
 * @author Idrissi
 * @license MIT
 */

'use strict';

const { executeMove, executeClick, executeScroll, executeType, executeKeyPress } = require('./executor');
const { autoDetect, createProvider } = require('./model-provider');
const skills = require('./skills');

/** Detect potentially destructive actions that need user approval. */
function isDangerous(action) {
  if (!action) return false;
  // Dangerous shortcuts: Cmd+Q (quit), Cmd+W (close), Cmd+Delete, etc.
  if (action.action === 'shortcut') {
    const key = action.key?.toLowerCase();
    const mods = (action.modifiers || []).map(m => m.toLowerCase());
    if (mods.includes('command') && ['q', 'w', 'delete', 'backspace'].includes(key)) return true;
    if (mods.includes('command') && mods.includes('shift') && key === 'delete') return true;
  }
  // Typing passwords or sensitive content (model shouldn't, but guard)
  if (action.action === 'type' && action.text?.match(/password|secret|token|key/i)) return true;
  return false;
}

function describeDanger(action) {
  if (action.action === 'shortcut') {
    const combo = [...(action.modifiers || []), action.key].join('+');
    return `Keyboard shortcut: ${combo} (may close/quit apps or delete data)`;
  }
  if (action.action === 'type') return `Type text containing sensitive keywords`;
  return `Action: ${action.action}`;
}

let provider    = null;
let running     = false;
let currentTask = null;
let history     = [];

const SYSTEM_PROMPT = `You are an AI agent controlling a computer. You can see screenshots, move the mouse, click, type, press keys, and focus apps.

Respond with valid JSON only — no markdown, no explanation.

You can respond with a SINGLE action:
  {"action":"focus","app":"Brave Browser"}
  {"action":"find","name":"Search"}
  {"action":"click","x":500,"y":300}
  {"action":"type","text":"hello"}
  {"action":"key","key":"enter"}
  {"action":"shortcut","key":"t","modifiers":["command"]}
  {"action":"scroll","direction":"down","amount":3}
  {"action":"move","x":500,"y":300}
  {"action":"right_click","x":500,"y":300}
  {"action":"done","reason":"task completed"}
  {"action":"fail","reason":"description"}

Or a BATCH of actions when you can see everything needed (e.g. filling a form):
  {"actions":[
    {"action":"click","x":500,"y":200},
    {"action":"type","text":"Ahmed"},
    {"action":"key","key":"tab"},
    {"action":"type","text":"ahmed@email.com"},
    {"action":"key","key":"enter"}
  ]}

Rules:
- Use "find" to locate UI elements by name — returns exact coordinates. Use this instead of guessing.
- Use SINGLE action when you need to see the result before deciding next step.
- Use BATCH when all targets are visible and you can plan the full sequence.
- ALWAYS focus the target app before interacting with it.
- Coordinates are screen pixels (0,0 = top-left).
- To type in a field: click it first, then type.
- Key names: enter, tab, escape, backspace, delete, space, up, down, left, right.
- Modifier names: command, control, shift, alt.
- After a batch, you will receive a new screenshot to verify the result.
- If something didn't work, try a different approach.
- Look at your previous steps to avoid repeating failed actions.`;

/** Initialize with explicit provider, or auto-detect from env. */
function init(providerName, apiKey) {
  if (providerName && apiKey) {
    provider = createProvider(providerName, apiKey);
  } else {
    provider = autoDetect();
  }
  if (provider) console.log(`[Piggy AI] Using ${provider.name} (${provider.model})`);
}

/**
 * Send screenshot + full conversation history to the model.
 * The model sees everything it did so far in this task.
 */
async function askModel(base64, ctx) {
  const stepInfo = [
    `Task: ${ctx.task}`,
    `Screen: ${ctx.screenW}x${ctx.screenH}`,
    `Cursor: (${ctx.cursorX}, ${ctx.cursorY})`,
    `Step: ${ctx.step}/${ctx.maxSteps}`,
    ctx.apps?.length ? `Running apps: ${ctx.apps.join(', ')}` : '',
    ctx.uiElements ? `UI elements:\n${ctx.uiElements}` : ''
  ].filter(Boolean).join('\n');

  // Build full prompt with skills
  const fullPrompt = SYSTEM_PROMPT + skills.getSkillsPrompt();

  // Ask the model via the provider abstraction
  const raw = await provider.ask(fullPrompt, history, base64, stepInfo, 500);
  const match = raw?.match(/\{[\s\S]*\}/);

  // Save exchange to history WITH a tiny screenshot so model sees what happened
  history.push({
    role: 'user',
    content: [
      { type: 'text', text: `Step ${ctx.step}: ${stepInfo}` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${ctx.smallBase64 || ''}`, detail: 'low' } }
    ]
  });
  history.push({ role: 'assistant', content: raw || '{}' });

  // Keep last 10 exchanges (20 messages) to stay within token limits
  if (history.length > 20) {
    history = history.slice(-16);
  }

  if (match) {
    let obj;
    try { obj = JSON.parse(match[0]); } catch { obj = null; }

    if (!obj || typeof obj !== 'object') {
      return { parsed: [{ action: 'fail', reason: 'Invalid JSON from model' }], raw, isBatch: false };
    }

    // Batch: validate it's actually an array of objects with 'action' field
    if (obj.actions && Array.isArray(obj.actions)) {
      const valid = obj.actions.filter(a => a && typeof a === 'object' && typeof a.action === 'string');
      if (valid.length === 0) {
        return { parsed: [{ action: 'fail', reason: 'Empty or invalid batch' }], raw, isBatch: false };
      }
      return { parsed: valid, raw, isBatch: true };
    }

    // Single action: validate it has an 'action' field
    if (typeof obj.action !== 'string') {
      return { parsed: [{ action: 'fail', reason: 'Missing action field in response' }], raw, isBatch: false };
    }
    return { parsed: [obj], raw, isBatch: false };
  }
  return { parsed: [{ action: 'fail', reason: `Unparseable: ${raw?.slice(0, 100)}` }], raw, isBatch: false };
}

/**
 * Run the autonomous loop.
 */
async function runTask(task, opts = {}) {
  if (!provider) return { success: false, reason: 'No AI provider configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY in .env' };

  running     = true;
  currentTask = task;
  history     = []; // fresh history for each task
  const max   = opts.maxSteps || 15;

  for (let step = 1; step <= max; step++) {
    if (!running) return { success: false, steps: step, reason: 'Stopped by user' };

    // 1 — observe
    const shot   = await opts.captureScreen();
    const cursor = opts.getCursorPos();

    if (opts.onStep) opts.onStep({
      step, maxSteps: max, status: 'thinking', task,
      screenshot: shot.smallBase64
    });

    // 2 — decide (with full history)
    let action, raw;
    try {
      // Get UI elements for accessibility context
      const uiElements = opts.getUISummary ? opts.getUISummary() : '';

      const result = await askModel(shot.base64, {
        task, screenW: shot.width, screenH: shot.height,
        cursorX: cursor.x, cursorY: cursor.y, step, maxSteps: max,
        apps: opts.apps || [],
        smallBase64: shot.smallBase64,
        uiElements
      });
      action = result.parsed;
      raw = result.raw;
    } catch (err) {
      if (opts.onStep) opts.onStep({ step, maxSteps: max, status: 'error', error: err.message });
      history.push({ role: 'user', content: `Step ${step}: API error — ${err.message}` });
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    // 3 — execute actions (single or batch)
    const actions = result.parsed; // always an array now
    const moveCb = { onStep: (x, y, p) => { if (opts.onMouseMove) opts.onMouseMove(x, y, p); } };

    if (opts.onStep) opts.onStep({
      step, maxSteps: max, status: 'acting',
      action: actions.length === 1 ? actions[0] : { action: 'batch', count: actions.length, actions },
      raw,
      screenshot: shot.smallBase64
    });

    for (let ai = 0; ai < actions.length; ai++) {
      if (!running) break;
      const action = actions[ai];

      // Security: check for destructive actions
      if (opts.confirmAction && isDangerous(action)) {
        const { approved } = await opts.confirmAction(action, describeDanger(action));
        if (!approved) {
          if (opts.onStep) opts.onStep({ step, maxSteps: max, status: 'blocked', reason: 'User denied action' });
          continue; // skip this action, don't stop the whole task
        }
      }

      switch (action.action) {
        case 'find':
          if (opts.findElement) {
            const found = await opts.findElement(action.name);
            if (found.success && found.element) {
              // Auto-click the found element
              await executeClick(found.element.centerX, found.element.centerY, 'left', moveCb);
            }
          }
          break;

        case 'skill':
          await skills.execute(action.skill, action.method, action);
          break;

        case 'done':
          running = false;
          if (opts.onStep) opts.onStep({ step, maxSteps: max, status: 'done', reason: action.reason });
          return { success: true, steps: step, reason: action.reason, history: getHistory() };

        case 'fail':
          running = false;
          if (opts.onStep) opts.onStep({ step, maxSteps: max, status: 'failed', reason: action.reason });
          return { success: false, steps: step, reason: action.reason, history: getHistory() };

        case 'focus':
          if (opts.focusApp) await opts.focusApp(action.app);
          break;

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

        case 'type':
          await executeType(action.text || '', {
            onKey: (char, i, total) => { if (opts.onKeyPress) opts.onKeyPress(char, i, total); }
          });
          break;

        case 'key':
          executeKeyPress(action.key, [], {
            onKey: (k) => { if (opts.onKeyPress) opts.onKeyPress(k, 0, 1); }
          });
          break;

        case 'shortcut':
          executeKeyPress(action.key, action.modifiers || [], {
            onKey: (k) => { if (opts.onKeyPress) opts.onKeyPress(k, 0, 1); }
          });
          break;
      }

      // Brief pause between batch actions
      if (ai < actions.length - 1) {
        await new Promise(r => setTimeout(r, 150));
      }
    }

    // 4 — let screen settle after action(s)
    await new Promise(r => setTimeout(r, 800));
  }

  running = false;
  return { success: false, steps: max, reason: 'Step limit reached', history: getHistory() };
}

function stop() {
  running = false;
  currentTask = null;
}

function getHistory() {
  return history.map(h => ({ role: h.role, content: typeof h.content === 'string' ? h.content : '[image]' }));
}

function clearHistory() {
  history = [];
}

function status() {
  return { running, task: currentTask, historyLength: history.length };
}

module.exports = { init, runTask, stop, status, getHistory, clearHistory };
