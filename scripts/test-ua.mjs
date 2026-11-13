#!/usr/bin/env node
// Union Arena rules engine tests: setup, turn structure, energy, Raid, battles, keywords, triggers, compiled effects.
// Synthetic cards (toDef on hand-written rows) so the tests don't depend on the imported card list.
//
//   node scripts/test-ua.mjs

import { toDef, deckProblems, parseDeckText } from '../game/ua/cards.js';
import { newGame, applyAction, legalActions, checkInvariants, bpOf, kwOf, energyOf, viewFor } from '../game/ua/engine.js';
import { compileDef, parseTarget, parseCond } from '../game/ua/compile.js';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.error(`✗ ${name}\n   ${e.stack?.split('\n').slice(0, 3).join('\n   ')}`); }
};
const eq = (a, b, msg = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, msg = 'expected true') => { if (!v) throw new Error(msg); };
const throws = (fn, rx) => { try { fn(); } catch (e) { if (rx && !rx.test(e.message)) throw new Error(`threw "${e.message}", expected ${rx}`); return; } throw new Error('expected a RuleError'); };

// ---------- synthetic cards ----------
let n = 0;
const card = (o) => toDef({ no: o.no || `TST-1-${String(++n).padStart(3, '0')}`, src: 'TST', name: o.name || `Card ${n}`, type: o.type || 'Character',
  color: o.color || 'green', energy: o.energy ?? 0, ap: o.ap ?? 1, bp: o.type === 'Event' || o.type === 'Site' ? null : o.bp ?? 2000,
  affinities: o.aff || [], generated: o.gen ?? ['green'], effect: o.effect || null, trigger: o.trigger || null, img: '' });
const defs = new Map();
const reg = (o) => { const d = card(o); defs.set(d.no, d); return d; };

const VANILLA = reg({ name: 'Vanilla', bp: 2000 });
const BIG = reg({ name: 'Big', energy: 3, bp: 4000, gen: ['green'] });
const SMALL = reg({ name: 'Small', bp: 1000 });
const IMPACT = reg({ name: 'Impacter', bp: 3000, effect: '[Impact (1)] (When this character attacks and wins a battle, deal 1 damage to your opponent.)' });
const NULLIFY = reg({ name: 'Nullifier', bp: 1000, effect: '[Nullify Impact] (The character battling this character loses [Impact] for the duration of this battle.)' });
const DMG2 = reg({ name: 'Damager', bp: 1500, effect: '[Damage (2)] (When this character attacks and deals direct damage, deal 2 damage instead.)' });
const SNIPE = reg({ name: 'Sniper', bp: 2500, effect: '[Snipe] (You may target a character on your opponent\'s front line and attack it with this character. If you do, your opponent cannot block.)' });
const STEP = reg({ name: 'Stepper', bp: 1500, effect: '[Step] (During your movement phase, you may move this card from your front line to your energy line.)' });
const DBL = reg({ name: 'Doubler', bp: 2000, effect: '[Double Attack] (When this character attacks for the first time this turn, switch it to active.)' });
const GON = reg({ name: 'Gon Freecss', bp: 1500 });
const RAIDER = reg({ name: 'Gon Freecss', energy: 2, bp: 4500, effect: '[Raid] <Gon Freecss> Switch to active. May move to the front line.\n[When Played] Draw a card.' });
const KO = reg({ name: 'Killer', type: 'Event', energy: 0, ap: 1, effect: 'Choose up to one character with 2000 or less BP on your opponent\'s front line and sideline it.' });
const SHRINK = reg({ name: 'Shrinker', type: 'Event', energy: 0, ap: 1, effect: 'Choose one character on your opponent\'s front line. It loses 3000 BP until the end of the turn.' });
const TURNBUFF = reg({ name: 'Turn Buffer', bp: 2000, effect: '[During Your Turn] This character gains 1000 BP.' });
const DRAWTRIG = reg({ name: 'Draw Trig', bp: 1000, trigger: { type: 'Draw', text: 'Draw a card.' } });
const GETTRIG = reg({ name: 'Get Trig', bp: 1000, trigger: { type: 'Get', text: 'Add this card to your hand.' } });
const SITE = reg({ name: 'Whale Island', type: 'Site', energy: 0, ap: 1, gen: ['green'] });
const LOOK = reg({ name: 'Looker', type: 'Event', energy: 0, ap: 1, effect: 'Look at the top three cards of your deck. Reveal up to one [Hunter] affinity card among them and add it to your hand. Place the remaining cards on the bottom of your deck in any order.' });
const HUNTER = reg({ name: 'Hunter', bp: 1000, aff: ['Hunter'] });
const APUP = reg({ name: 'AP Up', type: 'Event', energy: 0, ap: 1, effect: 'Choose up to two of your AP cards and switch them to active.' });
const SUB = reg({ name: 'Subber', type: 'Event', energy: 0, ap: 1, effect: 'Choose up to one character with {1000 or less BP} on your opponent\'s front line and sideline it. If <Gon Freecss> is on your field, {3000 or less BP} instead.' });

