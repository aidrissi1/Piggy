/**
 * Piggy — Accessibility API
 * Queries macOS Accessibility to find UI elements by name, role, or type.
 * Returns exact coordinates so the AI doesn't have to guess from screenshots.
 *
 * @author Idrissi
 * @license MIT
 */

'use strict';

const { execSync } = require('child_process');

/**
 * Sanitize a string for use in AppleScript.
 */
function esc(str) {
  return str.replace(/[\\"]/g, '').replace(/[^a-zA-Z0-9 ._\-()]/g, '');
}

/**
 * Get all UI elements of the frontmost application.
 * Returns buttons, text fields, links, etc. with their names and positions.
 *
 * @param {object} [opts]
 * @param {string} [opts.app] - Target app name (default: frontmost)
 * @param {string} [opts.role] - Filter by role: 'button', 'textfield', 'link', 'menu', 'all'
 * @returns {{success: boolean, elements: Array<{name: string, role: string, x: number, y: number, width: number, height: number}>}}
 */
function getElements(opts = {}) {
  const role = opts.role || 'all';
  const app = opts.app ? esc(opts.app) : null;

  // AppleScript to query accessibility tree
  const script = app
    ? `tell application "System Events" to tell process "${app}"
        set frontmost to true
        delay 0.2
        set uiElements to entire contents of window 1
        set output to ""
        repeat with el in uiElements
          try
            set elRole to role of el
            set elName to name of el
            set elPos to position of el
            set elSize to size of el
            if elName is not missing value and elName is not "" then
              set output to output & elRole & "|" & elName & "|" & (item 1 of elPos) & "|" & (item 2 of elPos) & "|" & (item 1 of elSize) & "|" & (item 2 of elSize) & "\\n"
            end if
          end try
        end repeat
        return output
      end tell`
    : `tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        tell frontApp
          set uiElements to entire contents of window 1
          set output to appName & "\\n"
          repeat with el in uiElements
            try
              set elRole to role of el
              set elName to name of el
              set elPos to position of el
              set elSize to size of el
              if elName is not missing value and elName is not "" then
                set output to output & elRole & "|" & elName & "|" & (item 1 of elPos) & "|" & (item 2 of elPos) & "|" & (item 1 of elSize) & "|" & (item 2 of elSize) & "\\n"
              end if
            end try
          end repeat
          return output
        end tell
      end tell`;

  try {
    const raw = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf8',
      timeout: 5000
    }).trim();

    const lines = raw.split('\n').filter(Boolean);
    let appName = null;

    // If no app specified, first line is the app name
    if (!app && lines.length > 0) {
      appName = lines.shift();
    }

    const roleMap = {
      'button': 'AXButton',
      'textfield': 'AXTextField',
      'link': 'AXLink',
      'menu': 'AXMenuItem',
      'checkbox': 'AXCheckBox',
      'radio': 'AXRadioButton',
      'tab': 'AXTabGroup',
      'image': 'AXImage',
      'statictext': 'AXStaticText',
      'textarea': 'AXTextArea'
    };

    const filterRole = role !== 'all' ? roleMap[role] || role : null;

    const elements = [];
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 6) continue;

      const [elRole, elName, px, py, sw, sh] = parts;

      if (filterRole && elRole !== filterRole) continue;

      elements.push({
        name: elName,
        role: elRole.replace('AX', '').toLowerCase(),
        x: parseInt(px),
        y: parseInt(py),
        width: parseInt(sw),
        height: parseInt(sh),
        centerX: parseInt(px) + Math.round(parseInt(sw) / 2),
        centerY: parseInt(py) + Math.round(parseInt(sh) / 2)
      });
    }

    return { success: true, app: app || appName, elements, count: elements.length };

  } catch (err) {
    return { success: false, elements: [], count: 0, error: err.message };
  }
}

/**
 * Find a specific element by name.
 * Returns center coordinates for clicking.
 *
 * @param {string} name - Element name (partial match)
 * @param {object} [opts] - Same as getElements
 * @returns {{success: boolean, element: object|null}}
 */
function findElement(name, opts = {}) {
  const result = getElements(opts);
  if (!result.success) return { success: false, element: null, error: result.error };

  const lower = name.toLowerCase();
  const match = result.elements.find(el =>
    el.name.toLowerCase().includes(lower)
  );

  if (match) {
    return { success: true, element: match };
  }

  return { success: true, element: null, error: `Element "${name}" not found` };
}

/**
 * Get a simplified list of interactive elements for AI context.
 * Returns just names, roles, and center coordinates — compact for token efficiency.
 *
 * @param {object} [opts]
 * @returns {string} Formatted list for AI prompt
 */
function getElementsSummary(opts = {}) {
  const result = getElements(opts);
  if (!result.success || result.count === 0) return '';

  return result.elements
    .filter(el => ['button', 'textfield', 'link', 'menuitem', 'checkbox', 'textarea'].includes(el.role))
    .map(el => `[${el.role}] "${el.name}" at (${el.centerX}, ${el.centerY})`)
    .join('\n');
}

module.exports = { getElements, findElement, getElementsSummary };
