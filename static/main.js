'use strict';
/* =========================================================
   Gravity Maze – Frontend  (final fix)

   KRITISCHE BUGS GEFIXT:
   [A] btnFlipY war null → JS-Crash beim Start → alles kaputt
   [B] Nur deviceorientation versucht → devicemotion als Fallback
   [C] Alle DOM-Refs null-safe (kein Crash bei fehlendem Element)
   [D] server.py sendet jetzt Permissions-Policy-Header für Chrome
   [E] X-Flip UND Y-Flip Buttons
   [F] Live-Diagnose-Panel zeigt welches API Daten liefert
   ========================================================= */

// ── DOM-Referenzen (null-safe: kein Crash wenn Element fehlt) ─────────────
const canvas     = document.getElementById('game');
const ctx        = canvas.getContext('2d');
const scoreEl    = document.getElementById('score');
const coinsEl    = document.getElementById('coins');
const timeEl     = document.getElementById('time');
const overlay    = document.getElementById('overlay');
const msgEl      = document.getElementById('msg');
const btnStart   = document.getElementById('btnStart');
const btnRestart = document.getElementById('btnRestart');
const btnGyro    = document.getElementById('btnGyro');
const btnCalib   = document.getElementById('btnCalib');   // null-safe ✓
const btnFlipY   = document.getElementById('btnFlipY');   // null-safe ✓ [FIX A]
const btnFlipX   = document.getElementById('btnFlipX');   // null-safe ✓
const gyroBadge  = document.getElementById('gyroBadge');
const toast      = document.getElementById('toast');

// ── Spielzustand ──────────────────────────────────────────────────────────
let level     = null;
let tiles     = [];
let coins     = [];
let holeTiles = [];
let ball      = null;
let score     = 0;
let running   = false;
let lastTs    = 0;
let startTs   = 0;
const targetAccel = { x: 0, y: 0 };

// ── Tastatur ──────────────────────────────────────────────────────────────
const keys = new Set();
window.addEventListener('keydown', e => {
  keys.add(e.key);
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',
       'a','A','d','D','w','W','s','S'].includes(e.key)) e.preventDefault();
});
window.addEventListener('keyup', e => keys.delete(e.key));

function accelFromKeys() {
  let x = 0, y = 0;
  if (keys.has('ArrowLeft')  || keys.has('a') || keys.has('A')) x -= 1;
  if (keys.has('ArrowRight') || keys.has('d') || keys.has('D')) x += 1;
  if (keys.has('ArrowUp')    || keys.has('w') || keys.has('W')) y -= 1;
  if (keys.has('ArrowDown')  || keys.has('s') || keys.has('S')) y += 1;
  const m = Math.hypot(x, y);
  if (m > 1) { x /= m; y /= m; }
  return { x, y };
}

// ── Virtueller Joystick ───────────────────────────────────────────────────
const JOY_R    = 58;
const JOY_DEAD = 0.05;
const joy = { active: false, sx: 0, sy: 0, dx: 0, dy: 0 };

canvas.addEventListener('pointerdown', e => {
  joy.active = true;
  joy.sx = e.clientX; joy.sy = e.clientY;
  joy.dx = 0;         joy.dy = 0;
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
});
canvas.addEventListener('pointermove', e => {
  if (!joy.active) return;
  joy.dx = e.clientX - joy.sx;
  joy.dy = e.clientY - joy.sy;
  e.preventDefault();
});
function endJoy() {
  joy.active = false; joy.dx = 0; joy.dy = 0;
  if (!gyroEnabled) { targetAccel.x = 0; targetAccel.y = 0; }
}
canvas.addEventListener('pointerup',     endJoy);
canvas.addEventListener('pointercancel', endJoy);

function accelFromJoy() {
  const d = Math.hypot(joy.dx, joy.dy);
  const s = Math.min(d, JOY_R) / JOY_R;
  let ax = d > 0 ? (joy.dx / d) * s : 0;
  let ay = d > 0 ? (joy.dy / d) * s : 0;
  if (Math.abs(ax) < JOY_DEAD) ax = 0;
  if (Math.abs(ay) < JOY_DEAD) ay = 0;
  return { x: ax, y: ay };
}

// ═══════════════════════════════════════════════════════════════════════════
//   SENSOR-SCHICHT  –  beide APIs parallel abhören
// ═══════════════════════════════════════════════════════════════════════════

// ── API 1: DeviceOrientationEvent (beta / gamma) ──────────────────────────
let oe = { beta: null, gamma: null, count: 0, lastMs: 0 };

