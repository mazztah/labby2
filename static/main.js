'use strict';
/* =========================================================
   Gravity Maze – Frontend  (v3 – Gyro-Fix)
   Steuerung: Gyroskop · Virtueller Joystick · WASD / Pfeiltasten

   WICHTIGE GYRO-FIXES gegenüber v2:
   ① Sensor-Listener schon beim Seitenstart aktiv (nicht erst beim Button)
   ② Sensor-Check: 600 ms warten → prüfen ob Events ankamen
   ③ Gyro-Werte im Game-Loop anwenden (nicht im Event-Handler)
   ④ startGame() resettet nur hasFirstGyro, nicht die geglätteten Werte
   ⑤ Y-Flip-Button falls Richtung verkehrt
   ⑥ Klares Debug-Panel mit Live-Werten
   ========================================================= */

// ── DOM-Referenzen ────────────────────────────────────────────────────────
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
const btnCalib   = document.getElementById('btnCalib');
const btnFlipY   = document.getElementById('btnFlipY');
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
//  GYROSKOP  –  Komplette Neuimplementierung (Fix ①–⑥)
// ═══════════════════════════════════════════════════════════════════════════

// ── FIX ①: Sensor-Events sofort ab Seitenstart sammeln ──────────────────
//   (nicht erst wenn der Nutzer den Button drückt)
let rawBeta      = null;   // letzter beta-Wert (null = noch kein Event)
let rawGamma     = null;   // letzter gamma-Wert
let sensorCount  = 0;      // Zähler aller eingehenden Events
let sensorLastMs = 0;      // Zeitstempel des letzten Events

window.addEventListener('deviceorientation', e => {
  // Manche Android-Browser liefern kurz null-Werte – ignorieren
  if (e.beta == null || !Number.isFinite(+e.beta)) return;
  rawBeta      = +e.beta;
  rawGamma     = +(e.gamma ?? 0);
  sensorCount++;
  sensorLastMs = Date.now();
}, false);

// ── Gyro-Zustand ──────────────────────────────────────────────────────────
let gyroEnabled  = false;
let hasFirstGyro = false;  // wird beim 1. Loop-Tick nach Aktivierung gesetzt
let calibBeta    = 0;
let calibGamma   = 0;
let smoothBeta   = 0;
let smoothGamma  = 0;
let flipY        = false;  // Y-Richtung umkehren (falls verkehrt)

const GYRO_ALPHA = 0.72;   // Low-pass-Stärke (niedriger = flüssiger, mehr Rauschen)
const GYRO_RANGE = 26;     // Neigungsgrad für maximale Beschleunigung
const GYRO_DEAD  = 0.04;   // Deadzone gegen Sensor-Drift

// ── Bildschirmrotation ermitteln ──────────────────────────────────────────
function getScreenRot() {
  try {
    if (typeof screen?.orientation?.angle === 'number') {
      return ((screen.orientation.angle % 360) + 360) % 360;
    }
    if (typeof window.orientation === 'number') {
      return ((window.orientation % 360) + 360) % 360;
    }
  } catch (_) {}
  return 0;
}

// ── FIX ③: Gyro-Werte im Game-Loop anwenden (nicht im Event-Handler) ─────
function applyGyro() {
  if (!gyroEnabled || rawBeta === null) return;
  // Zu alte Daten? (Sensor eingeschlafen)
  if (Date.now() - sensorLastMs > 900) return;

  // FIX ④: Kalibrieren beim 1. Aufruf (aktuelle Haltung = Nulllage)
  if (!hasFirstGyro) {
    calibBeta   = rawBeta;
    calibGamma  = rawGamma;
    smoothBeta  = rawBeta;
    smoothGamma = rawGamma;
    hasFirstGyro = true;
    showToast('📐 Kalibriert – jetzt neigen!', 1800);
  }

  // Low-pass-Filter (Jitter glätten)
  smoothBeta  = GYRO_ALPHA * smoothBeta  + (1 - GYRO_ALPHA) * rawBeta;
  smoothGamma = GYRO_ALPHA * smoothGamma + (1 - GYRO_ALPHA) * rawGamma;

  // Neigung → Beschleunigung
  let ax = clamp((smoothGamma - calibGamma) / GYRO_RANGE, -1, 1);
  let ay = clamp((smoothBeta  - calibBeta)  / GYRO_RANGE, -1, 1);

  // Y-Flip (Knopf für verkehrte Richtung)
  if (flipY) ay = -ay;

  // Bildschirmrotation kompensieren (Querformat links/rechts)
  const rot = getScreenRot();
  if (rot === 90)  { const t = ax; ax =  ay; ay = -t; }
  if (rot === 180) { ax = -ax; ay = -ay; }
  if (rot === 270) { const t = ax; ax = -ay; ay =  t; }

  // Deadzone
  if (Math.abs(ax) < GYRO_DEAD) ax = 0;
  if (Math.abs(ay) < GYRO_DEAD) ay = 0;

  targetAccel.x = ax;
  targetAccel.y = ay;
}

