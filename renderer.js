/**
 * Piggy — Renderer
 * Three.js 3D mouse on a desk surface + test panel logic + screenshot viewer.
 *
 * @author Idrissi
 * @license MIT
 */

'use strict';

const THREE = require('three');
const { ipcRenderer } = require('electron');

// ── IPC shortcuts ─────────────────────────────────────────

const api = {
  moveCursor:     (dx, dy) => ipcRenderer.invoke('move-cursor', { dx, dy }),
  clickCursor:    (btn)    => ipcRenderer.invoke('click-cursor', { button: btn }),
  getCursorPos:   ()       => ipcRenderer.invoke('get-cursor-pos'),
  scrollCursor:   (dy)     => ipcRenderer.invoke('scroll-cursor', { dy }),
  takeScreenshot: (mode)   => ipcRenderer.invoke('take-screenshot', { mode: mode || 'screen' }),
  previewPath:    (x, y)   => ipcRenderer.invoke('preview-path', { targetX: x, targetY: y }),
  executeMove:    (x, y)   => ipcRenderer.invoke('execute-move', { targetX: x, targetY: y }),
  executeClick:   (x, y, b) => ipcRenderer.invoke('execute-click', { targetX: x, targetY: y, button: b }),
  executeType:    (text)   => ipcRenderer.invoke('execute-type', { text }),
  executeKey:     (key, mods) => ipcRenderer.invoke('execute-key', { key, modifiers: mods }),
  stopMovement:   ()       => ipcRenderer.invoke('stop-movement')
};

// ── Three.js Scene ────────────────────────────────────────

const canvas    = document.getElementById('canvas');
const container = document.getElementById('scene-container');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a12);
scene.fog = new THREE.Fog(0x0a0a12, 15, 30);

// Use fallback size since sim page may be hidden on init
const initW = container.clientWidth || 800;
const initH = container.clientHeight || 600;

const camera = new THREE.PerspectiveCamera(50, initW / initH, 0.1, 100);
camera.position.set(0, 6, 8);
camera.lookAt(0, 0, 0);

const gl = new THREE.WebGLRenderer({ canvas, antialias: true });
gl.setSize(initW, initH);
gl.setPixelRatio(window.devicePixelRatio);
gl.shadowMap.enabled = true;
gl.shadowMap.type = THREE.PCFSoftShadowMap;

// Lights
scene.add(new THREE.AmbientLight(0x404060, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(5, 10, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);

const accentA = new THREE.PointLight(0xa855f7, 0.8, 15);
accentA.position.set(-3, 3, -2);
scene.add(accentA);

const accentB = new THREE.PointLight(0x7c3aed, 0.4, 10);
accentB.position.set(3, 2, 3);
scene.add(accentB);

// Desk
const deskGeo = new THREE.BoxGeometry(12, 0.15, 8);
const desk = new THREE.Mesh(deskGeo, new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.3, metalness: 0.1 }));
desk.position.y = -0.075;
desk.receiveShadow = true;
scene.add(desk);
scene.add(new THREE.GridHelper(12, 24, 0x2a2a4a, 0x1a1a3a));

const border = new THREE.LineSegments(
  new THREE.EdgesGeometry(deskGeo),
  new THREE.LineBasicMaterial({ color: 0xa855f7, transparent: true, opacity: 0.25 })
);
border.position.y = -0.075;
scene.add(border);

// ── 3D Monitor (shows screenshots on desk) ───────────────

const monitorGrp = new THREE.Group();

// Stand
const standGeo = new THREE.BoxGeometry(0.3, 0.6, 0.15);
const standMat = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.3, metalness: 0.5 });
const stand = new THREE.Mesh(standGeo, standMat);
stand.position.set(0, 0.3, 0);
monitorGrp.add(stand);

// Base
const baseGeo = new THREE.BoxGeometry(1.2, 0.06, 0.5);
const base = new THREE.Mesh(baseGeo, standMat);
base.position.set(0, 0.03, 0);
monitorGrp.add(base);

// Screen frame (bezel)
const frameGeo = new THREE.BoxGeometry(5.5, 3.3, 0.1);
const frameMat = new THREE.MeshStandardMaterial({ color: 0x111118, roughness: 0.2, metalness: 0.7 });
const frame = new THREE.Mesh(frameGeo, frameMat);
frame.position.set(0, 2.25, 0);
monitorGrp.add(frame);

// Screen surface — 16:10 aspect ratio to match macOS, high-res canvas
const screenGeo = new THREE.PlaneGeometry(5.0, 3.125);
const screenCanvas = document.createElement('canvas');
screenCanvas.width = 1600;
screenCanvas.height = 1000;
const screenCtx = screenCanvas.getContext('2d');
screenCtx.fillStyle = '#0a0a12';
screenCtx.fillRect(0, 0, 1600, 1000);
screenCtx.fillStyle = '#333';
screenCtx.font = '36px sans-serif';
screenCtx.textAlign = 'center';
screenCtx.fillText('No screenshot yet', 800, 510);

const screenTex = new THREE.CanvasTexture(screenCanvas);
screenTex.minFilter = THREE.LinearFilter;
screenTex.magFilter = THREE.LinearFilter;
const screenMat = new THREE.MeshBasicMaterial({ map: screenTex });
const screenMesh = new THREE.Mesh(screenGeo, screenMat);
screenMesh.position.set(0, 2.25, 0.06);
monitorGrp.add(screenMesh);

