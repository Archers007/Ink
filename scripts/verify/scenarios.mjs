// Generated per-card scenarios: does the ability DO what the card says?
//
// For every ability whose printed effect is made of sentences this file can read on its own, build a small board,
// fire the ability (play the card / quest / use it / pass the turn), and compare the result with an ablated run —
// the same board, seed and answers, with the card's abilities removed. The difference is exactly what the ability did.
// What it should have done comes from the PRINTED TEXT through the independent phrase table below, never from the
// compiled proc, so a compiler misread can't hide itself. A "you may" ability is also run declining: nothing changes.
//   node scripts/verify/scenarios.mjs [--verbose] [--only "Card - Version"]     exit 1 on a mismatch
import { applyAction, viewFor } from '../../game/engine.js';
import { all, setup } from '../lib/game.mjs';

const VERBOSE = process.argv.includes('--verbose');
// --mutate: break the ability under test (every number +1, "opposing" → yours) — a sound check fails nearly all of them
const MUTATE = process.argv.includes('--mutate');
const mutate = (p) => { const q = structuredClone(p); const bump = (x) => { if (Array.isArray(x)) x.forEach(bump); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (k === 'n' && typeof v === 'number' && v < 90) x[k] = v + 1; else if (k === 'owner' && v === 'opp') x[k] = 'you'; else if (k === 'delta' || k === 'mods') bump(v); else bump(v); } }; bump(q.do || q.effect); q.mutated = JSON.stringify(q) !== JSON.stringify(p); return q; };
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const vanilla = (f) => all.find((d) => d.type === 'character' && d.abilities.length === 0 && !Object.keys(d.kw || {}).length && f(d));
// board: our ALLY (damaged, sturdy), their FOE (sturdy, undamaged so damage doesn't tip into a banish) and an item
const ALLY = vanilla((d) => d.wp >= 7 && d.str >= 2 && d.cost <= 6);
const FOE = vanilla((d) => d.wp >= 7 && d.str >= 2 && d.full !== ALLY.full) || ALLY;
const PLAIN = vanilla((d) => d.cost <= 3);
const WEAK = vanilla((d) => d.str <= 1 && d.wp >= 2);                  // for "banish chosen character with 1 {strength} or less"
const PLAIN_ITEM = all.find((d) => d.type === 'item' && d.procs.every((p) => p.kind === 'activated')) || null;
const KILL = all.find((d) => d.full === 'Dragon Fire');                // "Banish chosen character." — to fire "when this character is banished"
const ITEM = all.find((d) => d.type === 'item' && d.procs.every((p) => p.kind === 'activated' && p.exec)) || all.find((d) => d.type === 'item');
const STAT = { strength: 'str', willpower: 'wp', lore: 'lore' };
const ALLY_DAMAGE = 5;                                              // room for "remove up to 4" to show
const kwOf = (t) => { const [k, v] = t.split(' '); const n = v ? N(v.replace('+', '')) : 1; return n > 1 ? `${k.toLowerCase()}:${n}` : k.toLowerCase(); };   // "Challenger +3" → challenger:3 (as obs writes it)
const N = (w) => ({ a: 1, an: 1, one: 1, two: 2, three: 3 }[String(w).toLowerCase()] ?? Number(w));

