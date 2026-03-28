/**
 * Piggy — Plugin System
 * Extensible architecture for adding capabilities to Piggy.
 * Plugins can add new actions, vision providers, model providers, and hooks.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Plugin registry ──────────────────────────────────────

const plugins = new Map();      // name → plugin instance
const actions = new Map();       // action name → handler
const visionProviders = [];      // additional vision scanners
const hooks = {
  beforeTask:   [],  // (task, opts) → modified opts
  afterTask:    [],  // (task, result) → void
  beforeStep:   [],  // (step, actions) → modified actions
  afterStep:    [],  // (step, result) → void
  beforeAction: [],  // (action) → modified action or null (cancel)
  afterAction:  [],  // (action, result) → void
  onError:      [],  // (error, context) → recovery action or null
  onNavigate:   [],  // (fromURL, toURL) → void
  onScan:       []   // (elements) → modified elements
};

// ── Plugin interface ─────────────────────────────────────

/**
 * @typedef {object} PiggyPlugin
 * @property {string} name — unique plugin name
 * @property {string} version — semver version
 * @property {string} [description] — what it does
 * @property {string} [author] — who made it
 * @property {Function} [init] — called when plugin is loaded, receives piggy context
 * @property {Function} [destroy] — called when plugin is unloaded
 * @property {object} [actions] — { actionName: handler(action, context) }
 * @property {Function} [scan] — additional vision scanner: (appName) → elements[]
 * @property {object} [hooks] — { hookName: handler }
 */

// ── Core API ─────────────────────────────────────────────

/**
 * Register a plugin.
 *
 * @param {PiggyPlugin} plugin
 * @param {object} [context] — piggy context passed to plugin.init()
 * @returns {boolean} — true if registered successfully
 */
function register(plugin, context = {}) {
  if (!plugin || !plugin.name) {
    console.warn('[Piggy Plugins] Plugin missing name');
    return false;
  }

  if (plugins.has(plugin.name)) {
    console.warn(`[Piggy Plugins] Plugin "${plugin.name}" already registered`);
    return false;
  }

  // Register custom actions
  if (plugin.actions) {
    for (const [name, handler] of Object.entries(plugin.actions)) {
      if (actions.has(name)) {
        console.warn(`[Piggy Plugins] Action "${name}" already registered by another plugin`);
        continue;
      }
      actions.set(name, { handler, plugin: plugin.name });
      console.log(`[Piggy Plugin] ${plugin.name}: registered action "${name}"`);
    }
  }

  // Register vision provider
  if (typeof plugin.scan === 'function') {
    visionProviders.push({ name: plugin.name, scan: plugin.scan });
    console.log(`[Piggy Plugin] ${plugin.name}: registered vision provider`);
  }

  // Register hooks
  if (plugin.hooks) {
    for (const [hookName, handler] of Object.entries(plugin.hooks)) {
      if (hooks[hookName]) {
        hooks[hookName].push({ handler, plugin: plugin.name });
        console.log(`[Piggy Plugin] ${plugin.name}: registered hook "${hookName}"`);
      }
    }
  }

  // Initialize
  if (typeof plugin.init === 'function') {
    try {
      plugin.init(context);
    } catch (err) {
      console.warn(`[Piggy Plugin] ${plugin.name}: init failed:`, err.message);
    }
  }

  plugins.set(plugin.name, plugin);
  console.log(`[Piggy Plugin] Loaded: ${plugin.name} v${plugin.version || '0.0.0'}`);
  return true;
}

/**
 * Unregister a plugin.
 *
 * @param {string} name
 */
function unregister(name) {
  const plugin = plugins.get(name);
  if (!plugin) return;

  // Remove actions
  for (const [actionName, meta] of actions.entries()) {
    if (meta.plugin === name) actions.delete(actionName);
  }

  // Remove vision provider
  const idx = visionProviders.findIndex(v => v.name === name);
  if (idx >= 0) visionProviders.splice(idx, 1);

  // Remove hooks
  for (const hookList of Object.values(hooks)) {
    for (let i = hookList.length - 1; i >= 0; i--) {
      if (hookList[i].plugin === name) hookList.splice(i, 1);
    }
  }

  // Destroy
  if (typeof plugin.destroy === 'function') {
    try { plugin.destroy(); } catch {}
  }

  plugins.delete(name);
  console.log(`[Piggy Plugin] Unloaded: ${name}`);
}

