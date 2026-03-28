/**
 * Piggy — AI Controller (Production)
 * Vision-based autonomous loop with full module integration.
 *
 * Wired modules:
 *   - security.js       — action classification, rate limiting, audit
 *   - screen-diff.js    — screenshot comparison, stuck detection
 *   - error-recovery.js — state snapshots, rollback, recovery strategies
 *   - self-verify.js    — post-action verification
 *   - context-manager.js— intelligent history pruning
 *   - model-router.js   — cost-based model tier routing
 *   - skill-library.js  — learned behavior persistence
 *   - memory-engine     — persistent skills, reflections, recall
 *
 * @author Idrissi
 * @license MIT
 */

'use strict';

const path = require('path');
const { autoDetect, createProvider } = require('./model-provider');
const skills = require('./skills');
const vision = require('./vision');
const intentParser = require('./intent-parser');
const serpApi = require('./serp-api');
const cdp = require('./cdp-adapter');
const security = require('./security');
const contextManager = require('./context-manager');
const modelRouter = require('./model-router');
const errorRecovery = require('./error-recovery');
const selfVerify = require('./self-verify');
const screenDiff = require('./screen-diff');
const skillLibrary = require('./skill-library');
let memoryAdapter;
try { memoryAdapter = require('memory-engine/adapters/piggy'); } catch { memoryAdapter = null; }

// ── State ───────────────────────────────────────────────

let provider    = null;
let running     = false;
let currentTask = null;
let history     = [];
let chatHistory = [];
let memoryReady = false;
let ctxMgr      = null; // context manager instance

// ── System Prompt ───────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You control a macOS computer. You receive a TEXT LIST of interactive elements on screen (not a screenshot by default).

Use the tools provided to interact with the computer. ONE tool call per step.

ELEMENT LIST: Each step you receive numbered elements visible on screen. Use the EXACT element name when clicking.

TOOLS:
- focus_app — open/bring an app to front (Safari, Brave Browser, Terminal, etc.)
- click_element — click a button, link, or interactive element by name
- click_and_type — click an input field and type text into it
- press_key — press a key (enter, tab, escape, etc.)
- keyboard_shortcut — key combo (e.g. command+l for address bar)
- scroll_page — scroll up or down
- read_page — extract all text content from the current page
- navigate_to — go directly to a URL in the browser
- web_search — search the web instantly via SerpApi (returns results without navigating)
- recall_memory — search your past experience and learned skills for similar tasks
- take_screenshot — capture the screen (use only when you need visual confirmation)
- task_complete — finish with a report of your findings
- task_failed — declare failure with reason

BROWSERS: You can control Safari (via AppleScript) and Brave Browser / Chrome (via CDP).
- Use focus_app with "Brave Browser" or "Safari" to switch browsers
- navigate_to works in whichever browser is focused
- web_search returns results directly — use it for quick lookups instead of navigating to Google

WORKFLOW:
1. focus_app to open/focus the target app
2. Use recall_memory if you've done a similar task before
3. Use web_search for quick information lookups
4. Use navigate_to for direct URL navigation (faster than clicking address bar)
5. click_and_type for search bars/input fields
6. press_key "enter" to submit forms/searches
7. click_element to click results, links, buttons
8. read_page to extract information from pages
9. task_complete with your findings in the report field

RULES:
- Use element names from the list — match the beginning of the name if it's long
- Use navigate_to instead of clicking the address bar
- If element not found after 2 tries, try keyboard_shortcut or navigate_to
- Only use take_screenshot if the element list is empty or confusing
- Always read_page before task_complete if the user asked for information
- Be efficient — don't repeat failed actions
- If you notice you're stuck (same result twice), try a completely different approach`;


// ── Init ────────────────────────────────────────────────