// ---- the independent text oracle: one printed sentence → what it changes ----
//   lore [you, opp] · hand [you, opp] · ink (your inkwell) · drops · one {…} (exactly one card changes so) on 'opp'|'you'|any
//   each {…} on 'opp'|'you' (every such card in play) · self {…} (the card itself)
const TEXT = [
  [/^draw (a|\d+) cards?$/i, (m) => ({ hand: [N(m[1]), 0] })],
  [/^gain (\d+) lore$/i, (m) => ({ lore: [N(m[1]), 0] })],
  [/^each opponent loses (\d+) lore$/i, (m) => ({ lore: [0, -N(m[1])] })],
  [/^each opponent chooses and discards (a|\d+) cards?$/i, (m) => ({ hand: [0, -N(m[1])] })],
  [/^draw a card, then choose and discard a card$/i, () => ({ hand: [0, 0], discard: [1, 0] })],
  [/^get (\d+|an?) ink drops?$/i, (m) => ({ drops: N(m[1]) })],
  [/^put the top card of your deck into your inkwell facedown and exerted$/i, () => ({ ink: 1 })],
  [/^deal (\d+) damage to chosen (opposing )?character$/i, (m) => ({ one: { damage: N(m[1]) }, side: m[2] ? 'opp' : 'any' })],
  [/^deal (\d+) damage to each opposing character$/i, (m) => ({ each: { damage: N(m[1]) }, side: 'opp' })],
  [/^remove up to (\d+) damage from chosen character(?: of yours)?$/i, (m) => ({ one: { damage: -Math.min(N(m[1]), ALLY_DAMAGE) }, side: 'you' })],
  [/^banish chosen (opposing )?(character|item)$/i, (m) => ({ one: { zone: 'discard' }, side: m[1] ? 'opp' : 'any' })],
  [/^exert chosen (opposing )?character$/i, (m) => ({ one: { exerted: true }, side: m[1] ? 'opp' : 'any' })],
  [/^ready chosen character(?: of yours)?$/i, () => ({ one: { exerted: false }, side: 'you' })],
  [/^return chosen (opposing )?character to (?:their|its|your) (?:player's |owner's )?hand$/i, (m) => ({ one: { zone: 'hand' }, side: m[1] ? 'opp' : 'any' })],
  [/^chosen (opposing )?character (?:gets|loses) ([+-]?\d+) \{(strength|willpower|lore)\} (?:this turn|until the start of your next turn)$/i,
    (m) => ({ one: { [STAT[m[3].toLowerCase()]]: /loses/i.test(m[0]) ? -Math.abs(N(m[2])) : N(m[2]) }, side: m[1] ? 'opp' : 'any' })],
  [/^chosen character of yours gets \+(\d+) \{(strength|willpower|lore)\} (?:this turn|until the start of your next turn)$/i, (m) => ({ one: { [STAT[m[2].toLowerCase()]]: N(m[1]) }, side: 'you' })],
  [/^chosen (opposing )?character gains (Rush|Evasive|Ward|Reckless|Challenger \+\d+|Resist \+\d+|Bodyguard|Support|Alert) (?:this turn|until the start of your next turn)$/i,
    (m) => ({ one: { kw: kwOf(m[2]) }, side: m[1] ? 'opp' : 'any' })],
  [/^each opposing character gets -(\d+) \{(strength|willpower|lore)\} (?:this turn|until the start of your next turn)$/i, (m) => ({ each: { [STAT[m[2].toLowerCase()]]: -N(m[1]) }, side: 'opp' })],
  [/^your (other )?characters get \+(\d+) \{(strength|willpower|lore)\} this turn$/i, (m) => ({ each: { [STAT[m[3].toLowerCase()]]: N(m[2]) }, side: 'you', other: !!m[1] })],
  [/^deal (\d+) damage to chosen damaged character$/i, (m) => ({ one: { damage: N(m[1]) }, side: 'opp', damageFoe: true })],
  [/^banish chosen (opposing )?character with (\d+) \{strength\} or less$/i, (m) => ({ one: { zone: 'discard' }, side: m[1] ? 'opp' : 'any', weak: N(m[2]) })],
  [/^choose and discard a card$/i, () => ({ hand: [-1, 0], discard: [1, 0] })],
  [/^put the top card of your deck into your discard$/i, () => ({ discard: [1, 0] })],
  [/^each opponent chooses and exerts one of their ready characters$/i, () => ({ one: { exerted: true }, side: 'opp' })],
  [/^put this card into your inkwell facedown and exerted$/i, () => ({ ink: 1, selfZone: 'inkwell' })],
  [/^chosen ([A-Z][\w'.-]*(?: [A-Z][\w'.-]*)?) character gets \+(\d+) \{(strength|willpower|lore)\} this turn$/, (m) => ({ one: { [STAT[m[3].toLowerCase()]]: N(m[2]) }, side: 'you', cls: m[1] })],
  [/^your (other )?([A-Z][\w'.-]*(?: [A-Z][\w'.-]*)?) characters get \+(\d+) \{(strength|willpower|lore)\} this turn$/, (m) => ({ each: { [STAT[m[4].toLowerCase()]]: N(m[3]) }, side: 'you', other: !!m[1], cls: m[2] })],
  [/^each player draws (a|\d+) cards?$/i, (m) => ({ hand: [N(m[1]), N(m[1])] })],
  [/^ready all your characters$/i, () => ({ each: { exerted: false }, side: 'you', exertedFirst: true })],
  [/^remove up to (\d+) damage from each of your characters$/i, (m) => ({ each: { damage: -Math.min(N(m[1]), ALLY_DAMAGE) }, side: 'you', damagedOnly: true })],
  [/^return (?:a|an) (character|item) card from your discard to your hand$/i, (m) => ({ hand: [1, 0], discard: [-1, 0], discardHas: m[1] })],
  [/^chosen (opposing )?character gains Reckless during their next turn$/i, (m) => ({ one: { kw: 'reckless' }, side: m[1] ? 'opp' : 'any' })],
  [/^chosen (opposing )?character can't quest during their next turn$/i, (m) => ({ one: { kw: 'cantQuest' }, side: m[1] ? 'opp' : 'any' })],
  [/^chosen (opposing )?character can't ready at the start of their next turn$/i, (m) => ({ one: { kw: 'skipReady' }, side: m[1] ? 'opp' : 'any', exertFoe: true })],
  [/^(?:this character|he|she|they) gets? \+(\d+) \{(strength|willpower|lore)\} this turn$/i, (m) => ({ self: { [STAT[m[2].toLowerCase()]]: N(m[1]) } })],
  [/^(?:this character|he|she) gains (Rush|Evasive|Ward|Challenger \+\d+|Resist \+\d+) this turn$/i, (m) => ({ self: { kw: kwOf(m[1]) } })],
];
// statics: what the board looks like while the card is in play (no duration words)
const STATIC = [
  [/^this character gets \+(\d+) \{(strength|willpower|lore)\}$/i, (m) => ({ self: { [STAT[m[2].toLowerCase()]]: N(m[1]) } })],
  [/^your (other )?characters get \+(\d+) \{(strength|willpower|lore)\}$/i, (m) => ({ each: { [STAT[m[3].toLowerCase()]]: N(m[2]) }, side: 'you', other: !!m[1] })],
  [/^opposing characters get -(\d+) \{(strength|willpower|lore)\}$/i, (m) => ({ each: { [STAT[m[2].toLowerCase()]]: -N(m[1]) }, side: 'opp' })],
  [/^your (other )?characters gain (Rush|Evasive|Ward|Resist \+\d+|Challenger \+\d+|Bodyguard|Support|Alert)$/i, (m) => ({ each: { kw: kwOf(m[2]) }, side: 'you', other: !!m[1] })],
  [/^this character gains (Rush|Evasive|Ward|Resist \+\d+|Challenger \+\d+|Bodyguard|Support|Alert)$/i, (m) => ({ self: { kw: kwOf(m[1]) } })],
  [/^your (other )?([A-Z][\w'.-]*(?: [A-Z][\w'.-]*)?) characters get \+(\d+) \{(strength|willpower|lore)\}$/, (m) => ({ each: { [STAT[m[4].toLowerCase()]]: N(m[3]) }, side: 'you', other: !!m[1], cls: m[2] })],
  [/^your (other )?([A-Z][\w'.-]*(?: [A-Z][\w'.-]*)?) characters gain (Rush|Evasive|Ward|Resist \+\d+|Challenger \+\d+|Bodyguard|Support|Alert)$/, (m) => ({ each: { kw: kwOf(m[3]) }, side: 'you', other: !!m[1], cls: m[2] })],
  [/^this character can't challenge$/i, () => ({ self: { kw: 'cantChallenge' } })],
  [/^this character can't quest$/i, () => ({ self: { kw: 'cantQuest' } })],
  [/^this character can challenge ready characters$/i, () => ({ self: { kw: 'challengeReady' } })],
  [/^this character can't \{exert\} to sing songs$/i, () => ({ self: { kw: 'cantSing' } })],
];
// "This character enters play exerted / with 2 damage" — seen as it's played
const ENTERS = [
  [/^this character enters play exerted$/i, () => ({ self: { exerted: true } })],
  [/^this character enters play with (\d+) damage$/i, (m) => ({ self: { damage: N(m[1]) } })],
];
// an effect text → [expectation per sentence] | null (null = some sentence isn't one we read on its own)
const GAPS = process.argv.includes('--gaps') ? { sent: {}, entry: {} } : null;
const tmpl = (x) => x.replace(/\b\d+\b/g, 'N').replace(/\{(strength|willpower|lore)\}/g, '{S}').replace(/\b[A-Z][a-z]+(?: [A-Z][a-z]+)*\b/g, (w) => (/^(Rush|Evasive|Ward|Reckless|Challenger|Resist|Bodyguard|Support|Alert|Singer|Shift|Then|You|Each|Chosen|Draw|Deal|Gain|Banish|Exert|Ready|Return|Put|Remove|Look|Reveal|Your|This|If|When|Whenever|At|During|Once)$/.test(w) ? w : 'X'));
function expectOf(body, table = TEXT) {
  const out = [];
  for (let s of body.replace(/\s*\([^)]*\)/g, '').split(/(?<=\.)\s+/)) {
    s = s.trim().replace(/\.$/, '').replace(/^then,? /i, '');
    if (!s) continue;
    if (/\b(?:if|that|those|them|it|unless|for each|instead|equal to)\b/i.test(s)) { if (GAPS) GAPS.sent['(refers to another sentence) ' + tmpl(s)] = (GAPS.sent['(refers to another sentence) ' + tmpl(s)] || 0) + 1; return null; }   // depends on another sentence
    let may = false;
    if (/^you may /i.test(s)) { may = true; s = s.slice(8); }
    s = s.replace(/^you (?=draw|gain)/i, '').replace(/^give (chosen .+?) ([+-]\d+ \{\w+\}.*)$/i, '$1 gets $2');
    const hit = table.find(([rx]) => rx.test(s));
    if (!hit) { if (GAPS) GAPS.sent[tmpl(s)] = (GAPS.sent[tmpl(s)] || 0) + 1; return null; }
    out.push({ ...hit[1](s.match(hit[0])), may });
  }
  return out.length ? out : null;
}
// what fires the ability, and the effect text after its trigger / cost
function entryOf(D, p) {
  const t = p.text.replace(/\s*\([^)]*\)\s*$/, '');
  if (p.kind === 'static' && !p.cond && !p.during && D.type === 'character' && /^this character enters play /i.test(t)) return { ev: 'play', body: t, table: ENTERS };
  if (p.kind === 'static' && !p.cond && !p.during && D.type === 'character') return { ev: 'static', body: t, table: STATIC };
  // "Whenever you play a character, …" — play a plain one
  const pc = p.kind === 'triggered' && p.on.length === 1 && p.on[0].ev === 'playCard' && !p.cond && !p.during && !p.once && t.match(/^whenever you play (?:a|an) (character|item),\s*(.+)$/i);
  if (pc) return { ev: 'playCard', body: pc[2], play: pc[1].toLowerCase() };
  const bn = p.kind === 'triggered' && p.on.length === 1 && p.on[0].ev === 'banished' && !p.on[0].inChallenge && !p.cond && !p.during && t.match(/^when(?:ever)? this character is banished,\s*(.+)$/i);
  if (bn && D.type === 'character') return { ev: 'banished', body: bn[1] };
  if (p.kind === 'action' && (D.type === 'action' || D.type === 'song') && D.procs.filter((x) => x.kind === 'action').length === 1) return { ev: 'cast', body: t };
  if (p.kind === 'activated' && !p.from && !p.cond && Object.keys(p.cost).every((k) => k === 'exert' || k === 'ink')) { const m = t.match(/^[^—]+—\s*(.+)$/); return m ? { ev: 'use', body: m[1], cost: p.cost } : null; }
  if (p.kind !== 'triggered' || p.on.length !== 1 || p.cond || p.during || p.once || p.on[0].filter || p.on[0].whileCond) return null;
  const ev = p.on[0].ev;
  const head = { play: /^when(?:ever)? you play this (?:character|item|location),\s*(.+)$/i, quest: /^whenever this character quests,\s*(.+)$/i,
    turnStart: /^at the start of your turn,\s*(.+)$/i, turnEnd: /^at the end of your turn,\s*(.+)$/i }[ev];
  if (!head || (ev.startsWith('turn') && p.on[0].whose && p.on[0].whose !== 'yours')) return null;
  const m = t.match(head);
  return m ? { ev, body: m[1] } : null;
}