// LED indicator on bezel bottom
const monLedGeo = new THREE.BoxGeometry(0.08, 0.08, 0.02);
const monLedMat = new THREE.MeshStandardMaterial({ color: 0xa855f7, emissive: 0xa855f7, emissiveIntensity: 0.8 });
const monLed = new THREE.Mesh(monLedGeo, monLedMat);
monLed.position.set(0, 0.68, 0.06);
monitorGrp.add(monLed);

monitorGrp.position.set(0, 0, -3.2);
scene.add(monitorGrp);

/** Update the 3D monitor with a screenshot base64 */
function updateMonitorScreen(base64) {
  const img = new Image();
  img.onload = () => {
    screenCtx.clearRect(0, 0, 1600, 1000);
    screenCtx.drawImage(img, 0, 0, 1600, 1000);
    screenTex.needsUpdate = true;
  };
  img.src = `data:image/png;base64,${base64}`;
}

// ── 3D Mouse ──────────────────────────────────────────────

const mouseGrp = new THREE.Group();

const shape = new THREE.Shape();
shape.moveTo(-0.35, -0.6);
shape.quadraticCurveTo(-0.4, 0, -0.3, 0.5);
shape.quadraticCurveTo(0, 0.7, 0.3, 0.5);
shape.quadraticCurveTo(0.4, 0, 0.35, -0.6);
shape.quadraticCurveTo(0, -0.7, -0.35, -0.6);

const body = new THREE.Mesh(
  new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.05, bevelSegments: 8 }),
  new THREE.MeshStandardMaterial({ color: 0x2a2a3a, roughness: 0.2, metalness: 0.6 })
);
body.rotation.x = -Math.PI / 2;
body.position.y = 0.1;
body.castShadow = true;
mouseGrp.add(body);

const wheel = new THREE.Mesh(
  new THREE.CylinderGeometry(0.04, 0.04, 0.2, 16),
  new THREE.MeshStandardMaterial({ color: 0xa855f7, roughness: 0.5, metalness: 0.8 })
);
wheel.rotation.z = Math.PI / 2;
wheel.position.set(0, 0.38, 0.15);
mouseGrp.add(wheel);

const ledMat = new THREE.MeshStandardMaterial({ color: 0xa855f7, emissive: 0xa855f7, emissiveIntensity: 0.8, transparent: true, opacity: 0.7 });
const ledGeo = new THREE.BoxGeometry(0.02, 0.08, 0.8);
const ledL = new THREE.Mesh(ledGeo, ledMat); ledL.position.set(-0.36, 0.2, 0); mouseGrp.add(ledL);
const ledR = ledL.clone(); ledR.position.set(0.36, 0.2, 0); mouseGrp.add(ledR);

const btnMat = new THREE.MeshStandardMaterial({ color: 0xa855f7, emissive: 0xa855f7, emissiveIntensity: 0.3 });
const btnGeo = new THREE.BoxGeometry(0.01, 0.02, 0.4);
const btnL = new THREE.Mesh(btnGeo, btnMat); btnL.position.set(-0.1, 0.4, 0.3); mouseGrp.add(btnL);
const btnR = btnL.clone(); btnR.position.set(0.1, 0.4, 0.3); mouseGrp.add(btnR);

mouseGrp.add(new THREE.Mesh(
  new THREE.BoxGeometry(0.005, 0.01, 0.5),
  new THREE.MeshStandardMaterial({ color: 0x555577 })
).translateY(0.39).translateZ(0.2));

mouseGrp.add(new THREE.Mesh(
  new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.1, 0.65), new THREE.Vector3(0, 0.05, 1.2),
    new THREE.Vector3(0.2, 0.02, 2), new THREE.Vector3(0.5, 0.02, 3)
  ]), 20, 0.02, 8, false),
  new THREE.MeshStandardMaterial({ color: 0x333344, roughness: 0.8 })
));

scene.add(mouseGrp);

// ── 3D Keyboard ───────────────────────────────────────────

const kbGroup = new THREE.Group();
const keyMeshes = {};

const ROWS = [
  { chars: '1234567890',  z: -0.75, w: 0.26, xOff: 0 },
  { chars: 'qwertyuiop',  z: -0.40, w: 0.26, xOff: 0 },
  { chars: 'asdfghjkl',   z: -0.05, w: 0.26, xOff: 0.14 },
  { chars: 'zxcvbnm',     z:  0.30, w: 0.26, xOff: 0.35 }
];

const keyBaseMat = new THREE.MeshStandardMaterial({ color: 0x2a2a3e, roughness: 0.35, metalness: 0.3 });
const keyGlowMat = new THREE.MeshStandardMaterial({ color: 0xa855f7, emissive: 0xa855f7, emissiveIntensity: 1.5, roughness: 0.3, metalness: 0.5 });

// Base plate
const platGeo = new THREE.BoxGeometry(3.4, 0.06, 2.2);
const plate = new THREE.Mesh(platGeo, new THREE.MeshStandardMaterial({ color: 0x18182a, roughness: 0.2, metalness: 0.5 }));
plate.position.y = 0.03;
plate.receiveShadow = true;
kbGroup.add(plate);

// Create text labels using canvas textures
function makeKeyLabel(char) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2a2a3e';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#8888aa';
  ctx.font = 'bold 32px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(char.toUpperCase(), 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