// ── FIX ②: Gyro-Button mit Sensor-Check ──────────────────────────────────
async function toggleGyro() {
  if (gyroEnabled) {
    gyroEnabled = false;
    targetAccel.x = 0; targetAccel.y = 0;
    gyroBadge.classList.add('hidden');
    btnGyro.classList.remove('active');
    btnCalib.classList.add('hidden');
    btnFlipY.classList.add('hidden');
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

  // Sensor-Check: 600 ms warten, dann zählen ob Events ankamen
  const nBefore = sensorCount;
  showToast('⏳ Sensor wird geprüft…', 900);
  await new Promise(r => setTimeout(r, 650));

  if (sensorCount === nBefore || rawBeta === null) {
    // Kein Signal → mit Diagnose-Hinweis abbrechen
    showToast(
      '❌ Kein Gyro-Signal!\n' +
      '→ Seite per HTTPS öffnen (Render ✓)\n' +
      '→ Chrome: Einstellungen › Bewegungssensoren\n' +
      '→ Gerät hat möglicherweise kein Gyroskop',
      5000
    );
    return;
  }

  // Alles OK → aktivieren
  gyroEnabled  = true;
  hasFirstGyro = false;   // kalibriert beim ersten Loop-Tick (FIX ③/④)
  gyroBadge.classList.remove('hidden');
  btnGyro.classList.add('active');
  btnCalib.classList.remove('hidden');
  btnFlipY.classList.remove('hidden');
  showToast('📡 Gyro aktiv – Handy neigen zum Spielen');
}

// Neu-Kalibrierung: aktuelle Haltung = Nulllage
function calibrateGyro() {
  hasFirstGyro = false;
  showToast('📐 Halte in Spielposition…', 1200);
}

// FIX ⑤: Y-Achse umkehren, falls Kugel falsch reagiert
function toggleFlipY() {
  flipY = !flipY;
  btnFlipY.classList.toggle('active', flipY);
  showToast(flipY ? '↕ Y-Achse gespiegelt' : '↕ Y-Achse normal');
}

btnGyro.addEventListener('click',  toggleGyro);
btnCalib.addEventListener('click', calibrateGyro);
btnFlipY.addEventListener('click', toggleFlipY);

// ── FIX ⑥: Debug-Panel (live) ─────────────────────────────────────────────
const dbgEl = (() => {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position:'fixed', left:'10px', bottom:'88px', zIndex:'60',
    padding:'9px 11px', borderRadius:'12px',
    background:'rgba(7,10,18,.88)',
    border:'1px solid rgba(122,169,255,.35)',
    color:'#c8daff', fontSize:'11.5px',
    fontFamily:'ui-monospace,SFMono-Regular,monospace',
    pointerEvents:'none', whiteSpace:'pre', lineHeight:'1.5',
    maxWidth:'min(340px,calc(100vw - 20px))',
    opacity:'0', transition:'opacity .25s',
    boxShadow:'0 4px 20px rgba(0,0,0,.4)',
  });
  document.body.appendChild(el);
  return el;
})();

