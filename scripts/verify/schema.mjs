// Well-formedness of every compiled proc — the structural half of "the card works" (scripts/verify/README.md).
// Checks that each building block is one the registries know, has only fields its class reads, and that the
// back-references between steps (ifDid / linked / otherwise / "that card" / "that many") have something to refer to.
//   node scripts/verify/schema.mjs [--ex N]      exit 1 on any finding not in ALLOW
import { CLASSIFIERS } from '../../game/procs/classifiers/index.js';
import { CONDITIONS } from '../../game/procs/conditions/index.js';
import { SUPPORT } from '../../game/procs/support.js';
import { runnable } from './corpus.mjs';

const EXN = process.argv.includes('--ex') ? +process.argv[process.argv.indexOf('--ex') + 1] : 3;
const d = runnable();
// ---- field sets read by each condition / classifier (static scan of test+say source) ----
const readsOf = (K, methods, argIdx) => {
  const out = new Set();
  for (const m of methods) {
    const f = K[m]; if (!f || !Object.prototype.hasOwnProperty.call(K, m)) continue;
    const src = f.toString();
    const params = (src.match(/^[^(]*\(([^)]*)\)/) || [, ''])[1].split(',').map((x) => x.trim().replace(/=.*/, ''));
    const p = params[argIdx]; if (!p) continue;
    for (const mm of src.matchAll(new RegExp(String.raw`\b${p}\??\.(\w+)`, 'g'))) out.add(mm[1]);
    for (const mm of src.matchAll(new RegExp(String.raw`\{([^{}]*)\}\s*=\s*${p}\b`, 'g'))) for (const k of mm[1].split(',')) out.add(k.trim().split(/[:=\s]/)[0].replace('...', ''));
  }
  return out;
};
const COND = new Map(CONDITIONS.map((C) => [C.key, { C, reads: readsOf(C, ['test', 'say', 'count'], 2) }]));
for (const [k, v] of COND) { const r2 = readsOf(v.C, ['say'], 0); for (const x of r2) v.reads.add(x); v.reads.add(k); }
const CLS = new Map(CLASSIFIERS.map((C) => [C.id, { C, reads: new Set([C.id, ...readsOf(C, ['test'], 0), ...readsOf(C, ['say', 'is'], 0)]) }]));

const ZONES = new Set(['play', 'hand', 'deck', 'discard', 'inkwell', 'under']);
const TYPES = new Set(['character', 'item', 'location', 'action', 'song']);
const FILTER_KEYS = new Set(['zone', 'owner', 'types', 'other', 'with', 'any']);
const SEL_HEADS = ['self', 'singers', 'both', 'role', 'ref', 'all', 'chosen'];
const SEL_MODS = { chosen: ['upTo', 'exactly', 'total', 'yours'], ref: ['pron', 'of', 'nth'], all: ['random'] };

const hits = {};
const hit = (rule, x, detail) => { (hits[rule] ||= []).push({ key: x.key, text: x.text, detail }); };

