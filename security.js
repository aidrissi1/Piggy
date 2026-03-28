/**
 * Piggy — Security Module
 * Action approval, sandboxing, rate limiting, and audit logging.
 * Every action passes through security before execution.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Configuration ────────────────────────────────────────

const config = {
  // Action approval
  autoApprove: true,           // auto-approve safe actions
  confirmDangerous: true,      // ask user for dangerous actions
  blockDestructive: true,      // block destructive actions entirely

  // Rate limiting
  maxActionsPerMinute: 60,     // max actions in a rolling minute
  maxActionsPerTask: 200,      // max actions per task
  maxConcurrentTasks: 1,       // max simultaneous tasks

  // Sandboxing
  allowedApps: null,           // null = all apps allowed. Set to string[] to restrict.
  blockedApps: ['System Preferences', 'Disk Utility', 'Migration Assistant'],
  blockedURLs: [],             // URL patterns to never navigate to
  blockedKeywords: [],         // keywords in actions to block

  // Audit
  auditLog: true,              // enable audit logging
  auditPath: null,             // file path for audit log (null = in-memory only)
  maxAuditEntries: 10000       // max entries in memory
};

// ── State ────────────────────────────────────────────────

const auditEntries = [];
const actionTimestamps = [];  // for rate limiting
let taskActionCount = 0;
let activeTasks = 0;

// ── Dangerous/Destructive action detection ───────────────

/**
 * Dangerous actions: need user confirmation.
 */
const DANGEROUS_PATTERNS = {
  shortcuts: {
    quit:    { key: 'q', modifiers: ['command'] },
    closeW:  { key: 'w', modifiers: ['command'] },
    delete:  { key: 'delete', modifiers: ['command'] },
    delShft: { key: 'delete', modifiers: ['command', 'shift'] },
    forceQ:  { key: 'q', modifiers: ['command', 'alt'] }
  },
  typePatterns: /password|secret|token|api.?key|private.?key|credential|ssh/i,
  urlPatterns: /\b(admin|root|sudo|delete|remove|drop|truncate|format)\b/i
};

/**
 * Destructive actions: blocked entirely.
 */
