/**
 * Piggy — Input Abstraction
 * Tries native C driver (hardware-level) first, falls back to RobotJS.
 * If neither is available, provides no-op stubs that log errors.
 *
 * @author Idrissi
 * @license MIT
 */

'use strict';

let driver = null;
let driverName = 'none';

// Try native C driver first (hardware-level, undetectable)
try {
  driver = require('./native/build/Release/piggy_input');
  driverName = 'native';
  console.log('[Piggy] Using native C driver (CoreGraphics kCGHIDEventTap)');
} catch (e) {
  // Fall back to RobotJS
  try {
    const robot = require('robotjs');
    driver = {
      moveMouse:   (x, y) => { robot.moveMouse(Math.round(x), Math.round(y)); return true; },
      clickMouse:  (x, y, btn) => {
        robot.moveMouse(Math.round(x), Math.round(y));
        robot.mouseClick(btn === 1 ? 'right' : 'left');
        return true;
      },
      scrollMouse: (amount) => { robot.scrollMouse(0, amount); return true; },
      getMousePos: () => robot.getMousePos(),
      typeChar:    (ch) => { robot.typeString(ch); return true; },
      keyTap:      (key, mods) => { robot.keyTap(key, mods || []); return true; }
    };
    driverName = 'robotjs';
    console.log('[Piggy] Using RobotJS driver (fallback)');
  } catch (e2) {
    console.error('[Piggy] No input driver available! Mouse and keyboard will not work.');
    // No-op stubs so the app doesn't crash — it just won't control input
    driver = {
      moveMouse:   () => false,
      clickMouse:  () => false,
      scrollMouse: () => false,
      getMousePos: () => ({ x: 0, y: 0 }),
      typeChar:    () => false,
      keyTap:      () => false
    };
  }
}

module.exports = {
  moveMouse:     (x, y) => driver.moveMouse(x, y),
  clickMouse:    (x, y, button) => driver.clickMouse(x, y, button || 0),
  scrollMouse:   (amount) => driver.scrollMouse(amount),
  getMousePos:   () => driver.getMousePos(),
  typeChar:      (ch) => driver.typeChar(ch),
  keyTap:        (key, modifiers) => driver.keyTap(key, modifiers || []),
  getDriverName: () => driverName
};
