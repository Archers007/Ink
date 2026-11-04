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

// The full 734x1024 image, for the few cards shown large (a lifted hand card, a card being cast) (#77). Null until it
// has decoded, so the caller keeps the small face meanwhile. A short LRU: only a handful are ever on screen at once,
// and every face at full size would cost ~4 MB of VRAM each.
const hiCache = new Map();     // cardId -> { tex, ok }
const HI_KEEP = 6;
export function faceTextureHi(cardId) {
  let e = hiCache.get(cardId);
  if (e) { hiCache.delete(cardId); hiCache.set(cardId, e); return e.ok ? e.tex : null; }   // refresh its LRU slot
  e = { tex: null, ok: false };
  hiCache.set(cardId, e);
  (async () => {
    try {
      const res = await fetch(IMG(cardId), { mode: 'cors' });     // the browser cache already has it from faceTexture
      if (!res.ok) throw new Error(res.status);
      const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'flipY' });
      const tex = new THREE.Texture(bmp);
      tex.flipY = false;
      finish(tex);
      if (hiCache.get(cardId) !== e) { tex.dispose(); bmp.close?.(); return; }   // evicted while loading
      e.tex = tex; e.ok = true;
    } catch { /* the small face stays */ }
  })();
  while (hiCache.size > HI_KEEP) {
    const [k, old] = hiCache.entries().next().value;
    hiCache.delete(k);
    if (old.tex) { old.tex.image?.close?.(); old.tex.dispose(); }
  }
  return null;
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
  grd.addColorStop(0, '#26317a'); grd.addColorStop(0.6, '#141a44'); grd.addColorStop(1, '#080b1f');
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
  g.strokeStyle = '#d9b45a'; g.lineWidth = 14; roundRect(g, 18, 18, W - 36, H - 36, 26); g.stroke();
  g.strokeStyle = 'rgba(217,180,90,0.5)'; g.lineWidth = 4; roundRect(g, 40, 40, W - 80, H - 80, 18); g.stroke();
  // central hexagon "ink drop"
  g.save(); g.translate(W / 2, H / 2);
  g.fillStyle = 'rgba(217,180,90,0.15)'; g.strokeStyle = '#d9b45a'; g.lineWidth = 8;
  hex(g, 120); g.fill(); g.stroke();
  g.lineWidth = 3; hex(g, 96); g.stroke();
  g.fillStyle = '#f6ecd0'; g.font = '700 84px Figtree, system-ui, sans-serif';
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
const FONT = 'Figtree, system-ui, sans-serif';

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

// Damage token: a raised red rounded square reading "−N" (a smaller minus, condensed digits so 10+ fits). Severe (one
// more point banishes it) turns it orange; the board pulses a halo behind it.
export function damageTex(n, severe = false) {
  return canvasTex(`dmg:${n}:${severe ? 1 : 0}`, 144, 144, (g, w, h) => {
    const m = 12, r = 30;
    g.shadowColor = 'rgba(0,0,0,0.65)'; g.shadowBlur = 12; g.shadowOffsetY = 4;
    const grd = g.createLinearGradient(0, m, 0, h - m);
    if (severe) { grd.addColorStop(0, '#ffab55'); grd.addColorStop(0.55, '#ff5a1f'); grd.addColorStop(1, '#e0361c'); }
    else { grd.addColorStop(0, '#f2444a'); grd.addColorStop(0.5, '#dc2430'); grd.addColorStop(1, '#bb1523'); }
    g.fillStyle = grd; roundRect(g, m, m, w - 2 * m, h - 2 * m, r); g.fill();
    g.shadowColor = 'transparent';
    g.lineWidth = 5; g.strokeStyle = 'rgba(40,0,0,0.55)'; roundRect(g, m + 3, m + 3, w - 2 * m - 6, h - 2 * m - 6, r - 3); g.stroke();
    // top highlight
    const hl = g.createLinearGradient(0, m, 0, h / 2);
    hl.addColorStop(0, 'rgba(255,255,255,0.38)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = hl; roundRect(g, m + 6, m + 5, w - 2 * m - 12, h / 2 - m, r - 6); g.fill();
    const num = String(n);
    g.textBaseline = 'middle'; g.fillStyle = '#fff';
    g.shadowColor = 'rgba(60,0,0,0.6)'; g.shadowBlur = 4;
    const big = `900 ${num.length > 1 ? 70 : 82}px ${FONT}`, small = `800 ${num.length > 1 ? 52 : 60}px ${FONT}`;
    g.font = small; const mw = g.measureText('−').width * 0.8;
    g.font = big; const nw = g.measureText(num).width;
    const total = mw + nw, room = w - 2 * m - 14;
    const sx = total > room ? room / total : 1;             // condense rather than clip
    g.save(); g.translate(w / 2, h / 2 + 4); g.scale(sx, 1);
    let x = -total / 2;
    g.font = small; g.globalAlpha = 0.92; g.textAlign = 'left'; g.fillText('−', x, -2); x += mw;
    g.font = big; g.globalAlpha = 1; g.fillText(num, x, 0);
    g.restore();
  });
}

// A soft round halo (white, tinted by the material) for pulsing glows behind tokens.
export function haloTex() {
  return canvasTex('halo', 128, 128, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)'); grd.addColorStop(0.45, 'rgba(255,255,255,0.45)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  });
}

