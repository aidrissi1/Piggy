/**
 * Piggy — Model Router
 * Routes AI requests to the cheapest model that can handle the task.
 * Tracks token usage, cost, and enforces budget limits.
 *
 * Tier 1 (cheap):     Simple element picking, single clicks, verification
 * Tier 2 (mid):       Multi-step planning, error recovery, form filling
 * Tier 3 (expensive): Complex reasoning, task decomposition, reflection
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

// ── Pricing table (per million tokens) ───────────────────

const PRICING = {
  'claude-haiku-4-5':   { input: 0.80, output: 4.00,  tier: 1 },
  'claude-sonnet-4':    { input: 3.00, output: 15.00, tier: 2 },
  'claude-opus-4':      { input: 15.00, output: 75.00, tier: 3 },
  'gpt-4o':             { input: 2.50, output: 10.00, tier: 2 },
  'gpt-4o-mini':        { input: 0.15, output: 0.60,  tier: 1 },
  'gemini-2.5-flash':   { input: 0.15, output: 0.60,  tier: 1 },
  'gemini-2.5-pro':     { input: 1.25, output: 10.00, tier: 2 }
};

// ── Tier → model preference order ────────────────────────

const TIER_MODELS = {
  1: ['claude-haiku-4-5', 'gpt-4o-mini', 'gemini-2.5-flash'],
  2: ['claude-sonnet-4', 'gpt-4o', 'gemini-2.5-pro'],
  3: ['claude-opus-4', 'claude-sonnet-4', 'gpt-4o']
};

// ── State ────────────────────────────────────────────────

let budget = { maxPerTask: Infinity, maxTotal: Infinity };

const usage = {
  task:    { input: 0, output: 0, cost: 0, calls: 0 },
  session: { input: 0, output: 0, cost: 0, calls: 0 },
  total:   { input: 0, output: 0, cost: 0, calls: 0 }
};

const perModel = {};  // model → { input, output, cost, calls }
const perTier  = {};  // tier → { calls, successes, escalations }
const perClass = { simple: 0, moderate: 0, complex: 0 };

// ── Classification ───────────────────────────────────────

/**
 * Classify a model call by complexity.
 *
 * @param {object} ctx
 * @param {number} [ctx.elementCount=0]     — number of elements on screen
 * @param {string} [ctx.actionType]         — 'click'|'type'|'batch'|'plan'|'reflect'|'recover'
 * @param {number} [ctx.retryCount=0]       — how many retries so far
 * @param {number} [ctx.batchSize=1]        — number of actions in batch
 * @param {boolean} [ctx.hasErrors=false]   — whether errors occurred
 * @param {boolean} [ctx.isReflection=false]— post-task reflection
 * @param {boolean} [ctx.isPlanning=false]  — task decomposition
 * @param {string} [ctx.task]               — task description for keyword analysis
 * @returns {'simple'|'moderate'|'complex'}
 */
function classify(ctx = {}) {
  const {
    elementCount = 0,
    actionType = 'click',
    retryCount = 0,
    batchSize = 1,
    hasErrors = false,
    isReflection = false,
    isPlanning = false,
    task = ''
  } = ctx;

  // Always complex: reflection, planning, error recovery after 2+ retries
  if (isReflection || isPlanning) {
    perClass.complex++;
    return 'complex';
  }
  if (retryCount >= 2 || (hasErrors && retryCount >= 1)) {
    perClass.complex++;
    return 'complex';
  }

  // Complex keywords in task
  const complexKeywords = /\b(plan|analyze|compare|research|summarize|explain|create|design|write|compose|draft)\b/i;
  if (complexKeywords.test(task)) {
    perClass.complex++;
    return 'complex';
  }

  // Moderate: batches, first retry, many elements, form filling
  if (batchSize > 3 || retryCount === 1 || elementCount > 30) {
    perClass.moderate++;
    return 'moderate';
  }
  if (hasErrors) {
    perClass.moderate++;
    return 'moderate';
  }
  const moderateActions = ['batch', 'form', 'recover'];
  if (moderateActions.includes(actionType)) {
    perClass.moderate++;
    return 'moderate';
  }

  // Simple: single action, few elements, no issues
  perClass.simple++;
  return 'simple';
}

// ── Model selection ──────────────────────────────────────

/**
 * Get the best model for a classification.
 *
 * @param {'simple'|'moderate'|'complex'} classification
 * @param {string[]} availableModels — model names the user has configured
 * @returns {string|null} — model name to use, or null if none available
 */
function getModel(classification, availableModels = []) {
  const tierMap = { simple: 1, moderate: 2, complex: 3 };
  const tier = tierMap[classification] || 2;

  // Try preferred models for this tier
  const preferred = TIER_MODELS[tier] || TIER_MODELS[2];
  for (const model of preferred) {
    if (availableModels.includes(model)) return model;
  }

  // Escalate: try higher tiers
  for (let t = tier + 1; t <= 3; t++) {
    for (const model of TIER_MODELS[t]) {
      if (availableModels.includes(model)) return model;
    }
  }

  // Fallback: any available model
  return availableModels[0] || null;
}

// ── Usage tracking ───────────────────────────────────────

/**
 * Calculate cost for a model call.
 *
 * @param {string} model — model name
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number} — cost in dollars
 */
