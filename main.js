/**
 * Piggy — Main Process
 * Electron entry point. Wires the 3D renderer to the path engine,
 * screen capture, executor, and AI controller.
 *
 * @author Idrissi
 * @license MIT
 */

'use strict';

const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const path   = require('path');
const input  = require('./input');
const dotenv = require('dotenv');

const { generatePath, estimateDuration } = require('./path-engine');
const { executeMove, executeClick, executeScroll, executeType, executeKeyPress, stopMovement, getStatus } = require('./executor');
const ai = require('./ai-controller');
const a11y = require('./accessibility');
const vision = require('./vision');
const win = require('./windows');
const skills = require('./skills');
const cdp = require('./cdp-adapter');

dotenv.config({ path: path.join(__dirname, '.env') });
ai.init(); // auto-detects provider from OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY

let mainWindow;

// ── Window ────────────────────────────────────────────────

function createWindow() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().size;

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 750,
    title: 'Piggy',
    backgroundColor: '#0a0a0f',
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('init', { screenW, screenH });
  });
}

// ── Cursor ────────────────────────────────────────────────

ipcMain.handle('move-cursor', (_, { dx, dy }) => {
  const pos = input.getMousePos();
  const { width, height } = screen.getPrimaryDisplay().size;
  const x = Math.max(0, Math.min(width, pos.x + dx));
  const y = Math.max(0, Math.min(height, pos.y + dy));
  input.moveMouse(x, y);
  return { x, y };
});

ipcMain.handle('click-cursor', (_, { button }) => {
  const pos2 = input.getMousePos(); input.clickMouse(pos2.x, pos2.y, (button === 'right') ? 1 : 0);
  return { success: true };
});

ipcMain.handle('get-cursor-pos', () => input.getMousePos());

ipcMain.handle('get-screen-size', () => screen.getPrimaryDisplay().size);

ipcMain.handle('scroll-cursor', (_, { dy }) => {
  input.scrollMouse(dy);
  return { success: true };
});

// ── App Focus ─────────────────────────────────────────────

const { execSync } = require('child_process');

