// Textures for the Play board: card faces (from dreamborn's CDN, downscaled),
// a procedurally drawn card back, and canvas-rendered counter badges.
import * as THREE from 'three';

export const CARD_W = 6.3;
export const CARD_H = 8.8;
export const IMG = (id) => `https://cdn.dreamborn.ink/images/en/cards/${id}`;

let renderer = null;
export function initTextures(r) { renderer = r; }

function finish(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  tex.needsUpdate = true;
  return tex;
}

// ---------- card faces ----------
const faceCache = new Map();   // cardId -> { tex, ready:Promise }
let placeholder = null;

function placeholderTex() {
  if (placeholder) return placeholder;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 358;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, c.height);
  grd.addColorStop(0, '#3b3f63'); grd.addColorStop(1, '#1c1e33');
  g.fillStyle = grd; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#c9a44a'; g.lineWidth = 8; g.strokeRect(8, 8, c.width - 16, c.height - 16);
  g.fillStyle = '#c9a44a'; g.font = 'bold 28px system-ui'; g.textAlign = 'center';
  g.fillText('loading…', c.width / 2, c.height / 2);
  placeholder = finish(new THREE.CanvasTexture(c));
  return placeholder;
}

// Returns a texture immediately (placeholder until the real image arrives).
export function faceTexture(cardId) {
  let e = faceCache.get(cardId);
  if (e) return e.tex;
  const tex = new THREE.Texture();
  tex.image = placeholderTex().image;
  finish(tex);
  e = { tex };
  faceCache.set(cardId, e);
  e.ready = (async () => {
    try {
      const res = await fetch(IMG(cardId), { mode: 'cors' });
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      // downscale on decode: 512px wide is plenty on the table and keeps VRAM sane
      const bmp = await createImageBitmap(blob, { resizeWidth: 512, resizeHeight: 714, resizeQuality: 'high', imageOrientation: 'flipY' });
      tex.image = bmp;
      tex.flipY = false;          // ImageBitmap ignores flipY — we flip at decode time instead
      tex.userData.bitmap = true;
      finish(tex);
    } catch (err) {
      console.warn('[play] card image failed', cardId, err);
    }
  })();
  return tex;
}

// ---------- card back (original art, not the official back) ----------
let backTex = null;
export function backTexture() {
  if (backTex) return backTex;
  const c = document.createElement('canvas');
  c.width = 512; c.height = 714;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const grd = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, H * 0.7);
  grd.addColorStop(0, '#2c3a7a'); grd.addColorStop(0.6, '#161c45'); grd.addColorStop(1, '#0b0d24');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  // swirl lines
  g.strokeStyle = 'rgba(160,180,255,0.08)'; g.lineWidth = 3;
  for (let i = 0; i < 26; i++) {
    g.beginPath();
    for (let t = 0; t <= 1.001; t += 0.02) {
      const a = t * Math.PI * 3 + i * 0.24;
      const r = 30 + t * 340;
      const x = W / 2 + Math.cos(a) * r, y = H / 2 + Math.sin(a) * r * 1.2;
      t === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
  }
  // gold frame
  g.strokeStyle = '#d4b25c'; g.lineWidth = 14; roundRect(g, 18, 18, W - 36, H - 36, 26); g.stroke();
  g.strokeStyle = 'rgba(212,178,92,0.5)'; g.lineWidth = 4; roundRect(g, 40, 40, W - 80, H - 80, 18); g.stroke();
  // central hexagon "ink drop"
  g.save(); g.translate(W / 2, H / 2);
  g.fillStyle = 'rgba(212,178,92,0.15)'; g.strokeStyle = '#d4b25c'; g.lineWidth = 8;
  hex(g, 120); g.fill(); g.stroke();
  g.lineWidth = 3; hex(g, 96); g.stroke();
  g.fillStyle = '#f2dc9b'; g.font = '700 84px "Space Grotesk", system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('INK', 0, 6);
  g.restore();
  backTex = finish(new THREE.CanvasTexture(c));
  return backTex;
}

function hex(g, r) {
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
}
export function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// ---------- badges (counters) ----------
// Each badge is drawn once per unique content and cached.
const badgeCache = new Map();
const FONT = '"Space Grotesk", "Inter", system-ui, sans-serif';

function canvasTex(key, w, h, draw) {
  let t = badgeCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  t = finish(new THREE.CanvasTexture(c));
  t.userData.aspect = w / h;
  badgeCache.set(key, t);
  if (badgeCache.size > 600) { const k = badgeCache.keys().next().value; badgeCache.get(k).dispose(); badgeCache.delete(k); }
  return t;
}