ROWS.forEach(row => {
  const totalW = row.chars.length * (row.w + 0.06);
  const startX = -totalW / 2 + row.xOff;

  for (let i = 0; i < row.chars.length; i++) {
    const ch = row.chars[i];
    const keyGeo = new THREE.BoxGeometry(row.w, 0.1, 0.28);

    // Top face gets the label texture
    const materials = [
      keyBaseMat.clone(), keyBaseMat.clone(), // left, right
      new THREE.MeshStandardMaterial({ map: makeKeyLabel(ch), roughness: 0.4 }), // top
      keyBaseMat.clone(), // bottom
      keyBaseMat.clone(), keyBaseMat.clone()  // front, back
    ];

    const key = new THREE.Mesh(keyGeo, materials);
    key.position.set(startX + i * (row.w + 0.06), 0.11, row.z);
    key.castShadow = true;
    kbGroup.add(key);
    keyMeshes[ch] = key;
  }
});

// Space bar
const spaceMats = [
  keyBaseMat.clone(), keyBaseMat.clone(),
  new THREE.MeshStandardMaterial({ map: makeKeyLabel('___'), roughness: 0.4 }),
  keyBaseMat.clone(), keyBaseMat.clone(), keyBaseMat.clone()
];
const spaceKey = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 0.28), spaceMats);
spaceKey.position.set(0.2, 0.11, 0.65);
kbGroup.add(spaceKey);
keyMeshes[' '] = spaceKey;
keyMeshes['space'] = spaceKey;

// Enter key
const enterMats = [
  keyBaseMat.clone(), keyBaseMat.clone(),
  new THREE.MeshStandardMaterial({ map: makeKeyLabel('RET'), roughness: 0.4 }),
  keyBaseMat.clone(), keyBaseMat.clone(), keyBaseMat.clone()
];
const enterKey = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.1, 0.28), enterMats);
enterKey.position.set(1.6, 0.11, -0.05);
kbGroup.add(enterKey);
keyMeshes['enter'] = enterKey;
keyMeshes['\n'] = enterKey;

kbGroup.position.set(-3.0, 0, 2.0);
kbGroup.rotation.y = 0.2;
kbGroup.rotation.x = -0.05;
scene.add(kbGroup);

// Flash a key on the 3D keyboard
const activeKeys = [];

function flashKey(char) {
  const ch = char.toLowerCase();
  const mesh = keyMeshes[ch];
  if (!mesh) return;

  // Skip if this key is already flashing (prevent stacking)
  if (activeKeys.some(ak => ak.mesh === mesh)) return;

  // Store original materials and swap top face to glow (reuse, don't clone)
  const origMats = Array.isArray(mesh.material) ? mesh.material.slice() : [mesh.material];

  if (Array.isArray(mesh.material)) {
    const mats = mesh.material.slice();
    mats[2] = keyGlowMat;
    mesh.material = mats;
  } else {
    mesh.material = keyGlowMat;
  }
  mesh.position.y = 0.07;

  activeKeys.push({ mesh, origMats, origY: 0.11, life: 1.0 });
}

// Trail
const trails = [];
const tGeo = new THREE.SphereGeometry(0.03, 6, 6);
const tMat = new THREE.MeshBasicMaterial({ color: 0xa855f7, transparent: true, opacity: 0.5 });
for (let i = 0; i < 20; i++) { const m = new THREE.Mesh(tGeo, tMat.clone()); m.visible = false; scene.add(m); trails.push({ mesh: m, life: 0 }); }

// Path line
let pathLine = null;
function showPath(pts, sw, sh) {
  if (pathLine) { scene.remove(pathLine); pathLine = null; }
  if (!pts || pts.length < 2) return;
  const v = pts.map(p => new THREE.Vector3((p.x / sw - 0.5) * 12, 0.03, (p.y / sh - 0.5) * 8));
  const g = new THREE.BufferGeometry().setFromPoints(v);
  pathLine = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0x10b981, dashSize: 0.15, gapSize: 0.1, transparent: true, opacity: 0.6 }));
  pathLine.computeLineDistances();
  scene.add(pathLine);
}
function clearPath() { if (pathLine) { scene.remove(pathLine); pathLine = null; } }

// ── State ─────────────────────────────────────────────────

let mPos = { x: 0, z: 0 }, mVel = { x: 0, z: 0 };
let speed = 5, moving = false, mode = 'keyboard';
let clickFlash = 0, scrollAnim = 0, trailTick = 0;
let screenW = 1440, screenH = 900;
const keys = {};
const shots = [];
let shotIdx = -1;

// ── Events from main ──────────────────────────────────────

ipcRenderer.on('init', (_, d) => { screenW = d.screenW; screenH = d.screenH; });
ipcRenderer.on('mouse-pos-update', (_, { x, y }) => { mPos.x = (x / screenW - 0.5) * 12; mPos.z = (y / screenH - 0.5) * 8; moving = true; });
ipcRenderer.on('mouse-clicked', () => { clickFlash = 1; });
ipcRenderer.on('key-pressed', (_, { char }) => { flashKey(char); });