const deckOf = (...noQty) => noQty;
const filler = (d) => [[d.no, 50]];

// a game in progress: both players past setup with chosen hands/fields. seats' decks are `deck` cards.
function game({ p0 = {}, p1 = {}, deck0 = VANILLA, deck1 = VANILLA, seed = 7 } = {}) {
  const s = newGame({ players: [{ name: 'A', cards: filler(deck0) }, { name: 'B', cards: filler(deck1) }], defs: new Map([...defs, [deck0.no, deck0], [deck1.no, deck1]]), seed, first: 0 });
  applyAction(s, 0, { type: 'mulligan', redraw: false });
  applyAction(s, 1, { type: 'mulligan', redraw: false });
  // now: player 0's start phase, turn 1
  for (const [seat, cfg] of [[0, p0], [1, p1]]) place(s, seat, cfg);
  checkInvariants(s);
  return s;
}
// put fresh copies of cards into zones (hand/front/energy/life) for a seat
function place(s, seat, cfg) {
  const p = s.players[seat];
  for (const zone of ['hand', 'front', 'energy', 'lifeTop']) {
    for (const d of cfg[zone] || []) {
      const iid = `x${Object.keys(s.cards).length + 1}`;
      s.defs[d.no] = d;
      s.compiled[d.no] ||= compileDef(d);
      const z = zone === 'lifeTop' ? 'life' : zone;
      s.cards[iid] = { iid, no: d.no, owner: seat, zone: z, rest: false, under: [], parent: null, mods: [], once: {}, attacks: 0, blocks: 0, uid: iid };
      if (zone === 'lifeTop') p.life.unshift(iid); else p[z].push(iid);
    }
  }
  if (cfg.ap != null) p.ap = Array(cfg.ap).fill(true);
}
const ids = (s, seat, zone) => s.players[seat][zone];
const last = (s, seat, zone) => ids(s, seat, zone).at(-1);
const toMain = (s) => { applyAction(s, s.active, { type: 'next' }); applyAction(s, s.active, { type: 'next' }); };     // start → move → main
const toAttack = (s) => { toMain(s); applyAction(s, s.active, { type: 'next' }); };
const endTurn = (s) => {
  const seat = s.active;
  while (s.active === seat && s.winner == null) {
    if (s.pending?.type === 'phase') applyAction(s, seat, { type: 'next' });
    else if (s.pending?.op === 'handLimit') applyAction(s, seat, { type: 'choose', picks: s.pending.options.slice(0, 8) });
    else break;
  }
};

