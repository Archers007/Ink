// The 3D table. Owns the three.js scene; knows nothing about networking.
//
//   const board = new Board(canvas, callbacks);
//   board.render(view, defs, events);      // after every server update
//   board.setUi({ selected, targets, multi });
//
// Every visible card is a CardObj keyed by its instance id (iid), so a card
// glides from hand → play → discard instead of popping. Hidden cards (the
// opponent's hand, inkwells) are keyed by slot.

import * as THREE from 'three';
import {
  CARD_W, CARD_H, initTextures, faceTexture, backTexture, damageTex, statsTex, pillTex, numberTex, floatTex, tableTex,
} from './textures.js';
import { LORE_TO_WIN, KEYWORD_LABEL } from './rules.js';

const W = CARD_W, H = CARD_H;
const GAP = 1.1;

// Table layout (z mirrored for the far player).
export const L = {
  charZ: 6.4, rowZ: 16.6, handZ: 35, oppHandZ: 26.5,
  deckX: 31, discardX: 39.5, inkX: -40.5, inkStep: 1.15, inkW: 13,
  loreX: -42, loreZ: 6.8,
  rowMinX: -20, rowMaxX: 25, charMinX: -35, charMaxX: 36,
  tableW: 104, tableD: 78,
};

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
  glow: rectGeo(W + 2.2, H + 2.2, 1.4),
  edge: rectGeo(W + 0.12, H + 0.12, 0.44),
  unit: new THREE.PlaneGeometry(1, 1),
};

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const dampAngle = (a, b, k, dt) => {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-k * dt));
};

// ---------- card object ----------
class CardObj {
  constructor(board, key) {
    this.board = board;
    this.key = key;
    this.cardId = null;
    this.outer = new THREE.Group();
    this.inner = new THREE.Group();
    this.outer.add(this.inner);
    this.frontMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.0, side: THREE.FrontSide });
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
    this.badges = new THREE.Group();
    this.badges.position.z = 0.09;
    this.inner.add(this.glow, this.edge, this.back, this.front, this.badges);
    for (const m of [this.front, this.back, this.edge]) m.userData.card = this;
    this.target = { x: 0, y: 0, z: 0, yaw: 0, tilt: 0, flip: 0, scale: 1 };
    this.cur = null;  // set on first placement
    this.info = null; // { iid, zone, seat, faceUp }
    this.glowColor = null;
    this.badgeKey = '';
    this.dying = 0;
    this.lunge = null;
    this.pulse = 0;
    this.dimmed = false;
    board.cardLayer.add(this.outer);
  }
  setFace(cardId) {
    if (cardId === this.cardId) return;
    this.cardId = cardId;
    this.frontMat.map = cardId ? faceTexture(cardId) : backTexture();
    this.frontMat.needsUpdate = true;
  }
  place(t, spawn) {
    Object.assign(this.target, t);
    if (!this.cur) {
      this.cur = { ...this.target, ...(spawn || {}) };
      this.apply();
    }
  }
  apply() {
    const c = this.cur;
    let ox = 0, oz = 0, oy = 0;
    if (this.lunge) {
      const p = (performance.now() - this.lunge.t0) / 520;
      if (p >= 1) this.lunge = null;
      else {
        const k = Math.sin(Math.PI * p) * 0.55;
        ox = (this.lunge.x - c.x) * k; oz = (this.lunge.z - c.z) * k; oy = Math.sin(Math.PI * p) * 3;
      }
    }
    this.outer.position.set(c.x + ox, c.y + oy, c.z + oz);
    this.outer.rotation.set(0, c.yaw, 0);
    this.inner.rotation.set(-Math.PI / 2 + c.tilt, c.flip, 0);
    const s = c.scale * (1 + this.pulse * 0.12);
    this.outer.scale.setScalar(s);
  }
  tick(dt) {
    const c = this.cur, t = this.target;
    const k = 12;
    c.x = damp(c.x, t.x, k, dt); c.y = damp(c.y, t.y, k, dt); c.z = damp(c.z, t.z, k, dt);
    c.yaw = dampAngle(c.yaw, t.yaw, k, dt); c.tilt = damp(c.tilt, t.tilt, k, dt);
    c.flip = damp(c.flip, t.flip, 10, dt); c.scale = damp(c.scale, t.scale, k, dt);
    if (this.pulse > 0) this.pulse = Math.max(0, this.pulse - dt * 2.5);
    // glow
    const want = this.glowColor ? 1 : 0;
    if (this.glowColor) this.glowMat.color.set(this.glowColor);
    const pulse = this.glowColor ? 0.75 + 0.25 * Math.sin(performance.now() / 180) : 0;
    this.glowMat.opacity = damp(this.glowMat.opacity, want * pulse, 14, dt);
    this.glow.visible = this.glowMat.opacity > 0.01;
    const dimTarget = this.dimmed ? 0.45 : 1;
    const col = this.frontMat.color;
    col.setScalar(damp(col.r, dimTarget, 10, dt));
    this.apply();
  }
  setBadges(key, build) {
    if (key === this.badgeKey) return;
    this.badgeKey = key;
    for (const ch of [...this.badges.children]) { this.badges.remove(ch); ch.material.dispose(); }
    build(this.badges);
  }
  // Invisible pick area at a hand card's resting slot, so hover-lift doesn't
  // move the card out from under the cursor.
  setProxy(t) {
    if (!t) { if (this.proxy) this.proxy.visible = false; return; }
    if (!this.proxy) {
      this.proxy = new THREE.Mesh(GEO.card, this.board.proxyMat);
      this.proxy.userData.card = this;
      this.board.cardLayer.add(this.proxy);
    }
    this.proxy.visible = true;
    this.proxy.position.set(t.x, t.y, t.z);
    this.proxy.rotation.set(-Math.PI / 2 + t.tilt, 0, 0);
    this.proxy.scale.setScalar(t.scale);
  }
  dispose() {
    if (this.proxy) this.board.cardLayer.remove(this.proxy);
    this.board.cardLayer.remove(this.outer);
    this.frontMat.dispose();
    this.glowMat.dispose();
    for (const ch of this.badges.children) ch.material.dispose();
  }
}