function init(providerName, apiKey) {
  if (providerName && apiKey) {
    provider = createProvider(providerName, apiKey);
  } else {
    provider = autoDetect();
  }
  if (provider) console.log(`[Piggy AI] Using ${provider.name} (${provider.model})`);

  // Memory engine
  if (memoryAdapter) {
    try {
      const dbPath = path.join(__dirname, 'piggy-memory.db');
      memoryAdapter.init(dbPath);
      memoryReady = true;
      console.log('[Piggy AI] Memory engine initialized');
    } catch (err) {
      memoryReady = false;
      console.warn('[Piggy AI] Memory engine failed to init:', err.message);
    }
  }

  // Context manager — smarter than raw history slicing
  ctxMgr = contextManager.create({ maxMessages: 40, maxTokens: 30000, keepRecent: 10 });

  // Skill library — learned behaviors from past tasks
  try {
    skillLibrary.init(path.join(__dirname, 'skills-learned'));
    console.log(`[Piggy AI] Skill library: ${skillLibrary.count()} skills loaded`);
  } catch (err) {
    console.warn('[Piggy AI] Skill library init failed:', err.message);
  }

  // Security defaults
  security.configure({ autoApprove: false, maxActionsPerMinute: 60, maxActionsPerTask: 200 });

  // Vision scanner worker
  vision.start();
}

// ── Build System Prompt ─────────────────────────────────

function buildSystemPrompt(memCtx) {
  let prompt = BASE_SYSTEM_PROMPT + skills.getSkillsPrompt();

  if (memoryReady && memCtx) {
    if (memCtx.profile) prompt += '\n\n' + memCtx.profile;
    if (memCtx.taskContext) prompt += '\n\n' + memCtx.taskContext;
  }

  return prompt;
}

// ── Ask Model ───────────────────────────────────────────

async function askModel(ctx) {
  const parts = [
    `Task: ${ctx.task}`,
    `Step: ${ctx.step}/${ctx.maxSteps}`,
    ctx.app ? `Focused app: ${ctx.app}` : '',
    ctx.apps?.length ? `Running apps: ${ctx.apps.join(', ')}` : '',
    ctx.elementMap || 'No interactive elements detected on screen.',
    ctx.pageText ? `\nPAGE TEXT (first 2000 chars):\n${ctx.pageText.substring(0, 2000)}` : '',
    ctx.screenshotNote || '',
    ctx.extraContext ? `\n${ctx.extraContext}` : ''
  ];

  const stepInfo = parts.filter(Boolean).join('\n');
  const screenshot = ctx.screenshot || null;

  let toolResult;
  if (provider.askWithTools) {
    toolResult = await provider.askWithTools(ctx.systemPrompt, history, screenshot, stepInfo, 500);
  } else {
    const raw = await provider.ask(ctx.systemPrompt, history, screenshot, stepInfo, 300);
    toolResult = { tool: null, input: {}, raw: raw || '' };
  }

  // Context manager tracks history with smart pruning
  ctxMgr.addMessage('user', `Step ${ctx.step}: ${stepInfo}`);
  ctxMgr.addMessage('assistant', toolResult.raw || '');

  // Also keep raw history for the API (context manager for pruning decisions)
  history.push({ role: 'user', content: `Step ${ctx.step}: ${stepInfo}` });
  history.push({ role: 'assistant', content: toolResult.raw || '' });
  if (history.length > 30) history = history.slice(-20);

  const action = toolCallToAction(toolResult, ctx.currentElements || []);
  console.log(`[Piggy AI] Tool: ${toolResult.tool || 'none'} → ${action.action}${action._matched ? ' ("' + action._matched + '")' : ''}${action.text ? ' text="' + action.text.substring(0, 30) + '"' : ''}`);

  return { parsed: [action], raw: toolResult.raw };
}

// ── Tool Call → Action ──────────────────────────────────

