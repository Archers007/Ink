// Bounded exhaustive exploration, per card: put the card in a tiny fixed board, take each "entry" action that can fire
// its abilities (play it, quest with it, use each activated ability, pass two turns), then explore EVERY answer to
// every prompt that follows (all targets, skip, each option, yes/no), up to a branch cap. At every reached state check:
//   P1 checkInvariants          P2 bag drained: no s.fx left with no prompt (stuck)      P3 prompt answerable
//   P4 no 'Internal error'      P5 a rejected answer leaves the state byte-identical     P6 deterministic replay
//   node scripts/verify/explore.mjs [limitCards] [--only "Card Full Name"]     exit 1 on any P1–P6 finding
import { all, setup, FILLER } from '../lib/game.mjs';
import { applyAction, checkInvariants } from '../../game/engine.js';

const LIMIT = +(process.argv[2] || 1e9);
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const CAP = 400;                                   // states per scenario
const origErr = console.error; console.error = () => {};   // engine logs crashes; we record them ourselves

const DAMAGED = all.find((d) => d.type === 'character' && d.abilities.length === 0 && d.cost === 2 && d.wp >= 3);
const ITEM = all.find((d) => d.type === 'item' && d.abilities.length === 0) || null;
const LOC = all.find((d) => d.type === 'location' && d.procs.every((p) => p.kind !== 'triggered'));
const cards = all.filter((d) => d.procs.some((p) => p.exec && ['triggered', 'activated', 'static', 'action'].includes(p.kind)))
  .filter((d) => !ONLY || d.full === ONLY).slice(0, LIMIT);