ipcRenderer.on('ai-step', (_, info) => {
  const chat = document.getElementById('ai-chat');

  // Remove the initial "Talk to Piggy" message if still present
  const emptyMsg = chat.querySelector('.empty-msg');
  if (emptyMsg) emptyMsg.remove();

  // Build action description
  let body = '';
  if (info.status === 'thinking') body = 'Analyzing screenshot...';
  else if (info.status === 'recalling') body = `Searching memory: "${info.action?.query || '...'}"`;
  else if (info.status === 'acting') {
    const a = info.action;
    if (a.action === 'batch') {
      body = a.actions.map((act, i) => {
        if (act.action === 'focus') return `${i+1}. Focus → ${act.app}`;
        if (act.action === 'click') return `${i+1}. Click → (${act.x}, ${act.y})`;
        if (act.action === 'move') return `${i+1}. Move → (${act.x}, ${act.y})`;
        if (act.action === 'type') return `${i+1}. Type → "${act.text}"`;
        if (act.action === 'key') return `${i+1}. Key → ${act.key}`;
        if (act.action === 'shortcut') return `${i+1}. ${(act.modifiers||[]).join('+')}+${act.key}`;
        if (act.action === 'scroll') return `${i+1}. Scroll ${act.direction}`;
        if (act.action === 'find') return `${i+1}. Find → "${act.name}"`;
        return `${i+1}. ${act.action}`;
      }).join('<br>');
    } else {
      if (a.action === 'focus') body = `Focus → ${a.app}`;
      else if (a.action === 'click') body = `Click → (${a.x}, ${a.y})`;
      else if (a.action === 'move') body = `Move → (${a.x}, ${a.y})`;
      else if (a.action === 'type') body = `Type → "${a.text}"`;
      else if (a.action === 'key') body = `Key → ${a.key}`;
      else if (a.action === 'shortcut') body = `${(a.modifiers||[]).join('+')}+${a.key}`;
      else if (a.action === 'scroll') body = `Scroll ${a.direction}`;
      else if (a.action === 'find') body = `Find → "${a.name}"`;
      else body = JSON.stringify(a);
    }
  }
  else if (info.status === 'done') body = (info.report && info.report.length > 10) ? info.report : info.reason;
  else if (info.status === 'failed') body = info.reason;
  else if (info.status === 'error') body = info.error;
  else if (info.status === 'blocked') body = info.reason;

  // Find or create step element
  let stepEl = document.getElementById(`ai-step-${info.step}`);
  if (!stepEl) {
    stepEl = document.createElement('div');
    stepEl.id = `ai-step-${info.step}`;
    stepEl.className = 'chat-step';
    chat.appendChild(stepEl);
  }

  stepEl.innerHTML = `
    <div class="chat-step-header">
      <span class="chat-step-num">Step ${info.step}</span>
      <span class="chat-step-status ${info.status}">${info.status}</span>
    </div>
    <div class="chat-step-body">${body}</div>
    ${info.screenshot ? `<img class="chat-step-img" src="data:image/png;base64,${info.screenshot}">` : ''}
  `;

  chat.scrollTop = chat.scrollHeight;
});

// ── Keyboard ────────────────────────���─────────────────────

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  keys[e.key.toLowerCase()] = true;
  if (e.key === ' ') { e.preventDefault(); clickFlash = 1; api.clickCursor('left'); }
  if (e.key === 'q') { scrollAnim = 0.3; api.scrollCursor(-3); }
  if (e.key === 'e') { scrollAnim = -0.3; api.scrollCursor(3); }
  if (e.key === 'Tab') { e.preventDefault(); mode = mode === 'keyboard' ? 'ai' : 'keyboard'; document.getElementById('mode-indicator').textContent = mode.toUpperCase(); document.getElementById('mode-indicator').className = mode; }
});
document.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
document.getElementById('speed-slider').addEventListener('input', (e) => { speed = parseInt(e.target.value); document.getElementById('speed-val').textContent = speed; });

// ── Screenshot Viewer ─────────────────────────────────────

function renderShot() {
  const img = document.getElementById('screen-img');
  const msg = document.getElementById('no-shot-msg');
  const nav = document.getElementById('screen-nav');

  if (!shots.length) { img.style.display = 'none'; msg.style.display = 'block'; nav.style.display = 'none'; document.getElementById('screen-time').textContent = ''; return; }

  msg.style.display = 'none'; img.style.display = 'block'; nav.style.display = 'flex';
  const s = shots[shotIdx];
  img.src = `data:image/png;base64,${s.smallBase64}`;
  document.getElementById('screen-counter').textContent = `${shotIdx + 1}/${shots.length}`;
  document.getElementById('screen-time').textContent = `${s.width}x${s.height} — ${new Date(s.timestamp).toLocaleTimeString()}`;
  document.getElementById('btn-prev').disabled = shotIdx <= 0;
  document.getElementById('btn-next').disabled = shotIdx >= shots.length - 1;
}

async function doScreenshot(mode, btn, label) {
  btn.disabled = true; btn.textContent = '...';
  const r = await api.takeScreenshot(mode);
  if (r.smallBase64) {
    shots.push(r);
    shotIdx = shots.length - 1;
    renderShot();
    updateMonitorScreen(r.smallBase64);
  }
  btn.disabled = false; btn.textContent = label;
}

document.getElementById('btn-screenshot').addEventListener('click', () => {
  doScreenshot('screen', document.getElementById('btn-screenshot'), 'Full Screen');
});

document.getElementById('btn-screenshot-win').addEventListener('click', () => {
  doScreenshot('window', document.getElementById('btn-screenshot-win'), 'Window');
});

