/**
 * Piggy — Window Management
 * List, resize, move, minimize, and close windows via macOS System Events.
 *
 * @author Idrissi
 * @license MIT
 */

'use strict';

const { execSync } = require('child_process');

function esc(str) {
  return str.replace(/[\\"]/g, '').replace(/[^a-zA-Z0-9 ._\-()]/g, '');
}

/**
 * Get all visible windows with their positions and sizes.
 * @returns {{success: boolean, windows: Array}}
 */
function listWindows() {
  try {
    const script = `tell application "System Events"
      set output to ""
      set allProcs to every application process whose visible is true
      repeat with proc in allProcs
        set procName to name of proc
        try
          set wins to windows of proc
          repeat with w in wins
            set winName to name of w
            set winPos to position of w
            set winSize to size of w
            set output to output & procName & "|" & winName & "|" & (item 1 of winPos) & "|" & (item 2 of winPos) & "|" & (item 1 of winSize) & "|" & (item 2 of winSize) & "\\n"
          end repeat
        end try
      end repeat
      return output
    end tell`;

    const raw = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf8', timeout: 5000
    }).trim();

    const windows = raw.split('\n').filter(Boolean).map(line => {
      const [app, title, x, y, w, h] = line.split('|');
      return {
        app, title,
        x: parseInt(x), y: parseInt(y),
        width: parseInt(w), height: parseInt(h)
      };
    });

    return { success: true, windows };
  } catch (err) {
    return { success: false, windows: [], error: err.message };
  }
}

/**
 * Resize a window.
 * @param {string} appName
 * @param {number} width
 * @param {number} height
 */
function resizeWindow(appName, width, height) {
  const safe = esc(appName);
  try {
    execSync(
      `osascript -e 'tell application "System Events" to set size of window 1 of process "${safe}" to {${width}, ${height}}'`,
      { encoding: 'utf8', timeout: 3000 }
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Move a window to position.
 * @param {string} appName
 * @param {number} x
 * @param {number} y
 */
function moveWindow(appName, x, y) {
  const safe = esc(appName);
  try {
    execSync(
      `osascript -e 'tell application "System Events" to set position of window 1 of process "${safe}" to {${x}, ${y}}'`,
      { encoding: 'utf8', timeout: 3000 }
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Minimize a window.
 * @param {string} appName
 */
function minimizeWindow(appName) {
  const safe = esc(appName);
  try {
    execSync(
      `osascript -e 'tell application "${safe}" to set miniaturized of window 1 to true'`,
      { encoding: 'utf8', timeout: 3000 }
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Close a window.
 * @param {string} appName
 */
function closeWindow(appName) {
  const safe = esc(appName);
  try {
    execSync(
      `osascript -e 'tell application "${safe}" to close window 1'`,
      { encoding: 'utf8', timeout: 3000 }
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { listWindows, resizeWindow, moveWindow, minimizeWindow, closeWindow };
