'use strict';
/* =========================================================
   Gravity Maze – Frontend
   Controls: Gyroscope (Android) · Virtual Joystick (Touch) · WASD / Arrows
   ========================================================= */

// ── DOM refs ──────────────────────────────────────────────────────────────
const canvas    = document.getElementById('game');
const ctx       = canvas.getContext('2d');
const scoreEl   = document.getElementById('score');
const coinsEl   = document.getElementById('coins');
const timeEl    = document.getElementById('time');
const overlay   = document.getElementById('overlay');
const msgEl     = document.getElementById('msg');
const btnStart  = document.getElementById('btnStart');
const btnRestart= document.getElementById('btnRestart');
const btnGyro   = document.getElementById('btnGyro');
const btnCalib  = document.getElementById('btnCalib');
const gyroBadge = document.getElementById('gyroBadge');
const toast     = document.getElementById('toast');

// ── Game state ────────────────────────────────────────────────────────────
let level   = null;
let tiles   = [];
let coins   = [];
let holeTiles = [];
let ball    = null;

let score   = 0;
let running = false;
let lastTs  = 0;
let startTs = 0;

// ── Target acceleration for physics step ──────────────────────────────────
const targetAccel = { x: 0, y: 0 };

// ── Keyboard ──────────────────────────────────────────────────────────────
const keys = new Set();

window.addEventListener('keydown', e => {
  keys.add(e.key);
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',
       'a','A','w','W','s','S','d','D'].includes(e.key)) e.preventDefault();
});
window.addEventListener('keyup', e => keys.delete(e.key));

function accelFromKeys() {
  let x = 0, y = 0;
  if (keys.has('ArrowLeft')  || keys.has('a') || keys.has('A')) x -= 1;
  if (keys.has('ArrowRight') || keys.has('d') || keys.has('D')) x += 1;
  if (keys.has('ArrowUp')    || keys.has('w') || keys.has('W')) y -= 1;
  if (keys.has('ArrowDown')  || keys.has('s') || keys.has('S')) y += 1;
  const mag = Math.hypot(x, y);
  if (mag > 1) { x /= mag; y /= mag; }
  return { x, y };
}

// ── Virtual joystick ──────────────────────────────────────────────────────
const JOY_MAX_PX = 56; // max drag distance in CSS pixels
const JOY_DEAD   = 0.06;

const joy = {
  active: false,
  startX: 0, startY: 0,
  dx: 0, dy: 0,
};

canvas.addEventListener('pointerdown', e => {
  // Don't steal touches in a gyro session but allow joystick fallback
  joy.active = true;
  joy.startX = e.clientX;
  joy.startY = e.clientY;
  joy.dx = 0;
  joy.dy = 0;
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
});

canvas.addEventListener('pointermove', e => {
  if (!joy.active) return;
  joy.dx = e.clientX - joy.startX;
  joy.dy = e.clientY - joy.startY;
  e.preventDefault();
});

function endJoy() {
  joy.active = false;
  joy.dx = 0;
  joy.dy = 0;
  if (!gyroEnabled) { targetAccel.x = 0; targetAccel.y = 0; }
}
canvas.addEventListener('pointerup',     endJoy);
canvas.addEventListener('pointercancel', endJoy);

function accelFromJoy() {
  const dist = Math.hypot(joy.dx, joy.dy);
  const scale = Math.min(dist, JOY_MAX_PX) / JOY_MAX_PX;
  let ax = dist > 0 ? (joy.dx / dist) * scale : 0;
  let ay = dist > 0 ? (joy.dy / dist) * scale : 0;
  if (Math.abs(ax) < JOY_DEAD) ax = 0;
  if (Math.abs(ay) < JOY_DEAD) ay = 0;
  return { x: ax, y: ay };
}

// ── Gyroscope ─────────────────────────────────────────────────────────────
let gyroEnabled    = false;
let calibBeta      = 45;   // neutral beta (phone held ~45° from flat)
let calibGamma     = 0;
let smoothedBeta   = 45;
let smoothedGamma  = 0;
let hasFirstGyro   = false;

const GYRO_ALPHA   = 0.80;  // low-pass filter (0 = raw, 1 = frozen)
const GYRO_RANGE   = 28;    // degrees tilt for max acceleration
const GYRO_DEAD    = 0.04;

