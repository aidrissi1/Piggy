/**
 * Piggy — Executable Skill Library
 * Stores learned behaviors as executable JavaScript functions.
 * When Piggy completes a task, it generates a reusable skill.
 * Next time the same type of task comes up, the skill runs directly — no model call.
 *
 * This is Piggy's equivalent of muscle memory.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Skill storage ────────────────────────────────────────

const skills = new Map();   // name → Skill object
let skillDir = null;        // persistent storage directory

/**
 * @typedef {object} Skill
 * @property {string} name — unique skill name (kebab-case)
 * @property {string} description — what this skill does
 * @property {string[]} triggers — keywords/phrases that activate this skill
 * @property {string} app — target application
 * @property {Array<object>} actions — ordered list of actions to execute
 * @property {object} params — parameterized values (e.g., {query: null} for search)
 * @property {number} successes — times this skill completed successfully
 * @property {number} failures — times this skill failed
 * @property {number} confidence — 0.0-1.0, based on success rate
 * @property {string} createdAt — ISO timestamp
 * @property {string} updatedAt — ISO timestamp
 * @property {string} source — 'learned' | 'manual' | 'composed'
 */

// ── Initialization ───────────────────────────────────────

/**
 * Initialize the skill library.
 *
 * @param {string} dir — directory to persist skills as JSON files
 */
function init(dir) {
  skillDir = dir;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Load existing skills from disk
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (data.name && data.actions) {
        skills.set(data.name, data);
      }
    } catch {}
  }

  console.log(`[Piggy Skills] Loaded ${skills.size} skills from ${dir}`);
}

// ── Skill creation ───────────────────────────────────────

/**
 * Create a skill from a completed task's action history.
 * Parameterizes variable parts (search queries, URLs, text input).
 *
 * @param {string} taskDescription — the original task
 * @param {Array<object>} actions — the actions that were executed
 * @param {string} app — the app that was used
 * @param {object} [opts]
 * @returns {Skill|null}
 */
function createFromHistory(taskDescription, actions, app, opts = {}) {
  if (!actions || actions.length === 0) return null;

  // Filter to meaningful actions (skip failed finds, redundant focuses)
  const meaningful = actions.filter(a =>
    a.action && !['fail', 'recall'].includes(a.action)
  );

  if (meaningful.length === 0) return null;

  // Generate skill name from task
  const name = generateName(taskDescription);

  // Detect parameters — text that was typed, URLs that were navigated to
  const params = {};
  const parameterized = meaningful.map((action, i) => {
    const a = { ...action };

    // Parameterize typed text
    if (a.action === 'click_type' && a.text) {
      const paramName = detectParamName(a, taskDescription, i);
      params[paramName] = { type: 'string', default: a.text, description: `Text to ${paramName}` };
      a.text = `{{${paramName}}}`;
    }
    if (a.action === 'type' && a.text) {
      const paramName = detectParamName(a, taskDescription, i);
      params[paramName] = { type: 'string', default: a.text, description: `Text to type` };
      a.text = `{{${paramName}}}`;
    }

    // Remove item references (they change between sessions)
    // Keep x,y (the resolved coordinates are session-specific, but the element names persist)
    if (a.item !== undefined) {
      a._originalItem = a.item;
      a._elementName = findElementName(a, actions);
      delete a.item;
    }

    return a;
  });

  // Generate trigger phrases
  const triggers = generateTriggers(taskDescription, app);

  const skill = {
    name,
    description: taskDescription,
    triggers,
    app,
    actions: parameterized,
    params,
    successes: 1,
    failures: 0,
    confidence: 0.5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'learned'
  };

  // Check for duplicates — update existing if similar
  const existing = findSimilar(taskDescription, app);
  if (existing) {
    return mergeSkill(existing, skill);
  }

  skills.set(name, skill);
  persist(skill);
  console.log(`[Piggy Skills] Created skill: "${name}" (${parameterized.length} actions, ${Object.keys(params).length} params)`);
  return skill;
}

/**
 * Create a skill manually with explicit actions.
 *
 * @param {string} name
 * @param {string} description
 * @param {string[]} triggers
 * @param {string} app
 * @param {Array<object>} actions
 * @param {object} [params={}]
 * @returns {Skill}
 */
function create(name, description, triggers, app, actions, params = {}) {
  const skill = {
    name,
    description,
    triggers,
    app,
    actions,
    params,
    successes: 0,
    failures: 0,
    confidence: 0.6,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'manual'
  };

  skills.set(name, skill);
  persist(skill);
  return skill;
}

// ── Skill execution ──────────────────────────────────────

/**
 * Execute a skill by resolving parameters and returning the action sequence.
 * Does NOT execute the actions — returns them for the queue.
 *
 * @param {string} name — skill name
 * @param {object} [paramValues={}] — parameter values to fill in
 * @param {Function} [resolveElement] — async fn(elementName, app) → {x, y} for re-resolving positions
 * @returns {Promise<{actions: Array<object>, skill: Skill}|null>}
 */
