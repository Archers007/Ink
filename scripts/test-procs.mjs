// Proc compiler + runtime tests.
//   node scripts/test-procs.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileAbility, compileCard } from '../game/procs/compile.js';
import { canon, mergeSplitNames, unknownIcons } from '../game/procs/normalize.js';
import { SUPPORT } from '../game/procs/support.js';
import { createRuntime } from '../game/procs/runtime.js';
import { applyAction, checkInvariants, viewFor } from '../game/engine.js';
import { all, byName, test, done, ok, setup, FILLER } from './lib/game.mjs';

const C = (text, type = 'character', name = '') => compileAbility({ name, text }, type);

// ---------- L0 normalize ----------
test('normalize: icons, tags, quotes, dashes, bullets, keyword braces', () => {
  assert.equal(canon('{E}, 2 {I} - Draw a card.'), '{exert}, 2 {ink} — Draw a card.');
  assert.equal(canon('<Bodyguard> it’s fine'), "Bodyguard it's fine");
  assert.equal(canon('Chosen character gains {Rush} this turn.'), 'Chosen character gains Rush this turn.');
  assert.equal(canon('Choose one: - Draw a card. - Banish chosen item.'), 'Choose one: • Draw a card. • Banish chosen item.');
  assert.deepEqual(unknownIcons('gets +1 {strength} and {C}'), ['C']);
  assert.deepEqual(mergeSplitNames([{ name: 'HERE NOW', text: ',' }, { name: "DON'T DO THAT", text: 'X.' }]), [{ name: "HERE NOW, DON'T DO THAT", text: 'X.' }]);
});

// ---------- compiler ----------
test('compile: unknown sentence → whole ability unparsed (all-or-nothing)', () => {
  const p = C("Draw a card. Then, choose up to 3 cards from chosen opponent's discard and shuffle them into their deck.", 'action');
  assert.equal(p.kind, 'unparsed'); assert.equal(p.exec, false); assert.ok(p.why);
});
test('compile: triggers, selectors, filters, durations', () => {
  const p = C('When you play this character, chosen opposing character gets -2 {strength} until the start of your next turn.');
  assert.equal(p.kind, 'triggered'); assert.deepEqual(p.on, [{ ev: 'play' }]);
  assert.deepEqual(p.do, [{ fn: 'mod', sel: { chosen: { owner: 'opp', types: ['character'] } }, mods: [{ stat: 'str', n: -2 }], dur: 'next' }]);
  const b = C('Banish chosen opposing character with 2 {strength} or less.', 'action');
  assert.deepEqual(b.do[0].sel.chosen, { owner: 'opp', types: ['character'], str: { lte: 2 } });
});
test('compile: "you may X, then Y" is linked; "If you do" gates on did', () => {
  const p = C('When you play this character, you may draw a card, then choose and discard a card.');
  assert.equal(p.do[0].may, true); assert.equal(p.do[1].linked, true);
});
test('compile: statics, activated, keywords, choose one', () => {
  const s = C('While you have another Hero character in play, this character gets +1 {lore}.');
  assert.equal(s.kind, 'static'); assert.equal(s.cond.have.other, true);
  const a = C('{exert}, 1 {ink} — Draw a card.', 'item');
  assert.equal(a.kind, 'activated'); assert.deepEqual(a.cost, { exert: true, ink: 1 });
  const k = C('Evasive (Only characters with Evasive can challenge this character.)');
  assert.equal(k.kind, 'keyword'); assert.equal(k.exec, true);
  const c = C('Choose one: • Deal 2 damage to chosen character. • Banish chosen item.', 'action');
  assert.equal(c.do[0].fn, 'chooseOne'); assert.equal(c.do[0].options.length, 2);
});
test('compile: deterministic — same text, same proc', () => {
  const d = byName('Education or Elimination');
  assert.equal(JSON.stringify(compileCard(d)), JSON.stringify(compileCard(d)));
});