function calculateCost(model, inputTokens, outputTokens) {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

/**
 * Record token usage for a model call.
 *
 * @param {string} model — model name
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {object} [opts]
 * @param {boolean} [opts.success=true] — whether the call succeeded
 */
function trackUsage(model, inputTokens, outputTokens, opts = {}) {
  const cost = calculateCost(model, inputTokens, outputTokens);
  const { success = true } = opts;

  // Accumulate across scopes
  for (const scope of [usage.task, usage.session, usage.total]) {
    scope.input += inputTokens;
    scope.output += outputTokens;
    scope.cost += cost;
    scope.calls++;
  }

  // Per-model tracking
  if (!perModel[model]) {
    perModel[model] = { input: 0, output: 0, cost: 0, calls: 0 };
  }
  const m = perModel[model];
  m.input += inputTokens;
  m.output += outputTokens;
  m.cost += cost;
  m.calls++;

  // Per-tier tracking
  const tier = PRICING[model]?.tier || 2;
  if (!perTier[tier]) {
    perTier[tier] = { calls: 0, successes: 0, escalations: 0 };
  }
  perTier[tier].calls++;
  if (success) perTier[tier].successes++;

  return { cost, totalCost: usage.session.cost };
}

/**
 * Record an escalation (cheap model failed, escalating to expensive one).
 *
 * @param {number} fromTier
 * @param {number} toTier
 */
function recordEscalation(fromTier, toTier) {
  if (!perTier[fromTier]) perTier[fromTier] = { calls: 0, successes: 0, escalations: 0 };
  perTier[fromTier].escalations++;
}

// ── Budget ───────────────────────────────────────────────

/**
 * Set budget limits.
 *
 * @param {number} maxPerTask — max dollars per task
 * @param {number} maxTotal — max dollars total
 */
function setBudget(maxPerTask, maxTotal) {
  budget.maxPerTask = maxPerTask;
  budget.maxTotal = maxTotal;
}

/**
 * Check if the next call would be within budget.
 *
 * @param {string} [model] — model to estimate cost for
 * @param {number} [estInput=1000] — estimated input tokens
 * @param {number} [estOutput=500] — estimated output tokens
 * @returns {boolean}
 */
function isWithinBudget(model, estInput = 1000, estOutput = 500) {
  const estCost = model ? calculateCost(model, estInput, estOutput) : 0;
  return (usage.task.cost + estCost <= budget.maxPerTask) &&
         (usage.total.cost + estCost <= budget.maxTotal);
}

/**
 * Get budget status.
 *
 * @returns {{taskSpent: number, taskLimit: number, totalSpent: number, totalLimit: number, taskRemaining: number, totalRemaining: number}}
 */
function getBudgetStatus() {
  return {
    taskSpent: usage.task.cost,
    taskLimit: budget.maxPerTask,
    totalSpent: usage.total.cost,
    totalLimit: budget.maxTotal,
    taskRemaining: Math.max(0, budget.maxPerTask - usage.task.cost),
    totalRemaining: Math.max(0, budget.maxTotal - usage.total.cost)
  };
}

// ── Cost reporting ───────────────────────────────────────

/**
 * Get cost breakdown.
 *
 * @returns {{task: number, session: number, total: number, breakdown: object}}
 */
function getCost() {
  return {
    task: Math.round(usage.task.cost * 10000) / 10000,
    session: Math.round(usage.session.cost * 10000) / 10000,
    total: Math.round(usage.total.cost * 10000) / 10000,
    breakdown: { ...perModel }
  };
}

/**
 * Get full statistics.
 *
 * @returns {object}
 */
function getStats() {
  const totalCalls = usage.session.calls || 1;

  // Estimate savings vs using Opus for everything
  const opusOnlyCost = ((usage.session.input / 1_000_000) * 15) + ((usage.session.output / 1_000_000) * 75);
  const savings = opusOnlyCost - usage.session.cost;

  return {
    tokens: {
      input: usage.session.input,
      output: usage.session.output,
      total: usage.session.input + usage.session.output
    },
    cost: getCost(),
    calls: {
      total: usage.session.calls,
      perModel: Object.fromEntries(
        Object.entries(perModel).map(([k, v]) => [k, v.calls])
      ),
      perClassification: { ...perClass }
    },
    tiers: { ...perTier },
    budget: getBudgetStatus(),
    costPerCall: Math.round((usage.session.cost / totalCalls) * 10000) / 10000,
    estimatedSavingsVsOpus: Math.round(savings * 10000) / 10000
  };
}

// ── Reset ────────────────────────────────────────────────

/**
 * Reset task-level counters (call between tasks).
 */
function resetTask() {
  usage.task.input = 0;
  usage.task.output = 0;
  usage.task.cost = 0;
  usage.task.calls = 0;
}

/**
 * Reset session-level counters.
 */
function resetSession() {
  resetTask();
  usage.session.input = 0;
  usage.session.output = 0;
  usage.session.cost = 0;
  usage.session.calls = 0;
  for (const k of Object.keys(perModel)) delete perModel[k];
  for (const k of Object.keys(perTier)) delete perTier[k];
  perClass.simple = 0;
  perClass.moderate = 0;
  perClass.complex = 0;
}

/**
 * Get the pricing table.
 *
 * @returns {object}
 */
function getPricing() {
  return { ...PRICING };
}

/**
 * Update pricing for a model.
 *
 * @param {string} model
 * @param {number} input — per million tokens
 * @param {number} output — per million tokens
 */
function updatePricing(model, input, output) {
  if (PRICING[model]) {
    PRICING[model].input = input;
    PRICING[model].output = output;
  } else {
    PRICING[model] = { input, output, tier: 2 };
  }
}

module.exports = {
  classify,
  getModel,
  trackUsage,
  recordEscalation,
  getCost,
  setBudget,
  isWithinBudget,
  getBudgetStatus,
  getStats,
  resetTask,
  resetSession,
  getPricing,
  updatePricing,
  calculateCost
};