function toolCallToAction(toolResult, elements) {
  const { tool, input } = toolResult;
  if (!tool) return { action: 'wait' };

  const findElement = (name) => {
    return intentParser.findBestMatch((name || '').toLowerCase(), elements);
  };

  switch (tool) {
    case 'click_element': {
      const el = findElement(input.element_name);
      if (el) return { action: 'click', x: el.cx, y: el.cy, _matched: el.name };
      return { action: 'click', _matched: input.element_name, _notFound: true };
    }

    case 'click_and_type': {
      const el = findElement(input.element_name);
      if (el) return { action: 'click_type', x: el.cx, y: el.cy, text: input.text, _matched: el.name };
      return { action: 'click_type', text: input.text, _matched: input.element_name, _notFound: true };
    }

    case 'press_key':
      return { action: 'key', key: input.key };

    case 'scroll_page':
      return { action: 'scroll', direction: input.direction, amount: 3 };

    case 'focus_app':
      return { action: 'focus', app: input.app_name };

    case 'read_page':
      return { action: 'read' };

    case 'keyboard_shortcut':
      return { action: 'shortcut', key: input.key, modifiers: input.modifiers || [] };

    case 'task_complete':
      return { action: 'done', reason: input.reason, report: input.report || '' };

    case 'task_failed':
      return { action: 'fail', reason: input.reason };

    case 'take_screenshot':
      return { action: 'screenshot' };

    case 'navigate_to':
      return { action: 'navigate', url: input.url };

    case 'web_search':
      return { action: 'web_search', query: input.query, num: input.num_results || 5 };

    case 'recall_memory':
      return { action: 'recall', query: input.query };

    default:
      return { action: 'wait' };
  }
}

// ── Main Loop ───────────────────────────────────────────