// ---- observables ----
function obs(s) {
  const P = s.players.map((p) => ({ lore: p.lore, hand: p.hand.length, discard: p.discard.length, ink: p.inkwell.length, drops: p.inkDrops || 0 }));
  const cards = {};
  for (const seat of [0, 1]) for (const c of viewFor(s, -1).players[seat].play) cards[c.iid] = { zone: 'play', owner: seat, type: s.defs[c.cardId].type, classes: s.defs[c.cardId].classes || [], damage: c.damage, exerted: c.exerted, kws: Object.entries(c.kw || {}).filter(([, v]) => v).map(([k, v]) => (typeof v === 'number' && v > 1 ? `${k}:${v}` : k)).sort(), ...(c.eff || {}) };
  for (const iid of Object.keys(s.cards)) if (!cards[iid]) cards[iid] = { zone: s.cards[iid].zone, owner: s.cards[iid].owner };
  return { P, cards };
}
function delta(a, b) {   // b − a
  const d = { lore: [0, 1].map((k) => b.P[k].lore - a.P[k].lore), hand: [0, 1].map((k) => b.P[k].hand - a.P[k].hand), discard: [0, 1].map((k) => b.P[k].discard - a.P[k].discard), ink: b.P[0].ink - a.P[0].ink, drops: b.P[0].drops - a.P[0].drops, changed: [] };
  for (const iid of Object.keys(b.cards)) {
    const x = a.cards[iid] || {}; const y = b.cards[iid]; const ch = {};
    for (const k of ['zone', 'damage', 'exerted', 'str', 'wp', 'lore']) if (x[k] !== y[k]) ch[k] = typeof y[k] === 'number' && typeof x[k] === 'number' && k !== 'zone' ? y[k] - x[k] : y[k];
    const add = (y.kws || []).filter((k) => !(x.kws || []).includes(k));
    if (add.length) ch.kw = add[0];
    if (Object.keys(ch).length) d.changed.push({ iid, owner: y.owner, ...ch });
  }
  return d;
}

