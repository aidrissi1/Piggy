/**
 * Piggy — Skill System
 * Pluggable tools that extend what the AI can do beyond mouse and keyboard.
 * Each skill registers actions the model can call.
 *
 * @author Idrissi
 * @license MIT
 */

'use strict';

const skills = {};

/**
 * Register a skill.
 * @param {string} name - Skill name (used in AI prompt)
 * @param {object} skill
 * @param {string} skill.description - What this skill does (shown to AI)
 * @param {object} skill.actions - Map of action names → handler functions
 */
function register(name, skill) {
  skills[name] = skill;
  console.log(`[Piggy Skill] Registered: ${name} — ${skill.description}`);
}

/**
 * Get all registered skills formatted for the AI prompt.
 * @returns {string}
 */
function getSkillsPrompt() {
  const lines = [];
  for (const [name, skill] of Object.entries(skills)) {
    lines.push(`Skill "${name}": ${skill.description}`);
    for (const [action, handler] of Object.entries(skill.actions)) {
      lines.push(`  {"action":"skill","skill":"${name}","method":"${action}"${handler.params ? ',' + handler.params : ''}}`);
    }
  }
  return lines.length ? '\nAvailable skills:\n' + lines.join('\n') : '';
}

/**
 * Execute a skill action.
 * @param {string} skillName
 * @param {string} method
 * @param {object} params
 * @returns {Promise<object>}
 */
async function execute(skillName, method, params = {}) {
  const skill = skills[skillName];
  if (!skill) return { success: false, error: `Unknown skill: ${skillName}` };

  const handler = skill.actions[method];
  if (!handler) return { success: false, error: `Unknown method: ${skillName}.${method}` };

  try {
    return await handler.run(params);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * List registered skills.
 */
function list() {
  return Object.entries(skills).map(([name, s]) => ({
    name,
    description: s.description,
    actions: Object.keys(s.actions)
  }));
}

// ── Built-in Skills ──────────────────────────────────────

// Clipboard skill
register('clipboard', {
  description: 'Read and write the system clipboard',
  actions: {
    read: {
      params: '',
      run: async () => {
        const { clipboard } = require('electron');
        return { success: true, text: clipboard.readText() };
      }
    },
    write: {
      params: '"text":"content to copy"',
      run: async (params) => {
        const { clipboard } = require('electron');
        clipboard.writeText(params.text || '');
        return { success: true };
      }
    }
  }
});

// Shell skill (non-destructive commands only)
register('shell', {
  description: 'Run safe shell commands (read-only: ls, cat, pwd, which, echo)',
  actions: {
    run: {
      params: '"command":"ls -la"',
      run: async (params) => {
        const { execSync } = require('child_process');
        const cmd = params.command || '';

        // Whitelist safe commands
        const safe = /^(ls|cat|pwd|which|echo|whoami|date|uptime|df|du|head|tail|wc|grep|find|file)\b/;
        if (!safe.test(cmd.trim())) {
          return { success: false, error: 'Command not allowed. Only read-only commands permitted.' };
        }

        try {
          const output = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
          return { success: true, output: output.slice(0, 2000) }; // cap output
        } catch (err) {
          return { success: false, error: err.message };
        }
      }
    }
  }
});

// URL skill
register('url', {
  description: 'Open URLs in the default browser',
  actions: {
    open: {
      params: '"url":"https://example.com"',
      run: async (params) => {
        const { shell } = require('electron');
        if (params.url && /^https?:\/\//i.test(params.url)) {
          await shell.openExternal(params.url);
          return { success: true };
        }
        return { success: false, error: 'Invalid URL' };
      }
    }
  }
});

module.exports = { register, getSkillsPrompt, execute, list };