function checkFilter(x, F, where) {
  if (!F || typeof F !== 'object') return hit('filter.notObject', x, where);
  for (const k of Object.keys(F)) if (!FILTER_KEYS.has(k)) hit('filter.unknownKey', x, `${where}.${k}`);
  if (F.owner && !['you', 'opp'].includes(F.owner)) hit('filter.badOwner', x, `${where}.owner=${F.owner}`);
  if (F.zone && !ZONES.has(F.zone)) hit('filter.badZone', x, `${where}.zone=${F.zone}`);
  for (const t of F.types || []) if (!TYPES.has(t)) hit('filter.badType', x, `${where}.types ∋ ${t}`);
  for (const c of F.with || []) checkClassifier(x, c, `${where}.with`);
  for (const G of F.any || []) checkFilter(x, G, `${where}.any`);
}
function checkClassifier(x, c, where) {
  const ids = Object.keys(c || {}).filter((k) => CLS.has(k));
  if (ids.length === 0) return hit('classifier.unknown(throws at runtime)', x, `${where} ${JSON.stringify(c)}`);
  if (ids.length > 1) hit('classifier.ambiguous(only first id tested)', x, `${where} ${JSON.stringify(c)}`);
  const R = CLS.get(ids[0]).reads;
  for (const k of Object.keys(c)) if (!R.has(k)) hit('classifier.unreadKey', x, `${where} {${ids[0]}} .${k}`);
  // nested filters inside classifiers
  for (const v of Object.values(c)) if (v && typeof v === 'object' && !Array.isArray(v) && (v.types || v.with || v.owner)) checkFilter(x, v, `${where}.${ids[0]}`);
}
function checkCond(x, C, where) {
  if (!C || typeof C !== 'object') return;
  const keys = Object.keys(C).filter((k) => COND.has(k));
  if (keys.length === 0) return hit('cond.unknown(always false at runtime)', x, `${where} ${JSON.stringify(C)}`);
  if (keys.length > 1) hit('cond.ambiguous(only first key tested)', x, `${where} keys=${keys}`);
  const { reads } = COND.get(keys[0]);
  for (const k of Object.keys(C)) if (!reads.has(k)) hit('cond.unreadKey', x, `${where} {${keys[0]}} .${k}=${JSON.stringify(C[k])}`);
  if (C.have) checkFilter(x, C.have, `${where}.have`);
  if (C.refIs && typeof C.refIs === 'object') checkFilter(x, C.refIs, `${where}.refIs`);
  if (Array.isArray(C.self)) for (const c of C.self) checkClassifier(x, c, `${where}.self`);
  for (const k of ['any', 'all']) if (Array.isArray(C[k])) C[k].forEach((D) => checkCond(x, D, `${where}.${k}`));
  if (C.not && typeof C.not === 'object') checkCond(x, C.not, `${where}.not`);
}
function checkSel(x, sel, where, ctx) {
  if (!sel || typeof sel !== 'object') return hit('sel.notObject', x, where);
  const heads = SEL_HEADS.filter((h) => h in sel);
  if (heads.length !== 1) return hit('sel.heads≠1', x, `${where} ${JSON.stringify(sel)}`);
  const h = heads[0];
  for (const k of Object.keys(sel)) if (k !== h && !(SEL_MODS[h] || []).includes(k)) hit('sel.unknownKey', x, `${where} {${h}} .${k}`);
  if (h === 'chosen' || h === 'all') {
    checkFilter(x, sel[h], `${where}.${h}`);
    if (!Object.keys(sel[h]).length) hit(`sel.${h}.emptyFilter(any card in play)`, x, where);
  }
  if (h === 'both') sel.both.forEach((s2, i) => checkSel(x, s2, `${where}.both[${i}]`, ctx));
  if (h === 'ref' && !sel.pron && ctx.first && !ctx.hasEventIt) hit(`ref.first.noEvent(→ falls back to source card) [${ctx.kind}]`, x, where);
  if (h === 'ref' && sel.of && !ctx.prevFns.includes(sel.of)) hit('ref.of.noSuchEarlierFn', x, `${where} of=${sel.of} prev=${ctx.prevFns}`);
}
function checkAmount(x, n, where, ctx) {
  if (n == null || typeof n === 'number' || n === 'free') return;   // moveCost n:'free'
  const known = ['n', 'per', 'stat', 'of', 'max', 'last', 'itCount', 'plus', 'handOver', 'healed'];
  for (const k of Object.keys(n)) if (!known.includes(k)) hit('amount.unknownKey(→0)', x, `${where}.${k}`);
  if ((n.last || n.itCount || n.per?.count?.thisWay) && ctx.first && !ctx.hasEventIt) hit('amount.thatMany.first.noEvent', x, `${where} ${JSON.stringify(n)}`);
  if (n.per?.count) { const c = n.per.count; if (c.types || c.with || c.owner) checkFilter(x, Object.fromEntries(Object.entries(c).filter(([k]) => FILTER_KEYS.has(k))), `${where}.per.count`); }
}