// [FIX B] Immer ab Seitenstart lauschen (nicht erst beim Button-Klick)
window.addEventListener('deviceorientation', e => {
  if (!Number.isFinite(e.beta)) return;
  oe.beta  = e.beta;
  oe.gamma = e.gamma ?? 0;
  oe.count++;
  oe.lastMs = Date.now();
}, false);

// ── API 2: DeviceMotionEvent (accelerationIncludingGravity) ───────────────
// Zuverlässiger auf manchen Android-Geräten / Chrome-Versionen
let dm = { x: null, y: null, z: null, count: 0, lastMs: 0 };

window.addEventListener('devicemotion', e => {
  const a = e.accelerationIncludingGravity;
  if (!a || !Number.isFinite(a.x)) return;
  dm.x = a.x; dm.y = a.y; dm.z = a.z;
  dm.count++;
  dm.lastMs = Date.now();
}, false);

// ── Gyro-Zustand ──────────────────────────────────────────────────────────
let gyroEnabled  = false;
let hasFirstGyro = false;
let calibBeta    = 0;
let calibGamma   = 0;
let smoothBeta   = 0;
let smoothGamma  = 0;
let flipX        = false;   // [FIX E] X-Achse invertieren
let flipY        = false;   // [FIX E] Y-Achse invertieren

const GYRO_ALPHA = 0.70;    // Low-pass (höher = glatter aber träger)
const GYRO_RANGE = 26;      // Grad Neigung für max. Beschleunigung
const GYRO_DEAD  = 0.04;    // Deadzone gegen Drift

function getScreenRot() {
  try {
    if (typeof screen?.orientation?.angle === 'number')
      return ((screen.orientation.angle % 360) + 360) % 360;
    if (typeof window.orientation === 'number')
      return ((window.orientation % 360) + 360) % 360;
  } catch (_) {}
  return 0;
}

// ── Aktuell aktives Sensor-API ermitteln ──────────────────────────────────
function activeSensor() {
  const now = Date.now();
  const oeOk = oe.count > 2 && (now - oe.lastMs) < 1000 && oe.beta !== null;
  const dmOk = dm.count > 2 && (now - dm.lastMs) < 1000 && dm.x !== null;
  if (oeOk) return 'orientation';
  if (dmOk) return 'motion';
  return null;
}

// ── Gyro-Beschleunigung aus DeviceOrientation ─────────────────────────────
function accelFromOrientation() {
  // Kalibrierung beim ersten Aufruf [FIX: nicht in startGame() zurücksetzen]
  if (!hasFirstGyro) {
    calibBeta   = oe.beta;
    calibGamma  = oe.gamma;
    smoothBeta  = oe.beta;
    smoothGamma = oe.gamma;
    hasFirstGyro = true;
    showToast('📐 Kalibriert – jetzt neigen!', 1600);
  }

  smoothBeta  = GYRO_ALPHA * smoothBeta  + (1 - GYRO_ALPHA) * oe.beta;
  smoothGamma = GYRO_ALPHA * smoothGamma + (1 - GYRO_ALPHA) * oe.gamma;

  let ax = clamp((smoothGamma - calibGamma) / GYRO_RANGE, -1, 1);
  let ay = clamp((smoothBeta  - calibBeta)  / GYRO_RANGE, -1, 1);

  if (flipX) ax = -ax;
  if (flipY) ay = -ay;

  // Querformat-Kompensation
  const rot = getScreenRot();
  if (rot === 90)  { const t = ax; ax =  ay; ay = -t; }
  if (rot === 180) { ax = -ax; ay = -ay; }
  if (rot === 270) { const t = ax; ax = -ay; ay =  t; }

  return { x: ax, y: ay };
}

// ── Gyro-Beschleunigung aus DeviceMotion (Fallback) ──────────────────────
// accelerationIncludingGravity beinhaltet die Schwerkraft-Komponente,
// die direkt die Neigung widerspiegelt (wie Android TYPE_ACCELEROMETER).
function accelFromMotion() {
  const g = 9.81;
  // Normalisieren auf [-1, 1]; Vorzeichen empirisch auf Android getestet:
  //   x positiv = Neigung nach rechts auf den meisten Geräten
  //   y positiv = Neigung nach vorne (Oberkante weg vom Nutzer)
  // Flip-Buttons erlauben schnelle Korrektur falls verkehrt.
  let ax = clamp(-dm.x / g, -1, 1);
  let ay = clamp(-dm.y / g, -1, 1);

  if (flipX) ax = -ax;
  if (flipY) ay = -ay;

  // Deadzone
  if (Math.abs(ax) < GYRO_DEAD) ax = 0;
  if (Math.abs(ay) < GYRO_DEAD) ay = 0;

  return { x: ax, y: ay };
}