async function execute(name, paramValues = {}, resolveElement = null) {
  const skill = skills.get(name);
  if (!skill) return null;

  const resolved = [];

  for (const action of skill.actions) {
    const a = { ...action };

    // Resolve parameter placeholders
    if (a.text && a.text.startsWith('{{') && a.text.endsWith('}}')) {
      const paramName = a.text.slice(2, -2);
      a.text = paramValues[paramName] || skill.params[paramName]?.default || '';
    }

    // Re-resolve element positions if we have element names
    if (a._elementName && resolveElement && (a.action === 'click' || a.action === 'click_type')) {
      try {
        const pos = await resolveElement(a._elementName, skill.app);
        if (pos && pos.x !== undefined) {
          a.x = pos.x;
          a.y = pos.y;
        }
      } catch {}
    }

    resolved.push(a);
  }

  return { actions: resolved, skill };
}

/**
 * Record the outcome of a skill execution.
 *
 * @param {string} name — skill name
 * @param {boolean} success
 */
function recordOutcome(name, success) {
  const skill = skills.get(name);
  if (!skill) return;

  if (success) {
    skill.successes++;
  } else {
    skill.failures++;
  }

  // Recalculate confidence
  const total = skill.successes + skill.failures;
  skill.confidence = total > 0 ? skill.successes / total : 0;

  // Decay skills that keep failing
  if (skill.confidence < 0.2 && total >= 5) {
    console.log(`[Piggy Skills] Skill "${name}" deprecated (confidence: ${skill.confidence})`);
    skill.deprecated = true;
  }

  skill.updatedAt = new Date().toISOString();
  persist(skill);
}

// ── Skill matching ───────────────────────────────────────

/**
 * Find a skill that matches a task description.
 *
 * @param {string} taskDescription
 * @param {string} [app]
 * @returns {Skill|null}
 */
function match(taskDescription, app = null) {
  const lower = taskDescription.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;

  for (const skill of skills.values()) {
    if (skill.deprecated) continue;
    if (skill.confidence < 0.3) continue;
    if (app && skill.app !== app) continue;

    // Score by trigger match
    let score = 0;
    for (const trigger of skill.triggers) {
      const triggerLower = trigger.toLowerCase();
      if (lower.includes(triggerLower)) {
        score += triggerLower.length / lower.length;
      }
      // Check if trigger words appear in task
      const words = triggerLower.split(/\s+/);
      const matchedWords = words.filter(w => lower.includes(w));
      score += (matchedWords.length / words.length) * 0.5;
    }

    // Boost by confidence
    score *= skill.confidence;

    // Boost by success count
    score *= (1 + Math.log2(1 + skill.successes) * 0.1);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = skill;
    }
  }

  // Minimum threshold
  return bestScore > 0.3 ? bestMatch : null;
}

/**
 * Extract parameter values from a task description using a matched skill.
 *
 * @param {Skill} skill
 * @param {string} taskDescription
 * @returns {object} — { paramName: value }
 */
