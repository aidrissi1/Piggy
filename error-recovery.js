/**
 * Piggy — Error Recovery Module
 * Handles failures with alternative strategies instead of blind retries.
 * Saves state snapshots for rollback. Tracks what recovery strategies work.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

// ── Error types ──────────────────────────────────────────

const ERROR_TYPES = {
  ELEMENT_NOT_FOUND: 'element_not_found',
  CLICK_FAILED:      'click_failed',
  TYPE_FAILED:       'type_failed',
  NAV_FAILED:        'navigation_failed',
  TIMEOUT:           'timeout',
  PAGE_ERROR:        'page_error',
  UNKNOWN:           'unknown'
};

// ── State ────────────────────────────────────────────────

const snapshots = new Map();  // stateId → snapshot
let snapshotId = 0;
const recoveryHistory = [];   // { strategy, errorType, success, timestamp }
const failureLog = [];        // recent failures for stuck detection
const MAX_FAILURES = 50;

// ── State snapshots ──────────────────────────────────────

/**
 * Save a state snapshot before a risky action.
 *
 * @param {object} context
 * @param {string} [context.url] — current page URL
 * @param {Array} [context.elements] — current element list
 * @param {number} [context.step] — current step number
 * @param {Array} [context.actionsHistory] — actions taken so far
 * @param {string} [context.app] — focused app
 * @returns {number} — snapshot ID
 */
function saveState(context) {
  const id = ++snapshotId;
  snapshots.set(id, {
    id,
    timestamp: Date.now(),
    url: context.url || '',
    elements: context.elements ? [...context.elements] : [],
    step: context.step || 0,
    actionsHistory: context.actionsHistory ? [...context.actionsHistory] : [],
    app: context.app || ''
  });

  // Limit stored snapshots
  if (snapshots.size > 20) {
    const oldest = snapshots.keys().next().value;
    snapshots.delete(oldest);
  }

  return id;
}

/**
 * Get a saved state snapshot.
 *
 * @param {number} stateId
 * @returns {object|null}
 */
function getState(stateId) {
  return snapshots.get(stateId) || null;
}

/**
 * Generate actions needed to roll back to a saved state.
 *
 * @param {number} stateId
 * @param {object} currentContext — current state to diff from
 * @returns {{actions: Array, description: string}|null}
 */
function rollback(stateId, currentContext = {}) {
  const state = snapshots.get(stateId);
  if (!state) return null;

  const actions = [];

  // If the app changed, re-focus
  if (state.app && state.app !== currentContext.app) {
    actions.push({ action: 'focus', app: state.app });
  }

  // If the URL changed, navigate back
  if (state.url && state.url !== currentContext.url) {
    actions.push({ action: 'navigate', url: state.url });
  }

  return {
    actions,
    description: `Rollback to state ${stateId} (step ${state.step}): ${state.url || state.app}`
  };
}

// ── Recovery strategies ──────────────────────────────────

/**
 * @typedef {object} RecoverySuggestion
 * @property {string} strategy — 'retry'|'alternative'|'scroll'|'wait'|'shortcut'|'rollback'|'skip'|'abort'
 * @property {Array} actions — suggested actions to try
 * @property {string} reason — why this strategy was chosen
 * @property {number} confidence — 0-1 how likely this will work
 */

/**
 * Suggest a recovery strategy for a failed action.
 *
 * @param {object} failedAction — the action that failed
 * @param {string} errorType — from ERROR_TYPES
 * @param {object} context
 * @param {Array} [context.elements] — current elements on screen
 * @param {number} [context.retryCount=0] — how many times this was retried
 * @param {number} [context.step] — current step
 * @param {string} [context.app] — current app
 * @returns {RecoverySuggestion}
 */
function suggestRecovery(failedAction, errorType, context = {}) {
  const retries = context.retryCount || 0;
  const action = failedAction || {};

  // Log the failure
  failureLog.push({
    action: action.action,
    errorType,
    step: context.step,
    timestamp: Date.now()
  });
  if (failureLog.length > MAX_FAILURES) failureLog.shift();

  // If stuck, escalate aggressively
  if (isStuck()) {
    return {
      strategy: 'rollback',
      actions: [],
      reason: 'Agent appears stuck — rolling back to try a different approach',
      confidence: 0.3
    };
  }

  // Strategy selection based on error type and retry count
  switch (errorType) {
    case ERROR_TYPES.ELEMENT_NOT_FOUND:
      return recoverElementNotFound(action, context, retries);

    case ERROR_TYPES.CLICK_FAILED:
      return recoverClickFailed(action, context, retries);

    case ERROR_TYPES.TYPE_FAILED:
      return recoverTypeFailed(action, context, retries);

    case ERROR_TYPES.NAV_FAILED:
      return recoverNavFailed(action, context, retries);

    case ERROR_TYPES.TIMEOUT:
      return recoverTimeout(action, context, retries);

    case ERROR_TYPES.PAGE_ERROR:
      return recoverPageError(action, context, retries);

    default:
      return retries < 2
        ? { strategy: 'retry', actions: [action], reason: 'Unknown error — retrying', confidence: 0.4 }
        : { strategy: 'abort', actions: [], reason: 'Unknown error after multiple retries', confidence: 0.1 };
  }
}

