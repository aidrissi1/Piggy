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
const robot  = require('robotjs');
const dotenv = require('dotenv');

const { generatePath, estimateDuration } = require('./path-engine');
const { executeMove, executeClick, stopMovement, getStatus } = require('./executor');
const ai = require('./ai-controller');

dotenv.config({ path: path.join(__dirname, '.env') });
if (process.env.OPENAI_API_KEY) ai.init(process.env.OPENAI_API_KEY);

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
  const pos = robot.getMousePos();
  const { width, height } = screen.getPrimaryDisplay().size;
  const x = Math.max(0, Math.min(width, pos.x + dx));
  const y = Math.max(0, Math.min(height, pos.y + dy));
  robot.moveMouse(x, y);
  return { x, y };
});

ipcMain.handle('click-cursor', (_, { button }) => {
  robot.mouseClick(button || 'left');
  return { success: true };
});

ipcMain.handle('get-cursor-pos', () => robot.getMousePos());

ipcMain.handle('get-screen-size', () => screen.getPrimaryDisplay().size);

ipcMain.handle('scroll-cursor', (_, { dy }) => {
  robot.scrollMouse(0, dy);
  return { success: true };
});

// ── Screenshot ────────────────────────────────────────────

async function takeScreenshot() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const scale = display.scaleFactor || 1;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) }
  });
  if (!sources?.length) throw new Error('No screen sources');

  const thumb     = sources[0].thumbnail;
  const base64    = thumb.toPNG().toString('base64');
  const small     = thumb.resize({ width: 400 });
  const smallB64  = small.toPNG().toString('base64');

  return { base64, smallBase64: smallB64, width, height, timestamp: Date.now() };
}

ipcMain.handle('take-screenshot', async () => takeScreenshot());

// ── Path ──────────────────────────────────────────────────

ipcMain.handle('preview-path', (_, { targetX, targetY }) => {
  const pos = robot.getMousePos();
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

ipcMain.handle('stop-movement', () => stopMovement());

ipcMain.handle('get-executor-status', () => getStatus());

// ── AI ────────────────────────────────────────────────────

ipcMain.handle('ai-run-task', async (_, { task, maxSteps }) => {
  return ai.runTask(task, {
    maxSteps: maxSteps || 15,
    captureScreen: takeScreenshot,
    getCursorPos: () => robot.getMousePos(),
    onStep: (info) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ai-step', info);
    },
    onMouseMove: sendPos
  });
});

ipcMain.handle('ai-stop', () => { ai.stop(); stopMovement(); return { stopped: true }; });

ipcMain.handle('ai-status', () => ai.status());

// ── App lifecycle ─────────────────────────────────────────

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