function updateDebug() {
  const show = gyroEnabled;
  dbgEl.style.opacity = show ? '1' : '0';
  if (!show) return;
  const fresh = (Date.now() - sensorLastMs) < 900;
  const sigIcon = fresh ? '🟢' : (sensorCount > 0 ? '🟡' : '🔴');
  dbgEl.textContent =
    `Sensor  ${sigIcon} ${sensorCount} Events\n` +
    `β raw   ${rawBeta  !== null ? rawBeta.toFixed(1).padStart(7) : '   null'}\n` +
    `γ raw   ${rawGamma !== null ? rawGamma.toFixed(1).padStart(7) : '   null'}\n` +
    `β-cal   ${(smoothBeta  - calibBeta).toFixed(1).padStart(7)}\n` +
    `γ-cal   ${(smoothGamma - calibGamma).toFixed(1).padStart(7)}\n` +
    `accel   x${targetAccel.x.toFixed(2)} y${targetAccel.y.toFixed(2)}\n` +
    `flipY:${flipY}  rot:${getScreenRot()}°`;
}

// ── Toast ─────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, ms = 2200) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), ms);
}

// ── Canvas-Größe ──────────────────────────────────────────────────────────
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
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
function hideOverlay() { overlay.classList.add('hidden'); }
function showOverlay() { overlay.classList.remove('hidden'); }

// ── Welt → Bildschirm-Koordinaten ────────────────────────────────────────
function worldToScreen(wx, wy) {
  const W   = window.innerWidth;
  const H   = window.innerHeight;
  const tw  = level.world_width_tiles;
  const th  = level.world_height_tiles;
  const pad = 56;
  const tpx = Math.min((W - pad * 2) / tw, (H - pad * 2) / th);
  const ox  = (W - tpx * tw) / 2;
  const oy  = (H - tpx * th) / 2;
  return { sx: ox + wx * tpx, sy: oy + wy * tpx, tpx };
}

