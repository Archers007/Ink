// The 3D table. Owns the three.js scene; knows nothing about networking.
//
//   const board = new Board(canvas, callbacks);
//   board.render(view, defs, events);      // after every server update
//   board.setUi({ selected, targets, multi });
//
// Every visible card is a CardObj keyed by its instance id (iid), so a card
// glides from hand → play → discard instead of popping. Hidden cards (the
// opponent's hand, inkwells) are keyed by slot; when a card moves between a
// slot and an iid the object is handed over, so one card always travels.

import * as THREE from 'three';
import {
  CARD_W, CARD_H, initTextures, faceTexture, faceTextureHi, backTexture, damageTex, statsTex, pillTex, numberTex, floatTex, tableTex, sweepTex,
  haloTex, chipTex, ghostSlotTex,
} from './textures.js';
import { LORE_TO_WIN, KEYWORD_LABEL, modSum } from './rules.js';
import { AURA, computeAuras, challengeTargets, challengeOutcome, myMove } from './signals.js';
import { Arrow } from './arrow.js';

const W = CARD_W, H = CARD_H;
// Every card in a row gets an exerted-wide slot, so exerting or readying one turns it in place instead of shoving
// the rest of the row sideways (#97).
const SLOT = H + 0.4;
const SPELL = new Set(['action', 'song']);
const IMPACT_MS = 250;     // a challenge's hit lands this far into the lunge
const LUNGE_MS = 560;
const CAST_HOLD_MS = 900;  // how long a played action/song shows at the cast pose (#92)
// the keywords a card in play wears as bottom-left chips (duels.ink style: violet Singer, red Challenger, …)
const KW_CHIP = {
  singer: { label: (n) => `SINGER ${n}`, bg: '#7c3aed' },
  challenger: { label: (n) => `CHALL +${n}`, bg: '#dc2626' },
  resist: { label: (n) => `RESIST ${n}`, bg: '#475569' },
  evasive: { label: () => 'EVASIVE', bg: '#0e9488' },
  ward: { label: () => 'WARD', bg: '#64748b' },
  bodyguard: { label: () => 'GUARD', bg: '#9f1239' },
  rush: { label: () => 'RUSH', bg: '#ea580c' },
  reckless: { label: () => 'RECKLESS', bg: '#b91c1c' },
  support: { label: () => 'SUPPORT', bg: '#15803d' },
  alert: { label: () => 'ALERT', bg: '#0369a1' },
  vanish: { label: () => 'VANISH', bg: '#6d28d9' },
};

// Table layout (z mirrored for the far player).
const DESK = {
  charZ: 6.4, rowZ: 16.6, handZ: 35, oppHandZ: 26.5,
  deckX: 31, discardX: 39.5, inkX: -40.5, inkStep: 1.15, inkW: 16,
  // the lore dial sits in the corner between the character row and the inkwell, clear of both (#96)
  loreX: -41, loreZ: 5.4, loreS: 0.82,
  rowMinX: -20, rowMaxX: 25, charMinX: -35, charMaxX: 36,
  tableW: 104, tableD: 78,
};
// Landscape phones frame just the character rows (#51); the deck, discard and inkwell leave the table like portrait
// (the plates carry their counts) and the hand peeks up from the bottom edge.
const MOB = { ...DESK, handZ: 31.5, charMinX: -29, charMaxX: 29, rowMinX: -20, rowMaxX: 20 };
// Portrait (PvZ Heroes-style lanes): narrow rows that swipe sideways past 3 cards; the deck, discard and inkwell
// leave the table (the HUD banners carry their counts), so cards fly off the edges to reach them.
// The front rows stand a little apart so the centre line between them stays clear for the midline pill and prompts.
const PORT = {
  ...DESK,
  charZ: 6.8, rowZ: 17, handZ: 30.5,
  deckX: 26, discardX: 26, inkX: -32,
  rowMinX: -13.8, rowMaxX: 13.8, charMinX: -13.8, charMaxX: 13.8,
};
export let L = DESK;

// ---------- geometry ----------
function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function rectGeo(w, h, r, segs = 6) {
  const g = new THREE.ShapeGeometry(roundedRectShape(w, h, r), segs);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + w / 2) / w, (pos.getY(i) + h / 2) / h);
  uv.needsUpdate = true;
  return g;
}
const GEO = {
  card: rectGeo(W, H, 0.38),
  glow: rectGeo(W + 0.7, H + 0.7, 0.62),          // a thin rim, not a frame
  edge: rectGeo(W + 0.12, H + 0.12, 0.44),
  unit: new THREE.PlaneGeometry(1, 1),
};

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const wrapAngle = (d) => { d = ((d + Math.PI) % (Math.PI * 2)) - Math.PI; return d < -Math.PI ? d + Math.PI * 2 : d; };
const dampAngle = (a, b, k, dt) => a + wrapAngle(b - a) * (1 - Math.exp(-k * dt));

// ---------- motion ----------
// Cards move on eased tweens whose length grows with the distance: a nudge is quick, a flight across the table takes
// a little longer but never drags (#94). Flights ease in and out and arc up off the table, so a card clears the deck
// box and the cards in its way and lands on a pile from above (#93); short moves (a hover lift) just ease out.
const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const easeOut = (p) => 1 - Math.pow(1 - p, 3);
export const flightMs = (d) => Math.min(560, 220 + 4 * d);
const FIELDS = ['x', 'y', 'z', 'yaw', 'tilt', 'flip', 'scale'];
const pose = (o) => ({ x: o.x, y: o.y, z: o.z, yaw: o.yaw, tilt: o.tilt, flip: o.flip, scale: o.scale });
function samePose(a, b) {
  for (const k of FIELDS) {
    const d = k === 'yaw' ? wrapAngle(a[k] - b[k]) : a[k] - b[k];
    if (Math.abs(d) > 1e-3) return false;
  }
  return true;
}
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// the attacker's lunge: a wind-up into the hit (at IMPACT_MS), then back
function strike(p) {
  const hit = IMPACT_MS / LUNGE_MS;
  return p < hit ? 0.62 * Math.pow(p / hit, 2) : 0.62 * (1 - easeInOut((p - hit) / (1 - hit)));
}