function onDeviceOrientation(e) {
  if (!gyroEnabled) return;
  const beta  = e.beta  ?? 0;
  const gamma = e.gamma ?? 0;

  // Auto-calibrate on first reading so current hold = neutral
  if (!hasFirstGyro) {
    calibBeta  = beta;
    calibGamma = gamma;
    smoothedBeta  = beta;
    smoothedGamma = gamma;
    hasFirstGyro  = true;
  }

  // Low-pass filter
  smoothedBeta  = GYRO_ALPHA * smoothedBeta  + (1 - GYRO_ALPHA) * beta;
  smoothedGamma = GYRO_ALPHA * smoothedGamma + (1 - GYRO_ALPHA) * gamma;

  let ax = clamp((smoothedGamma - calibGamma) / GYRO_RANGE, -1, 1);
  let ay = clamp((smoothedBeta  - calibBeta)  / GYRO_RANGE, -1, 1);

  if (Math.abs(ax) < GYRO_DEAD) ax = 0;
  if (Math.abs(ay) < GYRO_DEAD) ay = 0;

  // While joystick is being dragged, blend joystick on top of gyro
  if (joy.active) {
    const j = accelFromJoy();
    ax = j.x;
    ay = j.y;
  }

  targetAccel.x = ax;
  targetAccel.y = ay;
}

async function toggleGyro() {
  if (gyroEnabled) {
    gyroEnabled = false;
    hasFirstGyro = false;
    targetAccel.x = 0;
    targetAccel.y = 0;
    gyroBadge.classList.add('hidden');
    btnGyro.classList.remove('active');
    btnCalib.classList.add('hidden');
    showToast('Gyroskop deaktiviert');
    return;
  }

  // iOS Safari needs explicit permission
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const result = await DeviceOrientationEvent.requestPermission();
      if (result !== 'granted') {
        showToast('Gyroskop-Zugriff verweigert');
        return;
      }
    } catch (err) {
      showToast('Gyroskop nicht verfügbar');
      return;
    }
  }

  // Check for sensor support
  if (!('DeviceOrientationEvent' in window)) {
    showToast('Dieses Gerät hat kein Gyroskop');
    return;
  }

  gyroEnabled = true;
  hasFirstGyro = false;
  window.addEventListener('deviceorientation', onDeviceOrientation);
  gyroBadge.classList.remove('hidden');
  btnGyro.classList.add('active');
  btnCalib.classList.remove('hidden');
  showToast('Gyroskop aktiv – Handy neigen zum Spielen');
}

function calibrateGyro() {
  calibBeta  = smoothedBeta;
  calibGamma = smoothedGamma;
  showToast('Kalibriert! Aktuelle Position = Neutral');
}

btnGyro.addEventListener('click', toggleGyro);
btnCalib.addEventListener('click', calibrateGyro);

// ── Toast helper ──────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, durationMs = 2200) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), durationMs);
}