// Keyword / buff chip for a card's bottom-left corner: "SINGER 5", "⚔+2". `ring` marks one granted by another card.
export function chipTex(text, bg, ring = false) {
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  measureCtx.font = `800 40px ${FONT}`;
  const w = Math.ceil(measureCtx.measureText(text).width) + 30;
  return canvasTex(`chip:${text}:${bg}:${ring ? 1 : 0}`, Math.max(64, w), 60, (g, cw, ch) => {
    g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
    g.fillStyle = bg; roundRect(g, 3, 3, cw - 6, ch - 6, 12); g.fill();
    g.shadowColor = 'transparent';
    g.lineWidth = ring ? 5 : 3; g.strokeStyle = ring ? '#b6ffcf' : 'rgba(0,0,0,0.35)'; g.stroke();
    g.fillStyle = '#fff'; g.font = `800 40px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, cw / 2, ch / 2 + 2);
  });
}

// Dashed, card-shaped placeholder for the inkwell slot a card can still go into this turn.
export function ghostSlotTex() {
  return canvasTex('ghost-slot', 252, 352, (g, w, h) => {
    g.fillStyle = 'rgba(120,160,255,0.10)'; roundRect(g, 8, 8, w - 16, h - 16, 18); g.fill();
    g.setLineDash([22, 14]); g.lineWidth = 7; g.strokeStyle = 'rgba(220,232,255,0.75)';
    roundRect(g, 8, 8, w - 16, h - 16, 18); g.stroke();
    g.setLineDash([]);
    g.fillStyle = 'rgba(220,232,255,0.8)'; g.font = `800 56px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('INK', w / 2, h / 2);
  });
}