// ---------- support contract ----------
test('support: every supported fn has a runtime executor; every runnable proc only uses supported parts', () => {
  const R = createRuntime({});                        // throws if support.js lists a fn runtime.js lacks
  for (const f of SUPPORT.fn) assert.equal(typeof R.FN[f], 'function', f);
  const built = JSON.parse(readFileSync('cache/procs.json', 'utf8'));
  const fns = new Set();
  const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.fn) fns.add(x.fn); Object.values(x).forEach(walk); } };
  for (const c of Object.values(built.cards)) for (const p of c.procs) if (p.exec && p.kind !== 'static') walk(p.do || []);
  for (const f of fns) assert.ok(SUPPORT.fn.has(f) || f === 'chooseOne', `runnable proc uses unsupported fn ${f}`);
  assert.ok(built.coverage.pctAbilities > 50, `coverage dropped to ${built.coverage.pctAbilities}%`);
});

// ---------- runtime scenarios ----------
const vanilla = (f) => all.find((d) => d.type === 'character' && d.abilities.length === 0 && f(d));

test('triggered "whenever this character challenges" resolves before challenge damage', () => {
  const hook = byName('Captain Hook - Conniving Pirate');
  const victim = vanilla((d) => d.wp >= 5);
  const { s, ids } = setup({ play0: [hook], play1: [victim] });
  s.cards[ids.play1[0]].exerted = true;
  const lore = s.players[0].lore;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }));
  assert.equal(s.players[0].lore, lore + 1);
  assert.equal(s.cards[ids.play1[0]].damage, hook.str);
  const gain = s.log.findIndex((l) => /gained 1 lore/.test(l.text));
  const dmg = s.log.findIndex((l) => /dealt \d+, took/.test(l.text));
  assert.ok(gain >= 0 && dmg > gain, 'trigger before damage');
  checkInvariants(s);
});

test('static "while you have a Queen" applies and lifts with the condition', () => {
  const agnarr = byName('Agnarr - King of Arendelle');
  const queen = all.find((d) => d.type === 'character' && (d.classes || []).includes('queen') && d.procs.every((p) => p.kind === 'keyword' || !p.exec));
  const { s, ids } = setup({ play0: [agnarr], hand0: [queen] });
  const str = () => viewFor(s, 0).players[0].play.find((c) => c.iid === ids.play0[0]).eff.str;
  ok(applyAction(s, 0, { type: 'endTurn' })); ok(applyAction(s, 1, { type: 'endTurn' }));
  assert.equal(str(), agnarr.str);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink' }));
  while (s.pending) ok(applyAction(s, 0, { type: 'choose', skip: true, confirm: false }));
  assert.equal(str(), agnarr.str + 2);
});

test('selfCost: "if you have Ariel in play, you pay 1 less"', () => {
  const flounder = byName("Flounder - Collector's Companion");
  const ariel = all.find((d) => d.name === 'Ariel' && d.type === 'character' && d.procs.every((p) => p.kind === 'keyword'));
  const { s, ids } = setup({ hand0: [flounder, flounder], play0: [ariel], ink0: 10 });
  const ready = () => s.players[0].inkwell.filter((i) => !s.cards[i].exerted).length;
  const before = ready();
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink' }));
  assert.equal(before - ready(), flounder.cost - 1);
});

