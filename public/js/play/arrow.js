// A curved, glowing targeting arrow over the table (duels.ink's challenge arrow, in 3D): a tube along a quadratic
// Bezier lifted above the cards, with dashes flowing toward the target, a soft glow tube around it, a cone head and a
// reticle ring on the target. Optional outcome labels ("3 dmg", "BANISH") float over either end.
import * as THREE from 'three';
import { labelTex } from './textures.js';

const DASH_VS = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const DASH_FS = `
uniform vec3 color; uniform float time; uniform float len; uniform float alpha;
varying vec2 vUv;
void main() {
  float u = vUv.x * len;
  float d = fract((u - time * 5.0) / 1.6);
  float on = smoothstep(0.0, 0.08, d) * (1.0 - smoothstep(0.58, 0.66, d));
  float fade = smoothstep(0.0, 0.06, vUv.x);                  // fades in out of the attacker
  gl_FragColor = vec4(mix(color * 0.55, mix(color, vec3(1.0), 0.35), on), (0.45 + 0.55 * on) * fade * alpha);
}`;

export class Arrow {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.visible = false;
    parent.add(this.group);
    this.color = new THREE.Color(0xff4a4a);
    this.dashMat = new THREE.ShaderMaterial({
      vertexShader: DASH_VS, fragmentShader: DASH_FS, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { color: { value: this.color }, time: { value: 0 }, len: { value: 10 }, alpha: { value: 1 } },
    });
    this.glowMat = new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.headMat = new THREE.MeshBasicMaterial({ color: this.color, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.tube = new THREE.Mesh(new THREE.BufferGeometry(), this.dashMat);
    this.glow = new THREE.Mesh(new THREE.BufferGeometry(), this.glowMat);
    this.head = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.7, 18), this.headMat);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.85, 40), this.glowMat.clone());
    this.ring.material.opacity = 0.7;
    this.ring.rotation.x = -Math.PI / 2;
    for (const [m, o] of [[this.glow, 30], [this.tube, 31], [this.head, 32], [this.ring, 30]]) { m.renderOrder = o; m.frustumCulled = false; this.group.add(m); }
    this.labels = [];
    this.key = '';
    this.t0 = 0;
  }
  // from / to: world points {x, y, z}; labels: [{ text, color, at: 'from'|'to' }]
  show(from, to, color, labels = [], noArrow = false) {
    if (!this.group.visible) this.t0 = performance.now();
    this.group.visible = true;
    this.color.set(color);
    this.headMat.color.set(color); this.ring.material.color.set(color);
    this.noArrow = noArrow;
    for (const m of [this.tube, this.glow, this.head]) m.visible = !noArrow;
    const lk = JSON.stringify(labels);
    if (lk !== this.labelKey) {
      this.labelKey = lk;
      for (const s of this.labels) { this.group.remove(s); s.material.dispose(); }
      this.labels = labels.map((l) => {
        const tex = labelTex(l.text, l.color);
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
        const h = 1.9;
        s.scale.set(h * tex.userData.aspect, h, 1);
        s.renderOrder = 40;
        s.userData.at = l.at;
        this.group.add(s);
        return s;
      });
    }
    this.update(from, to);
  }
  hide() { this.group.visible = false; this.key = ''; }
  update(from, to) {
    const key = [from.x, from.y, from.z, to.x, to.y, to.z].map((v) => v.toFixed(2)).join(',');
    if (key === this.key) return;
    this.key = key;
    const a = new THREE.Vector3(from.x, Math.max(from.y, 0) + 2.2, from.z);
    const b = new THREE.Vector3(to.x, Math.max(to.y, 0) + 2.2, to.z);
    const d = a.distanceTo(b);
    const mid = a.clone().lerp(b, 0.5);
    mid.y += 3 + d * 0.22;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    // stop short of the target so the head's tip lands on it
    const len = curve.getLength();
    const tEnd = Math.max(0.5, 1 - 1.5 / Math.max(1, len));
    const pts = Array.from({ length: 33 }, (_, i) => curve.getPoint((i / 32) * tEnd));
    const path = new THREE.CatmullRomCurve3(pts);
    this.tube.geometry.dispose(); this.glow.geometry.dispose();
    this.tube.geometry = new THREE.TubeGeometry(path, 48, 0.17, 8, false);
    this.glow.geometry = new THREE.TubeGeometry(path, 48, 0.55, 8, false);
    this.dashMat.uniforms.len.value = len * tEnd;
    const tip = curve.getPoint(1), base = curve.getPoint(tEnd);
    const dir = tip.clone().sub(base).normalize();
    this.head.position.copy(base).addScaledVector(dir, 0.85);
    this.head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.ring.position.set(to.x, Math.max(to.y, 0) + 0.4, to.z);
    for (const s of this.labels) {
      const p = s.userData.at === 'from' ? from : to;
      s.position.set(p.x, Math.max(p.y, 0) + 4.6, p.z - 0.5);
    }
  }
  tick(now) {
    if (!this.group.visible) return;
    const t = (now - this.t0) / 1000;
    this.dashMat.uniforms.time.value = t;
    const k = Math.min(1, t / 0.18);                                    // a quick fade-in
    this.dashMat.uniforms.alpha.value = k;
    this.glowMat.opacity = (0.16 + 0.08 * Math.sin(t * 6)) * k;
    this.ring.material.opacity = (0.55 + 0.25 * Math.sin(t * 7)) * k;
    this.ring.scale.setScalar(1 + 0.06 * Math.sin(t * 7));
    for (const s of this.labels) s.material.opacity = k;
  }
}