async function runTask(task, opts = {}) {
  if (!provider) return { success: false, reason: 'No AI provider configured.' };

  running = true;
  currentTask = task;
  history = [];
  ctxMgr.clear();
  vision.invalidate();
  vision.clearPageCache();
  const max = opts.maxSteps || 25;

  // ── Pre-task: initialize all modules ──
  security.taskStart();
  modelRouter.resetTask();
  screenDiff.reset();
  errorRecovery.reset();

  // Memory
  let memCtx = null;
  if (memoryReady) {
    try {
      memCtx = memoryAdapter.beforeTask(task, { app: opts.apps?.[0] || null });
      console.log(`[Piggy Memory] Session ${memCtx.sessionId} started`);
    } catch (err) { console.warn('[Piggy Memory]', err.message); }
  }

  // Check skill library for matching learned skill
  const matchedSkill = skillLibrary.match(task);
  if (matchedSkill) {
    console.log(`[Piggy Skills] Matched skill: "${matchedSkill.name}" (${Math.round(matchedSkill.confidence * 100)}%)`);
  }

  const systemPrompt = buildSystemPrompt(memCtx);
  let allActions = [];
  let extraContext = '';
  let currentElements = [];
  let focusedApp = null;
  let notFoundCount = 0;
  let needsScreenshot = false;
  let consecutiveFailures = 0;

  // Detect app from task
  const taskLower = task.toLowerCase();
  if (opts.apps) {
    for (const app of opts.apps) {
      if (taskLower.includes(app.toLowerCase())) { focusedApp = app; break; }
    }
  }
  if (!focusedApp) {
    if (taskLower.includes('brave')) focusedApp = 'Brave Browser';
    else if (taskLower.includes('chrome')) focusedApp = 'Google Chrome';
    else if (taskLower.includes('safari')) focusedApp = 'Safari';
  }

  // ── Step Loop ──
  for (let step = 1; step <= max; step++) {
    if (!running) break;

    // ── 1. Focus app (first step) ──
    if (step === 1 && focusedApp && opts.focusApp) {
      console.log(`[Piggy AI] Auto-focusing: ${focusedApp}`);
      await opts.focusApp(focusedApp);
      await new Promise(r => setTimeout(r, 1000));
    }

    // ── 2. Vision scan ──
    let elementMap = '';
    let screenshotBase64 = null;
    let screenshotNote = '';

    if (focusedApp) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const scan = await vision.scan(focusedApp, attempt > 0);
          currentElements = scan.elements;
          if (scan.count > 0) {
            elementMap = scan.map;
            console.log(`[Piggy Vision] ${scan.count} elements`);
            break;
          }
          if (attempt < 2) {
            console.log(`[Piggy Vision] 0 elements, retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
          }
        } catch (err) {
          console.warn(`[Piggy Vision] Scan error: ${err.message}`);
          break;
        }
      }
    }

    // ── 3. Screenshot (first step or on request) ──
    if (step === 1 || needsScreenshot) {
      try {
        const shot = await opts.captureScreen();
        screenshotBase64 = shot.base64;
        screenshotNote = '[Screenshot attached — you can see the current screen state]';
        needsScreenshot = false;
      } catch (err) {
        screenshotNote = '[Screenshot failed — rely on element list]';
      }
    }

    if (opts.onStep) opts.onStep({ step, maxSteps: max, status: 'thinking', task });

    // ── 4. Ask model ──
    let actions, raw;
    try {
      const result = await askModel({
        task, step, maxSteps: max,
        apps: opts.apps || [],
        screenshot: screenshotBase64,
        screenshotNote,
        elementMap, currentElements,
        app: focusedApp,
        systemPrompt, extraContext
      });
      actions = result.parsed;
      raw = result.raw;
      extraContext = '';
    } catch (err) {
      console.warn(`[Piggy AI] Model error: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    console.log(`[Piggy AI] Step ${step}: [${actions.map(a => a.action).join(', ')}]`);
    if (opts.onStep) opts.onStep({ step, maxSteps: max, status: 'acting', raw });

    // ── 5. Execute actions ──
    for (const action of actions) {
      if (!running) break;
      allActions.push(action);

      // ── PRE-ACTION: Security check ──
      const secCheck = security.check(action);
      if (!secCheck.allowed && !secCheck.needsConfirmation) {
        security.audit('blocked', action, secCheck.reason);
        extraContext = `ACTION BLOCKED by security: ${secCheck.reason}. Try a different approach.`;
        console.log(`[Piggy Security] Blocked: ${action.action} — ${secCheck.reason}`);
        continue;
      }
      if (secCheck.needsConfirmation && opts.confirmAction) {
        const { approved } = await opts.confirmAction(action, secCheck.reason);
        if (!approved) {
          security.audit('denied', action, 'User denied');
          extraContext = `Action denied by user. Try a different approach.`;
          continue;
        }
      }
      security.audit('allowed', action);

      // ── PRE-ACTION: Rate limit check ──
      const rateCheck = security.checkRateLimit();
      if (!rateCheck.allowed) {
        console.warn(`[Piggy Security] Rate limited: ${rateCheck.reason}`);
        await new Promise(r => setTimeout(r, 2000));
      }

      // ── PRE-ACTION: Save state for error recovery ──
      errorRecovery.saveState({ elements: currentElements, step, app: focusedApp });

      // ── PRE-ACTION: Memory — classify and store action ──
      if (memoryReady && memCtx) {
        try {
          const memResult = memoryAdapter.afterStep(memCtx.sessionId, action, step);
          // If recall action, inject results
          if (memResult.isRecall && memResult.recallResult) {
            extraContext = memResult.recallResult;
          }
          // If context loss detected, inject warnings
          if (memResult.contextBoost) {
            extraContext += (extraContext ? '\n' : '') + memResult.contextBoost;
          }
        } catch (err) { console.warn('[Piggy Memory] afterStep:', err.message); }
      }

      // ── EXECUTE ACTION ──
      let actionSuccess = true;
      let actionDetail = '';

      switch (action.action) {
        case '_narration': {
          extraContext = 'WRONG FORMAT. Do NOT explain what you see. Call a tool instead.';
          console.log(`[Piggy AI] Correcting model — narration rejected`);
          break;
        }

        case 'done': {
          running = false;
          const report = action.report || action.reason || '';
          console.log(`[Piggy] Task complete. Reason: ${(action.reason || '').substring(0, 80)}`);
          if (report) console.log(`[Piggy] Report: ${report.substring(0, 200)}`);
          if (opts.onStep) opts.onStep({ step, maxSteps: max, status: 'done', reason: action.reason, report });
          return await finishTask(memCtx, 'success', step, allActions, focusedApp, opts);
        }

        case 'fail': {
          running = false;
          if (opts.onStep) opts.onStep({ step, maxSteps: max, status: 'failed', reason: action.reason });
          return await finishTask(memCtx, 'failure', step, allActions, focusedApp, opts);
        }

        case 'focus': {
          focusedApp = action.app;
          if (opts.focusApp) {
            console.log(`[Piggy] Focusing: ${action.app}`);
            await opts.focusApp(action.app);
            await new Promise(r => setTimeout(r, 800));
          }
          actionDetail = `Focused ${action.app}`;
          vision.invalidate();
          break;
        }

        case 'navigate': {
          if (action.url) {
            const cleanURL = action.url.replace(/[}"'\]>\s]+$/, '').trim();
            console.log(`[Piggy] Navigating to: ${cleanURL}`);
            if (vision.isCDPBrowser(focusedApp)) {
              try {
                if (!cdp.isConnected()) await cdp.connect();
                await cdp.navigateTo(cleanURL);
                actionDetail = `Navigated to ${cleanURL}`;
              } catch (err) {
                console.warn(`[Piggy] CDP navigate failed: ${err.message}`);
                actionSuccess = false;
                actionDetail = `Navigate failed: ${err.message}`;
                if (opts.navigateBrowser) await opts.navigateBrowser(cleanURL, focusedApp);
              }
            } else {
              const reader = require('./page-reader');
              await reader.navigateSafari(cleanURL);
              actionDetail = `Navigated to ${cleanURL}`;
            }
            await new Promise(r => setTimeout(r, 2000));
            vision.invalidate();

            // Verify navigation
            const navVerify = selfVerify.verifyNavigation({ expectedURL: cleanURL, elements: currentElements });
            if (!navVerify.verified && navVerify.confidence < 0.3) {
              extraContext += `\nNAV WARNING: ${navVerify.reason}`;
            }
          }
          break;
        }

        case 'read': {
          try {
            const pageData = await vision.readPage(focusedApp);
            if (pageData.success) {
              extraContext = `PAGE CONTENT from "${pageData.title}":\nURL: ${pageData.url}\n\n${pageData.text}`;
              actionDetail = `Read page: "${pageData.title}" (${pageData.wordCount} words)`;
              console.log(`[Piggy] ${actionDetail}`);
            } else {
              extraContext = 'PAGE READ FAILED — try again.';
              actionSuccess = false;
              actionDetail = 'Page read failed';
            }
          } catch (err) {
            extraContext = 'PAGE READ FAILED: ' + err.message;
            actionSuccess = false;
            actionDetail = err.message;
          }
          break;
        }

        case 'wait': {
          console.log('[Piggy] Waiting for page...');
          await new Promise(r => setTimeout(r, 2000));
          actionDetail = 'Waited for page load';
          vision.invalidate();
          break;
        }

        case 'click':
        case 'click_type':
        case 'right_click': {
          if (action._notFound) {
            notFoundCount++;
            actionSuccess = false;
            actionDetail = `Element "${action._matched}" not found`;
            console.log(`[Piggy] Element "${action._matched}" not found (${notFoundCount}x)`);

            if (notFoundCount >= 2 && action.text) {
              console.log(`[Piggy] Auto-using Cmd+L to type "${action.text}"`);
              if (opts.executeKey) opts.executeKey('l', ['command']);
              await new Promise(r => setTimeout(r, 500));
              if (opts.executeType) await opts.executeType(action.text);
              if (opts.executeKey) opts.executeKey('enter', []);
              await new Promise(r => setTimeout(r, 2000));
              vision.invalidate();
              notFoundCount = 0;
              actionSuccess = true;
              actionDetail = `Used Cmd+L fallback to type "${action.text}"`;
              break;
            }

            // Error recovery suggestion
            const recovery = errorRecovery.suggestRecovery(action, 'element_not_found', {
              elements: currentElements, retryCount: notFoundCount, step
            });
            const available = currentElements.slice(0, 8).map(e => `"${e.name}"`).join(', ');
            extraContext = `Element "${action._matched}" NOT found. Available: ${available}. Suggestion: ${recovery.description || 'try keyboard_shortcut command+l'}`;
            break;
          }
          notFoundCount = 0;
          if (action.x !== undefined && action.y !== undefined) {
            if (opts.executeClick) {
              await opts.executeClick(action.x, action.y, action.action === 'right_click' ? 'right' : 'left');
              actionDetail = `Clicked "${action._matched || 'element'}" at (${action.x}, ${action.y})`;
              console.log(`[Piggy] Clicked (${action.x}, ${action.y})${action._matched ? ' → "' + action._matched + '"' : ''}`);
              await new Promise(r => setTimeout(r, action.action === 'click' ? 1000 : 400));
            }
            if (action.action === 'click_type' && action.text && opts.executeType) {
              await new Promise(r => setTimeout(r, 300));
              await opts.executeType(action.text);
              actionDetail = `Clicked "${action._matched}" and typed "${action.text.substring(0, 30)}"`;
              console.log(`[Piggy] Typed "${action.text.substring(0, 30)}"`);
            }
            vision.invalidate();
          } else {
            actionSuccess = false;
            actionDetail = 'Click without coordinates';
            console.warn(`[Piggy] Click without coordinates`);
            extraContext = `Could not find the element. Available: ${currentElements.slice(0, 5).map(e => '"' + e.name + '"').join(', ')}`;
          }
          break;
        }

        case 'type': {
          if (action.text && opts.executeType) {
            await opts.executeType(action.text);
            actionDetail = `Typed "${action.text.substring(0, 40)}"`;
            console.log(`[Piggy] Typed "${action.text.substring(0, 30)}"`);
          }
          break;
        }

        case 'key': {
          if (action.key && opts.executeKey) {
            opts.executeKey(action.key, []);
            actionDetail = `Pressed ${action.key}`;
            console.log(`[Piggy] Pressed ${action.key}`);
            if (action.key === 'enter') {
              await new Promise(r => setTimeout(r, 2000));
              vision.invalidate();
            } else {
              await new Promise(r => setTimeout(r, 200));
            }
          }
          break;
        }

        case 'shortcut': {
          if (action.key && opts.executeKey) {
            opts.executeKey(action.key, action.modifiers || []);
            actionDetail = `Shortcut ${[...(action.modifiers || []), action.key].join('+')}`;
            console.log(`[Piggy] Shortcut: ${actionDetail}`);
            await new Promise(r => setTimeout(r, 500));
            vision.invalidate();
          }
          break;
        }

        case 'scroll': {
          if (opts.executeScroll) {
            opts.executeScroll(action.direction === 'up' ? -3 : 3);
            actionDetail = `Scrolled ${action.direction || 'down'}`;
            console.log(`[Piggy] Scrolled ${action.direction || 'down'}`);
            await new Promise(r => setTimeout(r, 500));
            vision.invalidate();
          }
          break;
        }

        case 'screenshot': {
          needsScreenshot = true;
          actionDetail = 'Screenshot requested';
          console.log(`[Piggy] Screenshot requested — will capture next step`);
          break;
        }

        case 'web_search': {
          if (action.query) {
            console.log(`[Piggy] Web search: "${action.query}"`);
            try {
              const results = await serpApi.search(action.query, { num: action.num || 5 });
              extraContext = serpApi.formatForPrompt(results);
              actionDetail = `Search returned ${results.results?.length || 0} results`;
              console.log(`[Piggy] ${actionDetail}`);
            } catch (err) {
              extraContext = `WEB SEARCH FAILED: ${err.message}`;
              actionSuccess = false;
              actionDetail = err.message;
            }
          }
          break;
        }

        case 'recall': {
          if (action.query) {
            console.log(`[Piggy] Recall: "${action.query}"`);
            if (memoryReady) {
              try {
                const memory = require('memory-engine');
                const recalled = memory.recallFormatted(action.query, { app: focusedApp });
                extraContext = recalled;
                actionDetail = `Recalled past experience for "${action.query}"`;
              } catch (err) {
                extraContext = 'No memories found.';
                actionDetail = 'Recall failed';
              }
            } else {
              extraContext = 'Memory engine not available.';
              actionDetail = 'Memory unavailable';
            }
          }
          break;
        }
      }

      // ── POST-ACTION: Screen diff — stuck detection ──
      try {
        if (opts.captureScreen && action.action !== 'done' && action.action !== 'fail' && action.action !== 'screenshot' && action.action !== 'recall' && action.action !== 'web_search' && action.action !== 'read') {
          const shot = await opts.captureScreen();
          const diff = screenDiff.pushFrame(shot.smallBase64, currentElements);
          if (diff.isStuck) {
            consecutiveFailures++;
            console.warn(`[Piggy ScreenDiff] Stuck detected (${consecutiveFailures}x)`);
            if (consecutiveFailures >= 3) {
              const recovery = errorRecovery.suggestRecovery(action, 'stuck', {
                elements: currentElements, retryCount: consecutiveFailures, step, app: focusedApp
              });
              extraContext += `\nSTUCK: Screen hasn't changed after ${consecutiveFailures} actions. ${recovery.description || 'Try a completely different approach — keyboard shortcut, different element, or navigate_to a URL directly.'}`;
            }
          } else {
            consecutiveFailures = 0;
          }
        }
      } catch (_) {} // screen diff is best-effort

      // ── POST-ACTION: Memory — store ground truth ──
      if (memoryReady && memCtx) {
        try {
          memoryAdapter.onStepResult(memCtx.sessionId, action, actionSuccess, actionDetail, step);
        } catch (err) { console.warn('[Piggy Memory] onStepResult:', err.message); }
      }

      // ── POST-ACTION: Track failures for recovery ──
      if (!actionSuccess) {
        errorRecovery.recordRecoveryOutcome('direct', action.action, false);
      }

      await new Promise(r => setTimeout(r, 100));
    }

    // Let screen settle before next step
    await new Promise(r => setTimeout(r, 800));
  }

  running = false;
  return await finishTask(memCtx, 'stopped', max, allActions, focusedApp, opts);
}

// ── Finish Task ─────────────────────────────────────────

async function finishTask(memCtx, outcome, steps, allActions, focusedApp, opts) {
  security.taskEnd();

  const taskResult = {
    success: outcome === 'success',
    steps,
    reason: outcome === 'success' ? 'Task completed' : outcome === 'failure' ? 'Task failed' : 'Step limit reached',
    history: getHistory(),
    security: security.getStats(),
    cost: modelRouter.getCost()
  };

  // Skill library: learn from this task
  if (outcome === 'success' && allActions.length > 2) {
    try {
      const skill = skillLibrary.createFromHistory(currentTask, allActions, focusedApp || 'unknown');
      if (skill) {
        console.log(`[Piggy Skills] Learned: "${skill.name}" (${skill.actions?.length || 0} steps)`);
      }
    } catch (err) { console.warn('[Piggy Skills] createFromHistory:', err.message); }
  }

  if (!memoryReady || !memCtx) return taskResult;

  // Memory: end session + reflection
  try {
    const { reflectionPrompt } = memoryAdapter.afterTask(
      memCtx.sessionId, outcome, steps, memCtx.activeSkillIds
    );

    // Run reflection — model analyzes what happened and extracts skills
    if (reflectionPrompt && provider) {
      try {
        const reflectionResponse = await provider.ask(
          'You are reflecting on a completed computer automation task. Respond with ONLY valid JSON.',
          [], null, reflectionPrompt, 800
        );
        if (reflectionResponse) {
          const result = memoryAdapter.onReflection(memCtx.sessionId, reflectionResponse);
          if (result?.skill) {
            console.log(`[Piggy Memory] Skill extracted: "${result.skill.name}" (${Math.round((result.skill.confidence || 0) * 100)}%)`);
          }
          if (result?.reflection) {
            console.log(`[Piggy Memory] Reflection stored (outcome: ${outcome})`);
          }
        }
      } catch (err) {
        console.warn('[Piggy Memory] Reflection failed:', err.message);
      }
    }
  } catch (err) {
    console.warn('[Piggy Memory] afterTask failed:', err.message);
  }

  return taskResult;
}

// ── Chat ────────────────────────────────────────────────

const CHAT_SYSTEM_PROMPT = `You are Piggy, an AI assistant that can control a real computer. Right now you're in CHAT MODE.

ABSOLUTE RULES — NEVER BREAK THESE:
- NEVER output <computer_action> tags. NEVER. That format does not exist here.
- NEVER output {"action":"click"...} or any action JSON in chat mode.
- NEVER pretend to take screenshots or click things. You CANNOT act in chat mode.
- You can ONLY respond with plain text OR the ready signal below.

If the user asks you to DO something on the computer (open an app, click something, type something, search for something, navigate somewhere):
- Respond with ONLY this JSON, nothing else: {"ready": true, "task": "exact description of what to do"}
- Example: User says "search for cats on Google" → You respond: {"ready": true, "task": "Search for cats on Google in Brave Browser"}
- Example: User says "open Brave and go to youtube" → You respond: {"ready": true, "task": "Open Brave Browser and navigate to youtube.com"}
- Example: User says "type hello in the search bar" → You respond: {"ready": true, "task": "Type hello in the search bar"}
- This triggers EXECUTION MODE where you can actually control the computer.

BROWSERS: You can control both Safari and Brave Browser. When the user doesn't specify, prefer Brave Browser.

If the user is just chatting, asking questions, or discussing — respond in plain text. Be concise.

NEVER try to control the computer from chat mode. ALWAYS use the ready signal to trigger execution mode.`;

async function chat(message, opts = {}) {
  if (!provider) return { reply: 'No AI provider configured. Set an API key in .env first.', ready: false, task: null };

  let systemPrompt = CHAT_SYSTEM_PROMPT;
  if (opts.apps && opts.apps.length) {
    systemPrompt += `\n\nRunning apps on this computer: ${opts.apps.join(', ')}`;
  }
  if (memoryReady) {
    try {
      const memory = require('memory-engine');
      const profileBlock = memory.getProfile({ agentName: 'Piggy' });
      if (profileBlock) systemPrompt += '\n\n' + profileBlock;
    } catch (_) {}
  }

  if (opts.screenshot) {
    chatHistory.push({
      role: 'user',
      content: [
        { type: 'text', text: message },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${opts.screenshot}`, detail: 'low' } }
      ]
    });
  } else {
    chatHistory.push({ role: 'user', content: message });
  }

  if (chatHistory.length > 20) chatHistory = chatHistory.slice(-16);

  try {
    let raw = await provider.ask(systemPrompt, chatHistory, null, message, 500);

    if (raw && raw.includes('<computer_action>')) {
      const taskDesc = message;
      raw = JSON.stringify({ ready: true, task: taskDesc });
    }

    chatHistory.push({ role: 'assistant', content: raw || '' });

    let ready = false;
    let task = null;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed.ready === true && parsed.task) {
          ready = true;
          task = parsed.task;
        }
      }
    } catch (_) {}

    return { reply: raw, ready, task };
  } catch (err) {
    return { reply: `Error: ${err.message}`, ready: false, task: null };
  }
}

async function runTaskFromChat(task, opts = {}) {
  history = [];
  return runTask(task, opts);
}

function getChatHistory() {
  return chatHistory.map(h => ({ role: h.role, content: typeof h.content === 'string' ? h.content : '[image + text]' }));
}

function clearChat() {
  chatHistory = [];
}

// ── Controls ────────────────────────────────────────────

function stop() {
  running = false;
  currentTask = null;
}

function getHistory() {
  return history.map(h => ({ role: h.role, content: typeof h.content === 'string' ? h.content : '[image]' }));
}

function clearHistory() {
  history = [];
  chatHistory = [];
}

function status() {
  const memStats = memoryReady ? memoryAdapter.getStats() : null;
  return {
    running,
    task: currentTask,
    historyLength: history.length,
    memory: memStats,
    security: security.getStats(),
    cost: modelRouter.getCost(),
    skills: skillLibrary.count()
  };
}

module.exports = { init, runTask, runTaskFromChat, chat, stop, status, getHistory, getChatHistory, clearHistory, clearChat };