// ---- one scenario: the real card or the ablated one, prompts answered by the text's expectations ----
function run(D, entry, exp, ablate, policy) {
  const inPlay = entry.ev !== 'play' && entry.ev !== 'cast';
  const dh = exp.find((e) => e.discardHas);
  const extra = [...(entry.ev === 'playCard' ? [entry.play === 'item' ? PLAIN_ITEM : PLAIN] : entry.ev === 'banished' ? [KILL] : []), ...(dh ? Array(2).fill(dh.discardHas === 'item' ? PLAIN_ITEM : PLAIN) : [])];
  if (extra.some((x) => !x)) return { err: 'no plain card for this scenario' };
  const cls = exp.find((e) => e.cls)?.cls;
  const ALLY2 = cls ? vanilla((d) => (d.classes || []).includes(cls.toLowerCase()) && d.wp >= 2) || all.find((d) => d.type === 'character' && (d.classes || []).includes(cls.toLowerCase()) && d.procs.every((x) => x.kind === 'keyword')) : null;
  if (cls && !ALLY2) return { err: `no plain ${cls} character` };
  const mine = [ALLY, ...(ALLY2 ? [ALLY2] : [])];
  const { s, ids } = setup({ ...(inPlay ? { play0: [D, ...mine], hand0: extra } : { hand0: [D, ...extra], play0: mine }), play1: [FOE, ITEM, WEAK], ink0: Math.max(D.cost, entry.cost?.ink || 0, ...extra.map((x) => x.cost)) + 2 });
  if (dh) for (const x of ids.hand0.slice(-2)) { s.players[0].hand.splice(s.players[0].hand.indexOf(x), 1); s.cards[x].zone = 'discard'; s.players[0].discard.push(x); }   // two, so "return 1" ≠ "return 2"
  // one ability at a time: the card keeps its keywords and only the ability under test (or none, ablated)
  s.defs[D.id] = { ...D, procs: D.procs.map((p) => (p.kind === 'keyword' ? p : !ablate && p === entry.p ? (MUTATE ? mutate(p) : p) : { ...p, kind: 'reminder', exec: false })) };
  s.players[0].lore = 5; s.players[1].lore = 5;
  const src = inPlay ? ids.play0[0] : ids.hand0[0];
  const ally = inPlay ? ids.play0[1] : ids.play0[0];
  s.cards[ally].damage = ALLY_DAMAGE;                                // heal has something to remove
  if (exp.some((e) => e.one?.exerted === false)) s.cards[ally].exerted = true;
  if (exp.some((e) => e.one?.exerted === true)) s.cards[ids.play1[0]].exerted = false;
  if (exp.some((e) => e.exertFoe)) s.cards[ids.play1[0]].exerted = true;
  if (exp.some((e) => e.damageFoe)) s.cards[ids.play1[0]].damage = 1;
  if (exp.some((e) => e.exertedFirst)) for (const iid of s.players[0].play) s.cards[iid].exerted = true;
  if (inPlay) s.cards[src].drying = false;
  const before = obs(s);
  const act = entry.ev === 'static' ? { type: 'endTurn', force: true }
    : entry.ev === 'playCard' || entry.ev === 'banished' ? { type: 'play', iid: ids.hand0[0] }
      : entry.ev === 'play' || entry.ev === 'cast' ? { type: 'play', iid: src }
    : entry.ev === 'quest' ? { type: 'quest', iid: src }
      : entry.ev === 'use' ? { type: 'useAbility', iid: src, index: D.procs.indexOf(entry.p) } : { type: 'endTurn', force: true };
  const r = applyAction(s, 0, act);
  if (!r.ok) return { err: r.error };
  if (entry.ev === 'static') { const r2 = applyAction(s, 1, { type: 'endTurn', force: true }); if (!r2.ok) return { err: r2.error }; }
  if (entry.ev === 'banished' && s.pending?.valid?.includes(src)) { const r2 = applyAction(s, 0, { type: 'choose', target: src }); if (!r2.ok) return { err: r2.error }; }
  if (entry.ev === 'turnStart') { const r2 = applyAction(s, 1, { type: 'endTurn', force: true }); if (!r2.ok) return { err: r2.error }; }
  const side = exp.find((e) => e.side)?.side;
  for (let k = 0; k < 12 && s.pending; k++) {
    const p = s.pending;
    if (p.type !== 'choose') { applyAction(s, p.seat, { type: 'support' }); continue; }
    const no = policy === 'no' && (p.confirm || p.optional);
    const want = (i) => (side === 'opp' ? s.cards[i].owner === 1 : side === 'you' ? s.cards[i].owner === 0 && i !== src : p.harmful ? s.cards[i].owner === 1 : s.cards[i].owner === 0 && i !== src);
    const weak = exp.find((e) => e.weak != null);
    const pick = (p.valid || []).find((i) => want(i) && (!cls || (s.defs[s.cards[i].cardId].classes || []).includes(cls.toLowerCase()))) ?? (p.valid || []).find(want) ?? (p.valid || [])[0];
    const a = no ? { skip: true } : p.choices ? { option: 0 } : p.confirm ? { confirm: true } : pick ? { target: pick } : { skip: true };
    const r2 = applyAction(s, p.seat, { type: 'choose', ...a });
    if (!r2.ok) return { err: r2.error };
  }
  return { o: obs(s), src, ids };
}
// the expectations, summed → a mismatch message or null
function check(exp, d, src, base) {
  const sum = (k, i) => exp.reduce((n, e) => n + (e[k]?.[i] || 0), 0);
  for (const k of ['lore', 'hand', 'discard']) for (const i of [0, 1]) if (exp.some((e) => e[k]) && d[k][i] !== sum(k, i)) return `${k}[${i === 0 ? 'you' : 'opp'}] changed by ${d[k][i]}, the text says ${sum(k, i)}`;
  if (exp.some((e) => e.ink != null) && d.ink !== exp.reduce((n, e) => n + (e.ink || 0), 0)) return `inkwell changed by ${d.ink}`;
  if (exp.some((e) => e.drops != null) && d.drops !== exp.reduce((n, e) => n + (e.drops || 0), 0)) return `ink drops changed by ${d.drops}`;
  const others = d.changed.filter((c) => c.iid !== src || exp.some((e) => e.each && e.side === 'you' && !e.other));
  for (const e of exp) {
    if (e.one) {
      const hit = others.filter((c) => Object.entries(e.one).every(([k, v]) => c[k] === v || (k === 'damage' && c.zone === 'discard')));
      if (hit.length < 1) return `no card changed by ${JSON.stringify(e.one)} (changes: ${JSON.stringify(others)})`;
      if (e.side === 'opp' && !hit.some((c) => c.owner === 1)) return 'hit our own card, the text says "opposing"';
      if (e.side === 'you' && !hit.some((c) => c.owner === 0)) return 'hit an opposing card, the text says "of yours"';
    }
    if (e.each) {
      const mine = e.side === 'opp' ? 1 : 0;
      const want = Object.keys(base.cards).filter((iid) => base.cards[iid].zone === 'play' && base.cards[iid].owner === mine && (iid !== src || (e.side === 'you' && !e.other && !e.damagedOnly)) && base.cards[iid].type === 'character' && (!e.damagedOnly || base.cards[iid].damage > 0) && (!e.cls || base.cards[iid].classes.includes(e.cls.toLowerCase())));
      for (const iid of want) { const c = others.find((x) => x.iid === iid); if (!c || Object.entries(e.each).some(([k, v]) => c[k] !== v && !(k === 'damage' && c.zone === 'discard'))) return `not every ${e.side === 'opp' ? 'opposing' : 'own'} character changed by ${JSON.stringify(e.each)}`; }
    }
    if (e.selfZone) { const me = d.changed.find((c) => c.iid === src); if (me?.zone !== e.selfZone) return `the card itself went to ${me?.zone}, the text says ${e.selfZone}`; }
    if (e.self) { const me = d.changed.find((c) => c.iid === src); if (!me || Object.entries(e.self).some(([k, v]) => me[k] !== v)) return `the card itself changed by ${JSON.stringify(me)}, the text says ${JSON.stringify(e.self)}`; }
  }
  return null;
}