document.getElementById('btn-prev').addEventListener('click', () => { if (shotIdx > 0) { shotIdx--; renderShot(); updateMonitorScreen(shots[shotIdx].smallBase64); } });
document.getElementById('btn-next').addEventListener('click', () => { if (shotIdx < shots.length - 1) { shotIdx++; renderShot(); updateMonitorScreen(shots[shotIdx].smallBase64); } });
document.getElementById('btn-del').addEventListener('click', () => {
  if (!shots.length || shotIdx < 0 || shotIdx >= shots.length) return;
  shots.splice(shotIdx, 1);
  shotIdx = Math.min(shotIdx, shots.length - 1);
  if (shots.length && shotIdx >= 0) {
    renderShot();
    updateMonitorScreen(shots[shotIdx].smallBase64);
  } else {
    shotIdx = -1;
    renderShot();
    screenCtx.fillStyle = '#0a0a12';
    screenCtx.fillRect(0, 0, 1600, 1000);
    screenCtx.fillStyle = '#333';
    screenCtx.font = '36px sans-serif';
    screenCtx.textAlign = 'center';
    screenCtx.fillText('No screenshot yet', 800, 510);
    screenTex.needsUpdate = true;
  }
});

// ── Page navigation ───────────────────────────────────────

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    if (!page) return;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('page-' + page).classList.add('active');

    // Resize Three.js canvas when switching to sim page
    if (page === 'sim') {
      const c = document.getElementById('scene-container');
      camera.aspect = c.clientWidth / c.clientHeight;
      camera.updateProjectionMatrix();
      gl.setSize(c.clientWidth, c.clientHeight);
    }
  });
});

// ── App focus ─────────────────────────────────────────────

let selectedApp = null;

async function loadApps() {
  const result = await ipcRenderer.invoke('list-apps');
  const container = document.getElementById('apps-list');
  container.innerHTML = '';

  if (!result.success || !result.apps.length) {
    container.innerHTML = '<span style="color:#444;font-size:0.72rem;">No apps found</span>';
    return;
  }

  result.apps.forEach(app => {
    const btn = document.createElement('button');
    btn.textContent = app;
    btn.className = 'btn btn-ghost';
    btn.style.cssText = 'width:auto;padding:4px 10px;font-size:0.68rem;flex:none;';
    if (app === selectedApp) {
      btn.style.borderColor = '#a855f7';
      btn.style.color = '#a855f7';
    }
    btn.addEventListener('click', () => {
      selectedApp = (selectedApp === app) ? null : app;
      loadApps(); // re-render to update highlight
    });
    container.appendChild(btn);
  });
}

/** Focus the selected app before an action. Returns true if focused. */
async function focusSelected() {
  if (!selectedApp) return true; // no app selected, proceed anyway
  const res = await ipcRenderer.invoke('focus-app', { appName: selectedApp });
  return res.success;
}

loadApps();
document.querySelector('[data-page="action"]').addEventListener('click', loadApps);

// ── Action tab — Queue system ─────────────────────────────

const queue = [];

function getTarget() {
  return {
    x: parseInt(document.getElementById('target-x').value),
    y: parseInt(document.getElementById('target-y').value)
  };
}

function getTypeText() {
  return document.getElementById('type-text').value || '';
}

function describeStep(step) {
  switch (step.action) {
    case 'focus': return `Focus → ${step.app}`;
    case 'move': return `Move → (${step.x}, ${step.y})`;
    case 'click': return `Click → (${step.x}, ${step.y})`;
    case 'click_type': return `Click (${step.x}, ${step.y}) → Type "${step.text}"`;
    case 'type': return `Type → "${step.text}"`;
    case 'key': return `Key → ${step.key}`;
    case 'screenshot': return `Screenshot (${step.mode})`;
    default: return step.action;
  }
}

function renderQueue() {
  const list = document.getElementById('queue-list');
  if (!queue.length) {
    list.innerHTML = '<span class="empty-msg">No steps added</span>';
    return;
  }
  list.innerHTML = queue.map((step, i) => `
    <div class="queue-item" id="queue-item-${i}">
      <span class="queue-num">${i + 1}</span>
      <span class="queue-desc">${describeStep(step)}</span>
      <button class="queue-del" data-idx="${i}">×</button>
    </div>
  `).join('');

  list.querySelectorAll('.queue-del').forEach(btn => {
    btn.addEventListener('click', () => {
      queue.splice(parseInt(btn.dataset.idx), 1);
      renderQueue();
    });
  });
}

// Add step buttons
document.getElementById('btn-add-move').addEventListener('click', () => {
  const { x, y } = getTarget();
  queue.push({ action: 'move', x, y });
  renderQueue();
});

document.getElementById('btn-add-click').addEventListener('click', () => {
  const { x, y } = getTarget();
  queue.push({ action: 'click', x, y });
  renderQueue();
});

document.getElementById('btn-add-type').addEventListener('click', () => {
  const text = getTypeText();
  if (!text) return;
  queue.push({ action: 'type', text });
  renderQueue();
});

document.getElementById('btn-add-click-type').addEventListener('click', () => {
  const { x, y } = getTarget();
  const text = getTypeText();
  if (!text) return;
  queue.push({ action: 'click_type', x, y, text });
  renderQueue();
});

document.getElementById('btn-add-enter').addEventListener('click', () => {
  queue.push({ action: 'key', key: 'enter' });
  renderQueue();
});

document.getElementById('btn-add-tab').addEventListener('click', () => {
  queue.push({ action: 'key', key: 'tab' });
  renderQueue();
});