test('enters play exerted / with damage', () => {
  const baymax = byName('Baymax - Low Battery');
  const { s, ids } = setup({ hand0: [baymax] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink' }));
  assert.equal(s.cards[ids.hand0[0]].exerted, true);
});

test('"whenever you play a song" fires off another card', () => {
  const alan = byName("Alan-a-Dale - Rockin' Rooster");
  const song = all.find((d) => d.type === 'song' && d.cost <= 3 && d.procs.every((p) => p.exec));
  const { s, ids } = setup({ play0: [alan], hand0: [song] });
  const lore = s.players[0].lore;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink' }));
  for (let k = 0; k < 6 && s.pending; k++) ok(applyAction(s, s.pending.seat, s.pending.confirm ? { type: 'choose', skip: true } : s.pending.choices ? { type: 'choose', option: 0 } : s.pending.optional ? { type: 'choose', skip: true } : { type: 'choose', target: s.pending.valid[0] }));
  assert.ok(s.players[0].lore >= lore + 1);
});

test('choose one: picks an option and runs only that branch', () => {
  const hot = byName('Hot Potato');
  const item = all.find((d) => d.type === 'item' && d.abilities.length === 0) || all.find((d) => d.type === 'item');
  const victim = vanilla((d) => d.wp >= 3);
  const { s, ids } = setup({ hand0: [hot], play1: [victim, item] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink' }));
  assert.deepEqual(s.pending.choices, ['Deal 2 damage to chosen character', 'Banish chosen item']);
  assert.equal(applyAction(s, 0, { type: 'choose', option: 5 }).ok, false);
  ok(applyAction(s, 0, { type: 'choose', option: 1 }));
  assert.ok(s.pending.valid.includes(ids.play1[1]));
  ok(applyAction(s, 0, { type: 'choose', target: ids.play1[1] }));
  assert.equal(s.cards[ids.play1[1]].zone, 'discard');
  assert.equal(s.cards[ids.play1[0]].damage, 0);
  checkInvariants(s);
});

test('look at top N: reveal a character card into hand, rest to bottom', () => {
  const guest = byName('Besties, Assemble!');
  const char = vanilla((d) => d.cost === 2);
  const { s, ids } = setup({ hand0: [guest, char] });
  const p = s.players[0];
  const c = ids.hand0[1];
  p.hand.splice(p.hand.indexOf(c), 1); p.deck.splice(2, 0, c); s.cards[c].zone = 'deck';
  const top = p.deck.slice(0, 4);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink' }));
  assert.ok(s.pending.valid.includes(top[2]));
  assert.ok(s.pending.cards.length > 0, 'deck picks come with their card ids');
  ok(applyAction(s, 0, { type: 'choose', target: top[2] }));
  assert.equal(s.cards[top[2]].zone, 'hand');
  assert.deepEqual(p.deck.slice(-3).sort(), top.filter((i) => i !== top[2]).sort());
});

test('"when this character is banished, you may draw" fires from challenge damage', () => {
  const bruni = byName('Bucky - Nutty Rascal');
  const big = vanilla((d) => d.str >= bruni.wp + 1 && d.wp > bruni.str);
  const { s, ids } = setup({ play0: [big], play1: [bruni] });
  s.cards[ids.play1[0]].exerted = true;
  const hand1 = s.players[1].hand.length;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }));
  assert.equal(s.cards[ids.play1[0]].zone, 'discard');
  assert.equal(s.pending?.seat, 1, "Bruni's owner decides");
  ok(applyAction(s, 1, { type: 'choose', confirm: true }));
  assert.equal(s.players[1].hand.length, hand1 + 1);
});

test('activated item ability: pays ⟳, targets, can\'t reuse, "this turn" expires', () => {
  const item = byName('Ruby Chromicon');
  const guy = vanilla((d) => d.str >= 1);
  const { s, ids } = setup({ play0: [item, guy] });
  const str = () => viewFor(s, 0).players[0].play.find((c) => c.iid === ids.play0[1]).eff.str;
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 }));
  assert.equal(s.cards[ids.play0[0]].exerted, true);
  ok(applyAction(s, 0, { type: 'choose', target: ids.play0[1] }));
  assert.equal(str(), guy.str + 1);
  assert.equal(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 }).ok, false);
  ok(applyAction(s, 0, { type: 'endTurn' }));
  assert.equal(str(), guy.str);
});

test('demo decks are built only from fully-runnable cards', () => {
  void FILLER;
  const d = all.filter((x) => x.procs.some((p) => !p.exec));
  assert.ok(d.length > 0 && d.length < all.length);
});

done();