/**
 * Recovery for element not found.
 */
function recoverElementNotFound(action, context, retries) {
  const elements = context.elements || [];

  if (retries === 0) {
    // First try: scroll down to reveal hidden elements
    return {
      strategy: 'scroll',
      actions: [{ action: 'scroll', direction: 'down', amount: 3 }],
      reason: 'Element may be below the fold — scrolling down',
      confidence: adjustConfidence(0.6, 'scroll', ERROR_TYPES.ELEMENT_NOT_FOUND)
    };
  }

  if (retries === 1) {
    // Second try: wait for dynamic content
    return {
      strategy: 'wait',
      actions: [],
      reason: 'Element may be loading dynamically — waiting',
      confidence: adjustConfidence(0.5, 'wait', ERROR_TYPES.ELEMENT_NOT_FOUND)
    };
  }

  if (retries === 2 && elements.length > 0) {
    // Third try: find similar element by partial name match
    const targetName = (action.name || action._elementName || '').toLowerCase();
    if (targetName) {
      const similar = elements.find(e =>
        (e.name || '').toLowerCase().includes(targetName.substring(0, 5))
      );
      if (similar) {
        return {
          strategy: 'alternative',
          actions: [{ action: 'click', item: similar.id }],
          reason: `Trying similar element: "${similar.name}"`,
          confidence: adjustConfidence(0.5, 'alternative', ERROR_TYPES.ELEMENT_NOT_FOUND)
        };
      }
    }
  }

  // Fallback: try keyboard shortcut
  return {
    strategy: 'shortcut',
    actions: [{ action: 'shortcut', key: 'l', modifiers: ['command'] }],
    reason: 'Element not found after 3 attempts — trying keyboard shortcut',
    confidence: adjustConfidence(0.4, 'shortcut', ERROR_TYPES.ELEMENT_NOT_FOUND)
  };
}

/**
 * Recovery for click failed.
 */
function recoverClickFailed(action, context, retries) {
  if (retries === 0) {
    // First: re-focus the app and retry
    return {
      strategy: 'retry',
      actions: [
        { action: 'focus', app: context.app || 'Safari' },
        action
      ],
      reason: 'Click may have missed — re-focusing app and retrying',
      confidence: adjustConfidence(0.7, 'retry', ERROR_TYPES.CLICK_FAILED)
    };
  }

  if (retries === 1) {
    // Second: scroll to element and retry
    return {
      strategy: 'scroll',
      actions: [
        { action: 'scroll', direction: 'up', amount: 2 },
        action
      ],
      reason: 'Element may have moved — scrolling and retrying',
      confidence: adjustConfidence(0.5, 'scroll', ERROR_TYPES.CLICK_FAILED)
    };
  }

  // Give up on this click
  return {
    strategy: 'skip',
    actions: [],
    reason: 'Click failed after multiple retries — skipping',
    confidence: 0.2
  };
}

/**
 * Recovery for type failed.
 */
function recoverTypeFailed(action, context, retries) {
  if (retries === 0) {
    // Click the field first, then type
    return {
      strategy: 'alternative',
      actions: [
        { action: 'click', x: action.x, y: action.y },
        { action: 'type', text: action.text || '' }
      ],
      reason: 'Field may not be focused — clicking first then typing',
      confidence: adjustConfidence(0.7, 'alternative', ERROR_TYPES.TYPE_FAILED)
    };
  }

  if (retries === 1) {
    // Try Tab to focus, then type
    return {
      strategy: 'alternative',
      actions: [
        { action: 'key', key: 'tab' },
        { action: 'type', text: action.text || '' }
      ],
      reason: 'Trying Tab to focus the field',
      confidence: adjustConfidence(0.5, 'alternative', ERROR_TYPES.TYPE_FAILED)
    };
  }

  // Clear field and retype
  return {
    strategy: 'alternative',
    actions: [
      { action: 'shortcut', key: 'a', modifiers: ['command'] },
      { action: 'type', text: action.text || '' }
    ],
    reason: 'Selecting all and retyping',
    confidence: adjustConfidence(0.4, 'alternative', ERROR_TYPES.TYPE_FAILED)
  };
}

/**
 * Recovery for navigation failed.
 */