// a step list as one job (or spliced into one); pred = the step that runs before list[0] in the same job (null = fresh job)
function checkList(x, list, ctx) {
  if (!Array.isArray(list)) return;
  const prevFns = [...(ctx.prevFns || [])];
  list.forEach((st, i) => {
    const pred = i > 0 ? list[i - 1] : ctx.pred;
    const first = !pred;
    const c = { ...ctx, first, prevFns: [...prevFns] };
    checkStep(x, st, c, pred);
    prevFns.push(st.fn);
  });
}
function checkStep(x, st, ctx, pred) {
  const w = `${ctx.path}:${st.fn}`;
  if (!st.fn) return hit('step.noFn', x, JSON.stringify(st));
  if (ctx.first && st.ifDid) hit(`gate.ifDid.first(vacuous: ctx.did starts true) [${ctx.kind}]`, x, w);
  if (ctx.first && st.linked) hit(`gate.linked.first(vacuous) [${ctx.kind}]`, x, w);
  if (st.otherwise) {
    if (!pred) hit('gate.otherwise.first(always skipped: did=true)', x, w);
    else if (!pred.cond && !pred.may && !pred.ifDid) hit('gate.otherwise.predHasNoCondOrMay(keys on did)', x, `${w} pred=${pred.fn}`);
  }
  if (st.cond) checkCond(x, st.cond, `${w}.cond`);
  if (st.instead) { checkCond(x, st.instead.cond, `${w}.instead.cond`); }
  if (st.sel) checkSel(x, st.sel, `${w}.sel`, ctx);
  if (st.filter) checkFilter(x, st.filter, `${w}.filter`);
  if (st.from && typeof st.from === 'object') checkSel(x, st.from, `${w}.from`, ctx);
  if (st.to && typeof st.to === 'object' && SEL_HEADS.some((h) => h in st.to)) checkSel(x, st.to, `${w}.to`, ctx);
  checkAmount(x, st.n, `${w}.n`, ctx);
  if (st.dur && !SUPPORT.dur.has(st.dur)) hit('step.badDur', x, `${w} ${st.dur}`);
  for (const k of st.kws || []) {
    if (!SUPPORT.kw.has(k.kw)) hit('kw.unsupported', x, `${w} ${k.kw}`);
    if (k.kw === 'grant' && k.proc) checkProc(x, k.proc, `${w}.grant`);
  }
  // nested lists
  if (st.fn === 'eachPlayer') checkList(x, st.do, { ...ctx, pred: null, path: `${w}.do`, kind: ctx.kind });          // fresh job (inherits it)
  if (st.fn === 'oppChoose' || st.fn === 'unlessOther') checkList(x, st.do, { ...ctx, pred: st, path: `${w}.do` });
  if (st.fn === 'chooseOne') (st.options || []).forEach((o, i) => checkList(x, o, { ...ctx, pred: st, path: `${w}.opt${i}` }));
  if (st.fn === 'delayed' && st.proc) checkProc(x, st.proc, `${w}.delayed`);
  if (st.instead?.step) checkStep(x, { ...st, instead: undefined, ...st.instead.step }, ctx, pred);
}
function checkProc(x, p, path = '') {
  const kind = p.kind;
  if (kind === 'triggered' || kind === 'delayed') {
    for (const o of p.on || []) { if (o.filter) checkFilter(x, o.filter, `${path}on.${o.ev}.filter`); if (o.whileCond) checkCond(x, o.whileCond, `${path}on.whileCond`); }
    if (p.cond) checkCond(x, p.cond, `${path}cond`);
    // "if X, A. Otherwise, B." with X lifted onto the whole trigger: B can never run (Beast - Tragic Hero)
    if (p.cond && (p.do || []).some((st) => st.otherwise) && !(p.do || []).slice(0, (p.do || []).findIndex((st) => st.otherwise)).some((st) => st.cond || st.may)) hit('gate.otherwise.condOnProc(never runs)', x, `${path}do`);
    // event-carrying triggers seed ctx.it; all triggers can seed ctx.n
    checkList(x, p.do, { kind: 'triggered', hasEventIt: true, pred: null, path: `${path}do` });
  } else if (kind === 'action') {
    if (p.playIf) checkCond(x, p.playIf, `${path}playIf`);
    checkList(x, p.do, { kind: 'action', hasEventIt: false, pred: null, path: `${path}do` });
  } else if (kind === 'activated') {
    const c = p.cost || {};
    const costStep = c.discard || c.exertOther || c.banishOther || c.banishN ? { fn: 'cost' } : null;
    if (p.cond) checkCond(x, p.cond, `${path}cond`);
    checkList(x, p.do, { kind: 'activated', hasEventIt: false, pred: costStep, path: `${path}do` });
  } else if (kind === 'static') {
    if (p.cond) checkCond(x, p.cond, `${path}cond`);
    if (p.effect) checkStep(x, p.effect, { kind: 'static', hasEventIt: false, first: false, prevFns: [], path: `${path}effect` }, { fn: 'static' });
  } else if (!p.on && p.do) {
    checkList(x, p.do, { kind: kind || '?', hasEventIt: true, pred: null, path: `${path}do` });
  }
  if (p.alsoProc) checkProc(x, p.alsoProc, `${path}also.`);
}

for (const x of d) checkProc(x, x.p);

// action cards whose several action abilities are concatenated into one job (Action.cast: procs.flatMap(p => p.do))
const byCard = new Map();
for (const x of d) { const card = x.key.replace(/#\d+$/, ''); if (x.p.kind === 'action' && x.p.exec) (byCard.get(card) || byCard.set(card, []).get(card)).push(x); }
for (const [, xs] of byCard) if (xs.length > 1) {
  const later = xs.slice(1).flatMap((y) => y.p.do.slice(0, 1));
  const leaks = later.filter((st) => st.ifDid || st.linked || st.otherwise || st.sel?.ref || st.n?.last || st.n?.itCount);
  hit(`action.multiProcOneJob${leaks.length ? '+gateOrRefOnJoin' : ''}`, xs[1], xs.map((y) => y.p.do.map((s) => s.fn).join('>')).join(' | '));
}

// findings that were checked by hand and are fine — rule → why
const ALLOW = {
  'ref.of.noSuchEarlierFn': (h) => /of=healedIds/.test(h.detail),           // a list a step keeps in ctx, not a step fn
};
console.log(`runnable procs checked: ${d.length}\n`);
const procsHit = new Set();
let bad = 0;
for (const [rule, hs0] of Object.entries(hits).sort((a, b) => b[1].length - a[1].length)) {
  const hs = hs0.filter((h) => !ALLOW[rule]?.(h));
  if (!hs.length) continue;
  bad += hs.length;
  const nProcs = new Set(hs.map((h) => h.key)).size;
  hs.forEach((h) => procsHit.add(h.key));
  console.log(`${String(hs.length).padStart(4)} hits / ${String(nProcs).padStart(4)} procs  ${rule}`);
  for (const h of hs.slice(0, EXN)) console.log(`        ${h.key}  ::  ${h.detail}\n          "${h.text.slice(0, 150)}"`);
}
console.log(bad ? `\nprocs with a finding: ${procsHit.size}` : 'schema: OK — every runnable proc is well-formed');
process.exitCode = bad ? 1 : 0;