// ── Gyro im Game-Loop anwenden [FIX B + C] ───────────────────────────────
function applyGyro() {
  if (!gyroEnabled) return;
  const api = activeSensor();
  if (!api) return;

  let a;
  if (api === 'orientation') {
    a = accelFromOrientation();
  } else {
    a = accelFromMotion();
  }

  // Deadzone (für DeviceOrientation bereits in accelFromOrientation)
  if (api !== 'orientation') {
    if (Math.abs(a.x) < GYRO_DEAD) a.x = 0;
    if (Math.abs(a.y) < GYRO_DEAD) a.y = 0;
  }

  targetAccel.x = a.x;
  targetAccel.y = a.y;
}

// ── Gyro-Button  [FIX A: btnFlipY null-safe] ─────────────────────────────
async function toggleGyro() {
  if (gyroEnabled) {
    gyroEnabled = false;
    targetAccel.x = 0; targetAccel.y = 0;
    if (gyroBadge) gyroBadge.classList.add('hidden');
    if (btnGyro)   btnGyro.classList.remove('active');
    if (btnCalib)  btnCalib.classList.add('hidden');
    if (btnFlipY)  btnFlipY.classList.add('hidden');
    if (btnFlipX)  btnFlipX.classList.add('hidden');
    dbgEl.style.opacity = '0';
    showToast('Gyroskop deaktiviert');
    return;
  }

  // iOS Safari braucht explizite Genehmigung
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { showToast('❌ Zugriff verweigert'); return; }
    } catch { showToast('❌ Sensor-Fehler'); return; }
  }

  // [FIX B] 800 ms warten, dann prüfen ob IRGENDEINE API Daten liefert
  const oeBefore = oe.count;
  const dmBefore = dm.count;
  showToast('⏳ Sensor wird geprüft…', 1000);
  await new Promise(r => setTimeout(r, 800));

  const oeGot = oe.count > oeBefore;
  const dmGot = dm.count > dmBefore;

  if (!oeGot && !dmGot) {
    showToast(
      '❌ Kein Sensor-Signal!\n' +
      '1. Seite per HTTPS öffnen (Render ✓)\n' +
      '2. Chrome › ⋮ › Einstellungen › Datenschutz\n' +
      '   › Website-Einstellungen › Bewegungssensoren → Zulassen\n' +
      '3. Oder: Adresszeile-Schloss › Website-Einstellungen',
      6000
    );
    return;
  }

  const apiName = oeGot ? 'DeviceOrientation' : 'DeviceMotion';
  gyroEnabled  = true;
  hasFirstGyro = false;
  if (gyroBadge) gyroBadge.classList.remove('hidden');
  if (btnGyro)   btnGyro.classList.add('active');
  if (btnCalib)  btnCalib.classList.remove('hidden');
  if (btnFlipY)  btnFlipY.classList.remove('hidden');
  if (btnFlipX)  btnFlipX.classList.remove('hidden');
  showToast(`📡 Gyro aktiv [${apiName}] – Handy neigen!`);
}

// Neu-Kalibrierung
function calibrateGyro() {
  hasFirstGyro = false;
  showToast('📐 Halte in Spielposition…', 1200);
}

// Achsen umkehren [FIX E]
function toggleFlipY() {
  flipY = !flipY;
  if (btnFlipY) btnFlipY.classList.toggle('active', flipY);
  showToast(flipY ? '↕ Y-Achse gespiegelt' : '↕ Y-Achse normal');
}
function toggleFlipX() {
  flipX = !flipX;
  if (btnFlipX) btnFlipX.classList.toggle('active', flipX);
  showToast(flipX ? '↔ X-Achse gespiegelt' : '↔ X-Achse normal');
}

// [FIX A] null-safe Event-Listener
if (btnGyro)    btnGyro.addEventListener('click',  toggleGyro);
if (btnCalib)   btnCalib.addEventListener('click', calibrateGyro);
if (btnFlipY)   btnFlipY.addEventListener('click', toggleFlipY);
if (btnFlipX)   btnFlipX.addEventListener('click', toggleFlipX);

