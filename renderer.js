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
  takeScreenshot: ()       => ipcRenderer.invoke('take-screenshot'),
  previewPath:    (x, y)   => ipcRenderer.invoke('preview-path', { targetX: x, targetY: y }),
  executeMove:    (x, y)   => ipcRenderer.invoke('execute-move', { targetX: x, targetY: y }),
  executeClick:   (x, y, b) => ipcRenderer.invoke('execute-click', { targetX: x, targetY: y, button: b }),
  stopMovement:   ()       => ipcRenderer.invoke('stop-movement')
};

// ── Three.js Scene ────────────────────────────────────────

const canvas    = document.getElementById('canvas');
const container = document.getElementById('scene-container');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a12);
scene.fog = new THREE.Fog(0x0a0a12, 15, 30);

const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 100);
camera.position.set(0, 6, 8);
camera.lookAt(0, 0, 0);

const gl = new THREE.WebGLRenderer({ canvas, antialias: true });
gl.setSize(container.clientWidth, container.clientHeight);
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

// Screen surface (where screenshot texture goes)
const screenGeo = new THREE.PlaneGeometry(5.2, 3.0);
const screenCanvas = document.createElement('canvas');
screenCanvas.width = 800;
screenCanvas.height = 450;
const screenCtx = screenCanvas.getContext('2d');
screenCtx.fillStyle = '#0a0a12';
screenCtx.fillRect(0, 0, 800, 450);
screenCtx.fillStyle = '#333';
screenCtx.font = '24px sans-serif';
screenCtx.textAlign = 'center';
screenCtx.fillText('No screenshot yet', 400, 230);

const screenTex = new THREE.CanvasTexture(screenCanvas);
screenTex.minFilter = THREE.LinearFilter;
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
    screenCtx.clearRect(0, 0, 800, 450);
    screenCtx.drawImage(img, 0, 0, 800, 450);
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

ipcRenderer.on('ai-step', (_, info) => {
  const el = document.getElementById('ai-status');
  const colors = { thinking: '#a855f7', acting: '#f59e0b', done: '#10b981', failed: '#ef4444', error: '#ef4444' };
  el.style.color = colors[info.status] || '#888';
  if (info.status === 'thinking') el.textContent = `Step ${info.step}/${info.maxSteps}: Thinking...`;
  else if (info.status === 'acting') { const a = info.action; el.textContent = `Step ${info.step}: ${a.action}${a.x ? ` (${a.x},${a.y})` : ''}`; }
  else if (info.status === 'done') el.textContent = `Done: ${info.reason}`;
  else if (info.status === 'failed') el.textContent = `Failed: ${info.reason}`;
  else if (info.status === 'error') el.textContent = `Error: ${info.error}`;
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

document.getElementById('btn-screenshot').addEventListener('click', async () => {
  const btn = document.getElementById('btn-screenshot');
  btn.disabled = true; btn.textContent = '...';
  const r = await api.takeScreenshot();
  if (r.smallBase64) {
    shots.push(r);
    shotIdx = shots.length - 1;
    renderShot();
    updateMonitorScreen(r.smallBase64);
  }
  btn.disabled = false; btn.textContent = 'Capture';
});

document.getElementById('btn-prev').addEventListener('click', () => { if (shotIdx > 0) { shotIdx--; renderShot(); updateMonitorScreen(shots[shotIdx].smallBase64); } });
document.getElementById('btn-next').addEventListener('click', () => { if (shotIdx < shots.length - 1) { shotIdx++; renderShot(); updateMonitorScreen(shots[shotIdx].smallBase64); } });
document.getElementById('btn-del').addEventListener('click', () => {
  if (!shots.length) return;
  shots.splice(shotIdx, 1);
  if (shotIdx >= shots.length) shotIdx = shots.length - 1;
  if (shots.length) { renderShot(); updateMonitorScreen(shots[shotIdx].smallBase64); }
  else { shotIdx = -1; renderShot(); screenCtx.fillStyle = '#0a0a12'; screenCtx.fillRect(0, 0, 800, 450); screenCtx.fillStyle = '#333'; screenCtx.font = '24px sans-serif'; screenCtx.textAlign = 'center'; screenCtx.fillText('No screenshot yet', 400, 230); screenTex.needsUpdate = true; }
});

// ── Panel Buttons ─────────────────────────────────────────

document.getElementById('btn-move').addEventListener('click', async () => {
  const tx = parseInt(document.getElementById('target-x').value);
  const ty = parseInt(document.getElementById('target-y').value);
  const st = document.getElementById('move-status');
  const btn = document.getElementById('btn-move');
  btn.disabled = true; st.textContent = 'Planning...'; st.style.color = '#888';
  const pv = await api.previewPath(tx, ty);
  showPath(pv.points, screenW, screenH);
  st.textContent = `${pv.points.length} steps`;
  await new Promise(r => setTimeout(r, 400));
  st.textContent = 'Moving...'; st.style.color = '#f59e0b';
  const res = await api.executeMove(tx, ty);
  st.textContent = res.completed ? `Arrived (${tx},${ty})` : 'Cancelled';
  st.style.color = res.completed ? '#10b981' : '#ef4444';
  clearPath(); btn.disabled = false;
});

document.getElementById('btn-click').addEventListener('click', async () => {
  const tx = parseInt(document.getElementById('click-x').value);
  const ty = parseInt(document.getElementById('click-y').value);
  const btn = document.getElementById('btn-click');
  btn.disabled = true;
  const pv = await api.previewPath(tx, ty);
  showPath(pv.points, screenW, screenH);
  await new Promise(r => setTimeout(r, 300));
  const res = await api.executeClick(tx, ty, 'left');
  if (res.clicked) clickFlash = 1;
  clearPath(); btn.disabled = false;
});

document.getElementById('btn-ai-run').addEventListener('click', async () => {
  const task = document.getElementById('ai-task').value.trim();
  if (!task) return;
  const btn = document.getElementById('btn-ai-run');
  const st = document.getElementById('ai-status');
  btn.disabled = true; btn.textContent = '...';
  st.textContent = 'Starting...'; st.style.color = '#a855f7';
  mode = 'ai'; document.getElementById('mode-indicator').textContent = 'AI'; document.getElementById('mode-indicator').className = 'ai';
  const res = await ipcRenderer.invoke('ai-run-task', { task, maxSteps: 15 });
  st.textContent = res.success ? `Done (${res.steps}): ${res.reason}` : `Stopped (${res.steps}): ${res.reason}`;
  st.style.color = res.success ? '#10b981' : '#ef4444';
  btn.disabled = false; btn.textContent = 'Run';
  mode = 'keyboard'; document.getElementById('mode-indicator').textContent = 'KEYBOARD'; document.getElementById('mode-indicator').className = 'keyboard';
});

document.getElementById('btn-stop').addEventListener('click', async () => {
  await ipcRenderer.invoke('ai-stop');
  await api.stopMovement();
  clearPath();
  document.getElementById('move-status').textContent = 'Stopped';
  document.getElementById('ai-status').textContent = 'Stopped';
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

// Hold Shift + scroll to zoom, Shift + drag to rotate
canvas.addEventListener('wheel', (e) => {
  if (!e.shiftKey) return;
  e.preventDefault();
  camDist = Math.max(4, Math.min(20, camDist + e.deltaY * 0.01));
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
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  gl.setSize(w, h);
});