// ---------- deck rules ----------
test('deck: 50 cards, one title, 4 copies, trigger limits', () => {
  const sp1 = reg({ name: 'Sp1', trigger: { type: 'SPECIAL', text: 'x' } });
  const sp2 = reg({ name: 'Sp2', trigger: { type: 'SPECIAL', text: 'x' } });
  const legal = [[VANILLA.no, 4], [SMALL.no, 4], [BIG.no, 4], [IMPACT.no, 4], [NULLIFY.no, 4], [DMG2.no, 4], [SNIPE.no, 4], [STEP.no, 4], [DBL.no, 4], [GON.no, 4], [RAIDER.no, 4], [KO.no, 4], [SHRINK.no, 2]];
  eq(deckProblems(legal, defs), []);
  ok(deckProblems([[VANILLA.no, 5], ...legal.slice(1), [TURNBUFF.no, 1]], defs).some((p) => /limit is 4/.test(p)));
  ok(deckProblems(legal.slice(1), defs).some((p) => /exactly 50/.test(p)));
  ok(deckProblems([...legal.slice(0, 11), [sp1.no, 3], [sp2.no, 3]], defs).some((p) => /SPECIAL trigger/.test(p)));
  const other = toDef({ no: 'XXX-1-001', src: 'XXX', name: 'Other', type: 'Character', color: 'red', energy: 0, ap: 1, bp: 1000 });
  defs.set(other.no, other);
  ok(deckProblems([...legal.slice(0, 12), [other.no, 2]], defs).some((p) => /one title/.test(p)));
  defs.delete(other.no);
});
test('deck text: "4 HTR-1-001" lines', () => {
  eq(parseDeckText('4 HTR-1-001\nUE02BT/HTR-1-002 x3\nHTR-1-001_p1 1'), [['HTR-1-001', 5], ['HTR-1-002', 3]]);
});

// ---------- setup and turn structure ----------
test('setup: 7 in hand, 7 life, Player One 1 AP and no draw on turn 1; Player Two 2 AP and draws', () => {
  const s = newGame({ players: [{ name: 'A', cards: filler(VANILLA) }, { name: 'B', cards: filler(VANILLA) }], defs, seed: 3, first: 0 });
  eq(s.pending.type, 'mulligan'); eq(s.pending.seat, 0);
  applyAction(s, 0, { type: 'mulligan', redraw: true });
  eq(s.pending.seat, 1);
  applyAction(s, 1, { type: 'mulligan', redraw: false });
  eq(s.players[0].hand.length, 7); eq(s.players[0].life.length, 7); eq(s.players[1].life.length, 7);
  eq(s.players[0].ap, [true]);
  eq(s.players[0].deck.length, 50 - 14);
  endTurn(s);
  eq(s.active, 1);
  eq(s.players[1].ap, [true, true]);
  eq(s.players[1].hand.length, 8);
  endTurn(s);
  eq(s.players[0].ap.length, 2);
  eq(s.players[0].hand.length, 8);
  endTurn(s); endTurn(s);
  eq(s.players[0].ap.length, 3); eq(s.players[1].ap.length, 2);
  checkInvariants(s);
});
test('extra draw: once per turn for 1 AP', () => {
  const s = game();
  const h = s.players[0].hand.length;
  applyAction(s, 0, { type: 'extraDraw' });
  eq(s.players[0].hand.length, h + 1);
  eq(s.players[0].ap, [false]);
  throws(() => applyAction(s, 0, { type: 'extraDraw' }));
});
test('deck-out: no card to draw in your start phase loses', () => {
  const s = game();
  s.players[1].deck = [];
  for (const c of Object.values(s.cards)) if (c.owner === 1 && c.zone === 'deck') { c.zone = 'removal'; s.players[1].removal.push(c.iid); }
  endTurn(s);
  eq(s.winner, 0);
});
test('end phase: hand above 8 goes down to 8 into the removal area', () => {
  const s = game({ p0: { hand: [SMALL, SMALL, SMALL] } });
  eq(s.players[0].hand.length, 10);
  while (s.pending?.type === 'phase') applyAction(s, 0, { type: 'next' });
  eq(s.pending.type, 'choose');
  applyAction(s, 0, { type: 'choose', picks: s.players[0].hand.slice(0, 8) });
  eq(s.players[0].hand.length, 8);
  eq(s.players[0].removal.length, 2);
  eq(s.active, 1);
});