function badgePlane(tex, width, x, y, z = 0) {
  const h = width / (tex.userData.aspect || 1);
  const m = new THREE.Mesh(GEO.unit, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.scale.set(width, h, 1);
  m.position.set(x, y, z);
  m.renderOrder = 2;
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
    this.scene.background = new THREE.Color(0x070814);
    this.scene.fog = new THREE.Fog(0x070814, 140, 260);
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 600);

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
    const rim = new THREE.Mesh(new THREE.BoxGeometry(L.tableW + 4, 2, L.tableD + 4), new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.7 }));
    rim.position.y = -1.1;
    this.scene.add(rim);

    this.cardLayer = new THREE.Group();
    this.scene.add(this.cardLayer);
    this.fx = new THREE.Group();
    this.scene.add(this.fx);

    this.cards = new Map();      // key -> CardObj
    this.sides = [];              // per-seat static props (deck box, lore dial, labels)
    this.zoneOutlines = new THREE.Group();
    this.scene.add(this.zoneOutlines);
    this.floaters = [];
    this.ui = { selected: null, targets: new Set(), multi: new Set(), targetColor: 0x58ff8a };
    this.view = null;
    this.defs = {};
    this.hover = null;
    this.drag = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -4);

    this.bindPointer();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.timer = new THREE.Timer();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ---------- camera ----------
  setInsets(insets) { this.insets = insets; this.resize(); }
  // phones: frame the table closer (less depth to fit, the hand hugging the bottom edge), lift a tapped hand card
  setMobile(on) { if (this.mobile === !!on) return; this.mobile = !!on; this.resize(); if (this.view) this.render(this.view, this.defs, []); }
  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Fit the play surface into the gap between the HUD panels (left plates,
    // right log) and shift the view so the table is centred in that gap.
    const { left = 0, right = 0 } = this.insets || {};
    const free = Math.max(320, w - left - right);
    const fovV = THREE.MathUtils.degToRad(this.camera.fov);
    const tanH = Math.tan(fovV / 2) * this.camera.aspect * (free / w);
    const needW = 92 / (2 * tanH);
    const needH = (this.mobile ? 62 : 74) / (2 * Math.tan(fovV / 2));
    const dist = Math.max(needW, needH);
    const elev = THREE.MathUtils.degToRad(this.mobile ? 55 : 58);
    const focusZ = this.mobile ? 5 : 2;
    this.camera.position.set(0, Math.sin(elev) * dist, Math.cos(elev) * dist + focusZ);
    this.camera.lookAt(0, 0, focusZ);
    this.camera.setViewOffset(w, h, (right - left) / 2, 0, w, h);
    this.camera.updateProjectionMatrix();
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
      const m = new THREE.Mesh(rectGeo(w, h, 0.8), new THREE.MeshBasicMaterial({ color: 0xd4b25c, transparent: true, opacity: 0.08, depthWrite: false }));
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
    // lore dial: 20 segments around a big number
    p.lore = new THREE.Group();
    p.lore.position.set(L.loreX, 0.02, sign * L.loreZ);
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
    p.halo = new THREE.Mesh(new THREE.RingGeometry(5.6, 6.4, 48), new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
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
      p.shownLore = pl.lore;
      p.loreNum.material.map = numberTex(String(pl.lore), pl.lore >= 15 ? '#ffd34d' : '#f2dc9b', `/ ${LORE_TO_WIN}`);
      p.loreNum.material.needsUpdate = true;
      p.segs.forEach((m, i) => m.material.color.set(i < pl.lore ? (i >= 15 ? 0xffc93a : 0xd4b25c) : 0x2b2f52));
      if (up) p.lorePulse = 1;
    }
    if (p.lorePulse > 0) {
      p.lorePulse = Math.max(0, p.lorePulse - this.dt * 1.6);
      p.lore.scale.setScalar(1 + Math.sin(p.lorePulse * Math.PI) * 0.18);
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
    if (!view) { for (const c of this.cards.values()) c.dispose(); this.cards.clear(); return; }
    const me = view.you >= 0 ? view.you : 0;
    const seen = new Set();
    const spawnHint = new Map();   // iid -> {seat, zone}
    for (const e of events) if (e.k === 'move' && e.iid) spawnHint.set(e.iid, e.from);

    const anchor = (seat, zone) => {
      const sign = seat === me ? 1 : -1;
      switch (zone) {
        case 'hand': return { x: 0, y: 4, z: sign * (sign > 0 ? L.handZ : L.oppHandZ) };
        case 'discard': return { x: L.discardX, y: 1, z: sign * L.rowZ };
        case 'inkwell': return { x: L.inkX + 4, y: 1, z: sign * L.rowZ };
        case 'play': return { x: 0, y: 1, z: sign * L.charZ };
        default: return { x: L.deckX, y: 2, z: sign * L.rowZ, flip: Math.PI };
      }
    };
    const get = (key, spawnFrom) => {
      let c = this.cards.get(key);
      if (!c) { c = new CardObj(this, key); this.cards.set(key, c); c.spawn = spawnFrom; }
      c.dying = 0;
      seen.add(key);
      return c;
    };
    const put = (c, t) => { c.place(t, c.spawn ? { ...c.spawn } : null); c.spawn = null; };

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
      this.layoutRow(chars.map((c) => ({ c })), sign * L.charZ, L.charMinX, L.charMaxX, seat, sign, get, put, spawnHint, anchor);
      this.layoutRow(row2, sign * L.rowZ, L.rowMinX, L.rowMaxX, seat, sign, get, put, spawnHint, anchor);

      // ---- discard (all cards, stacked) ----
      pl.discard.forEach((c, i) => {
        const o = get(c.iid, spawnHint.has(c.iid) ? anchor(spawnHint.get(c.iid).seat, spawnHint.get(c.iid).zone) : anchor(seat, 'hand'));
        o.setFace(c.cardId);
        o.info = { iid: c.iid, zone: 'discard', seat, cardId: c.cardId };
        o.dimmed = false;
        o.setBadges('', () => {});
        put(o, { x: L.discardX + ((i * 37) % 5 - 2) * 0.06, y: 0.05 + i * 0.04, z: sign * L.rowZ + ((i * 53) % 5 - 2) * 0.06, yaw: ((i * 29) % 7 - 3) * 0.015, tilt: 0, flip: 0, scale: 1 });
      });

      // ---- inkwell (facedown slots; ready ones first) ----
      for (let i = 0; i < pl.inkTotal; i++) {
        const key = `ink:${seat}:${i}`;
        const o = get(key, anchor(seat, 'hand'));
        o.setFace(null);
        o.info = { zone: 'inkwell', seat, slot: i };
        o.dimmed = false;
        o.setBadges('', () => {});
        const exerted = i >= pl.inkReady - (pl.inkDrops || 0);
        put(o, { x: L.inkX + i * L.inkStep, y: 0.05 + i * 0.03, z: sign * L.rowZ + (exerted ? 0.6 : 0), yaw: exerted ? -Math.PI / 2 : 0, tilt: 0, flip: Math.PI, scale: 0.92 });
      }

      // ---- hand ----
      if (mine && pl.hand) {
        const n = pl.hand.length;
        const step = Math.min(W * 1.22 + 0.4, 70 / Math.max(1, n));
        const handZ = this.mobile ? L.handZ - 3.5 : L.handZ;                       // phones: the hand sits higher, fully on screen
        pl.hand.forEach((c, i) => {
          const o = get(c.iid, anchor(seat, 'deck'));
          o.setFace(c.cardId);
          o.info = { iid: c.iid, zone: 'hand', seat, cardId: c.cardId };
          o.setBadges('', () => {});
          const x = (i - (n - 1) / 2) * step;
          const hovered = !this.mobile && this.hover === o && !this.drag;          // no hover on a touch screen: a tap selects
          const lifted = hovered || this.ui.multi.has(c.iid) || this.ui.selected === c.iid;   // a tapped card stays up (its options float above it)
          const arc = Math.abs(i - (n - 1) / 2) * 0.18;
          o.setProxy({ x, y: 8 + i * 0.05, z: handZ + arc, tilt: 0.55, scale: 1.22 });
          if (this.drag?.obj === o) return;
          put(o, {
            x, y: 8 + i * 0.05 + (lifted ? 4 : 0), z: handZ + arc + (lifted ? -8.5 : 0),
            yaw: 0, tilt: 0.55, flip: 0, scale: hovered || this.ui.selected === c.iid ? 1.55 : 1.22,
          });
        });
      } else {
        const n = pl.handCount;
        const step = Math.min(3.2, 36 / Math.max(1, n));
        for (let i = 0; i < n; i++) {
          const o = get(`ohand:${seat}:${i}`, anchor(seat, 'deck'));
          o.setFace(null);
          o.info = { zone: 'hand', seat, slot: i };
          o.dimmed = false;
          o.setBadges('', () => {});
          put(o, { x: (i - (n - 1) / 2) * step, y: 0.4 + i * 0.03, z: -L.oppHandZ, yaw: 0, tilt: 0, flip: Math.PI, scale: 0.72 });
        }
      }
    });

    // cards that left visibility: fly to their owner's deck and fade
    for (const [key, c] of this.cards) {
      if (seen.has(key)) continue;
      if (!c.dying) {
        c.dying = performance.now();
        const seat = c.info?.seat ?? 0;
        const a = anchor(seat, 'deck');
        c.place({ x: a.x, y: 3, z: a.z, scale: 0.9, flip: Math.PI, yaw: 0, tilt: 0 });
      }
    }

    this.playEvents(events, me);
    this.refreshGlow();
  }

  layoutRow(entries, z, minX, maxX, seat, sign, get, put, spawnHint, anchor) {
    const side = (c) => c.exerted || this.defs[c.cardId]?.type === 'location';
    const fw = ({ c }) => (side(c) ? H : W) + GAP + (c.under?.length ? 0.8 : 0);
    const total = entries.reduce((a, e) => a + fw(e), 0) - GAP;
    const span = maxX - minX;
    const squeeze = total > span ? span / total : 1;
    const center = (minX + maxX) / 2;
    let x = center - (Math.min(total, span)) / 2;
    for (const e of entries) {
      const c = e.c;
      const w = fw(e) * squeeze;
      const cx = x + ((side(c) ? H : W) * squeeze) / 2;
      x += w;
      const hint = spawnHint.get(c.iid);
      const o = get(c.iid, hint ? anchor(hint.seat, hint.zone) : anchor(seat, 'hand'));
      o.setFace(c.cardId);
      o.info = { iid: c.iid, zone: 'play', seat, cardId: c.cardId };
      o.dimmed = false;
      this.cardBadges(o, c);
      if (this.drag?.obj === o) continue;
      put(o, {
        x: cx, y: 0.1 + (e.at ? 0.15 : 0), z: z + (e.at ? sign * 0.9 : 0),
        yaw: side(c) ? -Math.PI / 2 : 0, tilt: 0, flip: 0, scale: 1,
      });
      // stack (shift / boost) underneath
      this.underCards(c, seat, cx, z, get);
    }
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
      const off = (n - i) * 0.75;
      o.place({ x: x - off, y: 0.02 + i * 0.01, z: z - off, yaw: c.exerted ? -Math.PI / 2 : 0, tilt: 0, flip: u.faceDown ? Math.PI : 0, scale: 1 });
    });
  }

  cardBadges(o, c) {
    const d = this.defs[c.cardId];
    if (!d) return;
    const eff = c.eff || {};
    const chips = [];
    if (c.drying && d.type === 'character') chips.push(['DRYING', '#3a4a8a']);
    if (c.granted?.length) chips.push([`+${c.granted.length} ability`, '#1d6b3a']);
    for (const m of c.mods || []) if (m.stat === 'kw') chips.push([`${m.delta > 0 ? '+' : '−'}${KEYWORD_LABEL[m.kw] || m.kw}`, m.delta > 0 ? '#1d6b3a' : '#7a1d1d']);
    if (c.under?.length) chips.push([`STACK ×${c.under.length + 1}`, '#5a2d82']);
    if (c.atLocation) chips.push(['@ LOCATION', '#6b4d12']);
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
    const key = JSON.stringify([c.damage, stats.map((s) => s.value), chips, d.type]);
    o.setBadges(key, (g) => {
      if (stats.length) {
        const t = statsTex(stats);
        const wdt = Math.min(W * 1.05, stats.length * 2.3);
        g.add(badgePlane(t, wdt, 0, -H / 2 - 0.2 - (wdt / t.userData.aspect) / 2 + 0.9, 0));
      }
      if (c.damage > 0) g.add(badgePlane(damageTex(c.damage), 3.1, 0, 0.6, 0.02));
      let y = H / 2 - 0.2;
      for (const [label, bg] of chips) {
        const t = pillTex(label, bg);
        const wdt = Math.min(W * 0.95, 0.95 + label.length * 0.36);
        g.add(badgePlane(t, wdt, 0, y, 0.01));
        y -= 1.05;
      }
    });
  }

  // ---------- effects ----------
  playEvents(events, me) {
    for (const e of events) {
      if (e.k === 'quest') {
        const o = this.cards.get(e.iid);
        if (o) { o.pulse = 1; this.floatText(`+${e.lore} ◆`, '#ffd34d', o.target); }
      } else if (e.k === 'damage') {
        const o = this.cards.get(e.iid);
        if (o) this.floatText(e.n > 0 ? `−${e.n}` : `+${-e.n}`, e.n > 0 ? '#ff6b6b' : '#7dffa0', o.target, 0.25);
      } else if (e.k === 'challenge') {
        const a = this.cards.get(e.a), t = this.cards.get(e.t);
        if (a && t) a.lunge = { x: t.target.x, z: t.target.z, t0: performance.now() };
      } else if (e.k === 'banish') {
        const o = this.cards.get(e.iid);
        if (o) this.floatText('BANISHED', '#ff9d4d', o.cur || o.target, 0.5);
      } else if (e.k === 'lore' && e.n < 0) {
        const side = this.sides[e.seat];
        if (side) this.floatText(`${e.n} ◆`, '#ff7d7d', { x: L.loreX, z: side.sign * L.loreZ });
      } else if (e.k === 'mod') {
        const o = this.cards.get(e.iid);
        const icon = { str: '⚔️', wp: '🛡️', lore: '◆', sing: '♪', kw: '★' }[e.stat] || '';
        if (o) this.floatText(`${e.delta > 0 ? '+' : ''}${e.delta} ${icon}`, e.delta > 0 ? '#7dffa0' : '#ff7d7d', o.target, 0.15);
      } else if (e.k === 'sing') {
        for (const iid of e.singers) { const o = this.cards.get(iid); if (o) this.floatText('♪', '#c7a2ff', o.target); }
      }
    }
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
  refreshGlow() {
    const { selected, targets, multi, targetColor } = this.ui;
    const targeting = targets && targets.size > 0;
    for (const o of this.cards.values()) {
      const iid = o.info?.iid;
      let col = null;
      if (iid && multi?.has(iid)) col = 0x4dc3ff;
      else if (iid && targets?.has(iid)) col = this.hover === o ? 0xffffff : targetColor;
      else if (iid && iid === selected) col = 0xffd34d;
      o.glowColor = col;
      o.dimmed = targeting && o.info?.zone === 'play' && !targets.has(iid) && iid !== selected && !multi?.has(iid);
    }
  }

  // ---------- picking ----------
  pick(ev) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const objs = [];
    for (const c of this.cards.values()) {
      if (c.dying || c === this.drag?.obj) continue;
      objs.push(c.front, c.back);
      if (c.proxy?.visible && c.info?.zone === 'hand') objs.push(c.proxy);
    }
    for (const s of this.sides) if (s) objs.push(s.deck, s.discardZone, s.inkZone, ...s.lore.children);
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
      if (this.drag) {
        const d = this.drag;
        if (!d.active && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) > 7) {
          d.active = true;
          clearTimeout(this.pressTimer);                                  // moving means dragging, not holding
          this.cb.onDragStart?.(d.obj.info);
        }
        if (d.active) {
          const p = this.planePoint(ev, 4);
          if (p) d.obj.place({ x: p.x, y: 4, z: p.z, tilt: 0, scale: 1.05, yaw: 0, flip: 0 });
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
      // hold a card (no drag) → its full breakdown; a tap → its quick options
      clearTimeout(this.pressTimer);
      this.pressFired = false;
      this.downAt = { x: ev.clientX, y: ev.clientY };
      if (hit?.card?.info?.iid) this.pressTimer = setTimeout(() => { if (this.drag?.active) return; this.pressFired = true; this.cb.onLongPress?.(hit.card.info); }, 450);
    });
    el.addEventListener('pointerup', (ev) => {
      clearTimeout(this.pressTimer);
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
    const prevHand = this.hover?.info?.zone === 'hand' || obj?.info?.zone === 'hand';
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
    for (const [key, c] of this.cards) {
      if (c.dying && now - c.dying > 450) { c.dispose(); this.cards.delete(key); continue; }
      c.tick(dt);
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
    if (this.view) for (const [seat, s] of this.sides.entries()) if (s && s.lorePulse > 0) this.updateSide(seat, s.sign, this.view.players[seat], this.view.active === seat);
    this.renderer.render(this.scene, this.camera);
  }

  // the top edge of a card (where it's heading), in screen pixels — the quick-options strip hangs above it
  cardTop(iid) {
    const t = this.cards.get(iid)?.target;
    if (!t) return null;
    const half = (H / 2) * (t.scale || 1);
    return this.toScreen({ x: t.x, y: (t.y || 0) + half * Math.sin(t.tilt || 0), z: t.z - half * Math.cos(t.tilt || 0) });
  }
  // project a world point to screen pixels (for DOM overlays)
  toScreen(v) {
    const p = new THREE.Vector3(v.x, v.y || 0, v.z).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }
}