document.getElementById('btn-add-esc').addEventListener('click', () => {
  queue.push({ action: 'key', key: 'escape' });
  renderQueue();
});

document.getElementById('btn-add-shot-screen').addEventListener('click', () => {
  queue.push({ action: 'screenshot', mode: 'screen' });
  renderQueue();
});

document.getElementById('btn-add-shot-window').addEventListener('click', () => {
  queue.push({ action: 'screenshot', mode: 'window' });
  renderQueue();
});

// Clear queue
document.getElementById('btn-clear-queue').addEventListener('click', () => {
  queue.length = 0;
  renderQueue();
  document.getElementById('queue-status').textContent = '';
});

// Execute all steps in order
document.getElementById('btn-execute').addEventListener('click', async () => {
  if (!queue.length) return;
  const btn = document.getElementById('btn-execute');
  const st = document.getElementById('queue-status');
  btn.disabled = true;

  // Focus selected app first
  await focusSelected();

  for (let i = 0; i < queue.length; i++) {
    const step = queue[i];
    const el = document.getElementById(`queue-item-${i}`);
    if (el) el.className = 'queue-item running';
    st.textContent = `Running step ${i + 1}/${queue.length}...`;
    st.style.color = '#f59e0b';

    switch (step.action) {
      case 'move': {
        const pv = await api.previewPath(step.x, step.y);
        showPath(pv.points, screenW, screenH);
        await api.executeMove(step.x, step.y);
        clearPath();
        break;
      }
      case 'click': {
        const pv = await api.previewPath(step.x, step.y);
        showPath(pv.points, screenW, screenH);
        const res = await api.executeClick(step.x, step.y, 'left');
        if (res.clicked) clickFlash = 1;
        clearPath();
        break;
      }
      case 'click_type': {
        const pv = await api.previewPath(step.x, step.y);
        showPath(pv.points, screenW, screenH);
        await api.executeMove(step.x, step.y);
        clearPath();
        // Double click to ensure field is active
        await api.clickCursor('left');
        await new Promise(r => setTimeout(r, 100));
        await api.clickCursor('left');
        clickFlash = 1;
        // Wait for field to become editable
        await new Promise(r => setTimeout(r, 400));
        await api.executeType(step.text);
        break;
      }
      case 'type':
        await api.executeType(step.text);
        break;
      case 'key':
        api.executeKey(step.key);
        break;
      case 'screenshot': {
        const shot = await api.takeScreenshot(step.mode);
        if (shot.smallBase64) {
          shots.push(shot);
          shotIdx = shots.length - 1;
          renderShot();
          updateMonitorScreen(shot.smallBase64);
        }
        break;
      }
    }

    if (el) el.className = 'queue-item done';
    await new Promise(r => setTimeout(r, 100));
  }

  st.textContent = `Done — ${queue.length} steps executed`;
  st.style.color = '#10b981';
  btn.disabled = false;
});

// ── AI Queue Execution (AI pushes actions here) ──────────

ipcRenderer.on('ai-queue-actions', (_, { actions, step }) => {
  // Clear existing queue
  queue.length = 0;

  // Add AI actions to the queue
  for (const action of actions) {
    switch (action.action) {
      case 'focus':
        queue.push({ action: 'focus', app: action.app });
        break;
      case 'click':
      case 'right_click':
        queue.push({ action: 'click', x: action.x, y: action.y });
        break;
      case 'click_type':
        queue.push({ action: 'click_type', x: action.x, y: action.y, text: action.text || '' });
        break;
      case 'move':
        queue.push({ action: 'move', x: action.x, y: action.y });
        break;
      case 'type':
        queue.push({ action: 'type', text: action.text || '' });
        break;
      case 'key':
        queue.push({ action: 'key', key: action.key });
        break;
      case 'shortcut':
        // Shortcuts become key actions with modifiers handled via IPC
        queue.push({ action: 'shortcut', key: action.key, modifiers: action.modifiers || [] });
        break;
      case 'scroll':
        queue.push({ action: 'scroll', direction: action.direction, amount: action.amount || 3 });
        break;
      case 'find':
        queue.push({ action: 'find', name: action.name });
        break;
    }
  }

  renderQueue();

  // Auto-switch to Action page so user sees the queue
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-page="action"]').classList.add('active');
  document.getElementById('page-action').classList.add('active');
});