/**
 * Load plugins from a directory.
 * Each plugin is a .js file that exports a PiggyPlugin object.
 *
 * @param {string} dir — directory path
 * @param {object} [context]
 * @returns {number} — number of plugins loaded
 */
function loadDir(dir, context = {}) {
  if (!fs.existsSync(dir)) return 0;

  let count = 0;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));

  for (const file of files) {
    try {
      const plugin = require(path.join(dir, file));
      if (register(plugin, context)) count++;
    } catch (err) {
      console.warn(`[Piggy Plugin] Failed to load ${file}:`, err.message);
    }
  }

  return count;
}

// ── Action execution ─────────────────────────────────────

/**
 * Check if an action is handled by a plugin.
 *
 * @param {string} actionName
 * @returns {boolean}
 */
function hasAction(actionName) {
  return actions.has(actionName);
}

/**
 * Execute a plugin action.
 *
 * @param {string} actionName
 * @param {object} action — full action object
 * @param {object} context — execution context
 * @returns {Promise<{success: boolean, result: *, error: string|null}>}
 */
async function executeAction(actionName, action, context = {}) {
  const meta = actions.get(actionName);
  if (!meta) return { success: false, result: null, error: `Unknown plugin action: ${actionName}` };

  try {
    const result = await meta.handler(action, context);
    return { success: true, result, error: null };
  } catch (err) {
    return { success: false, result: null, error: err.message };
  }
}

// ── Hook execution ───────────────────────────────────────

/**
 * Run all hooks of a given type.
 *
 * @param {string} hookName
 * @param {...*} args — arguments to pass to hooks
 * @returns {*} — last non-null return value, or first argument
 */
async function runHooks(hookName, ...args) {
  const hookList = hooks[hookName];
  if (!hookList || hookList.length === 0) return args[0];

  let result = args[0];
  for (const { handler, plugin } of hookList) {
    try {
      const ret = await handler(...args);
      if (ret !== undefined && ret !== null) result = ret;
    } catch (err) {
      console.warn(`[Piggy Plugin] Hook ${hookName} failed in ${plugin}:`, err.message);
    }
  }
  return result;
}

// ── Vision providers ─────────────────────────────────────

/**
 * Run all plugin vision providers and merge results.
 *
 * @param {string} appName
 * @returns {Promise<Array>} — combined elements
 */
async function scanAll(appName) {
  const allElements = [];
  for (const { name, scan } of visionProviders) {
    try {
      const elements = await scan(appName);
      if (Array.isArray(elements)) {
        allElements.push(...elements);
      }
    } catch (err) {
      console.warn(`[Piggy Plugin] Vision scan failed for ${name}:`, err.message);
    }
  }
  return allElements;
}

// ── Info ─────────────────────────────────────────────────

/**
 * Get list of loaded plugins.
 *
 * @returns {Array<{name: string, version: string, description: string, actions: string[], hooks: string[]}>}
 */
function list() {
  return Array.from(plugins.values()).map(p => ({
    name: p.name,
    version: p.version || '0.0.0',
    description: p.description || '',
    actions: Object.keys(p.actions || {}),
    hooks: Object.keys(p.hooks || {})
  }));
}

/**
 * Get all registered custom action names.
 *
 * @returns {string[]}
 */
function getActions() {
  return Array.from(actions.keys());
}

/**
 * Get all registered hook counts.
 *
 * @returns {object}
 */
function getHookCounts() {
  const counts = {};
  for (const [name, list] of Object.entries(hooks)) {
    if (list.length > 0) counts[name] = list.length;
  }
  return counts;
}

module.exports = {
  register,
  unregister,
  loadDir,
  hasAction,
  executeAction,
  runHooks,
  scanAll,
  list,
  getActions,
  getHookCounts
};