function extractParams(skill, taskDescription) {
  const values = {};

  // For search-type skills, extract the query
  if (skill.params.query) {
    const searchMatch = taskDescription.match(/(?:search|find|look up|google)\s+(?:for\s+)?(.+?)(?:\s+on\s+|\s+in\s+|$)/i);
    if (searchMatch) {
      values.query = searchMatch[1].trim();
    }
  }

  // For navigate-type skills, extract the URL
  if (skill.params.url) {
    const urlMatch = taskDescription.match(/(?:go to|navigate to|open|visit)\s+(\S+)/i);
    if (urlMatch) {
      values.url = urlMatch[1].trim();
    }
  }

  // For type-type skills, extract the text
  if (skill.params.text) {
    const typeMatch = taskDescription.match(/(?:type|write|enter)\s+["']?(.+?)["']?\s*$/i);
    if (typeMatch) {
      values.text = typeMatch[1].trim();
    }
  }

  return values;
}

// ── Skill composition ────────────────────────────────────

/**
 * Compose multiple skills into a workflow.
 *
 * @param {string} name — workflow name
 * @param {string} description
 * @param {string[]} skillNames — ordered skill names to chain
 * @param {object} [paramMapping={}] — map output of one skill to input of next
 * @returns {Skill}
 */
function compose(name, description, skillNames, paramMapping = {}) {
  const allActions = [];
  const allParams = {};

  for (const sn of skillNames) {
    const skill = skills.get(sn);
    if (!skill) {
      console.warn(`[Piggy Skills] Cannot compose: skill "${sn}" not found`);
      continue;
    }
    allActions.push(...skill.actions);
    Object.assign(allParams, skill.params);
  }

  const workflow = create(name, description, [description], '', allActions, allParams);
  workflow.source = 'composed';
  workflow.composedFrom = skillNames;
  persist(workflow);

  console.log(`[Piggy Skills] Composed workflow: "${name}" from [${skillNames.join(', ')}]`);
  return workflow;
}

// ── Helpers ──────────────────────────────────────────────

/**
 * Generate a kebab-case skill name from a description.
 */
function generateName(description) {
  const base = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => !['the', 'a', 'an', 'to', 'in', 'on', 'for', 'and', 'or', 'of', 'with'].includes(w))
    .slice(0, 5)
    .join('-');

  // Ensure unique
  let name = base;
  let counter = 1;
  while (skills.has(name)) {
    name = `${base}-${counter++}`;
  }
  return name;
}

/**
 * Generate trigger phrases from a task description.
 */
function generateTriggers(description, app) {
  const triggers = [description.toLowerCase()];

  // Extract key verb + object patterns
  const patterns = [
    /\b(search|find|look up|google)\s+(?:for\s+)?(.+?)(?:\s+on|\s+in|$)/i,
    /\b(go to|navigate|visit|open)\s+(.+?)(?:\s+in|$)/i,
    /\b(type|write|enter)\s+(.+?)(?:\s+in|$)/i,
    /\b(click|press|tap)\s+(.+?)$/i
  ];

  for (const p of patterns) {
    const m = description.match(p);
    if (m) {
      triggers.push(`${m[1]} ${m[2]}`.toLowerCase().trim());
    }
  }

  if (app) triggers.push(`${app.toLowerCase()}`);

  return [...new Set(triggers)];
}

/**
 * Detect parameter name from context.
 */
function detectParamName(action, task, index) {
  const lower = task.toLowerCase();
  if (/search|find|query|look up/i.test(lower)) return 'query';
  if (/url|website|navigate|go to/i.test(lower)) return 'url';
  if (action.action === 'click_type') return 'input_text';
  return `text_${index}`;
}

/**
 * Find the element name associated with an action (from the scan context).
 */
function findElementName(action, allActions) {
  // Look for a preceding find action that returned these coordinates
  if (action.x !== undefined && action.y !== undefined) {
    return `element_at_${action.x}_${action.y}`;
  }
  return null;
}

/**
 * Find a similar existing skill.
 */
function findSimilar(description, app) {
  const lower = description.toLowerCase();
  for (const skill of skills.values()) {
    if (skill.app !== app) continue;
    // Simple similarity: >60% word overlap
    const skillWords = new Set(skill.description.toLowerCase().split(/\s+/));
    const taskWords = lower.split(/\s+/);
    const overlap = taskWords.filter(w => skillWords.has(w)).length;
    if (overlap / taskWords.length > 0.6) return skill;
  }
  return null;
}

/**
 * Merge a new skill into an existing one.
 */
function mergeSkill(existing, newSkill) {
  existing.successes++;
  existing.confidence = existing.successes / (existing.successes + existing.failures);
  existing.updatedAt = new Date().toISOString();

  // If new skill has more actions (more complete), update the actions
  if (newSkill.actions.length > existing.actions.length) {
    existing.actions = newSkill.actions;
    existing.params = { ...existing.params, ...newSkill.params };
  }

  // Merge triggers
  const allTriggers = new Set([...existing.triggers, ...newSkill.triggers]);
  existing.triggers = [...allTriggers];

  persist(existing);
  console.log(`[Piggy Skills] Updated skill: "${existing.name}" (confidence: ${Math.round(existing.confidence * 100)}%)`);
  return existing;
}

/**
 * Persist a skill to disk.
 */
function persist(skill) {
  if (!skillDir) return;
  try {
    fs.writeFileSync(
      path.join(skillDir, `${skill.name}.json`),
      JSON.stringify(skill, null, 2)
    );
  } catch {}
}

// ── Info ─────────────────────────────────────────────────

/**
 * List all skills.
 *
 * @returns {Array<{name: string, description: string, confidence: number, successes: number, app: string}>}
 */
function list() {
  return Array.from(skills.values()).map(s => ({
    name: s.name,
    description: s.description,
    confidence: Math.round(s.confidence * 100),
    successes: s.successes,
    failures: s.failures,
    app: s.app,
    source: s.source,
    paramCount: Object.keys(s.params).length,
    actionCount: s.actions.length,
    deprecated: !!s.deprecated
  }));
}

/**
 * Get a skill by name.
 */
function get(name) {
  return skills.get(name) || null;
}

/**
 * Delete a skill.
 */
function remove(name) {
  skills.delete(name);
  if (skillDir) {
    try { fs.unlinkSync(path.join(skillDir, `${name}.json`)); } catch {}
  }
}

/**
 * Get skill count.
 */
function count() {
  return skills.size;
}

module.exports = {
  init,
  createFromHistory,
  create,
  execute,
  recordOutcome,
  match,
  extractParams,
  compose,
  list,
  get,
  remove,
  count
};