/** Sanitize app name to prevent command injection in osascript */
function sanitizeAppName(name) {
  return name.replace(/[\\"]/g, '').replace(/[^a-zA-Z0-9 ._\-()]/g, '');
}

ipcMain.handle('list-apps', async () => {
  try {
    const raw = execSync(
      `osascript -e 'tell application "System Events" to get name of every application process whose visible is true'`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();
    const apps = raw.split(', ').filter(a => a && a !== 'Piggy').sort();
    return { success: true, apps };
  } catch (err) {
    return { success: false, apps: [], error: err.message };
  }
});

/** CDP debugging port for Brave/Chrome */
const CDP_PORT = 9222;

/**
 * Launch or focus an app. For Brave/Chrome, launches with CDP debugging enabled.
 */
async function launchApp(appName) {
  const safe = sanitizeAppName(appName);
  if (!safe) return { success: false, error: 'Invalid app name' };

  const isBrave = safe.toLowerCase().includes('brave');
  const isChrome = safe.toLowerCase().includes('chrome');

  try {
    if (isBrave || isChrome) {
      // Launch with remote debugging port for CDP
      try {
        execSync(`open -a "${safe}" --args --remote-debugging-port=${CDP_PORT}`, { encoding: 'utf8', timeout: 5000 });
      } catch {
        // App may already be running — just focus it
        execSync(`open -a "${safe}"`, { encoding: 'utf8', timeout: 5000 });
      }
      await new Promise(r => setTimeout(r, 1500)); // give CDP time to start

      // Auto-connect CDP if not connected
      if (!cdp.isConnected()) {
        try {
          await cdp.connect(CDP_PORT);
          console.log('[Piggy] CDP auto-connected to', safe);
        } catch (err) {
          console.warn(`[Piggy] CDP connect to ${safe} failed: ${err.message}`);
        }
      }
    } else {
      execSync(`open -a "${safe}"`, { encoding: 'utf8', timeout: 5000 });
      await new Promise(r => setTimeout(r, 800));
    }
    return { success: true, app: safe };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

ipcMain.handle('focus-app', async (_, { appName }) => launchApp(appName));

// ── Window Management ─────────────────────────────────────

ipcMain.handle('list-windows', () => win.listWindows());
ipcMain.handle('resize-window', (_, { app, width, height }) => win.resizeWindow(app, width, height));
ipcMain.handle('move-window', (_, { app, x, y }) => win.moveWindow(app, x, y));
ipcMain.handle('minimize-window', (_, { app }) => win.minimizeWindow(app));
ipcMain.handle('close-window', (_, { app }) => win.closeWindow(app));

// ── Accessibility ─────────────────────────────────────────

ipcMain.handle('get-elements', (_, opts) => a11y.getElements(opts || {}));
ipcMain.handle('find-element', (_, { name, opts }) => a11y.findElement(name, opts || {}));
ipcMain.handle('get-elements-summary', (_, opts) => a11y.getElementsSummary(opts || {}));

// ── Screenshot ────────────────────────────────────────────

async function takeScreenshot(mode = 'screen') {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const scale = display.scaleFactor || 1;

  if (mode === 'window') {
    // Capture just the focused window
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) }
    });

    if (!sources?.length) throw new Error('No window sources');

    // Find the frontmost window (first non-Piggy window)
    const windowSource = sources.find(s => !s.name.includes('Piggy')) || sources[0];
    const thumb    = windowSource.thumbnail;
    const base64   = thumb.toPNG().toString('base64');
    const small    = thumb.resize({ width: 800 });
    const smallB64 = small.toPNG().toString('base64');
    const size     = thumb.getSize();

    return {
      base64, smallBase64: smallB64,
      width: Math.round(size.width / scale), height: Math.round(size.height / scale),
      timestamp: Date.now(), mode: 'window', windowName: windowSource.name
    };
  }

  // Full screen capture
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) }
  });
  if (!sources?.length) throw new Error('No screen sources');

  const thumb    = sources[0].thumbnail;
  const base64   = thumb.toPNG().toString('base64');
  const small    = thumb.resize({ width: 400 });
  const smallB64 = small.toPNG().toString('base64');

  return { base64, smallBase64: smallB64, width, height, timestamp: Date.now(), mode: 'screen' };
}

ipcMain.handle('take-screenshot', async (_, opts) => takeScreenshot(opts?.mode || 'screen'));

// ── Path ──────────────────────────────────────────────────

ipcMain.handle('preview-path', (_, { targetX, targetY }) => {
  const pos = input.getMousePos();
  const points = generatePath(pos.x, pos.y, targetX, targetY);
  return { points, startX: pos.x, startY: pos.y, targetX, targetY, estimatedMs: estimateDuration(points) };
});

const sendPos = (x, y, progress) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mouse-pos-update', { x, y, progress });
  }
};

ipcMain.handle('execute-move', async (_, { targetX, targetY }) => {
  return executeMove(targetX, targetY, { onStep: sendPos });
});

ipcMain.handle('execute-click', async (_, { targetX, targetY, button }) => {
  return executeClick(targetX, targetY, button || 'left', { onStep: sendPos });
});

// ── Keyboard ──────────────────────────────────────────────

ipcMain.handle('execute-type', async (_, { text }) => {
  return executeType(text, {
    onKey: (char, index, total) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('key-pressed', { char, index, total });
      }
    }
  });
});

ipcMain.handle('execute-key', (_, { key, modifiers }) => {
  return executeKeyPress(key, modifiers || [], {
    onKey: (k) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('key-pressed', { char: k, index: 0, total: 1 });
      }
    }
  });
});

ipcMain.handle('stop-movement', () => stopMovement());

ipcMain.handle('get-executor-status', () => getStatus());

// ── Skills ────────────────────────────────────────────────

ipcMain.handle('list-skills', () => skills.list());
ipcMain.handle('execute-skill', async (_, { skill, method, params }) => skills.execute(skill, method, params));

// ── Security Confirmation ─────────────────────────────────

ipcMain.handle('confirm-action', async (_, { action, description }) => {
  const { dialog } = require('electron');
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Allow', 'Deny'],
    defaultId: 1,
    cancelId: 1,
    title: 'Piggy — Action Confirmation',
    message: `AI wants to: ${description}`,
    detail: `Action: ${JSON.stringify(action, null, 2)}\n\nAllow this action?`
  });
  return { approved: result.response === 0 };
});