function recoverNavFailed(action, context, retries) {
  if (retries === 0) {
    // Retry the navigation
    return {
      strategy: 'retry',
      actions: [action],
      reason: 'Navigation may have timed out — retrying',
      confidence: adjustConfidence(0.6, 'retry', ERROR_TYPES.NAV_FAILED)
    };
  }

  if (retries === 1) {
    // Try refreshing
    return {
      strategy: 'shortcut',
      actions: [{ action: 'shortcut', key: 'r', modifiers: ['command'] }],
      reason: 'Refreshing the page',
      confidence: adjustConfidence(0.5, 'shortcut', ERROR_TYPES.NAV_FAILED)
    };
  }

  // Open in new tab
  return {
    strategy: 'alternative',
    actions: [
      { action: 'shortcut', key: 't', modifiers: ['command'] },
      { action: 'shortcut', key: 'l', modifiers: ['command'] },
      { action: 'type', text: action.url || '' },
      { action: 'key', key: 'enter' }
    ],
    reason: 'Trying new tab with direct URL entry',
    confidence: adjustConfidence(0.4, 'alternative', ERROR_TYPES.NAV_FAILED)
  };
}

/**
 * Recovery for timeout.
 */
function recoverTimeout(action, context, retries) {
  if (retries < 2) {
    return {
      strategy: 'wait',
      actions: [],
      reason: `Timeout — waiting and retrying (attempt ${retries + 1})`,
      confidence: adjustConfidence(0.5, 'wait', ERROR_TYPES.TIMEOUT)
    };
  }

  return {
    strategy: 'abort',
    actions: [],
    reason: 'Timeout after multiple retries',
    confidence: 0.1
  };
}

/**
 * Recovery for page errors (404, 500, etc.)
 */
function recoverPageError(action, context, retries) {
  if (retries === 0) {
    return {
      strategy: 'shortcut',
      actions: [{ action: 'key', key: 'left', modifiers: ['command'] }],
      reason: 'Page error — going back',
      confidence: adjustConfidence(0.6, 'shortcut', ERROR_TYPES.PAGE_ERROR)
    };
  }

  return {
    strategy: 'abort',
    actions: [],
    reason: 'Page error persists — aborting this path',
    confidence: 0.1
  };
}

// ── Stuck detection ──────────────────────────────────────

/**
 * Detect if the agent is stuck (same failures repeating).
 *
 * @param {Array} [history] — override failure log
 * @returns {boolean}
 */
function isStuck(history = null) {
  const log = history || failureLog;
  if (log.length < 3) return false;

  const recent = log.slice(-5);

  // Same action failing 3+ times in a row
  const lastAction = recent[recent.length - 1]?.action;
  const repeats = recent.filter(f => f.action === lastAction).length;
  if (repeats >= 3) return true;

  // All recent failures within 10 seconds (rapid failure loop)
  const timeSpan = recent[recent.length - 1]?.timestamp - recent[0]?.timestamp;
  if (recent.length >= 4 && timeSpan < 10000) return true;

  return false;
}

// ── Recovery history ─────────────────────────────────────

/**
 * Record the outcome of a recovery strategy.
 *
 * @param {string} strategy — strategy name
 * @param {string} errorType — what error was recovered from
 * @param {boolean} success — did it work?
 */
function recordRecoveryOutcome(strategy, errorType, success) {
  recoveryHistory.push({
    strategy,
    errorType,
    success,
    timestamp: Date.now()
  });

  // Limit history
  if (recoveryHistory.length > 200) recoveryHistory.splice(0, 50);
}

/**
 * Adjust confidence based on historical success rate.
 *
 * @param {number} baseConfidence
 * @param {string} strategy
 * @param {string} errorType
 * @returns {number}
 */
function adjustConfidence(baseConfidence, strategy, errorType) {
  const relevant = recoveryHistory.filter(r =>
    r.strategy === strategy && r.errorType === errorType
  );

  if (relevant.length < 3) return baseConfidence; // not enough data

  const successRate = relevant.filter(r => r.success).length / relevant.length;
  // Blend: 60% base, 40% historical
  return Math.round((baseConfidence * 0.6 + successRate * 0.4) * 100) / 100;
}

/**
 * Get recovery statistics.
 *
 * @returns {object}
 */
function getRecoveryStats() {
  const byStrategy = {};
  for (const r of recoveryHistory) {
    if (!byStrategy[r.strategy]) byStrategy[r.strategy] = { total: 0, successes: 0 };
    byStrategy[r.strategy].total++;
    if (r.success) byStrategy[r.strategy].successes++;
  }

  const stats = {};
  for (const [strategy, data] of Object.entries(byStrategy)) {
    stats[strategy] = {
      total: data.total,
      successes: data.successes,
      successRate: data.total > 0 ? Math.round((data.successes / data.total) * 100) : 0
    };
  }

  return {
    totalRecoveries: recoveryHistory.length,
    recentFailures: failureLog.length,
    isCurrentlyStuck: isStuck(),
    strategies: stats
  };
}

/**
 * Reset all recovery state.
 */
function reset() {
  snapshots.clear();
  snapshotId = 0;
  recoveryHistory.length = 0;
  failureLog.length = 0;
}

module.exports = {
  saveState,
  getState,
  rollback,
  suggestRecovery,
  recordRecoveryOutcome,
  getRecoveryStats,
  isStuck,
  reset,
  ERROR_TYPES
};