// ---------- energy and playing ----------
test('required energy comes from the energy line, by colour; front line generation does not count', () => {
  const s = game({ p0: { hand: [BIG], front: [VANILLA, VANILLA, VANILLA], ap: 3 } });
  toMain(s);
  const big = last(s, 0, 'hand');
  throws(() => applyAction(s, 0, { type: 'play', iid: big, line: 'front' }), /needs 3 green energy/);
  place(s, 0, { energy: [VANILLA, VANILLA, VANILLA] });
  eq(energyOf(s, 0).green, 3);
  applyAction(s, 0, { type: 'play', iid: big, line: 'front' });
  const c = s.cards[big];
  eq(c.zone, 'front'); eq(c.rest, true, 'enters resting');
  eq(s.players[0].ap.filter(Boolean).length, 2);
});
test('a full line: playing there needs a card put into the removal area first', () => {
  const s = game({ p0: { hand: [SMALL], front: [VANILLA, VANILLA, VANILLA, VANILLA] } });
  toMain(s);
  const sm = last(s, 0, 'hand');
  throws(() => applyAction(s, 0, { type: 'play', iid: sm, line: 'front' }), /full/);
  const gone = s.players[0].front[0];
  applyAction(s, 0, { type: 'play', iid: sm, line: 'front', remove: gone });
  eq(s.cards[gone].zone, 'removal');
  eq(s.players[0].front.length, 4);
});
test('sites go on the energy line only; events resolve and go to the sideline', () => {
  const s = game({ p0: { hand: [SITE, KO], ap: 3 }, p1: { front: [SMALL] } });
  toMain(s);
  const site = s.players[0].hand.at(-2), ko = last(s, 0, 'hand');
  throws(() => applyAction(s, 0, { type: 'play', iid: site, line: 'front' }), /energy line/);
  applyAction(s, 0, { type: 'play', iid: site, line: 'energy' });
  eq(s.cards[site].zone, 'energy');
  const target = s.players[1].front[0];
  applyAction(s, 0, { type: 'play', iid: ko });
  if (s.pending?.type === 'choose') applyAction(s, 0, { type: 'choose', picks: [target] });
  eq(s.cards[target].zone, 'side');
  eq(s.cards[ko].zone, 'side');
});