const DESTRUCTIVE_PATTERNS = {
  shortcuts: {
    emptyTrash: { key: 'delete', modifiers: ['command', 'shift', 'alt'] },
    forceQAll:  { key: 'q', modifiers: ['command', 'alt', 'shift'] }
  },
  typePatterns: /rm\s+-rf|sudo\s+rm|format\s+disk|dd\s+if=|mkfs\.|:(){:|fork\s*bomb/i
};

/**
 * Check if an action matches a shortcut pattern.
 */
function matchesShortcut(action, pattern) {
  if (action.action !== 'shortcut') return false;
  const key = (action.key || '').toLowerCase();
  const mods = (action.modifiers || []).map(m => m.toLowerCase()).sort();
  return key === pattern.key && JSON.stringify(mods) === JSON.stringify(pattern.modifiers.sort());
}

// ── Core security checks ─────────────────────────────────

/**
 * Classification result for an action.
 * @typedef {'safe'|'dangerous'|'destructive'|'blocked'} SecurityLevel
 */

/**
 * Classify an action's security level.
 *
 * @param {object} action — the action to classify
 * @returns {{level: SecurityLevel, reason: string|null}}
 */
function classify(action) {
  if (!action || !action.action) {
    return { level: 'blocked', reason: 'Invalid action' };
  }

  // Check destructive shortcuts
  for (const [name, pattern] of Object.entries(DESTRUCTIVE_PATTERNS.shortcuts)) {
    if (matchesShortcut(action, pattern)) {
      return { level: 'destructive', reason: `Destructive shortcut: ${name}` };
    }
  }

  // Check destructive type content
  if (action.action === 'type' && DESTRUCTIVE_PATTERNS.typePatterns.test(action.text || '')) {
    return { level: 'destructive', reason: 'Destructive command in type text' };
  }

  // Check dangerous shortcuts
  for (const [name, pattern] of Object.entries(DANGEROUS_PATTERNS.shortcuts)) {
    if (matchesShortcut(action, pattern)) {
      return { level: 'dangerous', reason: `Dangerous shortcut: ${name}` };
    }
  }

  // Check sensitive type content
  if (action.action === 'type' && DANGEROUS_PATTERNS.typePatterns.test(action.text || '')) {
    return { level: 'dangerous', reason: 'Sensitive content in type text' };
  }

  // Check blocked apps
  if (action.action === 'focus' && config.blockedApps.includes(action.app)) {
    return { level: 'blocked', reason: `App "${action.app}" is blocked` };
  }

  // Check allowed apps
  if (action.action === 'focus' && config.allowedApps && !config.allowedApps.includes(action.app)) {
    return { level: 'blocked', reason: `App "${action.app}" is not in allowed list` };
  }

  // Check blocked URLs in navigation
  if (action.action === 'navigate' || (action.action === 'type' && action.context?.isURL)) {
    const url = action.url || action.text || '';
    for (const pattern of config.blockedURLs) {
      if (url.includes(pattern) || new RegExp(pattern, 'i').test(url)) {
        return { level: 'blocked', reason: `URL matches blocked pattern: ${pattern}` };
      }
    }
  }

  // Check blocked keywords
  const actionStr = JSON.stringify(action).toLowerCase();
  for (const keyword of config.blockedKeywords) {
    if (actionStr.includes(keyword.toLowerCase())) {
      return { level: 'blocked', reason: `Action contains blocked keyword: ${keyword}` };
    }
  }

  return { level: 'safe', reason: null };
}

/**
 * Check if an action should be allowed to execute.
 *
 * @param {object} action
 * @returns {{allowed: boolean, needsConfirmation: boolean, reason: string|null}}
 */
function check(action) {
  const { level, reason } = classify(action);

  // Blocked = never allowed
  if (level === 'blocked') {
    audit('BLOCKED', action, reason);
    return { allowed: false, needsConfirmation: false, reason };
  }

  // Destructive = blocked if config says so
  if (level === 'destructive' && config.blockDestructive) {
    audit('BLOCKED_DESTRUCTIVE', action, reason);
    return { allowed: false, needsConfirmation: false, reason: `Destructive action blocked: ${reason}` };
  }

  // Dangerous = needs confirmation if config says so
  if (level === 'dangerous' && config.confirmDangerous) {
    audit('NEEDS_CONFIRMATION', action, reason);
    return { allowed: true, needsConfirmation: true, reason };
  }

  // Rate limiting
  const rateResult = checkRateLimit();
  if (!rateResult.allowed) {
    audit('RATE_LIMITED', action, rateResult.reason);
    return { allowed: false, needsConfirmation: false, reason: rateResult.reason };
  }

  // Safe
  audit('ALLOWED', action, null);
  return { allowed: true, needsConfirmation: false, reason: null };
}

// ── Rate limiting ────────────────────────────────────────

/**
 * Check rate limits.
 *
 * @returns {{allowed: boolean, reason: string|null}}
 */
function checkRateLimit() {
  const now = Date.now();

  // Clean old timestamps (older than 1 minute)
  while (actionTimestamps.length > 0 && actionTimestamps[0] < now - 60000) {
    actionTimestamps.shift();
  }

  // Per-minute limit
  if (actionTimestamps.length >= config.maxActionsPerMinute) {
    return { allowed: false, reason: `Rate limit: ${config.maxActionsPerMinute} actions/minute exceeded` };
  }

  // Per-task limit
  if (taskActionCount >= config.maxActionsPerTask) {
    return { allowed: false, reason: `Task limit: ${config.maxActionsPerTask} actions/task exceeded` };
  }

  actionTimestamps.push(now);
  taskActionCount++;
  return { allowed: true, reason: null };
}

// ── Task lifecycle ───────────────────────────────────────

/**
 * Called when a task starts.
 *
 * @returns {{allowed: boolean, reason: string|null}}
 */
function taskStart() {
  if (activeTasks >= config.maxConcurrentTasks) {
    return { allowed: false, reason: `Max concurrent tasks (${config.maxConcurrentTasks}) reached` };
  }
  activeTasks++;
  taskActionCount = 0;
  audit('TASK_START', null, null);
  return { allowed: true, reason: null };
}

/**
 * Called when a task ends.
 */
function taskEnd() {
  activeTasks = Math.max(0, activeTasks - 1);
  taskActionCount = 0;
  audit('TASK_END', null, null);
}

// ── Audit logging ────────────────────────────────────────

/**
 * Add an audit entry.
 *
 * @param {string} type — ALLOWED, BLOCKED, RATE_LIMITED, etc.
 * @param {object|null} action
 * @param {string|null} reason
 */
function audit(type, action, reason) {
  if (!config.auditLog) return;

  const entry = {
    ts: new Date().toISOString(),
    type,
    action: action ? { action: action.action, app: action.app, item: action.item } : null,
    reason
  };

  auditEntries.push(entry);

  // Trim to max
  while (auditEntries.length > config.maxAuditEntries) {
    auditEntries.shift();
  }

  // Write to file if configured
  if (config.auditPath) {
    try {
      fs.appendFileSync(config.auditPath, JSON.stringify(entry) + '\n');
    } catch {}
  }
}

/**
 * Get audit log entries.
 *
 * @param {number} [limit=100] — max entries to return
 * @param {string} [type] — filter by type
 * @returns {Array}
 */
function getAuditLog(limit = 100, type = null) {
  let entries = auditEntries;
  if (type) entries = entries.filter(e => e.type === type);
  return entries.slice(-limit);
}

/**
 * Get security statistics.
 *
 * @returns {object}
 */
function getStats() {
  const counts = {};
  for (const entry of auditEntries) {
    counts[entry.type] = (counts[entry.type] || 0) + 1;
  }

  return {
    totalActions: auditEntries.length,
    allowed: counts.ALLOWED || 0,
    blocked: (counts.BLOCKED || 0) + (counts.BLOCKED_DESTRUCTIVE || 0),
    rateLimited: counts.RATE_LIMITED || 0,
    confirmations: counts.NEEDS_CONFIRMATION || 0,
    tasks: (counts.TASK_START || 0),
    activeTasks,
    actionsThisMinute: actionTimestamps.length,
    actionsThisTask: taskActionCount
  };
}

// ── Configuration ────────────────────────────────────────

/**
 * Update security configuration.
 *
 * @param {object} updates — partial config to merge
 */
function configure(updates) {
  Object.assign(config, updates);
}

/**
 * Get current security configuration.
 *
 * @returns {object}
 */
function getConfig() {
  return { ...config };
}

/**
 * Reset all state (for testing).
 */
function reset() {
  auditEntries.length = 0;
  actionTimestamps.length = 0;
  taskActionCount = 0;
  activeTasks = 0;
}

module.exports = {
  classify,
  check,
  checkRateLimit,
  taskStart,
  taskEnd,
  audit,
  getAuditLog,
  getStats,
  configure,
  getConfig,
  reset
};