const found = {}; const add = (k, card, detail) => { (found[k] ||= []).push({ card, detail }); };
const J = (s) => JSON.stringify(s);
const answers = (s) => {
  const p = s.pending;
  if (!p) return [];
  if (p.type === 'support') return [{ type: 'support' }, ...s.players[p.seat].play.filter((t) => t !== p.from && s.defs[s.cards[t].cardId].type === 'character').map((t) => ({ type: 'support', target: t }))];
  if (p.choices) return p.choices.map((_, k) => ({ type: 'choose', option: k }));
  if (p.confirm) return [{ type: 'choose', confirm: true }, { type: 'choose', skip: true }];
  return [...p.valid.map((t) => ({ type: 'choose', target: t })), ...(p.optional ? [{ type: 'choose', skip: true }] : [])];
};
function checkState(s, card, path) {
  try { checkInvariants(s); } catch (e) { add('P1 invariant', card, `${e.message} after ${path}`); }
  if (s.status === 'playing' && !s.pending && (s.fx || []).length) add('P2 bag not drained, no prompt', card, `${s.fx.map((j) => j.label + '@' + j.i).join(', ')} after ${path}`);
  const p = s.pending;
  if (p && p.type === 'choose' && !p.choices && !p.confirm && !p.valid.length && !p.optional) add('P3 unanswerable prompt', card, `${p.prompt} after ${path}`);
  if (p && !s.players[p.seat]) add('P3 prompt for no seat', card, path);
}
let scenarios = 0, states = 0, okEntries = 0, prompted = 0; const rej = {};
function explore(s0, card, entry) {
  scenarios++;
  const first = structuredClone(s0);
  const r0 = applyAction(first, entry.seat, entry.a);
  if (!r0.ok) { if (/Internal error/.test(r0.error)) add('P4 crash', card, `${entry.a.type}: ${r0.error}`); else { rej[entry.a.type + ': ' + r0.error.slice(0, 60)] = (rej[entry.a.type + ': ' + r0.error.slice(0, 60)] || 0) + 1; } return; }
  okEntries++; if (first.pending) prompted++;
  // P6: same action from the same state → same result (modulo the RNG which is in the state)
  const again = structuredClone(s0); applyAction(again, entry.seat, entry.a);
  if (J(again) !== J(first)) add('P6 nondeterministic', card, entry.a.type);
  const stack = [[first, entry.a.type]];
  let n = 0;
  while (stack.length && n < CAP) {
    const [s, path] = stack.pop(); n++; states++;
    checkState(s, card, path);
    if (!s.pending || s.status !== 'playing') continue;
    // P5: a bad answer is rejected and leaves the state untouched
    const before = J(s);
    if (!s.pending.confirm) { const bad = applyAction(s, s.pending.seat, { type: 'choose', target: '__nope__' });
    if (bad.ok || J(s) !== before) add('P5 bad answer not atomic', card, `${s.pending?.prompt}`); }
    for (const a of answers(s)) {
      const t = structuredClone(s);
      const r = applyAction(t, s.pending.seat, a);
      if (!r.ok) { if (/Internal error/.test(r.error)) add('P4 crash', card, `${a.type}${a.option ?? a.target ?? ''}: ${r.error} after ${path}`); else add('P3 offered answer rejected', card, `${JSON.stringify(a)} → ${r.error} (${s.pending.prompt})`); continue; }
      stack.push([t, `${path} > ${a.target ?? a.option ?? (a.skip ? 'no' : 'yes')}`]);
    }
  }
  if (stack.length) add('cap reached', card, entry.a.type);
}
const t0 = Date.now();
for (const def of cards) {
  const extra = [FILLER, DAMAGED, ...(ITEM ? [ITEM] : [])];
  // A: in hand, 10 ink (play it)
  try {
    const { s, ids } = setup({ hand0: [def, FILLER], play0: [FILLER, DAMAGED], play1: [...extra, LOC], hand1: [FILLER] });
    s.cards[ids.play1[1]].damage = 1; s.cards[ids.play0[1]].damage = 1;
    explore(s, def.full, { seat: 0, a: { type: 'play', iid: ids.hand0[0] } });
  } catch (e) { add('setup error', def.full, e.message); }
  // B: in play (dry): quest, each activated ability, end two turns (start/end-of-turn triggers)
  if (def.type !== 'action' && def.type !== 'song') try {
    const { s, ids } = setup({ hand0: [FILLER], play0: [def, FILLER, DAMAGED], play1: [...extra], hand1: [FILLER] });
    const me = s.cards[ids.play0[0]]; me.drying = false; s.cards[ids.play1[1]].damage = 1; s.cards[ids.play1[1]].exerted = true;
    if (def.type === 'character') explore(s, def.full, { seat: 0, a: { type: 'quest', iid: me.iid } });
    def.procs.forEach((p, k) => { if (p.kind === 'activated' && p.exec) explore(s, def.full, { seat: 0, a: { type: 'useAbility', iid: me.iid, index: k } }); });
    explore(s, def.full, { seat: 0, a: { type: 'endTurn', force: true } });
    if (def.type === 'character') explore(s, def.full, { seat: 0, a: { type: 'challenge', attacker: me.iid, target: ids.play1[1] } });
  } catch (e) { add('setup error', def.full, e.message); }
}
console.error = origErr;
console.log(`explore: ${cards.length} cards · ${scenarios} scenarios · ${states} states · ${okEntries} entries ran (${prompted} with a prompt) · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
let bad = 0;
for (const [k, xs] of Object.entries(found).sort((a, b) => b[1].length - a[1].length)) {
  const cs = new Set(xs.map((x) => x.card));
  const real = /^P\d/.test(k) || k === 'setup error';
  if (real) bad += xs.length;
  console.log(`${String(xs.length).padStart(5)} hits / ${String(cs.size).padStart(4)} cards  ${k}${real ? '' : '  (not a failure)'}`);
  const seen = new Set();
  for (const x of xs) { if (seen.has(x.card) || seen.size >= 6) continue; seen.add(x.card); console.log(`         ${x.card} :: ${String(x.detail).slice(0, 220)}`); }
}
console.log(bad ? `explore: ${bad} findings` : 'explore: OK — every reachable state is sound');
process.exitCode = bad ? 1 : 0;
