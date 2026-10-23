// The step gates, as a written spec, checked against the engine's real step loop (Runtime.pump).
//
// Which steps of an ability happen depends on a few words — "you may", "If you do,", "then", "If …,", "Otherwise,".
// GATES below says what each means, in the rules' terms. For every runnable ability's step list, every combination of
// outcomes (each condition true/false, each "may" accepted/declined, each effect done/not done) is run through
// Runtime.pump with stand-in effects, and the steps that ran must be exactly the ones the spec says.
//   node scripts/verify/gates.mjs     exit 1 on a disagreement
import { Runtime } from '../../game/procs/index.js';
import { EFFECT } from '../../game/procs/effects/index.js';
import { runnable } from './corpus.mjs';

// ---- the spec ------------------------------------------------------------------------------------------------
// out[i] = { cond: bool (when the step has "If …,"), accept: bool (when it has "you may"), did: bool (the effect happened) }
// → the indexes of the steps that happen.
export function GATES(steps, out) {
  const ran = [];
  // prev: the step before — did it happen, was it cut off (declined, or never reached), and its "If …" result
  let prev = { happened: true, cut: false, cond: null };              // before the first step: nothing to depend on
  steps.forEach((st, i) => {
    const o = out[i];
    // "If you do, X" — X only if the step before happened (CR 6.1.4: a "may" not done, or an effect that couldn't, isn't done)
    // "…, then X" — the same sentence: X unless the step before was cut off (declined, or skipped by its own gate)
    // "Otherwise, X" — X only if the nearest "If …" before it was false; after a "may" with no "If", if it didn't happen
    const otherwiseBlocked = st.otherwise && (prev.cond != null ? prev.cond : prev.happened);
    if ((st.ifDid && !prev.happened) || (st.linked && prev.cut) || otherwiseBlocked) { prev = { happened: false, cut: true, cond: prev.cond }; return; }
    // "If C, X" — X only if C (checked as the step starts)
    if (st.cond && !o.cond) { prev = { happened: false, cut: true, cond: false }; return; }
    // "you may X" — the player chooses; declining means X doesn't happen
    if (st.may && !o.accept) { prev = { happened: false, cut: true, cond: st.cond ? true : null }; return; }
    ran.push(i);
    prev = { happened: o.did, cut: false, cond: st.cond ? true : null };
  });
  return ran;
}

// ---- the engine, with stand-in effects -----------------------------------------------------------------------
const STUB_E = { log() {}, nameOf: () => 'P', gameStateCheck() {}, prettyText: (t) => t };
function engineRun(steps, out) {
  const rt = new Runtime(STUB_E);
  const ran = [];
  const chooses = (st) => !!st.__chooses;
  rt.effect = () => ({
    chooses, verb: () => 'do it',
    run: (_rt, s, job, st) => {
      const o = out[st.__i];
      if (st.may && chooses(st) && !o.accept) { job.tmp.pick = { done: true, acc: [] }; return false; }   // a "may" pick, declined
      ran.push(st.__i);
      return o.did;
    },
  });
  rt.test = (s, C, ctl, src, job) => (C.__i != null ? out[C.__i].cond : true);
  rt.ask = (s, job, spec) => { s.pending = { type: 'choose', seat: 0, ...spec }; return null; };
  const s = { status: 'playing', pending: null, fx: [{ seat: 0, src: 'x', label: 't', steps: steps.map((st, i) => ({ ...st, __i: i, ...(st.cond ? { cond: { __i: i } } : {}) })), i: 0, ctx: { it: [] }, tmp: {} }] };
  for (let k = 0; k < 50 && s.fx.length; k++) {
    rt.pump(s, []);
    if (!s.pending) break;
    const job = s.fx[0];
    job.answer = { key: job.waitKey, skip: !out[job.steps[job.i].__i].accept };
    s.pending = null;
  }
  return ran;
}

// ---- every runnable step list, every outcome ---------------------------------------------------------------
const lists = new Map();                                              // shape → an example, so each shape runs once
for (const x of runnable()) {
  const top = x.p.do || [];
  if (!top.length || top.some((st) => st.repeat || st.instead)) continue;   // repeat / instead expand first — the step stays the same
  const shape = top.map((st) => ({ may: !!st.may, ifDid: !!st.ifDid, linked: !!st.linked, otherwise: !!st.otherwise, cond: !!st.cond, __chooses: !!EFFECT[st.fn]?.chooses(st) }));
  const k = JSON.stringify(shape);
  if (!lists.has(k)) lists.set(k, { shape, ex: x });
}
let combos = 0; const bad = [];
for (const { shape, ex } of lists.values()) {
  const vars = shape.flatMap((st, i) => [...(st.cond ? [[i, 'cond']] : []), ...(st.may ? [[i, 'accept']] : []), [i, 'did']]);
  const n = Math.min(vars.length, 14);
  for (let m = 0; m < 2 ** n; m++) {
    const out = shape.map(() => ({ cond: true, accept: true, did: true }));
    vars.slice(0, n).forEach(([i, k], b) => { out[i][k] = !!(m & (1 << b)); });
    combos++;
    const want = GATES(shape, out); const got = engineRun(shape, out);
    if (JSON.stringify(want) !== JSON.stringify(got)) { bad.push({ ex, shape, out, want, got }); break; }
  }
}
console.log(`gates: ${lists.size} step-list shapes from ${runnable().length} abilities · ${combos} outcome combinations`);
for (const b of bad.slice(0, 10)) console.log(`  ✗ ${b.ex.full}: "${b.ex.text.slice(0, 110)}"\n      gates ${JSON.stringify(b.shape.map((st) => Object.keys(st).filter((k) => st[k]).join('+') || '-'))}\n      outcomes ${JSON.stringify(b.out)}\n      spec runs ${JSON.stringify(b.want)}, engine runs ${JSON.stringify(b.got)}`);
console.log(bad.length ? `gates: ${bad.length} shapes where the engine and the spec disagree` : 'gates: OK — the engine runs exactly the steps the spec says');
process.exitCode = bad.length ? 1 : 0;