// Label on a dark pill (the challenge outcome preview: "3 dmg", "BANISH").
export function labelTex(text, color = '#fff', bg = 'rgba(0,0,0,0.78)') {
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  measureCtx.font = `900 54px ${FONT}`;
  const w = Math.ceil(measureCtx.measureText(text).width) + 48;
  return canvasTex(`label:${text}:${color}:${bg}`, Math.max(96, w), 84, (g, cw, ch) => {
    g.fillStyle = bg; roundRect(g, 3, 3, cw - 6, ch - 6, 20); g.fill();
    g.lineWidth = 3; g.strokeStyle = color; g.globalAlpha = 0.7; g.stroke(); g.globalAlpha = 1;
    g.font = `900 54px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = color; g.shadowBlur = color === '#fff' ? 0 : 14;
    g.fillStyle = color; g.fillText(text, cw / 2, ch / 2 + 3);
  });
}

// Stat strip under a card: [{icon, value, base}] — value colored vs base. Tall cells and big numerals: the strip is
// ~2 world units tall on the table, which is only 15–20px on screen (#91).
// Each cell widens with its number, so a two-digit value (10+ strength, willpower or lore) stays inside the box
// instead of clipping its edge (#106); a one-digit cell keeps the old 92px.
let measureCtx = null;
function valueWidth(text) {
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  measureCtx.font = `900 58px ${FONT}`;
  return measureCtx.measureText(text).width;
}
export function statsTex(items) {
  const key = 'st:' + items.map((i) => `${i.icon}${i.value}/${i.base}/${i.extra || ''}`).join('|');
  const BASE = 92;
  const cells = items.map((it) => BASE + Math.max(0, Math.ceil(valueWidth(String(it.value) + (it.extra || ''))) - 38));
  const total = cells.reduce((a, b) => a + b, 0);
  const t = canvasTex(key, total, 84, (g, w, h) => {
    g.fillStyle = 'rgba(10,12,28,0.92)'; roundRect(g, 2, 2, w - 4, h - 4, 20); g.fill();
    g.strokeStyle = 'rgba(217,180,90,0.95)'; g.lineWidth = 4; g.stroke();
    let x0 = 0;
    items.forEach((it, i) => {
      const x = x0 + BASE / 2;       // icon ends just left of here, the value starts here and takes the extra width
      x0 += cells[i];
      const col = it.value > it.base ? '#6dff9a' : it.value < it.base ? '#ff7d7d' : '#ffffff';
      g.font = `700 32px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'right';
      g.fillStyle = it.iconColor || '#f2dc9b'; g.fillText(it.icon, x - 6, h / 2 + 2);
      g.textAlign = 'left'; g.fillStyle = col; g.font = `900 58px ${FONT}`;
      g.fillText(String(it.value) + (it.extra || ''), x - 2, h / 2 + 4);
    });
  });
  t.userData.cells = items.length * BASE / total;   // the share of the width a one-digit strip would take
  return t;
}

// Small pill label (status chips: DRYING, +Evasive, ×2 under, counts).
export function pillTex(text, bg = '#1b2a6b', fg = '#fff') {
  return canvasTex(`pill:${text}:${bg}:${fg}`, Math.max(96, 30 + text.length * 25), 64, (g, w, h) => {
    g.fillStyle = bg; roundRect(g, 2, 2, w - 4, h - 4, 28); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 3; g.stroke();
    g.fillStyle = fg; g.font = `800 38px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
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

// A soft gold band (transparent at both ends) for the turn-change sweep.
export function sweepTex() {
  return canvasTex('sweep', 256, 4, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, 'rgba(255,211,77,0)'); grd.addColorStop(0.55, 'rgba(255,211,77,0.85)'); grd.addColorStop(0.62, 'rgba(255,240,190,1)'); grd.addColorStop(1, 'rgba(255,211,77,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  });
}

// Table felt with zone outlines.
export function tableTex() {
  const c = document.createElement('canvas');
  c.width = 2048; c.height = 1576;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(c.width / 2, c.height / 2, 100, c.width / 2, c.height / 2, c.width * 0.65);
  grd.addColorStop(0, '#1d2766'); grd.addColorStop(0.7, '#141a44'); grd.addColorStop(1, '#080b1f');
  g.fillStyle = grd; g.fillRect(0, 0, c.width, c.height);
  // subtle noise
  const img = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // centre line: a thin gilt rule that fades out at both ends
  const rule = g.createLinearGradient(80, 0, c.width - 80, 0);
  rule.addColorStop(0, 'rgba(217,180,90,0)'); rule.addColorStop(0.5, 'rgba(217,180,90,0.55)'); rule.addColorStop(1, 'rgba(217,180,90,0)');
  g.strokeStyle = rule; g.lineWidth = 3;
  g.beginPath(); g.moveTo(80, c.height / 2); g.lineTo(c.width - 80, c.height / 2); g.stroke();
  return finish(new THREE.CanvasTexture(c));
}