ipcRenderer.on('ai-execute-queue', async () => {
  if (!queue.length) {
    ipcRenderer.send('ai-queue-done', { success: true, steps: 0 });
    return;
  }

  const st = document.getElementById('queue-status');
  const btn = document.getElementById('btn-execute');
  btn.disabled = true;

  for (let i = 0; i < queue.length; i++) {
    const step = queue[i];
    const el = document.getElementById(`queue-item-${i}`);
    if (el) el.className = 'queue-item running';
    st.textContent = `AI running step ${i + 1}/${queue.length}...`;
    st.style.color = '#f59e0b';

    switch (step.action) {
      case 'focus':
        if (step.app) {
          await ipcRenderer.invoke('focus-app', { appName: step.app });
          await new Promise(r => setTimeout(r, 300));
        }
        break;
      case 'move': {
        const pv = await api.previewPath(step.x, step.y);
        showPath(pv.points, screenW, screenH);
        await api.executeMove(step.x, step.y);
        clearPath();
        break;
      }
      case 'click': {
        const pv = await api.previewPath(step.x, step.y);
        showPath(pv.points, screenW, screenH);
        const res = await api.executeClick(step.x, step.y, 'left');
        if (res.clicked) clickFlash = 1;
        clearPath();
        break;
      }
      case 'click_type': {
        const pv = await api.previewPath(step.x, step.y);
        showPath(pv.points, screenW, screenH);
        await api.executeMove(step.x, step.y);
        clearPath();
        await api.clickCursor('left');
        clickFlash = 1;
        await new Promise(r => setTimeout(r, 400));
        await api.executeType(step.text);
        break;
      }
      case 'type':
        await api.executeType(step.text);
        break;
      case 'key':
        api.executeKey(step.key);
        await new Promise(r => setTimeout(r, 50));
        break;
      case 'shortcut':
        api.executeKey(step.key, step.modifiers);
        await new Promise(r => setTimeout(r, 50));
        break;
      case 'scroll':
        api.scrollCursor(step.direction === 'up' ? -(step.amount || 3) : (step.amount || 3));
        break;
      case 'find': {
        const found = await ipcRenderer.invoke('find-element', { name: step.name });
        if (found.success && found.element) {
          st.textContent = `Found "${step.name}" at (${found.element.centerX}, ${found.element.centerY})`;
        } else {
          st.textContent = `"${step.name}" not found`;
        }
        // Send find result back to main for the AI to use
        ipcRenderer.send('ai-find-result', found);
        break;
      }
    }

    if (el) el.className = 'queue-item done';
    await new Promise(r => setTimeout(r, 150));
  }

  st.textContent = `Done — ${queue.length} steps executed`;
  st.style.color = '#10b981';
  btn.disabled = false;

  // Take screenshot after execution and send back to AI
  const shot = await api.takeScreenshot('window');
  if (shot.smallBase64) {
    updateMonitorScreen(shot.smallBase64);
  }
  ipcRenderer.send('ai-queue-done', { success: true, steps: queue.length, screenshot: shot });
});

// Update describeStep to handle new action types
const origDescribeStep = describeStep;
function describeStepExtended(step) {
  if (step.action === 'focus') return `Focus → ${step.app}`;
  if (step.action === 'shortcut') return `Shortcut → ${[...(step.modifiers || []), step.key].join('+')}`;
  if (step.action === 'scroll') return `Scroll ${step.direction || 'down'}`;
  if (step.action === 'find') return `Find → "${step.name}"`;
  return origDescribeStep(step);
}
// Replace describeStep
describeStep = describeStepExtended;

// ── AI tab — Chat + Task ─────────────────────────────────

let aiTaskRunning = false;
let pendingTask = null;

const chatEl = document.getElementById('ai-chat');
const inputEl = document.getElementById('ai-input');
const sendBtn = document.getElementById('btn-ai-send');
const badge = document.getElementById('ai-mode-badge');

function addChatMsg(role, text) {
  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;
  msg.innerHTML = text;
  chatEl.appendChild(msg);
  chatEl.scrollTop = chatEl.scrollHeight;
  return msg;
}

function setBadge(mode) {
  badge.textContent = mode;
  badge.className = mode === 'task' ? 'ai-badge task-mode' : 'ai-badge chat-mode';
}

async function sendChat() {
  const text = inputEl.value.trim();
  if (!text || aiTaskRunning) return;

  inputEl.value = '';
  addChatMsg('user', text);
  sendBtn.disabled = true; sendBtn.textContent = '...';

  const res = await ipcRenderer.invoke('ai-chat', { message: text, includeScreenshot: false });

  sendBtn.disabled = false; sendBtn.textContent = 'Send';

  if (res.ready && res.task) {
    // Model wants to execute — show the plan and a "Go" button
    const msgEl = addChatMsg('assistant', `${escHtml(res.reply)}<br><button class="ready-btn" id="btn-go-task">Execute task</button>`);
    pendingTask = res.task;

    msgEl.querySelector('#btn-go-task').addEventListener('click', () => {
      runTaskFromChat(pendingTask);
      pendingTask = null;
    });
  } else {
    addChatMsg('assistant', escHtml(res.reply));
  }
}

async function runTaskFromChat(task) {
  aiTaskRunning = true;
  setBadge('task');
  mode = 'ai';
  document.getElementById('mode-indicator').textContent = 'AI';
  document.getElementById('mode-indicator').className = 'ai';

  addChatMsg('system', `Executing: ${escHtml(task)}`);
  sendBtn.disabled = true; inputEl.disabled = true;

  const res = await ipcRenderer.invoke('ai-run-from-chat', { task, maxSteps: 15 });

  // Final result
  const final = document.createElement('div');
  final.className = 'chat-step';
  final.innerHTML = `
    <div class="chat-step-header">
      <span class="chat-step-num">Result</span>
      <span class="chat-step-status ${res.success ? 'done' : 'failed'}">${res.success ? 'Done' : 'Failed'}</span>
    </div>
    <div class="chat-step-body">${res.reason} (${res.steps} steps)</div>
  `;
  chatEl.appendChild(final);
  chatEl.scrollTop = chatEl.scrollHeight;

  aiTaskRunning = false;
  setBadge('chat');
  sendBtn.disabled = false; inputEl.disabled = false;
  mode = 'keyboard';
  document.getElementById('mode-indicator').textContent = 'KEYBOARD';
  document.getElementById('mode-indicator').className = 'keyboard';
}

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