const res = { abilities: 0, read: 0, pass: 0, fail: 0, declinePass: 0, declineFail: 0, err: 0, cards: new Set(), passCards: new Set() };
const fails = [];
for (const D of all) {
  if (ONLY && D.full !== ONLY) continue;
  for (const p of D.procs) {
    if (!p.exec || p.kind === 'keyword') continue;
    res.abilities++;
    const entry = entryOf(D, p);
    if (!entry && GAPS) { const k = p.kind === 'triggered' ? `trigger ${p.on.map((o) => o.ev).join('+')}${p.cond ? ' +cond' : ''}${p.during ? ' +during' : ''}${p.once ? ' +once' : ''}` : `${p.kind}${p.kind === 'activated' ? ` cost ${Object.keys(p.cost).join('+')}` : ''}`; GAPS.entry[k] = (GAPS.entry[k] || 0) + 1; }
    const exp = entry && expectOf(entry.body, entry.table);
    if (!exp) continue;
    entry.p = p;
    res.read++; res.cards.add(D.full);
    const real = run(D, entry, exp, false, 'yes'); const base = run(D, entry, exp, true, 'yes');
    if (real.err || base.err) { res.err++; if (VERBOSE) console.log('ERR', D.full, real.err || base.err); continue; }
    const d = delta(base.o, real.o);
    const why = check(exp, d, real.src, base.o);
    if (why) { res.fail++; fails.push(`${D.full} — "${entry.body}"\n      ${why}`); } else { res.pass++; res.passCards.add(D.full); if (MUTATE && mutate(p).mutated) (res.survivors ||= []).push(`${D.full} — "${entry.body}"`); }
    if (exp.every((e) => e.may)) {   // declining every "may" leaves the board as if the ability weren't there
      const no = run(D, entry, exp, false, 'no'); const dn = no.err ? null : delta(base.o, no.o);
      if (!dn || dn.lore.some(Boolean) || dn.hand.some(Boolean) || dn.changed.filter((c) => c.iid !== real.src).length) { res.declineFail++; fails.push(`${D.full} — declining "may" still changed ${JSON.stringify(dn)}`); } else res.declinePass++;
    }
  }
}
if (GAPS) {
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`).join('\n');
  console.log(`abilities whose trigger/cost the scenarios can't fire yet:\n${top(GAPS.entry, 25)}\nsentences the text table can't read yet:\n${top(GAPS.sent, 60)}`);
  process.exit(0);
}
if (MUTATE) {
  const sv = res.survivors || [];
  console.log(`mutated abilities caught: ${res.fail} of ${res.fail + sv.length} that the mutation changed (${res.pass - sv.length} had nothing to mutate)`);
  for (const x of sv) console.log(`  survived: ${x}`);
  process.exit(0);
}
console.log(`scenarios: ${res.read} of ${res.abilities} abilities read from the printed text (${res.cards.size} cards) · ${res.pass} match · ${res.fail} differ · ${res.declinePass}/${res.declinePass + res.declineFail} decline checks · ${res.err} couldn't run`);
for (const f of fails.slice(0, VERBOSE ? Infinity : 40)) console.log(`  ✗ ${f}`);
console.log(res.fail || res.declineFail ? 'scenarios: MISMATCH' : `scenarios: OK — ${res.passCards.size} cards do what their text says`);
process.exitCode = res.fail || res.declineFail ? 1 : 0;