// ── Level vom Backend laden ───────────────────────────────────────────────
async function loadLevel() {
  const res = await fetch('/api/level');
  if (!res.ok) throw new Error(`Level HTTP ${res.status}`);
  level     = await res.json();
  tiles     = level.tiles;
  coins     = level.coins.map(c => ({ ...c, collected: false }));
  holeTiles = level.hole_tiles || [];
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

  // Gitter
  ctx.save();
  ctx.strokeStyle = 'rgba(130,160,255,.07)';
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

  // Wände (Außenfläche + Bevel)
  ctx.fillStyle = '#2A3256';
  for (const t of tiles) if (t.type === 'WALL')
    ctx.fillRect(ox + t.x * tpx, oy + t.y * tpx, tpx + 0.5, tpx + 0.5);
  ctx.fillStyle = 'rgba(15,22,55,.65)';
  for (const t of tiles) if (t.type === 'WALL')
    ctx.fillRect(ox + t.x * tpx + 2, oy + t.y * tpx + 2, tpx - 3.5, tpx - 3.5);

  // Ziel
  for (const t of tiles) {
    if (t.type !== 'GOAL') continue;
    const cx = ox + (t.x + 0.5) * tpx;
    const cy = oy + (t.y + 0.5) * tpx;
    const r  = tpx * 0.34;
    const p  = 0.87 + 0.13 * Math.sin(Date.now() / 290);
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
    const c = coins.find(c => c.x === t.x && c.y === t.y);
    if (c?.collected) continue;
    const cx = ox + (t.x + 0.5) * tpx;
    const cy = oy + (t.y + 0.5) * tpx;
    const r  = tpx * 0.19;
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
    const cx = ox + (t.x + 0.5) * tpx;
    const cy = oy + (t.y + 0.5) * tpx;
    const r  = tpx * 0.28;
    ctx.save();
    ctx.shadowColor = 'rgba(110,76,255,.8)'; ctx.shadowBlur = 10;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(20,0,60,1)');
    g.addColorStop(1, 'rgba(110,76,255,.85)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Ball-Trail
  const bcx = ox + ball.pos.x * tpx;
  const bcy = oy + ball.pos.y * tpx;
  const br  = ball.radius * tpx;
  const tvx = ball.vel.x * tpx * 0.05;
  const tvy = ball.vel.y * tpx * 0.05;
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.strokeStyle = 'rgba(122,169,255,.9)';
  ctx.lineWidth   = Math.max(1.5, br * 0.22);
  ctx.lineCap     = 'round';
  ctx.beginPath(); ctx.moveTo(bcx - tvx * 14, bcy - tvy * 14); ctx.lineTo(bcx, bcy); ctx.stroke();
  ctx.restore();

  // Ball
  ctx.save();
  ctx.shadowColor = 'rgba(122,169,255,.7)'; ctx.shadowBlur = 20;
  const bg = ctx.createRadialGradient(bcx - br * .3, bcy - br * .3, br * .05, bcx, bcy, br);
  bg.addColorStop(0, '#B0CCFF');
  bg.addColorStop(1, '#4078D8');
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.arc(bcx, bcy, br, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.7)';
  ctx.beginPath(); ctx.arc(bcx - br * .28, bcy - br * .28, br * .22, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Joystick-Overlay
  if (joy.active && !gyroEnabled) {
    const d   = Math.hypot(joy.dx, joy.dy);
    const cl  = Math.min(d, JOY_R);
    const ang = Math.atan2(joy.dy, joy.dx);
    const kx  = joy.sx + Math.cos(ang) * cl;
    const ky  = joy.sy + Math.sin(ang) * cl;
    ctx.save();
    ctx.globalAlpha = 0.48;
    ctx.strokeStyle = 'rgba(122,169,255,.75)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(joy.sx, joy.sy, JOY_R, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = 'rgba(122,169,255,.3)';
    ctx.beginPath(); ctx.arc(joy.sx, joy.sy, 13, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.88)';
    ctx.beginPath(); ctx.arc(kx, ky, 20, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Gyro-Tilt-Kreis (Mini-Kompass oben rechts)
  if (gyroEnabled) {
    const ix = W - 40, iy = 86, ir = 14;
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = 'rgba(122,169,255,.55)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(ix, iy, ir, 0, Math.PI * 2); ctx.stroke();
    // Achsenlinien
    ctx.strokeStyle = 'rgba(122,169,255,.25)';
    ctx.beginPath(); ctx.moveTo(ix - ir, iy); ctx.lineTo(ix + ir, iy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ix, iy - ir); ctx.lineTo(ix, iy + ir); ctx.stroke();
    // Dot
    ctx.fillStyle = 'rgba(122,169,255,.95)';
    ctx.beginPath();
    ctx.arc(ix + targetAccel.x * ir, iy + targetAccel.y * ir, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ── Physik-Tick (HTTP → Backend) ─────────────────────────────────────────
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
        ball,
        tiles,
        coins,
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
      running = false; btnRestart.disabled = false;
      msgEl.textContent = '💥 Game Over – Ins Loch gefallen!';
      showOverlay(); return;
    }
    if (out.level_completed) {
      running = false; btnRestart.disabled = false;
      msgEl.textContent = `🎉 Level geschafft! +${out.score_delta} Punkte!`;
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
  timeEl.textContent = ((ts - startTs) / 1000).toFixed(1) + 's';

  // Eingabe-Priorität: Gyro > Joystick > Tastatur > Abklingen
  if (gyroEnabled) {
    applyGyro();             // FIX ③: im Loop anwenden, nicht im Event-Handler
    updateDebug();           // FIX ⑥: Debug-Panel live aktualisieren
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

  // FIX ④: Gyro-Kalibrierung NICHT zurücksetzen (keine Null-Initialisierung)
  // Nur hasFirstGyro = false → beim 1. Loop-Tick wird mit echter Sensorlage kalibriert
  if (gyroEnabled) hasFirstGyro = false;

  hideOverlay();
  btnRestart.disabled = false;
  startTs = performance.now();
  lastTs  = startTs;
  targetAccel.x = 0;
  targetAccel.y = 0;
  requestAnimationFrame(loop);
}

// ── Button-Handler ────────────────────────────────────────────────────────
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

// ── Start ─────────────────────────────────────────────────────────────────
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