// ── Canvas resizing ───────────────────────────────────────────────────────
function resizeCanvas() {
  const w   = window.innerWidth;
  const h   = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (level) draw();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── Helpers ───────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function hideOverlay() { overlay.classList.add('hidden'); }
function showOverlay() { overlay.classList.remove('hidden'); }

// ── World → Screen coordinate mapping ────────────────────────────────────
function worldToScreen(wx, wy) {
  const W   = window.innerWidth;
  const H   = window.innerHeight;
  const tw  = level.world_width_tiles;
  const th  = level.world_height_tiles;
  const pad = 54;                             // leave space for HUD / ctrl-bar
  const avW = W - pad * 2;
  const avH = H - pad * 2;
  const tpx = Math.min(avW / tw, avH / th);
  const ox  = (W - tpx * tw) / 2;
  const oy  = (H - tpx * th) / 2;
  return { sx: ox + wx * tpx, sy: oy + wy * tpx, tpx };
}

// ── Load level from backend ───────────────────────────────────────────────
async function loadLevel() {
  const res = await fetch('/api/level');
  if (!res.ok) throw new Error(`Level HTTP ${res.status}`);
  level    = await res.json();
  tiles    = level.tiles;
  coins    = level.coins.map(c => ({ ...c, collected: false }));
  holeTiles= level.hole_tiles || [];

  ball = {
    pos: { x: level.start.x, y: level.start.y },
    vel: { x: 0, y: 0 },
    radius: 0.22,
  };

  score = 0;
  scoreEl.textContent = '0';
  coinsEl.textContent = `0/${coins.length}`;
  timeEl.textContent  = '0.0s';
  msgEl.textContent   = '';
  running = false;
  btnRestart.disabled = true;
}

// ── Rendering ─────────────────────────────────────────────────────────────
function draw() {
  if (!level || !ball) return;

  const W = window.innerWidth;
  const H = window.innerHeight;
  ctx.clearRect(0, 0, W, H);

  const { sx: ox, sy: oy, tpx } = worldToScreen(0, 0);
  const tw = level.world_width_tiles;
  const th = level.world_height_tiles;

  // Faint grid
  ctx.save();
  ctx.strokeStyle = 'rgba(130,160,255,.08)';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= tw; i++) {
    const x = ox + i * tpx;
    ctx.beginPath(); ctx.moveTo(x, oy); ctx.lineTo(x, oy + th * tpx); ctx.stroke();
  }
  for (let j = 0; j <= th; j++) {
    const y = oy + j * tpx;
    ctx.beginPath(); ctx.moveTo(ox, y); ctx.lineTo(ox + tw * tpx, y); ctx.stroke();
  }
  ctx.restore();

  // Walls
  ctx.fillStyle = '#2A3256';
  for (const t of tiles) {
    if (t.type === 'WALL') {
      ctx.fillRect(ox + t.x * tpx, oy + t.y * tpx, tpx + 0.5, tpx + 0.5);
    }
  }

  // Wall inner bevel / depth
  ctx.fillStyle = 'rgba(20,30,70,.6)';
  for (const t of tiles) {
    if (t.type === 'WALL') {
      ctx.fillRect(ox + t.x * tpx + 2, oy + t.y * tpx + 2, tpx - 3, tpx - 3);
    }
  }

  // Goal
  for (const t of tiles) {
    if (t.type !== 'GOAL') continue;
    const cx = ox + (t.x + 0.5) * tpx;
    const cy = oy + (t.y + 0.5) * tpx;
    const r  = tpx * 0.35;

    const pulse = 0.88 + 0.12 * Math.sin(Date.now() / 300);
    ctx.save();
    ctx.shadowColor = 'rgba(60,255,143,.7)';
    ctx.shadowBlur  = 14;
    ctx.fillStyle   = `rgba(60,255,143,${0.85 * pulse})`;
    ctx.beginPath(); ctx.arc(cx, cy, r * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(60,255,143,.5)';
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.3, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // Coins
  for (const t of tiles) {
    if (t.type !== 'COIN') continue;
    const c = coins.find(c => c.x === t.x && c.y === t.y);
    if (c?.collected) continue; // skip collected coins
    const cx = ox + (t.x + 0.5) * tpx;
    const cy = oy + (t.y + 0.5) * tpx;
    const r  = tpx * 0.20;
    ctx.save();
    ctx.shadowColor = 'rgba(255,211,77,.5)';
    ctx.shadowBlur  = 6;
    ctx.fillStyle   = '#FFD34D';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    // shine
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.beginPath(); ctx.arc(cx - r * .25, cy - r * .25, r * .35, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Holes
  for (const t of holeTiles) {
    const cx = ox + (t.x + 0.5) * tpx;
    const cy = oy + (t.y + 0.5) * tpx;
    const r  = tpx * 0.28;
    ctx.save();
    ctx.shadowColor = 'rgba(110,76,255,.8)';
    ctx.shadowBlur  = 10;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(30,0,80,1)');
    g.addColorStop(1, 'rgba(110,76,255,.8)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Ball trail
  const bcx = ox + ball.pos.x * tpx;
  const bcy = oy + ball.pos.y * tpx;
  const br  = ball.radius * tpx;
  const vx  = ball.vel.x, vy = ball.vel.y;
  const trailLen = 14;
  const tx  = bcx - vx * tpx * 0.055 * trailLen;
  const ty  = bcy - vy * tpx * 0.055 * trailLen;
  ctx.save();
  ctx.globalAlpha = 0.30;
  ctx.strokeStyle = 'rgba(122,169,255,.85)';
  ctx.lineWidth   = Math.max(1.5, br * 0.22);
  ctx.lineCap     = 'round';
  ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(bcx, bcy); ctx.stroke();
  ctx.restore();

  // Ball
  ctx.save();
  ctx.shadowColor = 'rgba(122,169,255,.65)';
  ctx.shadowBlur  = 18;
  const bg = ctx.createRadialGradient(bcx - br * .3, bcy - br * .3, br * .05, bcx, bcy, br);
  bg.addColorStop(0, '#A8C8FF');
  bg.addColorStop(1, '#4A80E0');
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.arc(bcx, bcy, br, 0, Math.PI * 2); ctx.fill();
  // specular
  ctx.fillStyle = 'rgba(255,255,255,.72)';
  ctx.beginPath(); ctx.arc(bcx - br * .28, bcy - br * .28, br * .22, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Virtual joystick indicator
  if (joy.active && !gyroEnabled) {
    const jx = joy.startX;
    const jy = joy.startY;
    const dist = Math.hypot(joy.dx, joy.dy);
    const clamped = Math.min(dist, JOY_MAX_PX);
    const angle   = Math.atan2(joy.dy, joy.dx);
    const knobX   = jx + Math.cos(angle) * clamped;
    const knobY   = jy + Math.sin(angle) * clamped;

    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = 'rgba(122,169,255,.7)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath(); ctx.arc(jx, jy, JOY_MAX_PX, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle   = 'rgba(122,169,255,.35)';
    ctx.beginPath(); ctx.arc(jx, jy, 14, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle   = 'rgba(255,255,255,.9)';
    ctx.beginPath(); ctx.arc(knobX, knobY, 20, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Gyro tilt indicator (top-right mini compass)
  if (gyroEnabled) {
    const ix  = W - 44;
    const iy  = 88;
    const ir  = 16;
    const ax  = targetAccel.x;
    const ay  = targetAccel.y;
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = 'rgba(122,169,255,.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(ix, iy, ir, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(122,169,255,.9)';
    ctx.beginPath(); ctx.arc(ix + ax * ir, iy + ay * ir, 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

// ── Physics tick (HTTP to backend) ───────────────────────────────────────
let physicsInFlight = false;

async function physicsTick(dt) {
  if (!running || physicsInFlight) return;
  physicsInFlight = true;
  try {
    const resp = await fetch('/api/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accel:      { x: targetAccel.x, y: targetAccel.y },
        dt_seconds: dt,
        ball:       ball,
        tiles:      tiles,
        coins:      coins,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const out = await resp.json();

    ball  = out.ball;
    coins = out.coins;

    if (out.score_delta) {
      score += out.score_delta;
      scoreEl.textContent = String(score);
    }

    const collected = coins.filter(c => c.collected).length;
    coinsEl.textContent = `${collected}/${coins.length}`;

    if (out.game_over) {
      running = false;
      btnRestart.disabled = false;
      msgEl.textContent   = '💥 Game Over – Ins Loch gefallen!';
      showOverlay();
      return;
    }

    if (out.level_completed) {
      running = false;
      btnRestart.disabled = false;
      msgEl.textContent   = `🎉 Level geschafft! +${out.score_delta} Punkte!`;
      showOverlay();
      return;
    }
  } catch (err) {
    console.error('physicsTick:', err);
  } finally {
    physicsInFlight = false;
  }
}

// ── Main game loop ────────────────────────────────────────────────────────
function loop(ts) {
  if (!running) {
    draw();
    return;
  }

  const dt = Math.min(0.04, (ts - lastTs) / 1000 || 0.016);
  lastTs   = ts;
  timeEl.textContent = ((ts - startTs) / 1000).toFixed(1) + 's';

  // Priority: gyro > joystick > keyboard
  if (!gyroEnabled) {
    if (joy.active) {
      const j = accelFromJoy();
      targetAccel.x = j.x;
      targetAccel.y = j.y;
    } else if (keys.size > 0) {
      const k = accelFromKeys();
      targetAccel.x = k.x;
      targetAccel.y = k.y;
    } else {
      // Decay toward zero for smooth stop
      targetAccel.x *= 0.85;
      targetAccel.y *= 0.85;
    }
  }

  physicsTick(dt).finally(() => {
    draw();
    if (running) requestAnimationFrame(loop);
  });
}

// ── Start game ────────────────────────────────────────────────────────────
function startGame() {
  if (!level) return;
  running = true;
  hideOverlay();
  btnRestart.disabled = false;
  startTs = performance.now();
  lastTs  = startTs;
  targetAccel.x = 0;
  targetAccel.y = 0;
  requestAnimationFrame(loop);
}

// ── Button handlers ───────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  try {
    btnStart.disabled = true;
    await loadLevel();
    startGame();
  } catch (e) {
    msgEl.textContent = `Fehler: ${e.message}`;
    btnStart.disabled = false;
  }
});

btnRestart.addEventListener('click', async () => {
  try {
    btnRestart.disabled = true;
    running = false;
    await loadLevel();
    startGame();
  } catch (e) {
    console.error(e);
    btnRestart.disabled = false;
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────
(async () => {
  try {
    await loadLevel();
    draw();
    showOverlay();
  } catch (e) {
    msgEl.textContent = `Verbindungsfehler: ${e.message}`;
    showOverlay();
  }
})();