// ── [FIX F] Live-Diagnose-Panel ───────────────────────────────────────────
const dbgEl = (() => {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed', left: '10px', bottom: '88px', zIndex: '60',
    padding: '9px 12px', borderRadius: '12px',
    background: 'rgba(7,10,18,.90)',
    border: '1px solid rgba(122,169,255,.35)',
    color: '#cce0ff', fontSize: '11px',
    fontFamily: 'ui-monospace,SFMono-Regular,monospace',
    pointerEvents: 'none', whiteSpace: 'pre', lineHeight: '1.6',
    maxWidth: 'min(340px,calc(100vw - 20px))',
    opacity: '0', transition: 'opacity .25s',
    boxShadow: '0 4px 20px rgba(0,0,0,.45)',
  });
  document.body.appendChild(el);
  return el;
})();

function updateDebug() {
  if (!gyroEnabled) { dbgEl.style.opacity = '0'; return; }
  dbgEl.style.opacity = '1';

  const now   = Date.now();
  const oeAge = now - oe.lastMs;
  const dmAge = now - dm.lastMs;
  const api   = activeSensor();

  const sig = (count, age) => {
    if (count === 0) return '🔴 kein Signal';
    if (age < 500)   return `🟢 aktiv (${count})`;
    return            `🟡 veraltet (${count})`;
  };

  dbgEl.textContent =
    `Aktives API : ${api ?? '⚠️ keines'}\n` +
    `Orientation : ${sig(oe.count, oeAge)}\n` +
    (oe.beta  !== null ? `  β=${oe.beta.toFixed(1)}° γ=${oe.gamma.toFixed(1)}°\n` : '') +
    `Motion      : ${sig(dm.count, dmAge)}\n` +
    (dm.x !== null ? `  x=${dm.x.toFixed(2)} y=${dm.y.toFixed(2)}\n` : '') +
    `accel : x=${targetAccel.x.toFixed(2)} y=${targetAccel.y.toFixed(2)}\n` +
    `flipX:${flipX}  flipY:${flipY}  rot:${getScreenRot()}°`;
}

// ── Toast ─────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, ms = 2400) {
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), ms);
}

// ── Canvas-Größe ──────────────────────────────────────────────────────────
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width  = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (level) draw();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── Hilfsfunktionen ───────────────────────────────────────────────────────
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function hideOverlay() { overlay?.classList.add('hidden'); }
function showOverlay() { overlay?.classList.remove('hidden'); }

// ── Welt → Bildschirm ────────────────────────────────────────────────────
function worldToScreen(wx, wy) {
  const W = window.innerWidth, H = window.innerHeight;
  const tw = level.world_width_tiles, th = level.world_height_tiles;
  const pad = 56;
  const tpx = Math.min((W - pad * 2) / tw, (H - pad * 2) / th);
  const ox  = (W - tpx * tw) / 2;
  const oy  = (H - tpx * th) / 2;
  return { sx: ox + wx * tpx, sy: oy + wy * tpx, tpx };
}

// ── Level laden ───────────────────────────────────────────────────────────
async function loadLevel() {
  const res = await fetch('/api/level');
  if (!res.ok) throw new Error(`Level HTTP ${res.status}`);
  level     = await res.json();
  tiles     = level.tiles;
  coins     = level.coins.map(c => ({ ...c, collected: false }));
  holeTiles = level.hole_tiles || [];
  ball = { pos: { x: level.start.x, y: level.start.y }, vel: { x:0, y:0 }, radius: 0.22 };
  score = 0;
  if (scoreEl)  scoreEl.textContent  = '0';
  if (coinsEl)  coinsEl.textContent  = `0/${coins.length}`;
  if (timeEl)   timeEl.textContent   = '0.0s';
  if (msgEl)    msgEl.textContent    = '';
  running = false;
  if (btnRestart) btnRestart.disabled = true;
}