// Red damage counter with a number.
export function damageTex(n) {
  return canvasTex(`dmg:${n}`, 128, 128, (g, w, h) => {
    g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 10;
    const grd = g.createRadialGradient(w * 0.4, h * 0.35, 6, w / 2, h / 2, w / 2);
    grd.addColorStop(0, '#ff6b6b'); grd.addColorStop(1, '#a3101c');
    g.fillStyle = grd;
    g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 8, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;
    g.lineWidth = 6; g.strokeStyle = '#ffd6d6'; g.stroke();
    g.fillStyle = '#fff'; g.font = `800 ${n >= 10 ? 56 : 68}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), w / 2, h / 2 + 4);
  });
}

// Stat strip under a card: [{icon, value, base}] — value colored vs base.
export function statsTex(items) {
  const key = 'st:' + items.map((i) => `${i.icon}${i.value}/${i.base}/${i.extra || ''}`).join('|');
  const cellW = 112;
  return canvasTex(key, cellW * items.length, 72, (g, w, h) => {
    g.fillStyle = 'rgba(10,12,28,0.88)'; roundRect(g, 2, 2, w - 4, h - 4, 18); g.fill();
    g.strokeStyle = 'rgba(212,178,92,0.9)'; g.lineWidth = 3; g.stroke();
    items.forEach((it, i) => {
      const x = i * cellW + cellW / 2;
      const col = it.value > it.base ? '#6dff9a' : it.value < it.base ? '#ff7d7d' : '#ffffff';
      g.font = `700 34px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'right';
      g.fillStyle = it.iconColor || '#f2dc9b'; g.fillText(it.icon, x - 4, h / 2 + 2);
      g.textAlign = 'left'; g.fillStyle = col; g.font = `800 40px ${FONT}`;
      g.fillText(String(it.value) + (it.extra || ''), x + 2, h / 2 + 3);
    });
  });
}

// Small pill label (status chips: DRYING, +Evasive, ×2 under, counts).
export function pillTex(text, bg = '#1b2a6b', fg = '#fff') {
  return canvasTex(`pill:${text}:${bg}:${fg}`, Math.max(96, 26 + text.length * 22), 56, (g, w, h) => {
    g.fillStyle = bg; roundRect(g, 2, 2, w - 4, h - 4, 26); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 3; g.stroke();
    g.fillStyle = fg; g.font = `800 32px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 2);
  });
}

// Big number for the lore dial center / zone counts.
export function numberTex(text, color = '#f2dc9b', sub = '') {
  return canvasTex(`num:${text}:${color}:${sub}`, 256, 256, (g, w, h) => {
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 12;
    g.font = `800 ${String(text).length > 2 ? 96 : 128}px ${FONT}`;
    g.fillText(String(text), w / 2, sub ? h / 2 - 18 : h / 2 + 6);
    if (sub) { g.font = `700 40px ${FONT}`; g.fillStyle = '#c8cff5'; g.fillText(sub, w / 2, h / 2 + 70); }
  });
}

// Floating combat text (+2 ◆, -3, Banished!)
export function floatTex(text, color) {
  return canvasTex(`float:${text}:${color}`, Math.max(160, 40 + text.length * 40), 96, (g, w, h) => {
    g.font = `900 64px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 10; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(text, w / 2, h / 2 + 4);
    g.fillStyle = color; g.fillText(text, w / 2, h / 2 + 4);
  });
}

// Table felt with zone outlines.
export function tableTex() {
  const c = document.createElement('canvas');
  c.width = 2048; c.height = 1576;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(c.width / 2, c.height / 2, 100, c.width / 2, c.height / 2, c.width * 0.65);
  grd.addColorStop(0, '#24305f'); grd.addColorStop(0.7, '#151b3c'); grd.addColorStop(1, '#0b0e22');
  g.fillStyle = grd; g.fillRect(0, 0, c.width, c.height);
  // subtle noise
  const img = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // center line
  g.strokeStyle = 'rgba(212,178,92,0.35)'; g.lineWidth = 4; g.setLineDash([24, 18]);
  g.beginPath(); g.moveTo(80, c.height / 2); g.lineTo(c.width - 80, c.height / 2); g.stroke();
  g.setLineDash([]);
  return finish(new THREE.CanvasTexture(c));
}