// ---------- card object ----------
class CardObj {
  constructor(board, key) {
    this.board = board;
    this.key = key;
    this.cardId = null;
    this.outer = new THREE.Group();
    this.inner = new THREE.Group();
    this.outer.add(this.inner);
    // Faces are unlit and skip tone mapping: the printed card is the thing to read, and ACES lighting dulled the
    // parchment (#99). A per-card mip bias sharpens the few cards shown large (#77).
    this.frontMat = new THREE.MeshBasicMaterial({ side: THREE.FrontSide, toneMapped: false });
    this.bias = { value: 0 };
    this.frontMat.onBeforeCompile = (sh) => {
      sh.uniforms.faceBias = this.bias;
      sh.fragmentShader = 'uniform float faceBias;\n' + sh.fragmentShader.replace('#include <map_fragment>',
        THREE.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', 'texture2D( map, vMapUv, faceBias )'));
    };
    this.frontMat.customProgramCacheKey = () => 'card-face';
    this.front = new THREE.Mesh(GEO.card, this.frontMat);
    this.front.position.z = 0.03;
    this.back = new THREE.Mesh(GEO.card, board.backMat);
    this.back.rotation.y = Math.PI;
    this.back.position.z = -0.03;
    this.edge = new THREE.Mesh(GEO.edge, board.edgeMat);
    this.edge.position.z = 0;
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.glow = new THREE.Mesh(GEO.glow, this.glowMat);
    this.glow.position.z = -0.05;
    this.glow.renderOrder = -1;
    this.inner.add(this.glow, this.edge, this.back, this.front);
    // stat strip and chips stay upright and flat whatever the card's yaw (#90): they're not part of the card's
    // rotation, and they're laid against its on-screen footprint each frame
    this.badges = new THREE.Group();
    this.badges.rotation.x = -Math.PI / 2;
    for (const m of [this.front, this.back, this.edge]) m.userData.card = this;
    this.target = { x: 0, y: 0, z: 0, yaw: 0, tilt: 0, flip: 0, scale: 1 };
    this.cur = null;  // set on first placement
    this.tw = null;   // the running tween
    this.vel = { x: 0, y: 0, z: 0 };
    this.stops = [];  // [{ pose|null, until }]: show this pose (null = stay put) until then, before heading for target
    this.follow = false;
    this.info = null; // { iid, zone, seat, faceUp }
    this.glowColor = null;
    this.badgeKey = '';
    this.badgeHold = 0;
    this.pendingBadges = null;
    this.dying = 0;
    this.opacity = 1;
    this.lunge = null;
    this.pulse = 0;
    this.landPulse = false;
    this.dimmed = false;
    this.wantHi = false;
    this.hiUntil = 0;
    board.cardLayer.add(this.outer, this.badges);
  }
  setFace(cardId) {
    if (cardId === this.cardId && this.frontMat.map) return;
    this.cardId = cardId;
    this.frontMat.map = cardId ? faceTexture(cardId) : backTexture();
    this.frontMat.needsUpdate = true;
  }
  // a face-down slot: whatever face it carries stays underneath (an inked card keeps its face while it turns over)
  setHidden() { if (!this.frontMat.map) this.setFace(null); }
  place(t, spawn) {
    Object.assign(this.target, t);
    this.follow = false;
    if (!this.cur) {
      this.cur = { ...this.target, ...(spawn || {}) };
      this.apply(performance.now());
    }
  }
  dragTo(t) { Object.assign(this.target, t); this.follow = true; }
  // hold still (or show `p`) for `ms`, then carry on to the target
  hold(ms, p = null, now = performance.now()) { this.stops.push({ pose: p, until: now + ms }); }
  goal(now) {
    while (this.stops.length && now >= this.stops[0].until) this.stops.shift();
    const s = this.stops[0];
    if (!s) return this.target;
    if (!s.pose) s.pose = pose(this.cur);
    return s.pose;
  }
  startTween(g, now) {
    const c = this.cur;
    const to = pose(g);
    to.yaw = c.yaw + wrapAngle(g.yaw - c.yaw);
    const dh = Math.hypot(to.x - c.x, to.z - c.z), d = Math.hypot(dh, to.y - c.y);
    const flight = dh > 10;
    this.tw = {
      from: pose(c), to, t0: now, dur: flightMs(d), done: false,
      ease: flight ? easeInOut : easeOut,
      // a card already up in the air (the hand, the cast pose) needs little or no extra lift
      lift: flight ? Math.min(6, 1.5 + dh * 0.12) * Math.max(0, 1 - Math.max(c.y, to.y) / 14) : 0,
      v: { ...this.vel },
    };
  }
  apply(now) {
    const c = this.cur;
    let ox = 0, oz = 0, oy = 0;
    if (this.lunge) {
      const p = (now - this.lunge.t0) / LUNGE_MS;
      if (p >= 1) this.lunge = null;
      else if (p > 0) {
        const k = strike(p);
        ox = this.lunge.dx * k; oz = this.lunge.dz * k; oy = Math.sin(Math.PI * p) * 2.5;
      }
    }
    this.outer.position.set(c.x + ox, c.y + oy, c.z + oz);
    this.outer.rotation.set(0, c.yaw, 0);
    this.inner.rotation.set(-Math.PI / 2 + c.tilt, c.flip, 0);
    const s = c.scale * (1 + this.pulse * 0.12);
    this.outer.scale.setScalar(s);
    if (this.badges.children.length) {
      this.badges.position.set(c.x + ox, c.y + oy + 0.12, c.z + oz);
      const yc = Math.abs(Math.cos(c.yaw)), ys = Math.abs(Math.sin(c.yaw));
      const half = ((yc * H + ys * W) / 2) * c.scale;   // footprint depth / 2
      const halfW = ((yc * W + ys * H) / 2) * c.scale;  // footprint width / 2
      for (const b of this.badges.children) {
        const a = b.userData.anchor;
        if (!a) continue;
        b.position.y = (a.edge + (a.frac || 0)) * half + a.off;
        if (a.xedge != null) b.position.x = a.xedge * halfW + a.xoff;
      }
      this.animBadges(now);
    }
  }
  // the damage token punches when damage lands and its halo pulses while it's one point from banishing the card
  animBadges(now) {
    for (const b of this.badges.children) {
      const k = b.userData.anim;
      if (!k) continue;
      const base = b.userData.base;
      if (k === 'dmg') {
        const p = (now - (this.dmgPunch || 0)) / 350;
        const s = p >= 0 && p < 1 ? 1 + 0.45 * Math.sin(Math.PI * p) : 1;
        b.scale.set(base.x * s, base.y * s, 1);
      } else if (k === 'halo') {
        const w = 0.5 + 0.5 * Math.sin((now / 1600) * Math.PI * 2);
        b.material.opacity = 0.35 + 0.5 * w;
        const s = 1 + 0.18 * w;
        b.scale.set(base.x * s, base.y * s, 1);
      }
    }
  }
  tick(dt, now) {
    const c = this.cur;
    const px = c.x, py = c.y, pz = c.z;
    if (this.follow) {                                   // being dragged: track the pointer closely
      const t = this.target, k = 22;
      c.x = damp(c.x, t.x, k, dt); c.y = damp(c.y, t.y, k, dt); c.z = damp(c.z, t.z, k, dt);
      c.yaw = dampAngle(c.yaw, t.yaw, k, dt); c.tilt = damp(c.tilt, t.tilt, k, dt);
      c.flip = damp(c.flip, t.flip, k, dt); c.scale = damp(c.scale, t.scale, k, dt);
      this.tw = null;
    } else {
      const g = this.goal(now);
      if (!this.tw || !samePose(this.tw.to, g)) this.startTween(g, now);
      const t = this.tw;
      if (!t.done) {
        const p = Math.min(1, (now - t.t0) / t.dur);
        const e = t.ease(p);
        // the Hermite term carries the velocity a card had when it was redirected, so a retarget doesn't jerk
        const h = (p * (1 - p) * (1 - p) * t.dur) / 1000;
        c.x = t.from.x + (t.to.x - t.from.x) * e + t.v.x * h;
        // a flat-topped arc: up and off the table at once, over whatever's in the way, then down onto the pile from
        // above (a plain sine was still low enough to clip the deck box beside the discard)
        c.y = t.from.y + (t.to.y - t.from.y) * e + t.v.y * h + t.lift * (1 - Math.pow(2 * e - 1, 12));
        c.z = t.from.z + (t.to.z - t.from.z) * e + t.v.z * h;
        for (const k of ['yaw', 'tilt', 'flip', 'scale']) c[k] = t.from[k] + (t.to[k] - t.from[k]) * e;
        if (p >= 1) {
          t.done = true;
          Object.assign(c, t.to);
          if (this.landPulse && !this.stops.length) { this.landPulse = false; this.pulse = 1; }
        }
      }
    }
    if (dt > 0) {
      const cap = (v) => Math.max(-150, Math.min(150, v));
      this.vel.x = cap((c.x - px) / dt); this.vel.y = cap((c.y - py) / dt); this.vel.z = cap((c.z - pz) / dt);
    }
    if (this.pulse > 0) this.pulse = Math.max(0, this.pulse - dt * 2.5);
    if (this.pendingBadges && now >= this.badgeHold) { const b = this.pendingBadges; this.pendingBadges = null; this.setBadges(b.key, b.build); }
    // shown large (lifted, being cast): the full-size image once it's decoded, sampled a mip sharper (#77)
    const hi = (this.wantHi || now < this.hiUntil) && this.cardId;
    if (hi || this.hiOn) {
      const tex = hi ? faceTextureHi(this.cardId) || faceTexture(this.cardId) : (this.cardId ? faceTexture(this.cardId) : backTexture());
      if (this.frontMat.map !== tex) this.frontMat.map = tex;
      this.bias.value = hi ? -0.6 : 0;
      this.hiOn = !!hi;
    }
    // glow
    // selection / targeting glows pulse at full strength; an action aura is a quiet rim that wakes up under the cursor
    if (this.glowColor) this.glowMat.color.set(this.glowColor);
    let want = 0, wob = 1;
    if (this.glowColor && this.glowMode === 'aura') want = 0.5 + 0.1 * Math.sin(now / 520);
    else if (this.glowColor && this.glowMode === 'auraHover') { want = 0.78 + 0.18 * Math.sin(now / 110); wob = 1 + 0.025 * Math.sin(now / 75); }
    else if (this.glowColor) want = 0.75 + 0.25 * Math.sin(now / 180);
    this.glowMat.opacity = damp(this.glowMat.opacity, want, 14, dt) * this.opacity;
    this.glow.visible = this.glowMat.opacity > 0.01;
    this.glow.scale.set(wob, 1 + (wob - 1) * 0.7, 1);
    const dimTarget = this.dimmed ? 0.45 : 1;
    const col = this.frontMat.color;
    col.setScalar(damp(col.r, dimTarget, 10, dt));
    this.apply(now);
  }
  // leaving view: own copies of the shared back/edge materials so this card alone can fade (#94)
  fadeOut() {
    if (this.ownMats) return;
    this.ownMats = true;
    this.back.material = this.board.backMat.clone();
    this.edge.material = this.board.edgeMat.clone();
    for (const m of [this.frontMat, this.back.material, this.edge.material]) { m.transparent = true; m.needsUpdate = true; }
  }
  revive() {
    this.dying = 0;
    this.setOpacity(1);
    if (!this.ownMats) return;
    this.ownMats = false;
    this.back.material.dispose(); this.edge.material.dispose();
    this.back.material = this.board.backMat;
    this.edge.material = this.board.edgeMat;
    this.frontMat.transparent = false; this.frontMat.needsUpdate = true;
  }
  setOpacity(o) {
    o = Math.max(0, Math.min(1, o));
    if (o === this.opacity) return;
    this.opacity = o;
    for (const m of [this.frontMat, this.back.material, this.edge.material]) m.opacity = o;
  }
  setBadges(key, build) {
    if (key === this.badgeKey) { this.pendingBadges = null; return; }
    if (performance.now() < this.badgeHold) { this.pendingBadges = { key, build }; return; }   // a hit that hasn't landed yet
    this.badgeKey = key;
    for (const ch of [...this.badges.children]) { this.badges.remove(ch); ch.material.dispose(); }
    build(this.badges);
  }
  // Invisible pick area at a hand or play card's resting slot, so hover-lift doesn't
  // move the card out from under the cursor.
  setProxy(t) {
    if (!t) { if (this.proxy) this.proxy.visible = false; return; }
    if (!this.proxy) {
      this.proxy = new THREE.Mesh(GEO.card, this.board.proxyMat);
      this.proxy.rotation.order = 'YXZ';   // yaw on the table, then the tilt: the same as outer + inner
      this.proxy.userData.card = this;
      this.board.cardLayer.add(this.proxy);
    }
    this.proxy.visible = true;
    this.proxy.position.set(t.x, t.y, t.z);
    this.proxy.rotation.set(-Math.PI / 2 + t.tilt, t.yaw || 0, 0);
    this.proxy.scale.setScalar(t.scale);
  }
  dispose() {
    if (this.proxy) this.board.cardLayer.remove(this.proxy);
    this.board.cardLayer.remove(this.outer, this.badges);
    this.frontMat.dispose();
    this.glowMat.dispose();
    if (this.ownMats) { this.back.material.dispose(); this.edge.material.dispose(); }
    for (const ch of this.badges.children) ch.material.dispose();
  }
}

function badgePlane(tex, width, x, y, z = 0, anchor = null) {
  const h = width / (tex.userData.aspect || 1);
  const m = new THREE.Mesh(GEO.unit, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  m.scale.set(width, h, 1);
  m.position.set(x, y, z);
  m.renderOrder = 2;
  m.userData.anchor = anchor;   // { edge: +1 top / -1 bottom of the card's footprint, off } — see CardObj.apply
  return m;
}

// ---------- board ----------
export class Board {
  constructor(canvas, cb = {}) {
    this.canvas = canvas;
    this.cb = cb;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    initTextures(this.renderer);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080b1f);
    this.scene.fog = new THREE.Fog(0x080b1f, 140, 260);
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 600);
    this.focus = new THREE.Vector3();

    this.scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x1a1530, 1.35));
    const key = new THREE.DirectionalLight(0xfff1d6, 1.6);
    key.position.set(-30, 90, 40);
    this.scene.add(key);

    this.backMat = new THREE.MeshStandardMaterial({ map: backTexture(), roughness: 0.6 });
    this.edgeMat = new THREE.MeshStandardMaterial({ color: 0x0c0c12, roughness: 0.9 });
    // colorWrite off = never drawn, but still raycastable
    this.proxyMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

    // table
    const table = new THREE.Mesh(new THREE.PlaneGeometry(L.tableW, L.tableD), new THREE.MeshStandardMaterial({ map: tableTex(), roughness: 0.95 }));
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.05;
    this.scene.add(table);
    this.table = table;
    const rim = new THREE.Mesh(new THREE.BoxGeometry(L.tableW + 4, 2, L.tableD + 4), new THREE.MeshStandardMaterial({ color: 0x1a1636, roughness: 0.7 }));
    rim.position.y = -1.1;
    this.scene.add(rim);

    this.cardLayer = new THREE.Group();
    this.scene.add(this.cardLayer);
    this.fx = new THREE.Group();
    this.scene.add(this.fx);
    // the turn-change sweep: a gold band that runs across the new active player's side under their cards (#95)
    this.sweep = new THREE.Mesh(GEO.unit, new THREE.MeshBasicMaterial({ map: sweepTex(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    this.sweep.rotation.x = -Math.PI / 2;
    this.sweep.visible = false;
    this.fx.add(this.sweep);

    this.cards = new Map();      // key -> CardObj
    this.sides = [];              // per-seat static props (deck box, lore dial, labels)
    this.zoneOutlines = new THREE.Group();
    this.scene.add(this.zoneOutlines);
    this.floaters = [];
    this.timers = [];
    this.ui = { selected: null, targets: new Set(), multi: new Set(), targetColor: 0x6fa8ff, arrowFrom: null };
    // board-state signals (duels.ink style): action auras, the targeting arrow with its outcome preview, the ink slot.
    // setOptions({ auras: false }) turns them off; 'ink.signals' = 'off' in localStorage starts them off.
    let stored = null;
    try { stored = localStorage.getItem('ink.signals'); } catch { /* private window */ }
    this.opts = { auras: stored !== 'off', arrows: stored !== 'off' };
    this.auras = new Map();      // iid -> AURA key: what each of my cards can do right now
    this.inkedNow = new Map();   // ink slot key -> { cardId, turn }: inked this turn, shown face up
    this.loreSeen = [];
    this.arrow = new Arrow(this.scene);
    this.aim = null;             // { from, to, color, labels, noArrow }
    this.rowScroll = {};      // portrait lanes: how far each row is swiped (world units)
    this.rowMax = {};
    this.view = null;
    this.defs = {};
    this.hover = null;
    this.drag = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -4);

    this.bindPointer();
    this.resize();
    window.addEventListener('resize', () => { this.resize(); if (this.fit) this.fit.stale = true; });   // the HUD rects are from before: main refits
    this.timer = new THREE.Timer();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ---------- camera ----------
  // { left, right, top, bottom }: the free area to centre the table in; avoid: [{ x0, y0, x1, y1 }] screen rects of
  // HUD panels that no card may sit under
  // A refit with the same window keeps the current framing while it's still clear of the HUD, so a plate that grows or
  // shrinks a line mid-game doesn't make the camera hop.
  setInsets(insets) { this.insets = insets; this.resize(true); }
  // phones: frame the character rows closer, the hand peeking up from the bottom edge, lift a tapped hand card
  setMobile(on) {
    if (this.mobile === !!on) return;
    this.mobile = !!on;
    this.relayout();
  }
  setPortrait(on) {
    if (this.portrait === !!on) return;
    this.portrait = !!on;
    this.rowScroll = {};
    this.relayout();
  }
  relayout() {
    L = this.portrait ? PORT : this.mobile ? MOB : DESK;
    for (const s of this.sides) if (s) this.scene.remove(s.group);
    this.sides = [];
    this.resize();
    if (this.view) this.render(this.view, this.defs, []);
  }
  // the deck, discard, inkwell and lore dial live on the HUD plates instead of the table
  offTable() { return !!(this.portrait || this.mobile); }
  rowKey(seat, z) { return `${seat}:${Math.abs(z) < (L.charZ + L.rowZ) / 2 ? 0 : 1}`; }
  // which lane a screen point is over (portrait swipes), or null
  laneAt(ev) {
    const p = this.planePoint(ev, 0);
    if (!p || Math.abs(p.z) > L.rowZ + H / 2 + 1) return null;
    const me = this.view?.you >= 0 ? this.view.you : 0;
    const seat = p.z > 0 ? me : 1 - me;
    return { key: this.rowKey(seat, p.z), x: p.x };
  }
  // my hand: card scale at rest / lifted, how wide the fan may get, how far a lifted card comes forward
  handCfg() {
    // fit: how many cards' width the framing must leave room for (the fan then spreads as far as stays clear)
    if (this.portrait) return { z: L.handZ, s: 1.08, up: 1.4, span: 21, lift: -7, fit: 2 };
    if (this.mobile) return { z: L.handZ, s: 1.45, up: 1.75, span: 50, lift: -8.5, peek: 0.62, fit: 4 };
    return { z: L.handZ, s: 1.22, up: 1.55, span: 70, lift: -8.5, fit: 4 };
  }
  // the corners of a resting hand reaching ±hx: its top edge and the lowest part that has to show
  handPoints(hx, pts = []) {
    const hc = this.handCfg();
    const half = (H / 2) * hc.s, ct = Math.cos(0.55), st = Math.sin(0.55);
    const u = hc.peek ? 2 * hc.peek - 1 : 1;    // -1 the card's top edge … +1 its bottom edge
    for (const x of [-hx, 0, hx]) {
      pts.push([x, 8 + half * st, hc.z - half * ct]);
      pts.push([x, 8 - ((u - 1) / 2) * half * st, hc.z + 0.3 + ((u - 1) / 2) * half * ct]);
      pts.push([x, 8 - u * half * st, hc.z + 0.6 + u * half * ct]);
    }
    return pts;
  }
  // World points that have to be on screen and clear of the HUD: the zones in use and a resting hand of 4 (a bigger
  // hand fans as wide as the screen allows, then overlaps — see handSpan).
  framePoints() {
    const pts = [];
    const rect = (x0, x1, z0, z1, y = 0.1) => { for (const x of [x0, (x0 + x1) / 2, x1]) for (const z of [z0, (z0 + z1) / 2, z1]) pts.push([x, y, z]); };
    const zs = (s, a, b) => (s > 0 ? [a, b] : [-b, -a]);
    const hc = this.handCfg();
    this.handPoints(((hc.fit - 1) / 2) * Math.min(W * hc.s + 0.4, hc.span / hc.fit) + (W * hc.s) / 2, pts);
    if (this.portrait) {
      rect(L.rowMinX, L.rowMaxX, -(L.rowZ + H / 2 + 1.4), L.rowZ + H / 2 + 1.8);
    } else if (this.mobile) {
      for (const s of [1, -1]) {
        rect(L.charMinX, L.charMaxX, ...zs(s, L.charZ - H / 2 - 1.4, L.charZ + H / 2 + 1.8));
        rect(L.rowMinX, L.rowMaxX, ...zs(s, L.rowZ - H / 2, L.rowZ + H / 2 + 1.8));
      }
    } else {
      for (const s of [1, -1]) {
        rect(L.inkX - 3.5, L.inkX + L.inkW - 1.5, ...zs(s, L.rowZ - (H + 3) / 2, L.rowZ + (H + 3) / 2 + 2.2));
        const r = 5.95 * L.loreS;
        rect(L.loreX - r, L.loreX + r, ...zs(s, L.loreZ - r, L.loreZ + r));
        rect(L.deckX - (W + 1) / 2, L.discardX + (W + 1) / 2, ...zs(s, L.rowZ - (H + 1) / 2, L.rowZ + (H + 1) / 2 + 2));
        rect(L.charMinX, L.charMaxX, ...zs(s, L.charZ - H / 2 - 1.4, L.charZ + H / 2 + 1.8));
      }
      rect(-13, 13, -(L.oppHandZ + 3.4), -(L.oppHandZ - 3.4), 0.4);
    }
    return pts;
  }
  // Fit the camera: the closest distance (biggest cards) at which every frame point is on screen and outside every
  // HUD rect, then the view offset nearest the free area's centre. One rule for every window shape: the hand's bottom
  // edge at 1920x1080 (#78), a tablet's empty band above the table (#59), a phone's rails (#51), portrait plates (#55).
  resize(soft = false) {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    // portrait lanes widen with the screen (a tablet held upright fits more than a phone's three cards across)
    let relaid = false;
    if (this.portrait) {
      const lw = Math.round(Math.min(30, Math.max(PORT.rowMaxX, (PORT.rowMaxX * (w / h)) / (390 / 844))) * 10) / 10;
      if (L.rowMaxX !== lw) { L = { ...PORT, rowMinX: -lw, rowMaxX: lw, charMinX: -lw, charMaxX: lw }; relaid = true; }
    }
    this.renderer.setSize(w, h, false);
    const cam = this.camera;
    cam.aspect = w / h;
    const { left = 0, right = 0, top = 0, bottom = 0, avoid = [], safe = {} } = this.insets || {};
    const P = this.portrait, M = this.mobile && !P;
    const mode = P ? 'port' : M ? 'mob' : 'desk';
    const m = 6, pad = 8;
    // the screen edges cards keep clear of: a small margin, plus the notch / home indicator (safe-area insets)
    let ex0 = m + (safe.left || 0), ex1 = w - m - (safe.right || 0), ey0 = m + (safe.top || 0), ey1 = h - m - (safe.bottom || 0);
    // clamp: the insets are hard edges too (portrait: everything between the plates, so the hand sits above mine and
    // the lanes don't sink to the bottom to make room for it underneath)
    if (this.insets?.clamp) { ey0 = Math.max(ey0, top); ey1 = Math.min(ey1, h - bottom); }
    const boxes = avoid.map((r) => [r.x0 - pad, r.y0 - pad, r.x1 + pad, r.y1 + pad]);
    const pts = this.framePoints();
    const px = new Float64Array(pts.length), py = new Float64Array(pts.length);
    const v = new THREE.Vector3();
    const project = () => {
      const b = [Infinity, -Infinity, Infinity, -Infinity];
      for (let i = 0; i < pts.length; i++) {
        v.set(pts[i][0], pts[i][1], pts[i][2]).project(cam);
        px[i] = ((v.x + 1) / 2) * w; py[i] = ((1 - v.y) / 2) * h;
        b[0] = Math.min(b[0], px[i]); b[1] = Math.max(b[1], px[i]); b[2] = Math.min(b[2], py[i]); b[3] = Math.max(b[3], py[i]);
      }
      return b;
    };
    const clear = (ox, oy) => {
      for (let i = 0; i < pts.length; i++) {
        const x = px[i] - ox, y = py[i] - oy;
        for (const b of boxes) if (x > b[0] && x < b[2] && y > b[1] && y < b[3]) return false;
      }
      return true;
    };
    const f0 = this.fit;
    let keep = false;
    if (soft && f0 && !f0.stale && f0.w === w && f0.h === h && f0.mode === mode) {
      const b = project();                                            // with the current offset applied
      keep = b[0] >= ex0 - 1 && b[1] <= ex1 + 1 && b[2] >= ey0 - 1 && b[3] <= ey1 + 1 && clear(0, 0);
    }
    if (!keep) this.refit(w, h, mode, project, clear, { ex0, ex1, ey0, ey1 }, { left, right, top, bottom });
    // how wide the hand may fan at this framing: as far each way as it stays on screen and out from under the HUD
    // (a button column on one side shifts the fan toward the other)
    const hc = this.handCfg();
    const reach = (dir) => {
      let hx = (W * hc.s) / 2;
      for (let x = hx; x < 60; x += 0.5) {
        const ok = this.handPoints(x).filter((p) => p[0] * dir > 0).every(([a, b, c]) => {
          v.set(a, b, c).project(cam);
          const X = ((v.x + 1) / 2) * w, Y = ((1 - v.y) / 2) * h;
          return X >= ex0 && X <= ex1 && Y <= ey1 + 1 && !boxes.some((q) => X > q[0] && X < q[2] && Y > q[1] && Y < q[3]);
        });
        if (!ok) break;
        hx = x;
      }
      return hx;
    };
    const xl = reach(-1), xr = reach(1);
    const span = Math.min(hc.span, Math.max(0, xl + xr - W * hc.s));
    const shift = span < hc.span ? (xr - xl) / 2 : 0;
    if (span !== this.handSpan || shift !== this.handShift || relaid) {
      this.handSpan = span; this.handShift = shift;
      if (this.view) this.render(this.view, this.defs, []);
    }
  }
  refit(w, h, mode, project, clear, { ex0, ex1, ey0, ey1 }, { left, right, top, bottom }) {
    const cam = this.camera;
    const P = mode === 'port', M = mode === 'mob';
    const elev = THREE.MathUtils.degToRad(P ? 70 : M ? 55 : 58);
    const focusZ = P ? 4.5 : M ? 5 : 2;
    this.focus.set(0, 0, focusZ);
    const at = (dist) => {
      cam.position.set(0, Math.sin(elev) * dist, Math.cos(elev) * dist + focusZ);
      cam.lookAt(this.focus);
      cam.updateMatrixWorld();
    };
    cam.clearViewOffset();
    cam.updateProjectionMatrix();
    const want = { x: (right - left) / 2, y: (bottom - top) / 2 };
    const choices = (lo, hi, pref) => {
      const out = [Math.min(hi, Math.max(lo, pref))];
      for (let k = 0; k <= 10; k++) out.push(lo + ((hi - lo) * k) / 10);
      return out;
    };
    let fit = null;
    for (let dist = 30; dist < 480 && !fit; dist *= 1.02) {
      at(dist);
      const [x0, x1, y0, y1] = project();
      const oxLo = x1 - ex1, oxHi = x0 - ex0, oyLo = y1 - ey1, oyHi = y0 - ey0;
      if (oxLo > oxHi || oyLo > oyHi) continue;
      const cands = [];
      for (const ox of choices(oxLo, oxHi, want.x)) for (const oy of choices(oyLo, oyHi, want.y)) cands.push([ox, oy, 2 * Math.abs(ox - want.x) + Math.abs(oy - want.y)]);   // off-centre sideways looks worse
      cands.sort((a, b) => a[2] - b[2]);
      for (const [ox, oy] of cands) if (clear(ox, oy)) { fit = { dist, ox, oy }; break; }
    }
    if (!fit) {                                                       // nothing fits (a tiny window): the whole table, centred
      const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.aspect;
      fit = { dist: (P ? 34 : 96) / (2 * tanH), ox: want.x, oy: want.y };
    }
    at(fit.dist);
    cam.setViewOffset(w, h, fit.ox, fit.oy, w, h);
    cam.updateProjectionMatrix();
    this.fit = { ...fit, w, h, mode };
  }
  // where a played action or song is shown: in front of the table's centre, raised toward and facing the camera (#92)
  castPose() {
    const f = this.focus, c = this.camera.position, k = 0.3;
    const p = { x: f.x + (c.x - f.x) * k, y: f.y + (c.y - f.y) * k, z: f.z + (c.z - f.z) * k };
    return { ...p, yaw: 0, tilt: Math.atan2(c.z - p.z, c.y - p.y), flip: 0, scale: 2 };
  }
  // an action still resolving (its choices pending) waits off to the side, standing up, after its cast moment
  parkPose() {
    const c = this.castPose();
    if (this.offTable()) return { x: L.charMaxX - W / 2, y: 6, z: 0, yaw: 0, tilt: c.tilt, flip: 0, scale: 0.9 };
    return { x: (L.deckX + L.discardX) / 2, y: 3, z: 0, yaw: 0, tilt: c.tilt, flip: 0, scale: 1.05 };
  }
  castAt(o, now) {
    const p = this.castPose();
    const until = now + flightMs(dist3(o.cur, p)) + CAST_HOLD_MS;
    o.stops = [{ pose: p, until }];
    o.hiUntil = until;
    o.castShown = true;
  }

  // ---------- per-seat props ----------
  sideProps(seat, sign) {
    if (this.sides[seat] && this.sides[seat].sign === sign) return this.sides[seat];
    if (this.sides[seat]) this.scene.remove(this.sides[seat].group);
    const group = new THREE.Group();
    const p = { sign, group };
    // deck box
    const sideMat = new THREE.MeshStandardMaterial({ color: 0xe9e2cc, roughness: 0.9 });
    p.deck = new THREE.Mesh(new THREE.BoxGeometry(W, 1, H), [sideMat, sideMat, this.backMat, sideMat, sideMat, sideMat]);
    p.deck.position.set(L.deckX, 0.5, sign * L.rowZ);
    p.deck.userData.zone = { zone: 'deck', seat };
    group.add(p.deck);
    p.deckLabel = badgePlane(pillTex('0'), 3.4, 0, 0);
    p.deckLabel.rotation.x = -Math.PI / 2;
    group.add(p.deckLabel);
    // zone outlines
    const outline = (x, z, w, h, label) => {
      const m = new THREE.Mesh(rectGeo(w, h, 0.8), new THREE.MeshBasicMaterial({ color: 0xd9b45a, transparent: true, opacity: 0.08, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.position.set(x, 0.0, z);
      group.add(m);
      if (label) {
        const t = badgePlane(pillTex(label, 'rgba(0,0,0,0)', 'rgba(212,178,92,0.55)'), Math.max(4, label.length * 0.8), x, 0.01, 0);
        t.rotation.x = -Math.PI / 2; t.position.set(x, 0.02, z + sign * (h / 2 + 1.1));
        group.add(t);
      }
      return m;
    };
    outline(L.deckX, sign * L.rowZ, W + 1, H + 1, 'DECK');
    p.discardZone = outline(L.discardX, sign * L.rowZ, W + 1, H + 1, 'DISCARD');
    p.discardZone.userData.zone = { zone: 'discard', seat };
    p.inkZone = outline(L.inkX + L.inkW / 2 - 2.5, sign * L.rowZ, L.inkW + 2, H + 3, null);
    p.inkZone.userData.zone = { zone: 'inkwell', seat };
    p.discardLabel = badgePlane(pillTex('0'), 3.4, 0, 0);
    p.discardLabel.rotation.x = -Math.PI / 2;
    group.add(p.discardLabel);
    p.inkLabel = badgePlane(pillTex('INK 0/0'), 6, 0, 0);
    p.inkLabel.rotation.x = -Math.PI / 2;
    group.add(p.inkLabel);
    p.ghost = new THREE.Mesh(GEO.unit, new THREE.MeshBasicMaterial({ map: ghostSlotTex(), transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }));
    p.ghost.rotation.x = -Math.PI / 2;
    p.ghost.visible = false;
    p.ghost.userData.zone = { zone: 'inkwell', seat };
    group.add(p.ghost);
    // lore dial: 20 segments around a big number; the active player's halo hugs the ring (#96)
    p.lore = new THREE.Group();
    p.lore.position.set(L.loreX, 0.02, sign * L.loreZ);
    p.lore.scale.setScalar(L.loreS);
    p.segs = [];
    const segA = (Math.PI * 2) / LORE_TO_WIN;
    for (let i = 0; i < LORE_TO_WIN; i++) {
      const g = new THREE.RingGeometry(3.8, 5.4, 4, 1, Math.PI / 2 - (i + 1) * segA + 0.03, segA - 0.06);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x2b2f52, transparent: true, opacity: 0.95 }));
      m.rotation.x = -Math.PI / 2;
      p.lore.add(m);
      p.segs.push(m);
    }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(3.6, 40), new THREE.MeshBasicMaterial({ color: 0x0d1030 }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = -0.01;
    p.lore.add(disc);
    p.disc = disc;
    p.halo = new THREE.Mesh(new THREE.RingGeometry(5.5, 5.95, 48), new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
    p.halo.rotation.x = -Math.PI / 2;
    p.lore.add(p.halo);
    p.loreNum = badgePlane(numberTex('0', '#f2dc9b', 'LORE'), 6.4, 0, 0);
    p.loreNum.rotation.x = -Math.PI / 2; p.loreNum.position.y = 0.02;
    p.lore.add(p.loreNum);
    p.lore.userData.zone = { zone: 'lore', seat };
    disc.userData.zone = { zone: 'lore', seat };
    group.add(p.lore);
    p.nameTag = null;
    p.shownLore = -1;
    this.scene.add(group);
    this.sides[seat] = p;
    return p;
  }

  updateSide(seat, sign, pl, isActive) {
    const p = this.sideProps(seat, sign);
    p.group.visible = !this.offTable();
    if (this.offTable()) return;
    const n = pl.deckCount;
    p.deck.visible = n > 0;
    p.deck.scale.y = Math.max(0.05, n * 0.06);
    p.deck.position.y = (n * 0.06) / 2;
    if (p.deckN !== n) {
      p.deckN = n;
      p.deckLabel.material.map = pillTex(String(n), n <= 5 ? '#8b1a1a' : '#1b2a6b');
      p.deckLabel.material.needsUpdate = true;
    }
    p.deckLabel.position.set(L.deckX, n * 0.06 + 0.2, sign * L.rowZ);
    const dn = pl.discard.length;
    if (p.discardN !== dn) { p.discardN = dn; p.discardLabel.material.map = pillTex(String(dn)); p.discardLabel.material.needsUpdate = true; }
    p.discardLabel.position.set(L.discardX, dn * 0.04 + 0.3, sign * L.rowZ);
    p.discardLabel.visible = dn > 0;
    const inkKey = `INK ${pl.inkReady}/${pl.inkTotal}${pl.inkDrops ? ` +${pl.inkDrops}💧` : ''}`;
    if (p.inkKey !== inkKey) { p.inkKey = inkKey; p.inkLabel.material.map = pillTex(inkKey, '#1d3f73'); p.inkLabel.material.needsUpdate = true; }
    p.inkLabel.position.set(L.inkX + L.inkW / 2 - 2.5, 0.05, sign * (L.rowZ + (H + 3) / 2 + 1.3));
    // lore dial
    if (p.shownLore !== pl.lore) {
      const up = pl.lore > p.shownLore && p.shownLore >= 0;
      const gained = pl.lore - p.shownLore;
      p.shownLore = pl.lore;
      p.loreNum.material.map = numberTex(String(pl.lore), pl.lore >= 15 ? '#ffd34d' : '#f2dc9b', `/ ${LORE_TO_WIN}`);
      p.loreNum.material.needsUpdate = true;
      p.segs.forEach((m, i) => m.material.color.set(i < pl.lore ? (i >= 15 ? 0xffc93a : 0xd9b45a) : 0x2b2f52));
      if (up) {
        p.lorePulse = 1;
        this.floatText(`+${gained}`, '#7dffa0', { x: L.loreX + 1.2, z: sign * L.loreZ - 1 }, 0.25);   // the transient green "+N"
      }
    }
    if (p.lorePulse > 0) {
      p.lorePulse = Math.max(0, p.lorePulse - this.dt * 1.6);
      p.lore.scale.setScalar(L.loreS * (1 + Math.sin(p.lorePulse * Math.PI) * 0.18));
    }
    // active player's dial gets a glowing rim
    p.disc.material.color.set(isActive ? 0x3a2c08 : 0x0d1030);
    p.halo.visible = isActive;
    if (isActive) p.halo.material.opacity = 0.35 + 0.25 * Math.sin(performance.now() / 300);
  }

  // ---------- main render ----------
  render(view, defs, events = []) {
    this.view = view;
    this.defs = defs;
    if (!view) { for (const c of this.cards.values()) c.dispose(); this.cards.clear(); this.auras = new Map(); this.aim = null; this.arrow.hide(); return; }
    const me = view.you >= 0 ? view.you : 0;
    this.auras = this.opts.auras && !this.replaying() ? computeAuras(view, defs) : new Map();
    for (const [k, v] of this.inkedNow) if (v.turn !== view.turn) this.inkedNow.delete(k);
    view.players.forEach((pl, seat) => {
      const was = this.loreSeen[seat];
      if (was != null && pl.lore > was && events.length) this.cb.onLoreGain?.({ seat, n: pl.lore - was, mine: seat === view.you });
      this.loreSeen[seat] = pl.lore;
    });
    const now = performance.now();
    const off = this.offTable();
    const seen = new Set();
    const spawnHint = new Map();   // iid -> {seat, zone}: where it came from (its first move in this update)
    const leaveTo = new Map();     // iid -> {seat, zone}: where a card that's leaving view went
    const moves = [];
    for (const e of events) {
      if (e.k !== 'move' || !e.from || !e.to) continue;
      moves.push(e);
      if (e.iid) { if (!spawnHint.has(e.iid)) spawnHint.set(e.iid, e.from); leaveTo.set(e.iid, e.to); }
    }
    // where cards were before this update moved them: a challenge lunges at the defender's old spot, and numbers
    // rise over it, even when the re-layout has already sent the card on to the discard (#89)
    const was = new Map();
    for (const e of events) {
      for (const id of [e.iid, e.a, e.t, ...(e.singers || [])]) {
        const c = id && !was.has(id) && this.cards.get(id);
        if (c?.cur) was.set(id, { x: c.cur.x, y: c.cur.y, z: c.cur.z });
      }
    }
    // challenge damage shows on the cards when the hit lands, not when the update arrives
    for (const e of events) if (e.k === 'challenge') for (const id of [e.a, e.t]) { const c = this.cards.get(id); if (c) c.badgeHold = now + IMPACT_MS; }
    this.handOff(view, moves);
    const castNow = new Set();     // actions/songs played in this update
    for (const e of moves) if (e.iid && e.to.zone === 'play' && e.from.zone !== 'play' && SPELL.has(defs[e.cardId]?.type)) castNow.add(e.iid);

    const anchor = (seat, zone) => {
      const sign = seat === me ? 1 : -1;
      const base = { yaw: 0, tilt: 0, flip: 0, scale: 1 };
      switch (zone) {
        case 'hand': return { ...base, x: 0, y: 4, z: sign * (sign > 0 ? L.handZ : L.oppHandZ) };
        case 'discard': return { ...base, x: L.discardX, y: 1, z: sign * L.rowZ };
        case 'inkwell': return { ...base, x: L.inkX + 4, y: 1, z: sign * L.rowZ };
        case 'play': return { ...base, x: 0, y: 1, z: sign * L.charZ };
        default: {                                                    // the deck: just above its current top (#98)
          const n = view.players[seat]?.deckCount || 0;
          return { ...base, x: L.deckX, y: n * 0.06 + 0.6, z: sign * L.rowZ, flip: Math.PI };
        }
      }
    };
    const get = (key, spawnFrom) => {
      let c = this.cards.get(key);
      if (!c) { c = new CardObj(this, key); this.cards.set(key, c); c.spawn = spawnFrom; }
      if (c.dying) c.revive();
      c.wantHi = false;
      seen.add(key);
      return c;
    };
    const put = (c, t) => { c.place(t, c.spawn ? { ...c.spawn } : null); c.spawn = null; };
    const from = (iid, seat, fallback) => (spawnHint.has(iid) ? anchor(spawnHint.get(iid).seat, spawnHint.get(iid).zone) : anchor(seat, fallback));

    view.players.forEach((pl, seat) => {
      const sign = seat === me ? 1 : -1;
      const mine = seat === view.you;
      this.updateSide(seat, sign, pl, view.status === 'playing' && view.active === seat);

      // ---- play area ----
      const units = pl.play;
      const def = (c) => defs[c.cardId] || { type: 'character' };
      const chars = units.filter((c) => def(c).type === 'character' && !c.atLocation);
      const locs = units.filter((c) => def(c).type === 'location');
      const items = units.filter((c) => def(c).type === 'item');
      const atLoc = (l) => units.filter((c) => c.atLocation === l.iid);
      const row2 = [];
      for (const l of locs) { row2.push({ c: l }); for (const c of atLoc(l)) row2.push({ c, at: true }); }
      for (const c of items) row2.push({ c });
      // orphaned (location left) chars fall back to row 1
      this.layoutRow(chars.map((c) => ({ c })), sign * L.charZ, L.charMinX, L.charMaxX, seat, sign, get, put, from);
      this.layoutRow(row2, sign * L.rowZ, L.rowMinX, L.rowMaxX, seat, sign, get, put, from);
      // an action or song still resolving (its choices pending): shown at the cast pose, then parked to the side
      for (const c of units.filter((u) => SPELL.has(def(u).type))) {
        const o = get(c.iid, from(c.iid, seat, 'hand'));
        o.setFace(c.cardId);
        o.info = { iid: c.iid, zone: 'play', seat, cardId: c.cardId };
        o.dimmed = false;
        o.setBadges('', () => {});
        o.setProxy(null);                                             // no pick area left behind in the hand
        put(o, this.parkPose());
        if (!o.castShown) this.castAt(o, now);
      }

      // ---- discard (all cards, stacked; off the table on phones) ----
      if (!off) pl.discard.forEach((c, i) => {
        const o = get(c.iid, from(c.iid, seat, 'hand'));
        o.setFace(c.cardId);
        o.info = { iid: c.iid, zone: 'discard', seat, cardId: c.cardId };
        o.dimmed = false;
        o.setBadges('', () => {});
        put(o, { x: L.discardX + ((i * 37) % 5 - 2) * 0.06, y: 0.05 + i * 0.04, z: sign * L.rowZ + ((i * 53) % 5 - 2) * 0.06, yaw: ((i * 29) % 7 - 3) * 0.015, tilt: 0, flip: 0, scale: 1 });
        if (castNow.has(c.iid) && !o.castShown) this.castAt(o, now);   // played and resolved in one go: show it, then discard it
      });

      // ---- inkwell (facedown slots; ready ones first) ----
      // One row while it fits; past that, two rows per column a third of a card apart (the front row over the back
      // one, the cards a little smaller so both rows fit the zone's depth without reaching the character row's stat
      // strips), and the columns close up as the well grows, so even 30+ cards stay inside the zone (#105)
      const inkN = off ? 0 : pl.inkTotal;
      // while I can still ink this turn, a dashed slot waits where the next card will land (laid out as one more card,
      // so inking doesn't shuffle the rest)
      const canInk = !off && mine && this.opts.auras && !this.replaying() && myMove(view) && (pl.inkedThisTurn ?? 0) < (pl.inkLimit ?? 1)
        && (pl.hand || []).some((h) => defs[h.cardId]?.inkable || pl.rules?.handInkable);
      const slots = inkN + (canInk ? 1 : 0);
      const inkSpanAt = (s) => L.inkW - 1.5 - (H * s) / 2 - 0.3;      // first to last centre: an exerted card is H wide
      const inkRows = slots > Math.floor(inkSpanAt(0.92) / L.inkStep) + 1 ? 2 : 1;
      const inkScale = inkRows > 1 ? 0.85 : 0.92;
      const inkCols = Math.ceil(slots / inkRows);
      const inkStep = Math.min(L.inkStep, inkSpanAt(inkScale) / Math.max(1, inkCols - 1));
      const inkSlot = (i) => ({ x: L.inkX + Math.floor(i / inkRows) * inkStep, z: sign * (L.rowZ + (inkRows > 1 ? (i % 2 ? 2 : -0.6) : 0)) });
      for (let i = 0; i < inkN; i++) {
        const key = `ink:${seat}:${i}`;
        const o = get(key, anchor(seat, 'hand'));
        // the card inked this turn stays face up (inking reveals it) until the turn passes, then turns over
        const fresh = this.inkedNow.get(key);
        const faceUp = fresh && fresh.turn === view.turn && view.status === 'playing';
        if (faceUp) o.setFace(fresh.cardId); else o.setHidden();
        o.info = { zone: 'inkwell', seat, slot: i, ...(faceUp ? { cardId: fresh.cardId } : {}) };
        o.dimmed = false;
        o.setBadges('', () => {});
        const exerted = i >= pl.inkReady - (pl.inkDrops || 0);
        const s = inkSlot(i);
        put(o, { x: s.x, y: 0.05 + i * 0.03 + (faceUp ? 0.4 : 0), z: s.z + (exerted ? 0.6 : 0), yaw: exerted ? -Math.PI / 2 : 0, tilt: 0, flip: faceUp ? 0 : Math.PI, scale: inkScale });
      }
      const sp = this.sides[seat];
      if (sp?.ghost) {
        sp.ghost.visible = canInk;
        if (canInk) {
          // just past the last card, far enough out to read (the ready cards overlap closely), inside the zone
          const s = inkSlot(inkN), w = W * inkScale;
          const x = inkN ? Math.min(inkSlot(inkN - 1).x + w * 0.6, L.inkX + L.inkW - 1.5 - w / 2) : s.x;
          sp.ghost.position.set(Math.max(s.x, x), 0.6 + inkN * 0.03, s.z);
          sp.ghost.scale.set(w, H * inkScale, 1);
        }
      }

      // ---- hand ----
      if (mine && pl.hand) {
        const n = pl.hand.length;
        const hc = this.handCfg();
        const step = Math.min(W * hc.s + 0.4, (this.handSpan ?? hc.span) / Math.max(1, n - 1));   // centre to centre
        const x0 = this.handShift || 0;
        pl.hand.forEach((c, i) => {
          const o = get(c.iid, anchor(seat, 'deck'));
          o.setFace(c.cardId);
          o.info = { iid: c.iid, zone: 'hand', seat, cardId: c.cardId };
          o.setBadges('', () => {});
          const x = x0 + (i - (n - 1) / 2) * step;
          const hovered = !this.mobile && this.hover === o && !this.drag;          // no hover on a touch screen: a tap selects
          const lifted = hovered || this.ui.multi.has(c.iid) || this.ui.selected === c.iid;   // a tapped card stays up (its options float above it)
          const big = hovered || this.ui.selected === c.iid;
          o.wantHi = big;
          const arc = Math.abs(i - (n - 1) / 2) * 0.18;
          o.setProxy({ x, y: 8 + i * 0.05, z: hc.z + arc, tilt: 0.55, scale: hc.s });
          if (this.drag?.obj === o) return;
          put(o, {
            x, y: 8 + i * 0.05 + (lifted ? 4 : 0), z: hc.z + arc + (lifted ? hc.lift : 0),
            yaw: 0, tilt: 0.55, flip: 0, scale: big ? hc.up : hc.s,
          });
        });
      } else if (!off) {
        const n = pl.handCount;
        const step = Math.min(3.2, 36 / Math.max(1, n));
        for (let i = 0; i < n; i++) {
          const o = get(`ohand:${seat}:${i}`, anchor(seat, 'deck'));
          o.setHidden();
          o.info = { zone: 'hand', seat, slot: i };
          o.dimmed = false;
          o.setBadges('', () => {});
          put(o, { x: (i - (n - 1) / 2) * step, y: 0.4 + i * 0.03, z: sign > 0 ? L.handZ : -L.oppHandZ, yaw: 0, tilt: 0, flip: Math.PI, scale: 0.72 });
        }
      }
    });

    // cards that left visibility: fly to where they went (the inkwell when inked, otherwise the deck, #24) and fade out
    const rest = [...moves];
    for (const [key, c] of this.cards) {
      if (seen.has(key) || c.dying) continue;
      c.dying = now;
      c.fadeOut();
      c.setProxy(null);
      c.setBadges('', () => {});
      const seat = c.info?.seat ?? 0;
      let to = leaveTo.get(key);
      if (!to && c.info?.zone) {                                    // a face-down slot: the move out of that zone
        const k = rest.findIndex((m) => m.from.seat === seat && m.from.zone === c.info.zone && !m.iid);
        if (k >= 0) to = rest.splice(k, 1)[0].to;
      }
      const dest = ['inkwell', 'play', 'discard', 'hand'].includes(to?.zone) ? to.zone : 'deck';
      const a = anchor(to?.seat ?? seat, dest);
      c.place({ x: a.x, y: dest === 'deck' ? a.y + 0.5 : 1, z: a.z, scale: 0.9, flip: dest === 'discard' ? 0 : Math.PI, yaw: 0, tilt: 0 });
      if (castNow.has(key) && !c.castShown) this.castAt(c, now);
    }

    this.playEvents(events, me, was, now);
    this.refreshGlow();
  }

  // One object per physical card (#87 #88). When a card moves to where it's drawn under another key — a hand card
  // into an inkwell slot, an opponent's face-down hand slot into play — the object it already has becomes the new
  // one, so it travels (turning over on the way) instead of a twin appearing while the original pops. Slots pair up in
  // order: the opponent's vanishing hand slots (the last ones) with their moves out of the hand, new ink slots with
  // moves into the inkwell.
  handOff(view, moves) {
    if (!moves.length) return;
    const off = this.offTable();
    const live = (k) => { const c = this.cards.get(k); return c && !c.dying; };
    const count = (prefix, seat) => { let n = 0; while (live(`${prefix}:${seat}:${n}`)) n++; return n; };
    const range = (prefix, seat, a, b) => { const out = []; for (let i = a; i < b; i++) out.push(`${prefix}:${seat}:${i}`); return out; };
    const pools = new Map();
    const pool = (kind, seat) => {
      if (!pools.has(kind + seat)) {
        const pl = view.players[seat];
        const hidden = !off && seat !== view.you;                     // a hand drawn as face-down slots
        let list = [];
        if (pl && !off && kind === 'inkIn') list = range('ink', seat, count('ink', seat), pl.inkTotal);
        else if (pl && !off && kind === 'inkOut') list = range('ink', seat, pl.inkTotal, count('ink', seat)).reverse();
        else if (pl && hidden && kind === 'handIn') list = range('ohand', seat, count('ohand', seat), pl.handCount);
        else if (pl && hidden && kind === 'handOut') list = range('ohand', seat, pl.handCount, count('ohand', seat)).reverse();
        pools.set(kind + seat, list);
      }
      return pools.get(kind + seat);
    };
    for (const e of moves) {
      const { from, to } = e;
      let src = e.iid && live(e.iid) ? e.iid : null;
      if (!src && from.zone === 'hand' && from.seat !== view.you) src = pool('handOut', from.seat).shift() || null;
      if (!src && from.zone === 'inkwell') src = pool('inkOut', from.seat).shift() || null;
      let dst = null;
      if (to.zone === 'inkwell') dst = pool('inkIn', to.seat).shift() || null;
      else if (to.zone === 'hand' && to.seat !== view.you) dst = pool('handIn', to.seat).shift() || null;
      else if (e.iid && ['play', 'discard', 'hand', 'under'].includes(to.zone)) dst = e.iid;
      // inking reveals the card: that slot shows it face up for the rest of the turn
      if (to.zone === 'inkwell' && from.zone === 'hand' && dst && e.cardId) this.inkedNow.set(dst, { cardId: e.cardId, turn: view.turn });
      if (!src || !dst || src === dst || this.cards.has(dst)) continue;
      const c = this.cards.get(src);
      this.cards.delete(src);
      this.cards.set(dst, c);
      c.key = dst;
      c.setProxy(null);
    }
  }

  layoutRow(entries, z, minX, maxX, seat, sign, get, put, from) {
    const side = (c) => c.exerted || this.defs[c.cardId]?.type === 'location';
    const fw = ({ c }) => SLOT + (c.under?.length ? 0.8 : 0);
    const total = entries.reduce((a, e) => a + fw(e), 0) - (SLOT - H);
    const span = maxX - minX;
    const center = (minX + maxX) / 2;
    let squeeze = total > span ? span / total : 1;
    let x = center - (Math.min(total, span)) / 2;
    if (this.portrait) {
      // no squeezing: past 3 cards the row scrolls (swipe it), clamped so the row never leaves the lane
      const key = this.rowKey(seat, z);
      const max = Math.max(0, total - span);
      const sc = Math.min(max, Math.max(0, this.rowScroll[key] || 0));
      this.rowScroll[key] = sc;
      this.rowMax[key] = max;
      squeeze = 1;
      x = total > span ? minX - sc : center - total / 2;
    }
    // Squeezed rows overlap: each card sits a little above the one to its left (clear of that card's badges too), so
    // the right card is always on top instead of the two z-fighting, and a hovered card rises over the whole row (#105)
    const LAYER = 0.14;
    const top = entries.length * LAYER + 0.8;
    entries.forEach((e, i) => {
      const c = e.c;
      const under = c.under?.length ? 0.8 : 0;
      const cx = x + (under + H / 2) * squeeze;                       // centred in an H-wide box, stack peeking left
      x += fw(e) * squeeze;
      const o = get(c.iid, from(c.iid, seat, 'hand'));
      o.setFace(c.cardId);
      o.info = { iid: c.iid, zone: 'play', seat, cardId: c.cardId };
      o.dimmed = false;
      this.cardBadges(o, c);
      if (this.drag?.obj === o) return;
      const hovered = !this.mobile && this.hover === o && !this.drag;
      const rest = { x: cx, y: 0.1 + i * LAYER + (e.at ? 0.07 : 0), z: z + (e.at ? sign * 0.9 : 0), yaw: side(c) ? -Math.PI / 2 : 0, tilt: 0, flip: 0, scale: 1 };
      o.setProxy(rest);
      put(o, { ...rest, y: hovered ? 0.1 + top : rest.y });
      // stack (shift / boost) underneath
      this.underCards(c, seat, cx, z, get);
    });
  }

  underCards(c, seat, x, z, get) {
    const n = (c.under || []).length;
    (c.under || []).forEach((u, i) => {
      // keyed by the under-card's iid when visible so a shifted-onto card doesn't pop
      const o = get(u.iid || `under:${c.iid}:${i}`, null);
      o.setFace(u.cardId || null);
      o.info = { iid: u.iid, zone: 'under', seat, cardId: u.cardId, parent: c.iid };
      o.dimmed = false;
      o.setBadges('', () => {});
      // a slightly messy pile: the one just under the top card peeks out one way, the next the other way, anything
      // deeper hides under those two (the corner chip carries the count)
      const depth = Math.min(2, n - i);
      const [dx, dz, dyaw] = depth === 1 ? [-0.55, 0.45, 0.06] : [0.5, 0.7, -0.075];
      const base = c.exerted || this.defs[c.cardId]?.type === 'location' ? -Math.PI / 2 : 0;
      o.place({ x: x + dx, y: 0.02 + i * 0.01, z: z + dz, yaw: base + dyaw, tilt: 0, flip: u.faceDown ? Math.PI : 0, scale: 1 });
    });
  }

  cardBadges(o, c) {
    const d = this.defs[c.cardId];
    if (!d) return;
    const eff = c.eff || {};
    const chips = [];
    if (c.drying && d.type === 'character') chips.push(['DRYING', '#3a4a8a']);
    if (c.granted?.length) chips.push([`+${c.granted.length} ABILITY`, '#1d6b3a']);
    // keywords the corner chips show (below) aren't repeated up here; other gained / lost rules still are
    for (const m of c.mods || []) if (m.stat === 'kw' && !(KW_CHIP[m.kw] && m.delta > 0)) chips.push([`${m.delta > 0 ? '+' : '−'}${KEYWORD_LABEL[m.kw] || m.kw}`, m.delta > 0 ? '#1d6b3a' : '#7a1d1d']);
    if (c.atLocation) chips.push(['@ LOC', '#6b4d12']);
    // bottom-left corner: stack count, keywords (ringed when another card granted it), stat buffs
    const corner = [];
    if (c.under?.length) corner.push([`×${c.under.length + 1}`, '#d97706', false]);
    if (d.type === 'character' || d.type === 'location') {
      const kw = c.kw || {};
      for (const [k, spec] of Object.entries(KW_CHIP)) {
        const v = kw[k] ?? (c.kw ? undefined : d.kw?.[k]);
        if (!v) continue;
        corner.push([spec.label(typeof v === 'number' ? v : 1), spec.bg, !d.kw?.[k]]);
      }
      for (const [stat, icon] of [['str', '⚔'], ['wp', '⛨'], ['lore', '◆']]) {
        const n = modSum(c, stat);
        if (n) corner.push([`${icon}${n > 0 ? '+' : '−'}${Math.abs(n)}`, n > 0 ? '#059669' : '#dc2626', false]);
      }
    }
    const stats = [];
    if (d.type === 'character') {
      stats.push({ icon: '⚔️', value: eff.str ?? d.str, base: d.str ?? 0 });
      stats.push({ icon: '🛡️', value: eff.wp ?? d.wp, base: d.wp ?? 0 });
      stats.push({ icon: '◆', value: eff.lore ?? d.lore, base: d.lore ?? 0 });
    } else if (d.type === 'location') {
      stats.push({ icon: '🛡️', value: eff.wp ?? d.wp, base: d.wp ?? 0 });
      stats.push({ icon: '◆', value: eff.lore ?? d.lore, base: d.lore ?? 0 });
      if (d.move != null) stats.push({ icon: '⇢', value: d.move, base: d.move });
    }
    const wp = eff.wp ?? d.wp ?? 0;
    const severe = c.damage > 0 && (d.type === 'character' || d.type === 'location') && c.damage >= wp - 1;
    const key = JSON.stringify([c.damage, severe, stats.map((s) => s.value), chips, corner, d.type]);
    o.setBadges(key, (g) => {
      if (o.shownDamage !== undefined && c.damage > o.shownDamage) o.dmgPunch = performance.now();
      o.shownDamage = c.damage;
      // the stat strip hangs off the bottom of the card's footprint, a little over the card (#91: ~2 units tall)
      if (stats.length) {
        const t = statsTex(stats);
        const wdt = Math.min(W * 1.12, stats.length * 2.45) / (t.userData.cells || 1);   // wider for 10+ values (#106)
        const sh = wdt / t.userData.aspect;
        g.add(badgePlane(t, wdt, 0, 0, 0, { edge: -1, off: -sh / 2 + 0.85 }));
      }
      // damage token on the upper third of the art (clear of the stat strip and the rules text)
      if (c.damage > 0) {
        const at = { edge: 1, frac: -0.55, off: 0 };
        if (severe) {
          const halo = badgePlane(haloTex(), 4.6, 0, 0, 0.015, at);
          halo.material.color.set(0xff6a2a);
          halo.material.blending = THREE.AdditiveBlending;
          halo.userData.anim = 'halo'; halo.userData.base = { x: halo.scale.x, y: halo.scale.y };
          g.add(halo);
        }
        const tok = badgePlane(damageTex(c.damage, severe), 2.75, 0, 0, 0.03, at);
        tok.renderOrder = 3;
        tok.userData.anim = 'dmg'; tok.userData.base = { x: tok.scale.x, y: tok.scale.y };
        g.add(tok);
      }
      // corner chips: rows from the bottom-left up, over the card just above the stat strip
      if (corner.length) {
        const CH = 1.2, GAP = 0.14, MAXW = W - 0.5;
        const ts = corner.map(([label, bg, ring]) => chipTex(label, bg, ring));
        const base = (stats.length ? 0.85 : 0.3) + 0.2 + CH / 2;
        let x = 0, row = 0;
        ts.forEach((t) => {
          const cw = Math.min(MAXW, CH * t.userData.aspect);
          if (x > 0 && x + cw > MAXW) { x = 0; row++; }
          g.add(badgePlane(t, cw, 0, 0, 0.02, { edge: -1, off: base + row * (CH + GAP), xedge: -1, xoff: 0.3 + x + cw / 2 }));
          x += cw + GAP;
        });
      }
      // status chips: one row along the top edge, ~1.9 units tall; a crowded row shrinks a little, then wraps upward
      if (chips.length) {
        const MAXW = W + 2, GAPX = 0.2;
        const ts = chips.map(([label, bg]) => pillTex(label, bg));
        const sum = ts.reduce((a, t) => a + t.userData.aspect, 0);   // row width per unit of chip height
        const ch = Math.max(1.45, Math.min(1.9, (MAXW - GAPX * (ts.length - 1)) / sum));
        const cwOf = (t) => Math.min(MAXW, ch * t.userData.aspect);  // a very long label gets a slimmer chip, never a wider one
        const rows = [[]];
        let rw = 0;
        for (const t of ts) {
          const cw = cwOf(t);
          if (rows[rows.length - 1].length && rw + GAPX + cw > MAXW) { rows.push([]); rw = 0; }
          rows[rows.length - 1].push(t);
          rw += (rw ? GAPX : 0) + cw;
        }
        rows.forEach((row, r) => {
          const widths = row.map(cwOf);
          let x = -(widths.reduce((a, b) => a + b, 0) + GAPX * (row.length - 1)) / 2;
          row.forEach((t, i) => {
            g.add(badgePlane(t, widths[i], x + widths[i] / 2, 0, 0.01, { edge: 1, off: ch / 2 - 0.55 + r * (ch + 0.15) }));
            x += widths[i] + GAPX;
          });
        });
      }
    });
  }

  // ---------- effects ----------
  later(ms, fn) { this.timers.push({ at: performance.now() + ms, fn }); }
  playEvents(events, me, was, now) {
    const at = (iid) => was.get(iid) || this.cards.get(iid)?.target;
    const fight = new Set();
    for (const e of events) if (e.k === 'challenge') fight.add(e.a).add(e.t);
    const hitDelay = (iid) => (fight.has(iid) ? IMPACT_MS / 1000 : 0);
    for (const e of events) {
      if (e.k === 'quest') {
        const o = this.cards.get(e.iid);
        if (o) { o.pulse = 1; this.floatText(`+${e.lore} ◆`, '#ffd34d', at(e.iid)); }
      } else if (e.k === 'damage') {
        const p = at(e.iid);
        if (p) this.floatText(e.n > 0 ? `−${e.n}` : `+${-e.n}`, e.n > 0 ? '#ff6b6b' : '#7dffa0', p, fight.has(e.iid) ? IMPACT_MS / 1000 : 0.15);
      } else if (e.k === 'challenge') {
        // the attacker lunges from where it stood at where the defender stood; both stay put until the hit has landed
        const A = this.cards.get(e.a), T = this.cards.get(e.t), pa = at(e.a), pt = at(e.t);
        if (A && pa && pt) { A.stops = [{ pose: null, until: now + LUNGE_MS }]; A.lunge = { dx: pt.x - pa.x, dz: pt.z - pa.z, t0: now }; }
        if (T) { T.stops = [{ pose: null, until: now + IMPACT_MS + 160 }]; this.later(IMPACT_MS, () => { T.pulse = 1; }); }
        if (A) this.later(IMPACT_MS, () => { A.pulse = 0.6; });
      } else if (e.k === 'banish') {
        // a banished card stays where it fell long enough to read "BANISHED" over it, then goes to the discard
        const o = this.cards.get(e.iid), p = at(e.iid);
        if (o) o.stops = [{ pose: null, until: now + (fight.has(e.iid) ? IMPACT_MS + 650 : 600) }];
        if (p) this.floatText('BANISHED', '#ff9d4d', p, hitDelay(e.iid) + 0.15);
      } else if (e.k === 'lore' && e.n < 0) {
        const side = this.sides[e.seat];
        if (side) this.floatText(`${e.n} ◆`, '#ff7d7d', { x: L.loreX, z: side.sign * L.loreZ });
      } else if (e.k === 'mod') {
        const p = at(e.iid);
        const icon = { str: '⚔️', wp: '🛡️', lore: '◆', sing: '♪', kw: '★' }[e.stat] || '';
        if (p) this.floatText(`${e.delta > 0 ? '+' : ''}${e.delta} ${icon}`, e.delta > 0 ? '#7dffa0' : '#ff7d7d', p, 0.15);
      } else if (e.k === 'sing') {
        for (const iid of e.singers) { const p = at(iid); if (p) this.floatText('♪', '#c7a2ff', p); }
      } else if (e.k === 'turn') {
        this.turnSweep(e.seat, me, now);
      } else if (e.k === 'shuffle') {
        const s = this.sides[e.seat];
        if (s) s.shuffleT0 = now;
      } else if (e.k === 'shift') {
        // Shift: the new card comes in above the stack, drops onto it and pulses as it lands
        const o = this.cards.get(e.iid);
        if (o?.cur) {
          const above = { ...pose(o.target), y: o.target.y + 7, scale: 1.08 };
          o.stops = [{ pose: above, until: now + flightMs(dist3(o.cur, above)) + 60 }];
          o.landPulse = true;
        }
      }
    }
  }
  // a new turn: a band of light runs across the active side and their exerted cards ready one after another (#95)
  turnSweep(seat, me, now) {
    const sign = seat === me ? 1 : -1;
    const depth = L.rowZ + H / 2;
    this.sweep.scale.set(16, depth, 1);
    this.sweep.position.set(-60, 0.03, sign * (depth / 2 + 1));
    this.sweepT0 = now;
    const readying = [...this.cards.values()].filter((c) => c.info?.seat === seat && (c.info.zone === 'play' || c.info.zone === 'inkwell') && c.cur && Math.abs(wrapAngle(c.target.yaw - c.cur.yaw)) > 0.3 && !c.dying);
    readying.sort((a, b) => a.cur.x - b.cur.x);
    readying.forEach((c, i) => { if (!c.stops.length) c.hold(200 + i * 80, null, now); });
  }

  floatText(text, color, at, delay = 0) {
    const tex = floatTex(text, color);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    const w = 2 + text.length * 0.9;
    s.scale.set(w, w / tex.userData.aspect, 1);
    s.position.set(at.x, 6, at.z);
    s.renderOrder = 10;
    s.visible = false;
    this.fx.add(s);
    this.floaters.push({ s, t0: performance.now() + delay * 1000 });
  }

  // ---------- UI state (selection + targeting glow) ----------
  setUi(ui) {
    const was = this.ui.selected;
    Object.assign(this.ui, ui);
    if ('selected' in ui && ui.selected !== was && this.view) this.render(this.view, this.defs, []);   // re-fan the hand (lift)
    else this.refreshGlow();
  }
  // { auras, arrows }: the action auras + ink slot, and the targeting arrow with its outcome preview
  setOptions(o) {
    Object.assign(this.opts, o);
    if (this.view) this.render(this.view, this.defs, []);
  }
  replaying() { return typeof document !== 'undefined' && document.body.classList.contains('replaying'); }
  // the character that would challenge: the one being dragged, else the selected one of mine in play
  attacker() {
    const v = this.view;
    if (!v || !myMove(v)) return null;
    const mine = (o) => o?.info?.zone === 'play' && o.info.seat === v.you && this.defs[o.info.cardId]?.type === 'character';
    if (this.drag?.active && mine(this.drag.obj)) return this.drag.obj.info.iid;
    const s = this.ui.selected && this.cards.get(this.ui.selected);
    return mine(s) ? this.ui.selected : null;
  }
  refreshGlow() {
    const { selected, targets, multi, targetColor } = this.ui;
    const targeting = targets && targets.size > 0;
    const att = !targeting && this.opts.auras ? this.attacker() : null;
    const red = att ? challengeTargets(this.view, this.defs, att) : null;
    for (const o of this.cards.values()) {
      const iid = o.info?.iid;
      let col = null, mode = 'ui';
      if (iid && multi?.has(iid)) col = 0xf1d68a;
      else if (iid && targets?.has(iid)) col = this.hover === o ? 0xffffff : targetColor;
      else if (iid && iid === selected) col = 0xf1d68a;
      else if (iid && red?.has(iid)) { col = AURA.target; mode = this.hover === o ? 'auraHover' : 'aura'; }
      else if (iid && !targeting && !red?.size && this.auras.has(iid) && o.info.zone !== 'under') { col = AURA[this.auras.get(iid)]; mode = this.hover === o ? 'auraHover' : 'aura'; }
      o.glowColor = col;
      o.glowMode = mode;
      o.dimmed = targeting && o.info?.zone === 'play' && !targets.has(iid) && iid !== selected && !multi?.has(iid);
    }
    this.refreshAim(red, att);
  }
  // the targeting arrow: from the attacker (or the card acting) to the hovered valid target, with what would happen
  refreshAim(red, att) {
    this.aim = null;
    const v = this.view, h = this.hover?.info?.iid;
    if (!v || !h || !this.opts.arrows) return;
    const { targets, selected, targetColor, arrowFrom } = this.ui;
    const onBoard = (iid) => { const o = iid && this.cards.get(iid); return o && !o.dying && o.cur ? iid : null; };
    let from = null, to = h, color = AURA.target, outcome = null;
    if (targets?.size) {
      if (!targets.has(h)) return;
      color = targetColor;
      from = onBoard(arrowFrom) || (selected !== h && onBoard(selected)) || onBoard(v.pending?.src);
      if (!from || from === h) return;
      if (!v.pending) {                                         // a challenge picked from the card panel (either way round)
        outcome = challengeOutcome(v, this.defs, from, h);
        if (!outcome && challengeOutcome(v, this.defs, h, from)) { outcome = challengeOutcome(v, this.defs, h, from); [from, to] = [h, from]; }
      }
    } else if (att && red?.has(h)) {
      from = att;
      outcome = challengeOutcome(v, this.defs, att, h);
    } else return;
    const labels = [];
    if (outcome) {
      labels.push(outcome.banishT ? { text: `${outcome.toDefender} dmg · BANISH`, color: '#ff5a4f', at: 'to' } : { text: `${outcome.toDefender} dmg`, color: '#fff', at: 'to' });
      if (outcome.toAttacker > 0 || outcome.banishA) labels.push({ text: outcome.banishA ? `takes ${outcome.toAttacker} · BANISHED` : `takes ${outcome.toAttacker}`, color: outcome.banishA ? '#ff9d4d' : '#ffd6a0', at: 'from' });
    }
    this.aim = { from, to, color, labels, noArrow: !!this.drag?.active };
  }

  // ---------- picking ----------
  pick(ev) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const objs = [];
    for (const c of this.cards.values()) {
      if (c.dying || c.stops.length || c === this.drag?.obj) continue;   // mid-animation (cast, hit, readying): not a target
      objs.push(c.front, c.back);
      if (c.proxy?.visible && (c.info?.zone === 'hand' || c.info?.zone === 'play')) objs.push(c.proxy);
    }
    if (!this.offTable()) for (const s of this.sides) if (s) objs.push(s.deck, s.discardZone, s.inkZone, ...s.lore.children);
    const hits = this.raycaster.intersectObjects(objs, false);
    for (const h of hits) {
      if (h.object.userData.card) return { card: h.object.userData.card };
      if (h.object.userData.zone) return { zone: h.object.userData.zone };
    }
    return null;
  }
  planePoint(ev, y = 0) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.dragPlane.constant = -y;
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.dragPlane, p) ? p : null;
  }

  bindPointer() {
    const el = this.canvas;
    el.addEventListener('pointermove', (ev) => {
      const sw = this.swipe;
      if (sw) {
        const dx = ev.clientX - sw.sx, dy = ev.clientY - sw.sy;
        if (!sw.active && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) && (this.rowMax[sw.key] || 0) > 0) { sw.active = true; clearTimeout(this.pressTimer); }
        if (sw.active) {
          const p = this.planePoint(ev, 0);
          if (p) this.rowScroll[sw.key] = sw.start - (p.x - sw.x0);
          if (!this.swipeRaf) this.swipeRaf = requestAnimationFrame(() => { this.swipeRaf = 0; if (this.view) this.render(this.view, this.defs, []); });
          return;
        }
      }
      if (this.drag) {
        const d = this.drag;
        if (!d.active && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) > 7) {
          d.active = true;
          clearTimeout(this.pressTimer);                                  // moving means dragging, not holding
          this.cb.onDragStart?.(d.obj.info);
          this.refreshGlow();                                             // a dragged character lights what it can challenge
        }
        if (d.active) {
          const p = this.planePoint(ev, 4);
          if (p) d.obj.dragTo({ x: p.x, y: 4, z: p.z, tilt: 0, scale: 1.05, yaw: 0, flip: 0 });
          const over = this.pick(ev);
          this.setHover(over?.card || null, over);
          return;
        }
      }
      if (this.downAt && Math.hypot(ev.clientX - this.downAt.x, ev.clientY - this.downAt.y) > 7) clearTimeout(this.pressTimer);
      const hit = this.pick(ev);
      this.setHover(hit?.card || null, hit);
      el.style.cursor = hit ? 'pointer' : 'default';
    });
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const hit = this.pick(ev);
      if (hit?.card && this.cb.canDrag?.(hit.card.info)) {
        this.drag = { obj: hit.card, sx: ev.clientX, sy: ev.clientY, active: false };
        el.setPointerCapture(ev.pointerId);
      }
      this.downHit = hit;
      // portrait: a sideways swipe on a lane scrolls it (a tap still selects)
      this.swipe = null;
      if (this.portrait && (!hit?.card || hit.card.info?.zone === 'play')) {
        const lane = this.laneAt(ev);
        if (lane) { this.swipe = { key: lane.key, sx: ev.clientX, sy: ev.clientY, x0: lane.x, start: this.rowScroll[lane.key] || 0, active: false }; el.setPointerCapture(ev.pointerId); }
      }
      // hold a card (no drag) → its full breakdown; a tap → its quick options
      clearTimeout(this.pressTimer);
      this.pressFired = false;
      this.downAt = { x: ev.clientX, y: ev.clientY };
      if (hit?.card?.info?.iid) this.pressTimer = setTimeout(() => { if (this.drag?.active) return; this.pressFired = true; this.cb.onLongPress?.(hit.card.info); }, 450);
    });
    el.addEventListener('pointerup', (ev) => {
      clearTimeout(this.pressTimer);
      const swiped = this.swipe?.active;
      this.swipe = null;
      if (swiped) { this.drag = null; return; }
      if (this.pressFired) { this.pressFired = false; this.drag = null; return; }   // the hold already did its thing
      const d = this.drag;
      if (d?.active) {
        const over = this.pick(ev);   // while this.drag is set, so the dragged card is excluded
        const p = this.planePoint(ev, 0);
        this.drag = null;
        this.cb.onDrop?.({ info: d.obj.info, over: over?.card?.info || over?.zone || null, point: p });
        if (this.view) this.render(this.view, this.defs, []);  // snap back if nothing changed
        return;
      }
      this.drag = null;
      const hit = this.pick(ev);
      if (hit?.card) this.cb.onClickCard?.(hit.card.info, ev);
      else if (hit?.zone) this.cb.onClickZone?.(hit.zone, ev);
      else this.cb.onClickEmpty?.(ev);
    });
    el.addEventListener('pointerleave', () => this.setHover(null));
    el.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  setHover(obj, hit) {
    if (this.hover === obj) return;
    const lifts = (o) => o?.info?.zone === 'hand' || o?.info?.zone === 'play';   // a hovered card in hand or play rises
    const prevHand = lifts(this.hover) || lifts(obj);
    this.hover = obj;
    this.cb.onHover?.(obj?.info || null, hit);
    if (prevHand && this.view) this.render(this.view, this.defs, []);
    else this.refreshGlow();
  }

  // ---------- frame ----------
  tick() {
    this.timer.update();
    const dt = Math.min(0.05, this.timer.getDelta());
    this.dt = dt;
    const now = performance.now();
    for (let i = this.timers.length - 1; i >= 0; i--) if (now >= this.timers[i].at) this.timers.splice(i, 1)[0].fn();
    for (const [key, c] of this.cards) {
      c.tick(dt, now);
      if (!c.dying) continue;
      const t = c.tw;
      const flying = !c.stops.length && t && samePose(t.to, c.target);
      if ((flying && t.done) || now - c.dying > 5000) { c.dispose(); this.cards.delete(key); continue; }
      if (flying) c.setOpacity((t.t0 + t.dur - now) / 150);       // fade over the last 150ms of the way out (#94)
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      const p = (now - f.t0) / 1300;
      if (p < 0) continue;
      f.s.visible = true;
      if (p >= 1) { this.fx.remove(f.s); f.s.material.dispose(); this.floaters.splice(i, 1); continue; }
      f.s.position.y = 6 + p * 7;
      f.s.material.opacity = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3;
    }
    if (this.sweepT0) {
      const p = (now - this.sweepT0) / 900;
      if (p >= 1) { this.sweepT0 = 0; this.sweep.visible = false; } else {
        this.sweep.visible = true;
        this.sweep.position.x = -60 + easeInOut(p) * 120;
        this.sweep.material.opacity = 0.5 * Math.sin(Math.PI * p);
      }
    }
    for (const s of this.sides) {
      if (!s?.shuffleT0) continue;
      const p = (now - s.shuffleT0) / 650;                            // a shuffle: the deck box jiggles (#95)
      if (p >= 1) { s.shuffleT0 = 0; s.deck.rotation.y = 0; s.deck.position.x = L.deckX; continue; }
      const k = Math.sin(Math.PI * p);
      s.deck.rotation.y = Math.sin(p * 38) * 0.1 * k;
      s.deck.position.x = L.deckX + Math.sin(p * 27) * 0.5 * k;
    }
    if (this.view) for (const [seat, s] of this.sides.entries()) if (s && s.lorePulse > 0) this.updateSide(seat, s.sign, this.view.players[seat], this.view.active === seat);
    for (const s of this.sides) if (s?.ghost?.visible) s.ghost.material.opacity = 0.55 + 0.3 * Math.sin(now / 420);   // the ink slot breathes
    const aim = this.aim, A = aim && this.cards.get(aim.from), B = aim && this.cards.get(aim.to);
    if (A?.cur && B?.cur && !A.dying && !B.dying) { this.arrow.show(A.cur, B.cur, aim.color, aim.labels, aim.noArrow); this.arrow.tick(now); }
    else this.arrow.hide();
    this.renderer.render(this.scene, this.camera);
  }

  // a card's centre and top edge (where it's heading), in screen pixels — the quick options fan out around it
  cardAnchor(iid) {
    const t = this.cards.get(iid)?.target;
    if (!t) return null;
    const half = (H / 2) * (t.scale || 1);
    return { center: this.toScreen({ x: t.x, y: t.y || 0, z: t.z }), top: this.toScreen({ x: t.x, y: (t.y || 0) + half * Math.sin(t.tilt || 0), z: t.z - half * Math.cos(t.tilt || 0) }) };
  }
  // a card's resting rectangle on screen (where it's heading), in page pixels — for DOM overlays that sit by a card
  cardRect(iid) {
    const t = this.cards.get(iid)?.target;
    if (!t) return null;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y || 0, t.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, t.yaw || 0, 0)), new THREE.Vector3().setScalar(t.scale || 1))
      .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-Math.PI / 2 + (t.tilt || 0), t.flip || 0, 0)));
    const r = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const [x, y] of [[-W / 2, -H / 2], [W / 2, -H / 2], [-W / 2, H / 2], [W / 2, H / 2]]) {
      const p = this.toScreen(new THREE.Vector3(x, y, 0).applyMatrix4(m));
      r.left = Math.min(r.left, p.x); r.right = Math.max(r.right, p.x); r.top = Math.min(r.top, p.y); r.bottom = Math.max(r.bottom, p.y);
    }
    return r;
  }
  // the screen band between the two front rows (the far row's stat strips above, my row's chips below): where a
  // banner or the midline pill can sit without covering cards. top > bottom when the rows overlap the centre line.
  frontGap() {
    const top = this.toScreen({ x: 0, y: 0, z: -(L.charZ - H / 2) + 1.3 }).y;
    const bottom = this.toScreen({ x: 0, y: 0, z: L.charZ - H / 2 - 1.35 }).y;
    return { top, bottom, mid: this.toScreen({ x: 0, y: 0, z: 0 }).y };
  }
  // project a world point to screen pixels (for DOM overlays)
  toScreen(v) {
    const p = new THREE.Vector3(v.x, v.y || 0, v.z).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }
}