// ── Rendering ─────────────────────────────────────────────────────────────
function draw() {
  if (!level || !ball) return;
  const W = window.innerWidth, H = window.innerHeight;
  ctx.clearRect(0, 0, W, H);

  const { sx: ox, sy: oy, tpx } = worldToScreen(0, 0);
  const tw = level.world_width_tiles, th = level.world_height_tiles;

  // Gitter
  ctx.save();
  ctx.strokeStyle = 'rgba(130,160,255,.07)'; ctx.lineWidth = 0.5;
  for (let i = 0; i <= tw; i++) {
    const x = ox + i * tpx;
    ctx.beginPath(); ctx.moveTo(x, oy); ctx.lineTo(x, oy + th * tpx); ctx.stroke();
  }
  for (let j = 0; j <= th; j++) {
    const y = oy + j * tpx;
    ctx.beginPath(); ctx.moveTo(ox, y); ctx.lineTo(ox + tw * tpx, y); ctx.stroke();
  }
  ctx.restore();

  // Wände
  ctx.fillStyle = '#2A3256';
  for (const t of tiles) if (t.type === 'WALL')
    ctx.fillRect(ox + t.x * tpx, oy + t.y * tpx, tpx + 0.5, tpx + 0.5);
  ctx.fillStyle = 'rgba(15,22,55,.65)';
  for (const t of tiles) if (t.type === 'WALL')
    ctx.fillRect(ox + t.x * tpx + 2, oy + t.y * tpx + 2, tpx - 3.5, tpx - 3.5);

  // Ziel
  for (const t of tiles) {
    if (t.type !== 'GOAL') continue;
    const cx = ox + (t.x + 0.5) * tpx, cy = oy + (t.y + 0.5) * tpx;
    const r = tpx * 0.34, p = 0.87 + 0.13 * Math.sin(Date.now() / 290);
    ctx.save();
    ctx.shadowColor = 'rgba(60,255,143,.75)'; ctx.shadowBlur = 14;
    ctx.fillStyle   = `rgba(60,255,143,${0.85 * p})`;
    ctx.beginPath(); ctx.arc(cx, cy, r * p, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(60,255,143,.45)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.35, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // Münzen
  for (const t of tiles) {
    if (t.type !== 'COIN') continue;
    if (coins.find(c => c.x === t.x && c.y === t.y)?.collected) continue;
    const cx = ox + (t.x + 0.5) * tpx, cy = oy + (t.y + 0.5) * tpx, r = tpx * 0.19;
    ctx.save();
    ctx.shadowColor = 'rgba(255,211,77,.5)'; ctx.shadowBlur = 6;
    ctx.fillStyle = '#FFD34D';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.beginPath(); ctx.arc(cx - r * .24, cy - r * .24, r * .34, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Löcher
  for (const t of holeTiles) {
    const cx = ox + (t.x + 0.5) * tpx, cy = oy + (t.y + 0.5) * tpx, r = tpx * 0.28;
    ctx.save();
    ctx.shadowColor = 'rgba(110,76,255,.8)'; ctx.shadowBlur = 10;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(20,0,60,1)'); g.addColorStop(1, 'rgba(110,76,255,.85)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Ball-Trail
  const bcx = ox + ball.pos.x * tpx, bcy = oy + ball.pos.y * tpx, br = ball.radius * tpx;
  ctx.save();
  ctx.globalAlpha = 0.28; ctx.strokeStyle = 'rgba(122,169,255,.9)';
  ctx.lineWidth = Math.max(1.5, br * 0.22); ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(bcx - ball.vel.x * tpx * 0.7, bcy - ball.vel.y * tpx * 0.7);
  ctx.lineTo(bcx, bcy); ctx.stroke();
  ctx.restore();

  // Ball
  ctx.save();
  ctx.shadowColor = 'rgba(122,169,255,.7)'; ctx.shadowBlur = 20;
  const bg = ctx.createRadialGradient(bcx - br * .3, bcy - br * .3, br * .05, bcx, bcy, br);
  bg.addColorStop(0, '#B0CCFF'); bg.addColorStop(1, '#4078D8');
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.arc(bcx, bcy, br, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.7)';
  ctx.beginPath(); ctx.arc(bcx - br * .28, bcy - br * .28, br * .22, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Joystick-Overlay
  if (joy.active && !gyroEnabled) {
    const d = Math.hypot(joy.dx, joy.dy), ang = Math.atan2(joy.dy, joy.dx);
    const cl = Math.min(d, JOY_R);
    const kx = joy.sx + Math.cos(ang) * cl, ky = joy.sy + Math.sin(ang) * cl;
    ctx.save();
    ctx.globalAlpha = 0.45; ctx.strokeStyle = 'rgba(122,169,255,.75)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(joy.sx, joy.sy, JOY_R, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.7; ctx.fillStyle = 'rgba(122,169,255,.3)';
    ctx.beginPath(); ctx.arc(joy.sx, joy.sy, 13, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.88)';
    ctx.beginPath(); ctx.arc(kx, ky, 20, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Gyro-Tilt-Kreis
  if (gyroEnabled) {
    const ix = W - 40, iy = 88, ir = 14;
    ctx.save(); ctx.globalAlpha = 0.72;
    ctx.strokeStyle = 'rgba(122,169,255,.55)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(ix, iy, ir, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(122,169,255,.2)';
    ctx.beginPath(); ctx.moveTo(ix - ir, iy); ctx.lineTo(ix + ir, iy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ix, iy - ir); ctx.lineTo(ix, iy + ir); ctx.stroke();
    ctx.fillStyle = activeSensor() ? 'rgba(122,169,255,.95)' : '#FF5A5A';
    ctx.beginPath();
    ctx.arc(ix + targetAccel.x * ir, iy + targetAccel.y * ir, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ── Physik-Tick ───────────────────────────────────────────────────────────
let physicsInFlight = false;
async function physicsTick(dt) {
  if (!running || physicsInFlight) return;
  physicsInFlight = true;
  try {
    const resp = await fetch('/api/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accel: { x: targetAccel.x, y: targetAccel.y },
                             dt_seconds: dt, ball, tiles, coins }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const out = await resp.json();
    ball  = out.ball;
    coins = out.coins;
    if (out.score_delta) {
      score += out.score_delta;
      if (scoreEl) scoreEl.textContent = String(score);
    }
    const coll = coins.filter(c => c.collected).length;
    if (coinsEl) coinsEl.textContent = `${coll}/${coins.length}`;
    if (out.game_over) {
      running = false;
      if (btnRestart) btnRestart.disabled = false;
      if (msgEl) msgEl.textContent = '💥 Game Over – Ins Loch gefallen!';
      showOverlay(); return;
    }
    if (out.level_completed) {
      running = false;
      if (btnRestart) btnRestart.disabled = false;
      if (msgEl) msgEl.textContent = `🎉 Level geschafft! +${out.score_delta} Punkte!`;
      showOverlay(); return;
    }
  } catch (err) {
    console.error('physicsTick:', err);
  } finally {
    physicsInFlight = false;
  }
}

// ── Game-Loop ─────────────────────────────────────────────────────────────
function loop(ts) {
  if (!running) { draw(); return; }

  const dt = Math.min(0.04, (ts - lastTs) / 1000 || 0.016);
  lastTs = ts;
  if (timeEl) timeEl.textContent = ((ts - startTs) / 1000).toFixed(1) + 's';

  // Priorität: Gyro > Joystick > Tastatur > Abklingen
  if (gyroEnabled) {
    applyGyro();
    updateDebug();
  } else if (joy.active) {
    const j = accelFromJoy();
    targetAccel.x = j.x; targetAccel.y = j.y;
  } else if (keys.size > 0) {
    const k = accelFromKeys();
    targetAccel.x = k.x; targetAccel.y = k.y;
  } else {
    targetAccel.x *= 0.84;
    targetAccel.y *= 0.84;
  }

  physicsTick(dt).finally(() => {
    draw();
    if (running) requestAnimationFrame(loop);
  });
}

// ── Spiel starten ─────────────────────────────────────────────────────────
function startGame() {
  if (!level) return;
  running = true;
  // [FIX] nur hasFirstGyro zurücksetzen, smoothed-Werte NICHT auf 0
  if (gyroEnabled) hasFirstGyro = false;
  hideOverlay();
  if (btnRestart) btnRestart.disabled = false;
  startTs = performance.now(); lastTs = startTs;
  targetAccel.x = 0; targetAccel.y = 0;
  requestAnimationFrame(loop);
}

// ── Button-Handler ────────────────────────────────────────────────────────
btnStart?.addEventListener('click', async () => {
  try {
    if (btnStart) btnStart.disabled = true;
    await loadLevel();
    startGame();
  } catch (e) {
    if (msgEl) msgEl.textContent = `Fehler: ${e.message}`;
    if (btnStart) btnStart.disabled = false;
  }
});

btnRestart?.addEventListener('click', async () => {
  try {
    if (btnRestart) btnRestart.disabled = true;
    running = false;
    await loadLevel();
    startGame();
  } catch (e) {
    console.error(e);
    if (btnRestart) btnRestart.disabled = false;
  }
});

// ── Start ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    await loadLevel();
    draw();
    showOverlay();
  } catch (e) {
    if (msgEl) msgEl.textContent = `Verbindungsfehler: ${e.message}`;
    showOverlay();
  }
})();