sendBtn.addEventListener('click', sendChat);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

document.getElementById('btn-stop-ai').addEventListener('click', async () => {
  await ipcRenderer.invoke('ai-stop');
  await api.stopMovement();
  clearPath();
  if (aiTaskRunning) {
    addChatMsg('system', 'Task stopped by user');
    aiTaskRunning = false;
    setBadge('chat');
    sendBtn.disabled = false; inputEl.disabled = false;
  }
});

// ── Animation Loop ────────────────────────────────────────

function animate() {
  requestAnimationFrame(animate);
  const spd = speed * 0.008;
  let dx = 0, dz = 0;

  if (mode === 'keyboard') {
    if (keys['w'] || keys['arrowup'])    dz = -spd;
    if (keys['s'] || keys['arrowdown'])  dz =  spd;
    if (keys['a'] || keys['arrowleft'])  dx = -spd;
    if (keys['d'] || keys['arrowright']) dx =  spd;
  }

  if (dx || dz) {
    mVel.x += (dx - mVel.x) * 0.3; mVel.z += (dz - mVel.z) * 0.3;
    mPos.x = Math.max(-5, Math.min(5, mPos.x + mVel.x));
    mPos.z = Math.max(-3.5, Math.min(3.5, mPos.z + mVel.z));
    moving = true;
    api.moveCursor(mVel.x * 150, mVel.z * 150);
  } else {
    mVel.x *= 0.85; mVel.z *= 0.85;
    if (Math.abs(mVel.x) < 0.0005 && Math.abs(mVel.z) < 0.0005) moving = false;
  }

  mouseGrp.position.set(mPos.x, moving ? 0.02 + Math.sin(Date.now() * 0.01) * 0.005 : 0, mPos.z);
  mouseGrp.rotation.z = -mVel.x * 3;
  mouseGrp.rotation.x = mVel.z * 2;

  if (clickFlash > 0) { clickFlash -= 0.05; ledL.material.emissiveIntensity = ledR.material.emissiveIntensity = 0.8 + clickFlash * 2; body.position.y = 0.1 - clickFlash * 0.02; }
  else body.position.y = 0.1;

  if (Math.abs(scrollAnim) > 0.01) { wheel.rotation.x += scrollAnim; scrollAnim *= 0.9; }

  if (moving && ++trailTick % 3 === 0) {
    const t = trails.find(t => t.life <= 0);
    if (t) { t.mesh.position.set(mPos.x, 0.02, mPos.z); t.mesh.visible = true; t.mesh.material.opacity = 0.5; t.life = 1; }
  }
  trails.forEach(t => { if (t.life > 0) { t.life -= 0.03; t.mesh.material.opacity = t.life * 0.5; t.mesh.scale.setScalar(t.life); if (t.life <= 0) t.mesh.visible = false; } });

  // Keyboard key flash decay
  for (let i = activeKeys.length - 1; i >= 0; i--) {
    const ak = activeKeys[i];
    ak.life -= 0.06;
    if (ak.life <= 0) {
      ak.mesh.material = ak.origMats;
      ak.mesh.position.y = ak.origY;
      activeKeys.splice(i, 1);
    } else {
      ak.mesh.position.y = 0.07 + (1 - ak.life) * 0.04;
    }
  }

  const pulse = Math.sin(Date.now() * 0.003) * 0.2 + 0.8;
  if (clickFlash <= 0) { ledL.material.emissiveIntensity = ledR.material.emissiveIntensity = moving ? 1.2 : pulse; }

  accentA.position.x = mPos.x; accentA.position.z = mPos.z;

  api.getCursorPos().then(p => { document.getElementById('hud-x').textContent = Math.round(p.x); document.getElementById('hud-y').textContent = Math.round(p.y); });
  document.getElementById('hud-vel').textContent = (Math.sqrt(mVel.x ** 2 + mVel.z ** 2) * 1000).toFixed(1);

  gl.render(scene, camera);
}

// ── Camera Orbit (scroll zoom, right-drag rotate) ─────────

let camDist = 10;
let camAngleX = 0.55;  // vertical angle (radians)
let camAngleY = 0;     // horizontal angle
let isDragging = false;
let dragStart = { x: 0, y: 0 };

function updateCamera() {
  camera.position.x = Math.sin(camAngleY) * Math.cos(camAngleX) * camDist;
  camera.position.y = Math.sin(camAngleX) * camDist;
  camera.position.z = Math.cos(camAngleY) * Math.cos(camAngleX) * camDist;
  camera.lookAt(0, 1, 0);
}

updateCamera();

// Ctrl + scroll to zoom, Shift + drag to rotate
canvas.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
  camDist = Math.max(4, Math.min(20, camDist + delta * 0.01));
  updateCamera();
}, { passive: false });

canvas.addEventListener('mousedown', (e) => {
  if (e.shiftKey && e.button === 0) {
    isDragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  camAngleY += dx * 0.005;
  camAngleX = Math.max(0.1, Math.min(1.4, camAngleX + dy * 0.005));
  dragStart = { x: e.clientX, y: e.clientY };
  updateCamera();
});

canvas.addEventListener('mouseup', () => { isDragging = false; });
canvas.addEventListener('mouseleave', () => { isDragging = false; });

animate();

window.addEventListener('resize', () => {
  const w = container.clientWidth, h = container.clientHeight;
  if (w > 0 && h > 0) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    gl.setSize(w, h);
  }
});