// ---------- Raid ----------
test('Raid: onto the named character, switch to active, move to the front, When Played fires', () => {
  const s = game({ p0: { hand: [RAIDER], energy: [GON, VANILLA], ap: 2 } });
  toMain(s);
  const raider = last(s, 0, 'hand'), gon = s.players[0].energy[0];
  s.cards[gon].rest = true;
  const h = s.players[0].hand.length;
  applyAction(s, 0, { type: 'play', iid: raider, raid: true, onto: gon, toFront: true });
  const c = s.cards[raider];
  eq(c.zone, 'front'); eq(c.rest, false); eq(c.under, [gon]);
  eq(s.cards[gon].zone, 'under');
  eq(s.players[0].hand.length, h - 1 + 1, 'When Played: draw a card');
  checkInvariants(s);
  // a raided stack leaving the field: the top goes, the cards under it go to the sideline
  toAttack(s);
});
test('Raid needs a matching character without Raid', () => {
  const s = game({ p0: { hand: [RAIDER], energy: [VANILLA, VANILLA], ap: 2 } });
  toMain(s);
  throws(() => applyAction(s, 0, { type: 'play', iid: last(s, 0, 'hand'), raid: true, onto: s.players[0].energy[0] }), /can't Raid/);
});

// ---------- battle ----------
function attackSetup(attacker, defender, extra = {}) {
  const s = game({ p0: { front: [attacker], ...extra.p0 }, p1: { front: defender ? [defender] : [], ...extra.p1 } });
  toAttack(s);
  return s;
}
test('attack the player: 1 damage, the life card is checked and sidelined', () => {
  const s = attackSetup(VANILLA, null);
  applyAction(s, 0, { type: 'attack', iid: s.players[0].front[0] });
  eq(s.players[1].life.length, 6);
  eq(s.players[1].side.length, 1);
});
test('block: attacker BP ≥ blocker BP sidelines the blocker; lower attacker loses but stays', () => {
  let s = attackSetup(VANILLA, SMALL);
  applyAction(s, 0, { type: 'attack', iid: s.players[0].front[0] });
  eq(s.pending.type, 'block');
  const blk = s.players[1].front[0];
  applyAction(s, 1, { type: 'block', iid: blk });
  eq(s.cards[blk].zone, 'side');
  eq(s.players[1].life.length, 7);
  s = attackSetup(SMALL, VANILLA);
  const att = s.players[0].front[0];
  applyAction(s, 0, { type: 'attack', iid: att });
  applyAction(s, 1, { type: 'block', iid: s.players[1].front[0] });
  eq(s.cards[att].zone, 'front'); eq(s.cards[att].rest, true);
  eq(s.players[1].front.length, 1);
  // equal BP: the attacker wins
  s = attackSetup(VANILLA, VANILLA);
  applyAction(s, 0, { type: 'attack', iid: s.players[0].front[0] });
  applyAction(s, 1, { type: 'block', iid: s.players[1].front[0] });
  eq(s.players[1].front.length, 0);
});
test('Impact: winning a battle deals 1 damage; Nullify Impact stops it', () => {
  let s = attackSetup(IMPACT, SMALL);
  applyAction(s, 0, { type: 'attack', iid: s.players[0].front[0] });
  applyAction(s, 1, { type: 'block', iid: s.players[1].front[0] });
  eq(s.players[1].life.length, 6);
  s = attackSetup(IMPACT, NULLIFY);
  applyAction(s, 0, { type: 'attack', iid: s.players[0].front[0] });
  applyAction(s, 1, { type: 'block', iid: s.players[1].front[0] });
  eq(s.players[1].life.length, 7);
  eq(s.players[1].front.length, 0);
});
test('Damage 2: an unblocked attack deals 2', () => {
  const s = attackSetup(DMG2, null);
  applyAction(s, 0, { type: 'attack', iid: s.players[0].front[0] });
  eq(s.players[1].life.length, 5);
});
test('Snipe: attack a resting front line character, no block', () => {
  const s = attackSetup(SNIPE, SMALL, { p1: { front: [VANILLA] } });
  const tgt = s.players[1].front[0];
  s.cards[tgt].rest = true;
  applyAction(s, 0, { type: 'attack', iid: s.players[0].front[0], target: tgt });
  eq(s.cards[tgt].zone, 'side');
  ok(s.pending?.type !== 'block');
});
test('Double Attack: active again after its first attack', () => {
  const s = attackSetup(DBL, null);
  const a = s.players[0].front[0];
  applyAction(s, 0, { type: 'attack', iid: a });
  eq(s.cards[a].rest, false);
  applyAction(s, 0, { type: 'attack', iid: a });
  eq(s.cards[a].rest, true);
  eq(s.players[1].life.length, 5);
});
test('only active front line characters attack; resting ones cannot block', () => {
  const s = attackSetup(VANILLA, VANILLA);
  const a = s.players[0].front[0];
  s.cards[s.players[1].front[0]].rest = true;
  applyAction(s, 0, { type: 'attack', iid: a });
  ok(s.pending?.type !== 'block', 'no active blocker: no block step');
  throws(() => applyAction(s, 0, { type: 'attack', iid: a }));
});

// ---------- movement ----------
test('movement: energy → front for anyone; front → energy only with Step', () => {
  const s = game({ p0: { energy: [VANILLA], front: [STEP, SMALL] } });
  applyAction(s, 0, { type: 'next' });
  eq(s.phase, 'move');
  applyAction(s, 0, { type: 'move', iid: s.players[0].energy[0] });
  eq(s.players[0].front.length, 3);
  const step = s.players[0].front[0], small = s.players[0].front[1];
  throws(() => applyAction(s, 0, { type: 'move', iid: small }), /Step/);
  applyAction(s, 0, { type: 'move', iid: step });
  eq(s.cards[step].zone, 'energy');
});

// ---------- life triggers ----------
test('life triggers: Draw draws, Get adds the card to hand', () => {
  const s = attackSetup(DMG2, null, { p1: { lifeTop: [DRAWTRIG, GETTRIG] } });
  const hand = s.players[1].hand.length;
  applyAction(s, 0, { type: 'attack', iid: s.players[0].front[0] });
  // two cards with triggers: the damaged player picks the order, then activates each
  while (s.pending && s.pending.seat === 1) {
    if (s.pending.type === 'choose') applyAction(s, 1, { type: 'choose', picks: [s.pending.options[0]] });
    else if (s.pending.type === 'trigger') applyAction(s, 1, { type: 'trigger', use: true });
    else break;
  }
  eq(s.players[1].hand.length, hand + 2, 'one drawn + the Get card');
  eq(s.players[1].life.length, 7);
});
test('no life left after checking: that player loses', () => {
  const s = attackSetup(DMG2, null);
  const p = s.players[1];
  while (p.life.length > 2) { const iid = p.life.shift(); s.cards[iid].zone = 'removal'; p.removal.push(iid); }
  applyAction(s, 0, { type: 'attack', iid: s.players[0].front[0] });
  eq(s.winner, 0);
});

// ---------- compiled effects ----------
test('compile: targets and conditions', () => {
  eq(parseTarget("up to one character with 3000 or less BP on your opponent's front line"), { min: 0, max: 1, all: false, f: { who: 'opp', zones: ['front'], bpMax: 3000, kind: 'character' } });
  eq(parseTarget('one other character on your field with 2 or less required energy').f, { other: true, who: 'self', zones: ['front', 'energy'], energyMax: 2, kind: 'character' });
  eq(parseCond('<Gon Freecss> is on your field'), { k: 'count', f: { who: 'self', zones: ['front', 'energy'], name: ['Gon Freecss'] }, op: '>=', n: 1 });
  ok(compileDef(KO).event.ops.length === 2);
  eq(compileDef(TURNBUFF).statics[0].mod, { bp: 1000 });
  eq(compileDef(IMPACT).coverage.manual, []);
});
test('effect: BP to 0 or less sidelines', () => {
  const s = game({ p0: { hand: [SHRINK] }, p1: { front: [VANILLA] } });
  toMain(s);
  const t = s.players[1].front[0];
  applyAction(s, 0, { type: 'play', iid: last(s, 0, 'hand') });
  eq(s.cards[t].zone, 'side');
});
test('static: During Your Turn +1000 BP', () => {
  const s = game({ p0: { front: [TURNBUFF] }, p1: { front: [TURNBUFF] } });
  eq(bpOf(s, s.cards[s.players[0].front[0]]), 3000);
  eq(bpOf(s, s.cards[s.players[1].front[0]]), 2000);
});
test('effect: look at the top three, reveal an affinity card, rest to the bottom', () => {
  const s = game({ p0: { hand: [LOOK] }, deck0: HUNTER });
  toMain(s);
  const top3 = s.players[0].deck.slice(0, 3);
  applyAction(s, 0, { type: 'play', iid: last(s, 0, 'hand') });
  eq(s.pending.type, 'choose');
  applyAction(s, 0, { type: 'choose', picks: [top3[0]] });
  eq(s.cards[top3[0]].zone, 'hand');
  eq(s.players[0].deck.slice(-2), top3.slice(1));
});
test('effect: AP cards back to active', () => {
  const s = game({ p0: { hand: [APUP], ap: 3 } });
  toMain(s);
  s.players[0].ap = [false, false, true];
  applyAction(s, 0, { type: 'play', iid: last(s, 0, 'hand') });
  eq(s.players[0].ap, [true, true, false]);
});
test('substitution: "{1000 or less BP} … If <Gon Freecss> is on your field, {3000 or less BP} instead"', () => {
  let s = game({ p0: { hand: [SUB] }, p1: { front: [VANILLA] } });
  toMain(s);
  applyAction(s, 0, { type: 'play', iid: last(s, 0, 'hand') });
  eq(s.players[1].front.length, 1, 'no Gon: 2000 BP is too big');
  s = game({ p0: { hand: [SUB], energy: [GON] }, p1: { front: [VANILLA] } });
  toMain(s);
  applyAction(s, 0, { type: 'play', iid: last(s, 0, 'hand') });
  if (s.pending?.type === 'choose') applyAction(s, 0, { type: 'choose', picks: s.pending.options.slice(0, 1) });
  eq(s.players[1].front.length, 0, 'with Gon: 3000 or less');
});
test('views hide the opponent’s hand and both decks', () => {
  const s = game();
  const v = viewFor(s, 0);
  ok(Array.isArray(v.players[0].hand));
  eq(typeof v.players[1].hand, 'number');
  eq(typeof v.players[1].deck, 'number');
  ok(v.legal?.length > 0);
});
test('an illegal action leaves the state untouched', () => {
  const s = game();
  const norm = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
  const before = norm(s);
  throws(() => applyAction(s, 1, { type: 'next' }));
  toMain(s);
  const mid = norm(s);
  throws(() => applyAction(s, 0, { type: 'play', iid: 'nope', line: 'front' }));
  eq(norm(s), mid);
  ok(before !== mid);
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
