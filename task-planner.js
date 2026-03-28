/**
 * Piggy — Task Planner
 * Decomposes complex user requests into ordered subtask DAGs.
 * Each subtask is atomic — one clear action the executor can handle.
 *
 * Uses regex-based heuristic rules, NOT AI model calls.
 * The model router decides which model handles each subtask.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

// ── Constants ────────────────────────────────────────────

const TYPES = {
  FOCUS:    'focus',
  NAVIGATE: 'navigate',
  CLICK:    'click',
  TYPE:     'type',
  KEY:      'key',
  SEARCH:   'search',
  VERIFY:   'verify',
  WAIT:     'wait',
  SCROLL:   'scroll',
  FORM:     'form',
  COPY:     'copy',
  SELECT:   'select'
};

const STATUS = {
  PENDING:  'pending',
  RUNNING:  'running',
  DONE:     'done',
  FAILED:   'failed',
  BLOCKED:  'blocked',
  SKIPPED:  'skipped'
};

// Steps-per-type estimate for token cost estimation
const STEPS_PER_TYPE = {
  [TYPES.FOCUS]:    1,
  [TYPES.NAVIGATE]: 3,
  [TYPES.CLICK]:    2,
  [TYPES.TYPE]:     2,
  [TYPES.KEY]:      1,
  [TYPES.SEARCH]:   4,
  [TYPES.VERIFY]:   1,
  [TYPES.WAIT]:     1,
  [TYPES.SCROLL]:   1,
  [TYPES.FORM]:     5,
  [TYPES.COPY]:     2,
  [TYPES.SELECT]:   2
};

// Average tokens per model step
const TOKENS_PER_STEP = { input: 2000, output: 300 };

// ── App inference ────────────────────────────────────────

const BROWSER_KEYWORDS = /\b(safari|brave|chrome|firefox|browser|web|website|url|http|google|bing|duckduckgo|search engine)\b/i;
const TERMINAL_KEYWORDS = /\b(terminal|command|shell|bash|zsh|cli|command line|npm|node|pip|brew)\b/i;
const FINDER_KEYWORDS = /\b(finder|file|folder|directory|desktop|documents|downloads)\b/i;

/**
 * Infer the target app from task description.
 *
 * @param {string} task
 * @param {string} [defaultApp='Safari']
 * @returns {string}
 */
function inferApp(task) {
  if (/\bsafari\b/i.test(task)) return 'Safari';
  if (/\bbrave\b/i.test(task)) return 'Brave Browser';
  if (/\bchrome\b/i.test(task)) return 'Google Chrome';
  if (/\bfirefox\b/i.test(task)) return 'Firefox';
  if (TERMINAL_KEYWORDS.test(task)) return 'Terminal';
  if (FINDER_KEYWORDS.test(task)) return 'Finder';
  if (BROWSER_KEYWORDS.test(task)) return 'Safari';
  return 'Safari'; // default
}

/**
 * Detect if a string looks like a URL.
 *
 * @param {string} str
 * @returns {boolean}
 */
function isURL(str) {
  return /^https?:\/\//.test(str) || /\.(com|org|net|io|dev|ai|edu|gov|co)\b/.test(str);
}

// ── Clause splitting ─────────────────────────────────────

/**
 * Split a complex task into clauses.
 * Handles "and then", "after that", "then", commas, periods.
 *
 * @param {string} task
 * @returns {string[]}
 */
function splitClauses(task) {
  // Split on common connectors
  const parts = task
    .replace(/\band then\b/gi, '|||')
    .replace(/\bafter that\b/gi, '|||')
    .replace(/\bthen\b/gi, '|||')
    .replace(/\.\s+/g, '|||')
    .replace(/,\s+/g, '|||')  // comma-separated instructions
    .split('|||')
    .map(s => s.trim())
    .filter(s => s.length > 3);

  return parts.length > 0 ? parts : [task];
}

// ── Pattern matchers ─────────────────────────────────────

/**
 * Match a clause to subtask(s).
 *
 * @param {string} clause
 * @param {string} app
 * @param {number} startId
 * @param {number[]} deps — dependency IDs
 * @returns {Array<object>} — subtasks
 */