// ── AI ────────────────────────────────────────────────────

// Queue-based execution: send actions to renderer, wait for completion
function sendToQueue(actions, step) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve({ success: false, steps: 0 });
      return;
    }
    // Listen for queue completion
    const handler = (_, result) => {
      ipcMain.removeListener('ai-queue-done', handler);
      resolve(result);
    };
    ipcMain.on('ai-queue-done', handler);

    // Send actions to renderer queue and trigger execution
    mainWindow.webContents.send('ai-queue-actions', { actions, step });
    setTimeout(() => {
      mainWindow.webContents.send('ai-execute-queue');
    }, 200); // small delay to let queue render
  });
}

function buildTaskOpts(apps, maxSteps) {
  return {
    maxSteps: maxSteps || 25,
    apps,
    captureScreen: takeScreenshot,
    getCursorPos: () => input.getMousePos(),
    focusApp: async (appName) => {
      await launchApp(appName);
    },
    executeClick: async (x, y, button) => {
      return executeClick(x, y, button || 'left');
    },
    executeType: async (text) => {
      return executeType(text);
    },
    executeKey: (key, modifiers) => {
      return executeKeyPress(key, modifiers || []);
    },
    executeScroll: (amount) => {
      return executeScroll(amount);
    },
    navigateBrowser: async (url, appName) => {
      try {
        const safeUrl = url.replace(/'/g, '');
        if (vision.isCDPBrowser(appName)) {
          // CDP navigation for Brave/Chrome
          if (!cdp.isConnected()) await cdp.connect(CDP_PORT);
          await cdp.navigateTo(safeUrl);
        } else {
          // AppleScript navigation for Safari
          execSync(
            `osascript -e 'tell application "Safari" to set URL of current tab of window 1 to "${safeUrl}"'`,
            { encoding: 'utf8', timeout: 10000 }
          );
        }
      } catch (err) {
        console.warn('[Piggy] Navigate failed:', err.message);
      }
    },
    onStep: (info) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ai-step', info);
    }
  };
}

ipcMain.handle('ai-run-task', async (_, { task, maxSteps }) => {
  let apps = [];
  try {
    const raw = execSync(
      `osascript -e 'tell application "System Events" to get name of every application process whose visible is true'`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();
    apps = raw.split(', ').filter(a => a && a !== 'Piggy').sort();
  } catch {}

  return ai.runTask(task, buildTaskOpts(apps, maxSteps));
});

ipcMain.handle('ai-stop', () => { ai.stop(); stopMovement(); return { stopped: true }; });

ipcMain.handle('ai-status', () => ai.status());

// ── Chat ─────────────────────────────────────────────────

ipcMain.handle('ai-chat', async (_, { message, includeScreenshot }) => {
  let screenshot = null;
  if (includeScreenshot) {
    try {
      const shot = await takeScreenshot();
      screenshot = shot.smallBase64;
    } catch (_) {}
  }
  // Get running apps so the model knows what it can focus
  let apps = [];
  try {
    const raw = execSync(
      `osascript -e 'tell application "System Events" to get name of every application process whose visible is true'`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();
    apps = raw.split(', ').filter(a => a && a !== 'Piggy').sort();
  } catch (_) {}
  return ai.chat(message, { screenshot, apps });
});

ipcMain.handle('ai-chat-history', () => ai.getChatHistory());

ipcMain.handle('ai-clear-chat', () => { ai.clearChat(); return { cleared: true }; });

ipcMain.handle('ai-run-from-chat', async (_, { task, maxSteps }) => {
  let apps = [];
  try {
    const raw = execSync(
      `osascript -e 'tell application "System Events" to get name of every application process whose visible is true'`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();
    apps = raw.split(', ').filter(a => a && a !== 'Piggy').sort();
  } catch {}

  return ai.runTaskFromChat(task, buildTaskOpts(apps, maxSteps));
});

// ── App lifecycle ─────────────────────────────────────────

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  cdp.disconnect();
  app.quit();
});