function matchClause(clause, app, startId, deps) {
  const subtasks = [];
  let id = startId;
  const lower = clause.toLowerCase();

  // "open X" / "launch X" — focus app
  if (/^(open|launch|start|switch to|focus)\b/i.test(clause)) {
    const appMatch = clause.match(/(?:open|launch|start|switch to|focus)\s+(.+)/i);
    const targetApp = appMatch ? inferApp(appMatch[1]) : app;
    subtasks.push(makeSubtask(id++, TYPES.FOCUS, `Focus ${targetApp}`, targetApp, deps));
    return subtasks;
  }

  // "go to X" / "navigate to X" / "visit X"
  if (/\b(go to|navigate to|visit|open)\s+/i.test(clause)) {
    const urlMatch = clause.match(/(?:go to|navigate to|visit|open)\s+(.+)/i);
    const target = urlMatch ? urlMatch[1].trim() : clause;
    if (isURL(target) || /\b(google|youtube|twitter|x\.com|github|reddit)\b/i.test(target)) {
      subtasks.push(makeSubtask(id++, TYPES.NAVIGATE, `Navigate to ${target}`, app, deps, { url: target }));
      subtasks.push(makeSubtask(id++, TYPES.VERIFY, `Verify page loaded`, app, [id - 1]));
      return subtasks;
    }
  }

  // "search for X" / "search X" / "look up X"
  if (/\b(search|look up|find|google|query)\b/i.test(clause)) {
    const queryMatch = clause.match(/(?:search|look up|find|google|query)\s+(?:for\s+)?(.+?)(?:\s+on\s+.+)?$/i);
    const query = queryMatch ? queryMatch[1].trim() : clause;
    subtasks.push(makeSubtask(id++, TYPES.SEARCH, `Search for "${query}"`, app, deps, { query }));
    subtasks.push(makeSubtask(id++, TYPES.VERIFY, `Verify search results`, app, [id - 1]));
    return subtasks;
  }

  // "type X" / "write X" / "enter X"
  if (/\b(type|write|enter|input)\s+/i.test(clause)) {
    const textMatch = clause.match(/(?:type|write|enter|input)\s+(.+?)(?:\s+in\s+.+)?$/i);
    const text = textMatch ? textMatch[1].trim().replace(/^["']|["']$/g, '') : '';
    subtasks.push(makeSubtask(id++, TYPES.TYPE, `Type "${text}"`, app, deps, { text }));
    return subtasks;
  }

  // "click X" / "press X" / "tap X"
  if (/\b(click|press|tap|hit|select)\s+/i.test(clause)) {
    const targetMatch = clause.match(/(?:click|press|tap|hit|select)\s+(?:on\s+)?(?:the\s+)?(.+)/i);
    const target = targetMatch ? targetMatch[1].trim() : clause;

    // "press enter/tab/escape" → key action
    if (/^(enter|return|tab|escape|esc|space|backspace|delete)\b/i.test(target)) {
      subtasks.push(makeSubtask(id++, TYPES.KEY, `Press ${target}`, app, deps, { key: target.toLowerCase() }));
    } else {
      subtasks.push(makeSubtask(id++, TYPES.CLICK, `Click "${target}"`, app, deps, { target }));
    }
    return subtasks;
  }

  // "scroll down/up"
  if (/\b(scroll)\b/i.test(clause)) {
    const dir = /\bup\b/i.test(clause) ? 'up' : 'down';
    subtasks.push(makeSubtask(id++, TYPES.SCROLL, `Scroll ${dir}`, app, deps, { direction: dir }));
    return subtasks;
  }

  // "wait" / "pause"
  if (/\b(wait|pause|hold)\b/i.test(clause)) {
    subtasks.push(makeSubtask(id++, TYPES.WAIT, `Wait for page`, app, deps));
    return subtasks;
  }

  // "copy X" / "save X"
  if (/\b(copy|save|grab|get)\b/i.test(clause)) {
    subtasks.push(makeSubtask(id++, TYPES.COPY, `Copy: ${clause}`, app, deps));
    return subtasks;
  }

  // "fill in" / "fill out" — form
  if (/\b(fill|complete)\b/i.test(clause)) {
    subtasks.push(makeSubtask(id++, TYPES.FORM, `Fill form: ${clause}`, app, deps));
    return subtasks;
  }

  // Default: treat as a click/interaction
  subtasks.push(makeSubtask(id++, TYPES.CLICK, clause, app, deps));
  return subtasks;
}

/**
 * Create a subtask object.
 *
 * @param {number} id
 * @param {string} type
 * @param {string} description
 * @param {string} app
 * @param {number[]} dependsOn
 * @param {object} [context={}]
 * @returns {object}
 */
function makeSubtask(id, type, description, app, dependsOn, context = {}) {
  return {
    id,
    type,
    description,
    app,
    dependsOn: [...dependsOn],
    status: STATUS.PENDING,
    retries: 0,
    maxRetries: type === TYPES.VERIFY ? 3 : 2,
    estimatedSteps: STEPS_PER_TYPE[type] || 2,
    context,
    result: null,
    error: null
  };
}

// ── Public API ───────────────────────────────────────────

/**
 * Plan a task — decompose into subtasks.
 *
 * @param {string} taskDescription — natural language task
 * @param {object} [options]
 * @param {string} [options.app] — override target app
 * @param {string[]} [options.availableApps] — running apps
 * @returns {{subtasks: Array, estimatedSteps: number, estimatedCost: {input: number, output: number}}}
 */
function plan(taskDescription, options = {}) {
  const app = options.app || inferApp(taskDescription);
  const clauses = splitClauses(taskDescription);

  let subtasks = [];
  let nextId = 1;

  // Always start with focus
  subtasks.push(makeSubtask(nextId++, TYPES.FOCUS, `Focus ${app}`, app, []));

  // Detect if we need to navigate first
  const needsNavigation = /\b(google|bing|duckduckgo)\b/i.test(taskDescription) &&
    !/\b(go to|navigate|visit|open)\b/i.test(taskDescription);
  if (needsNavigation) {
    let url = 'https://www.google.com';
    if (/\bbing\b/i.test(taskDescription)) url = 'https://www.bing.com';
    if (/\bduckduckgo\b/i.test(taskDescription)) url = 'https://duckduckgo.com';
    subtasks.push(makeSubtask(nextId++, TYPES.NAVIGATE, `Navigate to ${url}`, app, [1], { url }));
    subtasks.push(makeSubtask(nextId++, TYPES.WAIT, `Wait for page load`, app, [nextId - 1]));
  }

  // Process each clause
  for (let i = 0; i < clauses.length; i++) {
    const deps = subtasks.length > 0 ? [subtasks[subtasks.length - 1].id] : [];
    const newTasks = matchClause(clauses[i], app, nextId, deps);
    subtasks.push(...newTasks);
    nextId += newTasks.length;
  }

  // Deduplicate consecutive focus actions for same app
  subtasks = deduplicateFocus(subtasks);

  // Estimate cost
  const totalSteps = subtasks.reduce((sum, s) => sum + s.estimatedSteps, 0);
  const estimatedCost = {
    input: totalSteps * TOKENS_PER_STEP.input,
    output: totalSteps * TOKENS_PER_STEP.output
  };

  return { subtasks, estimatedSteps: totalSteps, estimatedCost };
}

/**
 * Remove duplicate consecutive focus actions for the same app.
 *
 * @param {Array} subtasks
 * @returns {Array}
 */
function deduplicateFocus(subtasks) {
  const result = [];
  for (let i = 0; i < subtasks.length; i++) {
    if (subtasks[i].type === TYPES.FOCUS && i > 0) {
      const prev = result[result.length - 1];
      if (prev && prev.type === TYPES.FOCUS && prev.app === subtasks[i].app) {
        continue; // skip duplicate
      }
    }
    result.push(subtasks[i]);
  }
  return result;
}

/**
 * Get the next executable subtask (all dependencies met).
 *
 * @param {Array} subtasks
 * @returns {object|null} — next subtask, or null if none available
 */
function next(subtasks) {
  for (const task of subtasks) {
    if (task.status !== STATUS.PENDING) continue;

    const depsOk = task.dependsOn.every(depId => {
      const dep = subtasks.find(s => s.id === depId);
      return dep && dep.status === STATUS.DONE;
    });

    if (depsOk) return task;
  }
  return null;
}

/**
 * Update a subtask's status.
 *
 * @param {Array} subtasks
 * @param {number} subtaskId
 * @param {string} status — from STATUS
 * @param {*} [result=null] — result data
 * @returns {Array} — updated subtasks
 */
function update(subtasks, subtaskId, status, result = null) {
  const task = subtasks.find(s => s.id === subtaskId);
  if (!task) return subtasks;

  task.status = status;
  task.result = result;

  // On failure: block dependents
  if (status === STATUS.FAILED) {
    blockDependents(subtasks, subtaskId);
  }

  return subtasks;
}

/**
 * Recursively block subtasks that depend on a failed one.
 *
 * @param {Array} subtasks
 * @param {number} failedId
 */
function blockDependents(subtasks, failedId) {
  for (const task of subtasks) {
    if (task.status === STATUS.PENDING && task.dependsOn.includes(failedId)) {
      task.status = STATUS.BLOCKED;
      task.error = `Blocked by failed subtask ${failedId}`;
      blockDependents(subtasks, task.id);
    }
  }
}

/**
 * Check if a subtask can be retried.
 *
 * @param {object} subtask
 * @returns {boolean}
 */
function canRetry(subtask) {
  return subtask.retries < subtask.maxRetries;
}

/**
 * Retry a failed subtask — reset it and unblock dependents.
 *
 * @param {Array} subtasks
 * @param {number} subtaskId
 * @returns {Array}
 */
function retry(subtasks, subtaskId) {
  const task = subtasks.find(s => s.id === subtaskId);
  if (!task || !canRetry(task)) return subtasks;

  task.status = STATUS.PENDING;
  task.retries++;
  task.error = null;
  task.result = null;

  // Unblock dependents
  for (const t of subtasks) {
    if (t.status === STATUS.BLOCKED && t.dependsOn.includes(subtaskId)) {
      t.status = STATUS.PENDING;
      t.error = null;
    }
  }

  return subtasks;
}

/**
 * Recommend retry strategy based on error type.
 *
 * @param {object} subtask
 * @param {string} [errorType='unknown']
 * @returns {'retry'|'skip'|'abort'}
 */
function retryStrategy(subtask, errorType = 'unknown') {
  if (!canRetry(subtask)) return 'abort';

  // Transient errors → retry
  if (['timeout', 'network', 'loading', 'not_found'].includes(errorType)) {
    return 'retry';
  }

  // Verification failures → retry (page might need more time)
  if (subtask.type === TYPES.VERIFY) return 'retry';

  // Navigation errors → retry once, then abort
  if (subtask.type === TYPES.NAVIGATE) {
    return subtask.retries < 1 ? 'retry' : 'abort';
  }

  // Everything else: retry if first failure, abort otherwise
  return subtask.retries < 1 ? 'retry' : 'abort';
}

/**
 * Get human-readable progress summary.
 *
 * @param {Array} subtasks
 * @returns {string}
 */
function getSummary(subtasks) {
  const counts = { pending: 0, running: 0, done: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const t of subtasks) counts[t.status] = (counts[t.status] || 0) + 1;

  const total = subtasks.length;
  const progress = Math.round((counts.done / total) * 100);

  const lines = [
    `Progress: ${counts.done}/${total} (${progress}%)`,
    counts.running > 0 ? `Running: ${counts.running}` : '',
    counts.failed > 0 ? `Failed: ${counts.failed}` : '',
    counts.blocked > 0 ? `Blocked: ${counts.blocked}` : ''
  ].filter(Boolean);

  // Show current step
  const current = subtasks.find(s => s.status === STATUS.RUNNING);
  if (current) lines.push(`Current: ${current.description}`);

  return lines.join(' | ');
}

/**
 * Generate model context for a specific subtask.
 *
 * @param {object} subtask
 * @param {Array} allSubtasks — for context about completed steps
 * @returns {string}
 */
function getSubtaskPrompt(subtask, allSubtasks) {
  const completed = allSubtasks
    .filter(s => s.status === STATUS.DONE)
    .map(s => `✓ ${s.description}`)
    .join('\n');

  const remaining = allSubtasks
    .filter(s => s.status === STATUS.PENDING && s.id !== subtask.id)
    .map(s => `· ${s.description}`)
    .join('\n');

  let prompt = `CURRENT SUBTASK: ${subtask.description}\nType: ${subtask.type}`;
  if (subtask.context.query) prompt += `\nSearch query: "${subtask.context.query}"`;
  if (subtask.context.url) prompt += `\nTarget URL: ${subtask.context.url}`;
  if (subtask.context.text) prompt += `\nText to type: "${subtask.context.text}"`;
  if (subtask.context.target) prompt += `\nTarget element: "${subtask.context.target}"`;
  if (subtask.retries > 0) prompt += `\nRetry attempt: ${subtask.retries}/${subtask.maxRetries}`;
  if (completed) prompt += `\n\nCOMPLETED:\n${completed}`;
  if (remaining) prompt += `\n\nREMAINING:\n${remaining}`;

  return prompt;
}

module.exports = {
  plan,
  next,
  update,
  canRetry,
  retry,
  retryStrategy,
  getSummary,
  getSubtaskPrompt,
  inferApp,
  splitClauses,
  TYPES,
  STATUS
};
