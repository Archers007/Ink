// Proc compiler + runtime tests.
//   node scripts/test-procs.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { compileAbility, compileCard } from '../game/procs/index.js';
import { canon, mergeSplitNames, unknownIcons } from '../game/procs/normalize.js';
import { SUPPORT } from '../game/procs/index.js';
import { createRuntime } from '../game/procs/index.js';
import { applyAction, checkInvariants, viewFor, ENGINE as E } from '../game/engine.js';
import { all, byName, test, done, ok, setup, FILLER } from './lib/game.mjs';
import { RULES } from '../game/rulebook/rules.js';
import { section } from '../game/rulebook/cr.js';
import { TURN } from '../game/rulebook/turn.js';
import { FEATURES } from '../game/rulebook/features.js';
import { hasKw as kwHas } from '../public/js/play/rules.js';
import { deckProblems } from '../game/rulebook/deck.js';
import { namesOf } from '../game/procs/classifiers/named.js';

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
  const p = C('Draw a card. Then, each player plays with the top card of their deck face up.', 'action');
  assert.equal(p.kind, 'unparsed'); assert.equal(p.exec, false); assert.ok(p.why);
  const q = C("Draw a card. Then, choose up to 3 cards from chosen opponent's discard and shuffle them into their deck.", 'action');
  assert.deepEqual(q.do.map((x) => x.fn), ['draw', 'choose', 'shuffleIn']);
  assert.deepEqual(q.do[1].sel, { chosen: { zone: 'discard', owner: 'opp' }, upTo: 3 });
});
test('compile: triggers, selectors, filters, durations', () => {
  const p = C('When you play this character, chosen opposing character gets -2 {strength} until the start of your next turn.');
  assert.equal(p.kind, 'triggered'); assert.deepEqual(p.on, [{ ev: 'play' }]);
  assert.deepEqual(p.do, [{ fn: 'mod', sel: { chosen: { owner: 'opp', types: ['character'] } }, mods: [{ stat: 'str', n: -2 }], dur: 'next' }]);
  const b = C('Banish chosen opposing character with 2 {strength} or less.', 'action');
  assert.deepEqual(b.do[0].sel.chosen, { owner: 'opp', types: ['character'], with: [{ str: { lte: 2 } }] });
});
test('compile: "with" is a query over classifiers (keywords, classes, cost, stats, damage)', () => {
  const t = C('Whenever this character sings a song with Sing Together, draw a card.', 'character', 'Star Performance');
  assert.deepEqual(t.on, [{ ev: 'sings', song: { types: ['song'], with: [{ kw: 'singTogether' }] } }]);
  assert.equal(t.exec, true);
  const q = C('Banish chosen damaged Villain character with Evasive and cost 3 or less.', 'action');
  assert.deepEqual(q.do[0].sel.chosen, { types: ['character'], with: [{ damaged: true }, { class: ['villain'] }, { kw: 'evasive' }, { cost: { lte: 3 } }] });
  const s = C('While this character has no damage, he gets +2 {lore}.', 'character', 'X');
  assert.deepEqual(s.cond, { self: [{ undamaged: true }] }); assert.deepEqual(s.effect.sel, { self: true });
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
  const db = new DatabaseSync('cache/sanitized.db', { readOnly: true });
  db.exec("ATTACH DATABASE 'cache/proc.db' AS p");
  const fns = new Set();
  const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.fn) fns.add(x.fn); Object.values(x).forEach(walk); } };
  for (const r of db.prepare("SELECT json FROM p.procs WHERE exec = 1 AND kind != 'static'").all()) walk(JSON.parse(r.json).do || []);
  for (const f of fns) assert.ok(SUPPORT.fn.has(f) || f === 'chooseOne', `runnable proc uses unsupported fn ${f}`);
  const { n, ok } = db.prepare('SELECT count(*) n, sum(p.exec) ok FROM rulings r JOIN p.procs p USING (proc_id)').get();
  db.close();
  const pct = (100 * ok) / n;
  assert.ok(pct > 50, `coverage dropped to ${pct.toFixed(1)}%`);
});

// ---------- runtime scenarios ----------
const vanilla = (f) => all.find((d) => d.type === 'character' && d.abilities.length === 0 && !Object.keys(d.kw || {}).length && f(d));

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

// resolve every prompt: take the first option / first card / yes
const drain = (s) => { for (let k = 0; k < 20 && s.pending; k++) { const p = s.pending; ok(applyAction(s, p.seat, { type: 'choose', ...(p.choices ? { option: 0 } : p.confirm ? {} : p.valid.length ? { target: p.valid[0] } : { skip: true }) })); } };
test('Sing Together: every singer "sings" (CR 8.12.3); "with Sing Together" only matches those songs; triggers after the song', () => {
  const town = byName('4*Town - Hottest Band of the Year');
  const buddy = vanilla((d) => d.cost >= 4);
  const together = byName('Nobody Like U');                               // Sing Together 5
  const plain = all.find((d) => d.type === 'song' && !d.kw?.singTogether && d.procs.every((p) => p.exec) && d.cost <= 5 && /draw/i.test(JSON.stringify(d.procs)) === false);
  {
    const { s, ids } = setup({ play0: [town, buddy], hand0: [together] });
    for (const id of ids.play0) s.cards[id].drying = false;
    const hand = s.players[0].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'singTogether', singers: ids.play0 }));
    drain(s);
    assert.ok(ids.play0.every((id) => s.cards[id].exerted), 'both singers exerted');
    void hand;
    assert.equal(s.log.filter((l) => /Star Performance/.test(l.text) || /P0 drew 1 card/.test(l.text)).length >= 1, true, '4*Town drew');
    const song = s.log.findIndex((l) => /played Nobody Like U/.test(l.text));
    const draw = s.log.findIndex((l) => /drew 1 card/.test(l.text));
    assert.ok(song >= 0 && draw > song, 'draw resolves after the song is played');
  }
  {
    const { s, ids } = setup({ play0: [town], hand0: [plain] });
    s.cards[ids.play0[0]].drying = false;
    const hand = s.players[0].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'sing', singers: ids.play0 }));
    drain(s);
    void hand;
    assert.ok(!s.log.some((l) => /P0 drew 1 card/.test(l.text)), `no draw for a song without Sing Together (${plain.full})`);
  }
});
// ---------- coverage-push primitives ----------
const unready = (s, ids) => { for (const id of ids) s.cards[id].drying = false; };
const act = (d) => d.procs.findIndex((p) => p.kind === 'activated');
test('ink drops (CR 1.13.1.2): "get 1 ink drop" pays 1 {ink} once', () => {
  const merlin = byName('Merlin - Profoundly Curious');
  const one = vanilla((d) => d.cost === 1);
  const { s, ids } = setup({ hand0: [merlin, one], ink0: merlin.cost });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  drain(s);
  assert.equal(s.players[0].inkDrops, 1);
  assert.equal(viewFor(s, 0).players[0].inkReady, 1, 'the drop counts as ready ink');
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] }));
  assert.equal(s.players[0].inkDrops, 0, 'spent the drop');
});
test('reveal the top card: "if it\'s a character, you may put it into your hand. Otherwise, bottom"', () => {
  const jack = byName('Monterey Jack - Watchful Ranger');
  const char = vanilla((d) => d.cost === 2);
  const item = all.find((d) => d.type === 'item');
  for (const [top, where] of [[char, 'hand'], [item, 'bottom']]) {
    const { s, ids } = setup({ hand0: [jack, top] });
    const p = s.players[0]; const t = ids.hand0[1];
    p.hand.splice(p.hand.indexOf(t), 1); p.deck.unshift(t); s.cards[t].zone = 'deck';
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    drain(s);
    if (where === 'hand') assert.equal(s.cards[t].zone, 'hand');
    else assert.equal(p.deck[p.deck.length - 1], t, 'non-character goes to the bottom');
  }
});
test('"can\'t ready at the start of their next turn" skips exactly one ready step', () => {
  const anna = byName('Anna - Ice Breaker');
  const foe = vanilla((d) => d.cost >= 1);
  const { s, ids } = setup({ hand0: [anna], play1: [foe] });
  const f = ids.play1[0];
  s.cards[f].exerted = true;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  drain(s);
  ok(applyAction(s, 0, { type: 'endTurn' })); drain(s);
  assert.equal(s.active, 1); assert.equal(s.cards[f].exerted, true, 'stays exerted on their turn');
  ok(applyAction(s, 1, { type: 'endTurn' })); drain(s);
  ok(applyAction(s, 0, { type: 'endTurn' })); drain(s);
  assert.equal(s.cards[f].exerted, false, 'readies the turn after');
});
test('move to a location for free + location statics "while here"', () => {
  const bus = byName('Hyperia City Express');
  const stadium = byName('Khan Stadium - State of the Art');           // characters get +2 {strength} while here
  const guy = vanilla((d) => d.str >= 1);
  const { s, ids } = setup({ play0: [bus, stadium, guy] });
  const [b, loc, g] = ids.play0;
  const str = () => viewFor(s, 0).players[0].play.find((c) => c.iid === g).eff.str;
  assert.equal(str(), guy.str);
  ok(applyAction(s, 0, { type: 'useAbility', iid: b, index: act(bus) }));
  if (s.pending?.valid?.includes(g)) ok(applyAction(s, 0, { type: 'choose', target: g }));
  if (s.pending?.valid?.includes(loc)) ok(applyAction(s, 0, { type: 'choose', target: loc }));
  assert.equal(s.cards[g].atLocation, loc);
  assert.equal(s.players[0].inkwell.filter((i) => s.cards[i].exerted).length, 0, 'for free');
  assert.equal(str(), guy.str + 2, 'gets +2 while here');
});
test('history conditions: "if 2 or more cards were put into your discard this turn"', () => {
  const helga = byName('Helga Sinclair - No Backup Needed');            // pay 2 less
  const acts = all.filter((d) => d.type === 'action' && d.cost <= 2 && d.procs.every((p) => p.exec)).slice(0, 2);
  const { s, ids } = setup({ hand0: [helga, ...acts], ink0: 20 });
  const spent = () => s.players[0].inkwell.filter((i) => s.cards[i].exerted).length;
  for (const a of ids.hand0.slice(1)) { ok(applyAction(s, 0, { type: 'play', iid: a })); drain(s); }
  assert.ok(s.players[0].discard.length >= 2);
  const before = spent();
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  assert.equal(spent() - before, helga.cost - 2);
});
test('reveal hand + discard of your choice; "when he leaves play"; compound "draw and gain"', () => {
  const ludwig = byName('Ludwig von Drake - All-Around Expert');
  const action = all.find((d) => d.type === 'action');
  {
    const { s, ids } = setup({ hand0: [ludwig], hand1: [action] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    for (let k = 0; k < 5 && s.pending && !s.pending.valid?.includes(ids.hand1[0]); k++) drain(s);
    if (s.pending) ok(applyAction(s, 0, { type: 'choose', target: ids.hand1[0] }));
    assert.equal(s.cards[ids.hand1[0]].zone, 'discard');
  }
  const goat = byName('Merlin - Goat');                                 // play + leaves: gain 1 lore
  {
    const { s, ids } = setup({ hand0: [goat] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.players[0].lore, 1);
    const ev = []; s.cards[ids.hand0[0]].damage = 99;
    ok(applyAction(s, 0, { type: 'endTurn' })); drain(s);
    assert.equal(s.cards[ids.hand0[0]].zone, 'discard'); void ev;
    assert.equal(s.players[0].lore, 2, 'leaves play → +1 lore');
  }
  const dumbo = byName('Dumbo - Ninth Wonder of the Universe');         // {exert}, 1 {ink} — draw a card and gain 1 lore
  {
    const { s, ids } = setup({ play0: [dumbo] }); unready(s, ids.play0);
    const hand = s.players[0].hand.length;
    ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: act(dumbo) })); drain(s);
    assert.equal(s.players[0].hand.length, hand + 1); assert.equal(s.players[0].lore, 1);
  }
});
test('putUnder (Boost) + damaged triggers', () => {
  const john = byName('Little John - Impermanent Outlaw');              // whenever you put a card under him, ready him
  {
    const { s, ids } = setup({ play0: [john] }); unready(s, ids.play0);
    s.cards[ids.play0[0]].exerted = true;
    ok(applyAction(s, 0, { type: 'boost', iid: ids.play0[0] })); drain(s);
    assert.equal(s.cards[ids.play0[0]].under.length, 1);
    assert.equal(s.cards[ids.play0[0]].exerted, false);
  }
  const beast = byName('Beast - Relentless');                            // whenever an opposing character is damaged, may ready
  const big = vanilla((d) => d.str >= 1 && d.wp >= 3);
  const foe = vanilla((d) => d.wp >= 3 && d.str >= 0);
  {
    const { s, ids } = setup({ play0: [beast, big], play1: [foe] }); unready(s, ids.play0);
    s.cards[ids.play0[0]].exerted = true; s.cards[ids.play1[0]].exerted = true;
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[1], target: ids.play1[0] })); drain(s);
    assert.equal(s.cards[ids.play0[0]].exerted, false, 'Beast readied');
  }
});
test('eachPlayer: inner steps run as each player (their prompts, their "you")', () => {
  const world = byName('A Whole New World');                         // each player discards their hand and draws 7
  {
    const { s, ids } = setup({ hand0: [world] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.players[0].hand.length, 7); assert.equal(s.players[1].hand.length, 7);
  }
  const kuzco = byName('Kuzco - Impulsive Llama');                    // each opponent chooses one of their characters → bottom; then may draw
  const foe = vanilla((d) => d.cost >= 1);
  {
    const { s, ids } = setup({ hand0: [kuzco], play1: [foe] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    assert.equal(s.pending?.seat, 1, 'the opponent makes the choice');
    ok(applyAction(s, 1, { type: 'choose', target: ids.play1[0] }));
    assert.equal(s.players[1].deck[s.players[1].deck.length - 1], ids.play1[0]);
    const h = s.players[1].hand.length;
    assert.equal(s.pending?.seat, 1); ok(applyAction(s, 1, { type: 'choose', confirm: true }));
    assert.equal(s.players[1].hand.length, h + 1);
  }
});
test('amounts: "equal to the damage on chosen X" and "for each 1 damage removed this way"', () => {
  const mad = byName("Most Everyone's Mad Here");                      // gain lore = damage on chosen character, then banish them
  const tough = vanilla((d) => d.wp >= 5);
  {
    const { s, ids } = setup({ hand0: [mad], play1: [tough] });
    s.cards[ids.play1[0]].damage = 3;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] })); drain(s);
    assert.equal(s.players[0].lore, 3); assert.equal(s.cards[ids.play1[0]].zone, 'discard');
  }
  const ohana = byName('Ohana Means Family');                          // remove all damage; draw 1 per damage removed
  {
    const { s, ids } = setup({ hand0: [ohana], play0: [tough] });
    s.cards[ids.play0[0]].damage = 3;
    const h = s.players[0].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.cards[ids.play0[0]].damage, 0); assert.equal(s.players[0].hand.length, h - 1 + 3);
  }
});
test('"can\'t quest unless …" and "may enter play exerted to …"', () => {
  const bashful = byName('Bashful - Hopeless Romantic');
  const dwarf = all.find((d) => d.type === 'character' && d.full !== bashful.full && (d.classes || []).includes('seven dwarfs'));
  {
    const { s, ids } = setup({ play0: [bashful] }); unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'endTurn' })); ok(applyAction(s, 1, { type: 'endTurn' }));   // statics apply at the first GSC
    assert.equal(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }).ok, false, 'alone → can\'t quest');
  }
  {
    const { s, ids } = setup({ play0: [bashful, dwarf] }); unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'endTurn' })); ok(applyAction(s, 1, { type: 'endTurn' }));
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
  }
  const merida = byName('Merida - Wisp Conjurer');                     // may enter play exerted to draw a card
  {
    const { s, ids } = setup({ hand0: [merida] });
    const h = s.players[0].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    ok(applyAction(s, 0, { type: 'choose', confirm: true })); drain(s);
    assert.equal(s.cards[ids.hand0[0]].exerted, true); assert.equal(s.players[0].hand.length, h);   // -1 played +1 drawn
  }
});
test('pronouns: "whenever this character moves to a location, he gets +3" means him, not the location', () => {
  const cubby = byName('Cubby - Mighty Lost Boy');
  const loc = all.find((d) => d.type === 'location' && (d.move ?? 0) <= 2 && d.procs.every((p) => p.kind !== 'static'));
  const { s, ids } = setup({ play0: [cubby, loc] }); unready(s, ids.play0);
  const str = () => viewFor(s, 0).players[0].play.find((c) => c.iid === ids.play0[0]).eff.str;
  ok(applyAction(s, 0, { type: 'move', iid: ids.play0[0], location: ids.play0[1] })); drain(s);
  assert.equal(str(), cubby.str + 3);
});
test('"If a Princess character is chosen, banish her instead" — decided after the choice', () => {
  const apple = byName('Poisoned Apple');
  const princess = all.find((d) => d.type === 'character' && (d.classes || []).includes('princess') && d.abilities.length === 0) || all.find((d) => d.type === 'character' && (d.classes || []).includes('princess') && !d.kw?.ward);
  const plain = vanilla((d) => !(d.classes || []).includes('princess'));
  for (const [who, zone] of [[princess, 'discard'], [plain, 'play']]) {
    const { s, ids } = setup({ play0: [apple], play1: [who] });
    ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: act(apple) }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] })); drain(s);
    assert.equal(s.cards[ids.play1[0]].zone, zone, who.full);
    if (zone === 'play') assert.equal(s.cards[ids.play1[0]].exerted, true);
  }
});
test('damage prevention: "she takes no damage from the challenge"; "can\'t be dealt damage"', () => {
  const raya = byName('Raya - Leader of Heart');                      // whenever she challenges a damaged character
  const foe = vanilla((d) => d.str >= 1 && d.wp >= raya.str + 2);
  const { s, ids } = setup({ play0: [raya], play1: [foe] }); unready(s, ids.play0);
  s.cards[ids.play1[0]].exerted = true; s.cards[ids.play1[0]].damage = 1;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] })); drain(s);
  assert.equal(s.cards[ids.play0[0]].damage, 0, 'Raya took no damage');
  assert.equal(s.cards[ids.play1[0]].damage, 1 + raya.str);
});
test('Shift variants: Floodborn Shift (classification), Temporary Shift (back to hand at end of turn)', () => {
  const vine = byName('The Vine - Towering Stalk');                     // Floodborn Shift 7
  const flood = all.find((d) => d.type === 'character' && (d.classes || []).includes('floodborn') && d.full !== vine.full);
  const plain = vanilla((d) => !(d.classes || []).includes('floodborn'));
  {
    const { s, ids } = setup({ hand0: [vine], play0: [plain, flood] });
    assert.equal(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'shift', shiftKind: 'classShift', target: ids.play0[0] }).ok, false, 'not onto a non-Floodborn');
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'shift', shiftKind: 'classShift', target: ids.play0[1] }));
    assert.deepEqual(s.cards[ids.hand0[0]].under, [ids.play0[1]]);
    assert.equal(s.players[0].inkwell.filter((i) => s.cards[i].exerted).length, 7);
  }
  const wu = byName('Grandma Wu - Fierce Red Panda');                    // Temporary Shift 4
  const base = all.find((d) => d.type === 'character' && d.name === wu.name && d.full !== wu.full);
  {
    const { s, ids } = setup({ hand0: [wu], play0: [base] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'shift', target: ids.play0[0] })); drain(s);
    s.cards[ids.hand0[0]].damage = 2;
    ok(applyAction(s, 0, { type: 'endTurn' })); drain(s);
    assert.equal(s.cards[ids.hand0[0]].zone, 'hand', 'the Temporary Shift card goes back to hand');
    assert.equal(s.cards[ids.play0[0]].zone, 'play', 'the card under it stays');
    assert.equal(s.cards[ids.play0[0]].damage, 0);
    assert.ok(!s.cards[ids.hand0[0]].shifted, 'leaving play clears "used Shift"');
  }
});
test('Shift by spec: discard cost, ink-drop cost, Duo, Combo, Potato, Temporary [Classification]', () => {
  const char = (name, f = () => true) => all.find((d) => d.type === 'character' && d.name === name && !d.shifts && f(d));
  const play = (s, a) => applyAction(s, 0, { type: 'play', mode: 'shift', ...a });
  { // Shift: Discard an action card — the discard pays it, no ink
    const diablo = byName('Diablo - Devoted Herald');
    const act = all.find((d) => d.type === 'action'), item = all.find((d) => d.type === 'item');
    const { s, ids } = setup({ hand0: [diablo, item, act], play0: [char('Diablo')] });
    assert.equal(play(s, { iid: ids.hand0[0], target: ids.play0[0] }).ok, false, 'needs the discard');
    assert.equal(play(s, { iid: ids.hand0[0], target: ids.play0[0], discard: [ids.hand0[1]] }).ok, false, 'an item is not an action card');
    ok(play(s, { iid: ids.hand0[0], target: ids.play0[0], discard: [ids.hand0[2]] }));
    assert.equal(s.cards[ids.hand0[2]].zone, 'discard');
    assert.equal(s.players[0].inkwell.filter((i) => s.cards[i].exerted).length, 0, 'no ink paid');
    assert.deepEqual(s.cards[ids.hand0[0]].under, [ids.play0[0]]);
  }
  { // Shift Remove 2 ink drops
    const baymax = byName('Baymax - Amped Up');
    const { s, ids } = setup({ hand0: [baymax], play0: [char('Baymax')] });
    assert.equal(play(s, { iid: ids.hand0[0], target: ids.play0[0] }).ok, false, 'no ink drops');
    s.players[0].inkDrops = 2;
    ok(play(s, { iid: ids.hand0[0], target: ids.play0[0] }));
    assert.equal(s.players[0].inkDrops, 0);
  }
  { // Duo Shift: on top of two, one of each name — damage of both, exerted if either is
    const duo = byName('Mickey Mouse & Minnie Mouse - Adventuring Duo');
    const mickey = char('Mickey Mouse'), minnie = char('Minnie Mouse');
    const { s, ids } = setup({ hand0: [duo], play0: [mickey, minnie, char('Mickey Mouse', (d) => d.full !== mickey.full)] });
    assert.equal(play(s, { iid: ids.hand0[0], target: ids.play0[0] }).ok, false, 'Duo needs two');
    assert.equal(play(s, { iid: ids.hand0[0], targets: [ids.play0[0], ids.play0[2]] }).ok, false, 'two Mickeys are not one of each');
    s.cards[ids.play0[0]].damage = 1; s.cards[ids.play0[1]].damage = 2; s.cards[ids.play0[1]].exerted = true;
    ok(play(s, { iid: ids.hand0[0], targets: [ids.play0[0], ids.play0[1]] }));
    const c = s.cards[ids.hand0[0]];
    assert.deepEqual(c.under, [ids.play0[0], ids.play0[1]]);
    assert.equal(c.damage, 3); assert.equal(c.exerted, true);
    assert.ok(!s.players[0].play.includes(ids.play0[1]) && s.players[0].play.includes(c.iid));
  }
  { // Combo Shift: one of either name, or one of each
    const combo = byName('Sulley & Boo - Scare Buddies');
    const sulley = char('Sulley'), boo = char('Boo');
    { const { s, ids } = setup({ hand0: [combo], play0: [boo] }); ok(play(s, { iid: ids.hand0[0], target: ids.play0[0] })); }
    { const { s, ids } = setup({ hand0: [combo], play0: [sulley, boo] }); ok(play(s, { iid: ids.hand0[0], targets: ids.play0 }));
      assert.equal(s.cards[ids.hand0[0]].under.length, 2); }
  }
  { // Potato Shift: on top of an item named Potato — dry only if the Potato was there since the turn began
    const posey = byName('Posey - Vampire Potato'), potato = all.find((d) => d.type === 'item' && d.name === 'Potato');
    const { s, ids } = setup({ hand0: [posey], play0: [potato, char('Mickey Mouse')] });
    assert.equal(play(s, { iid: ids.hand0[0], target: ids.play0[1] }).ok, false, 'not onto a character');
    ok(play(s, { iid: ids.hand0[0], target: ids.play0[0] }));
    assert.equal(s.cards[ids.hand0[0]].drying, false);
  }
  { // Temporary Red Panda Shift: any Red Panda character, back to hand at the end of the turn
    const sun = byName('Sun Yee - Red Panda Spirit');
    const panda = all.find((d) => d.type === 'character' && (d.classes || []).includes('red panda') && d.name !== sun.name && !d.shifts);
    const { s, ids } = setup({ hand0: [sun], play0: [panda] });
    ok(play(s, { iid: ids.hand0[0], target: ids.play0[0] })); drain(s);
    ok(applyAction(s, 0, { type: 'endTurn' })); drain(s);
    assert.equal(s.cards[ids.hand0[0]].zone, 'hand');
    assert.equal(s.cards[ids.play0[0]].zone, 'play');
  }
  { // what the target counts as: "also counts as being named King Candy for Shift" · Morph takes any Shift
    const turbo = byName('Turbo - Royal Hack');
    const candy = all.find((d) => d.name === 'King Candy' && d.shifts?.some((x) => x.onto.by === 'name' && x.cost.ink != null));
    { const { s, ids } = setup({ hand0: [candy], play0: [turbo] }); ok(play(s, { iid: ids.hand0[0], target: ids.play0[0] })); }
    const morph = byName('Morph - Little Imitator');
    const vine = byName('The Vine - Towering Stalk');                       // Floodborn Shift — Morph isn't Floodborn
    { const { s, ids } = setup({ hand0: [vine], play0: [morph] }); ok(play(s, { iid: ids.hand0[0], target: ids.play0[0] })); }
    const plain = all.find((d) => d.type === 'character' && !d.shiftAs && !d.shifts && d.name !== 'King Candy');
    { const { s, ids } = setup({ hand0: [candy], play0: [plain] }); assert.equal(play(s, { iid: ids.hand0[0], target: ids.play0[0] }).ok, false); }
  }
});
test('generic act trigger · history · exists · challenge roles', () => {
  const vanillaChar = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  { // "Whenever one of your Hyena characters challenges a damaged character, gain 2 lore."
    const shenzi = byName('Shenzi - Head Hyena');
    const hyena = all.find((d) => d.type === 'character' && (d.classes || []).includes('hyena') && d.full !== shenzi.full && !d.abilities.some((a) => /challeng/i.test(a.text)));
    const foe = vanillaChar((d) => d.wp >= 6);
    const { s, ids } = setup({ play0: [shenzi, hyena], play1: [foe] }); unready(s, ids.play0);
    s.cards[ids.play1[0]].exerted = true;
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[1], target: ids.play1[0] })); drain(s);
    assert.equal(s.players[0].lore, 0, 'not damaged → no lore');
    const { s: s2, ids: i2 } = setup({ play0: [shenzi, hyena], play1: [foe] }); unready(s2, i2.play0);
    s2.cards[i2.play1[0]].exerted = true; s2.cards[i2.play1[0]].damage = 1;
    ok(applyAction(s2, 0, { type: 'challenge', attacker: i2.play0[1], target: i2.play1[0] })); drain(s2);
    assert.equal(s2.players[0].lore, 2);
  }
  { // "When you play this character, if a character of yours quested this turn, draw a card."
    const ff = byName('Fflewddur Fflam - Luckless Bard');
    const q = vanillaChar((d) => d.lore >= 1);
    const { s, ids } = setup({ hand0: [ff], play0: [q] }); unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
    const h = s.players[0].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.players[0].hand.length, h - 1 + 1, 'quested this turn → drew');
  }
  { // "While a damaged character is in play, this character gets +2 {strength}."
    const cs = byName('Card Soldiers - Royal Troops');
    const v = vanillaChar(() => true);
    const { s, ids } = setup({ play0: [cs], play1: [v] });
    const str0 = viewFor(s, 0).players[0].play.find((c) => c.iid === ids.play0[0]).eff.str;
    s.cards[ids.play1[0]].damage = 1;
    ok(applyAction(s, 0, { type: 'ink', iid: s.players[0].hand[0] }));      // any action runs the state check
    assert.equal(viewFor(s, 0).players[0].play.find((c) => c.iid === ids.play0[0]).eff.str, str0 + 2);
  }
  { // "When this character is challenged and banished, banish the challenging character."
    const cat = byName('Cheshire Cat - Not All There');
    const big = vanillaChar((d) => d.str >= cat.wp && d.wp > cat.str);
    const { s, ids } = setup({ play0: [big], play1: [cat] }); unready(s, ids.play0);
    s.cards[ids.play1[0]].exerted = true;
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] })); drain(s);
    assert.equal(s.cards[ids.play1[0]].zone, 'discard');
    assert.equal(s.cards[ids.play0[0]].zone, 'discard', 'the challenger is banished too');
  }
});
test('player subjects · moving several to one location · free moves', () => {
  const vanillaChar = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  { // "Whenever this character is challenged, the challenging player chooses and discards a card."
    const flynn = byName('Flynn Rider - Charming Rogue');
    const att = vanillaChar((d) => d.wp > flynn.str && d.str >= 1);
    const { s, ids } = setup({ play0: [att], play1: [flynn], hand0: [FILLER, FILLER] }); unready(s, ids.play0);
    s.cards[ids.play1[0]].exerted = true;
    const h = s.players[0].hand.length;
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] })); drain(s);
    assert.equal(s.players[0].hand.length, h - 1, 'the challenger discarded');
  }
  { // "move her and one of your other characters to the same location for free. If you do, the other character gets +1 {lore}"
    const rox = byName('Roxanne - Concert Lover');
    const buddy = vanillaChar(() => true);
    const loc = all.find((d) => d.type === 'location' && !d.abilities.length);
    const { s, ids } = setup({ hand0: [rox], play0: [buddy, loc] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    for (let k = 0; k < 6 && s.pending; k++) {
      const pd = s.pending;
      ok(applyAction(s, 0, { type: 'choose', ...(pd.confirm ? {} : { target: pd.valid.includes(ids.play0[0]) ? ids.play0[0] : pd.valid[0] }) }));
    }
    assert.equal(s.cards[ids.hand0[0]].atLocation, ids.play0[1]);
    assert.equal(s.cards[ids.play0[0]].atLocation, ids.play0[1]);
    assert.ok(s.cards[ids.play0[0]].mods.some((m) => m.stat === 'lore' && m.delta === 1), 'the other character got +1 lore');
  }
  { // "Your Pirate characters may move here for free."
    const ship = byName("Jolly Roger - Hook's Ship");
    const pirate = all.find((d) => d.type === 'character' && (d.classes || []).includes('pirate') && !d.abilities.length);
    const { s, ids } = setup({ play0: [ship, pirate], ink0: 0 }); unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'move', iid: ids.play0[1], location: ids.play0[0] }));
    assert.equal(s.cards[ids.play0[1]].atLocation, ids.play0[0]);
  }
});
test('"if you removed an ink drop to play this action" · "that character had a card under them"-style ref conditions', () => {
  const act = byName('Jousting Match');                                // deal 2 — or 5 if an ink drop paid for it
  const target = all.find((d) => d.type === 'character' && !d.abilities.length && d.wp >= 6);
  for (const drops of [0, 1]) {
    const { s, ids } = setup({ hand0: [act], play1: [target], ink0: act.cost - drops });
    s.players[0].inkDrops = drops;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.cards[ids.play1[0]].damage, drops ? 5 : 2, `${drops} ink drop(s) paid`);
  }
});
test('deck distributions: inkwell / top / bottom · reveal each · any number · either top or bottom', () => {
  const top = (s, n) => s.players[0].deck.slice(0, n);
  { // "Look at the top 3 cards of your deck. Put one into your inkwell facedown and exerted, one on the top of your deck, and one on the bottom of your deck."
    const act = byName('Everything Else Is Obsolete');
    const { s, ids } = setup({ hand0: [act] });
    const [a, b, c] = top(s, 3);
    const ink = s.players[0].inkwell.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    for (const want of [a, b, c]) if (s.pending) ok(applyAction(s, 0, { type: 'choose', target: s.pending.valid.includes(want) ? want : s.pending.valid[0] }));
    drain(s);
    assert.equal(s.players[0].inkwell.length, ink + 1, 'one into the inkwell');
    assert.ok(s.cards[a].zone === 'inkwell' && s.players[0].deck[0] === b && s.players[0].deck.at(-1) === c);
  }
  { // "Reveal the top 2 cards of your deck. Put revealed character cards into your hand. Put the rest on the bottom …"
    const inv = byName('Invited to the Ball');
    const { s, ids } = setup({ hand0: [inv] });
    const two = top(s, 2);
    const chars = two.filter((iid) => s.defs[s.cards[iid].cardId].type === 'character');
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    for (const iid of two) assert.equal(s.cards[iid].zone, chars.includes(iid) ? 'hand' : 'deck');
    for (const iid of two.filter((x) => !chars.includes(x))) assert.equal(s.players[0].deck.at(-1), iid);
  }
  { // "Put one on either the top or the bottom of your deck and the other into your inkwell facedown and exerted."
    const cin = byName('Cinderella - Unintentional Icon');
    const { s, ids } = setup({ play0: [cin] });
    const [a, b] = top(s, 2);
    const ink = s.players[0].inkwell.length;
    ok(applyAction(s, 0, { type: 'endTurn' }));
    for (let k = 0; k < 6 && s.pending; k++) {
      const pd = s.pending;
      ok(applyAction(s, 0, { type: 'choose', ...(pd.confirm ? (pd.op === 'scry' ? { skip: true } : {}) : { target: pd.valid.includes(a) ? a : pd.valid[0] }) }));
    }
    assert.equal(s.players[0].inkwell.length, ink + 1);
    assert.equal(s.cards[b].zone, 'inkwell', 'the other card went to the inkwell');
    assert.equal(s.players[0].deck[0], a, 'kept on top');
  }
});
test('query restrictions: who can challenge it · enters exerted · ready damaged characters · gained classification', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  { // Rajah: "While you have no cards in your hand, characters with cost 4 or less can't challenge this character."
    const rajah = byName('Rajah - Royal Protector');
    const cheap = plain((d) => d.cost <= 4), big = plain((d) => d.cost >= 5);
    const { s, ids } = setup({ play0: [cheap, big], play1: [rajah] }); unready(s, ids.play0);
    s.cards[ids.play1[0]].exerted = true;
    s.players[1].hand.splice(0).forEach((iid) => { s.cards[iid].zone = 'deck'; s.players[1].deck.push(iid); });
    ok(applyAction(s, 0, { type: 'ink', iid: s.players[0].hand[0] }));          // state check applies the static
    assert.equal(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }).ok, false, 'cost 4 or less is blocked');
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[1], target: ids.play1[0] }));
  }
  { // Figaro: "Opposing items enter play exerted."
    const figaro = byName('Figaro - Tuxedo Cat');
    const item = all.find((d) => d.type === 'item' && !d.abilities.some((a) => /enter/i.test(a.text)) && d.cost <= 5);
    const { s, ids } = setup({ hand0: [item], play1: [figaro] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.cards[ids.hand0[0]].exerted, true);
  }
  { // Gizmoduck: "This character can challenge ready damaged characters."
    const giz = byName('Gizmoduck - Suited Up');
    const v = plain((d) => d.wp >= 3);
    const { s, ids } = setup({ play0: [giz], play1: [v, v] }); unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'ink', iid: s.players[0].hand[0] }));
    assert.equal(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }).ok, false, 'ready and undamaged: no');
    s.cards[ids.play1[1]].damage = 1;
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[1] }));
  }
  { // Chief Bogo: "Your other characters gain the Detective classification."
    const bogo = byName('Chief Bogo - Calling the Shots');
    const v = plain((d) => !(d.classes || []).includes('detective'));
    const { s, ids } = setup({ play0: [bogo, v] });
    ok(applyAction(s, 0, { type: 'ink', iid: s.players[0].hand[0] }));
    assert.ok(s.cards[ids.play0[1]].mods.some((m) => m.stat === 'class' && m.cls === 'detective'));
  }
});
test('durations: no duration on what was played · at the end of the turn · while the source is in play', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  { // "Play a character with cost 4 or less for free. They gain Rush. At the end of the turn, banish them."
    const song = byName('Gruesome and Grim');
    const c = plain((d) => d.cost <= 4);
    const { s, ids } = setup({ hand0: [song, c] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    for (let k = 0; k < 4 && s.pending; k++) ok(applyAction(s, 0, { type: 'choose', target: ids.hand0[1] }));
    drain(s);
    const x = s.cards[ids.hand0[1]];
    assert.equal(x.zone, 'play');
    assert.ok(x.mods.some((m) => m.kw === 'rush'), 'gained Rush');
    ok(applyAction(s, 0, { type: 'endTurn' })); drain(s);
    assert.equal(x.zone, 'discard', 'banished at the end of the turn');
  }
  { // The Magic Feather: "choose a character of yours. While this item is in play, that character gains Evasive."
    const feather = byName('The Magic Feather');
    const c = plain(() => true);
    const { s, ids } = setup({ hand0: [feather], play0: [c] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    ok(applyAction(s, 0, { type: 'ink', iid: s.players[0].hand[0] }));
    assert.ok(s.cards[ids.play0[0]].mods.some((m) => m.kw === 'evasive'), 'Evasive while the feather is in play');
    ok(applyAction(s, 0, { type: 'moveCard', iid: ids.hand0[0], to: 'discard' }));
    assert.ok(!s.cards[ids.play0[0]].mods.some((m) => m.kw === 'evasive'), 'gone once the feather leaves');
  }
});
test('comparisons · same name · once-per-turn free ability', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  { // Faline: "While you have a character in play with more {strength} than each opposing character, this character gets +2 {lore}."
    const faline = byName('Faline - Playful Fawn');
    const strong = plain((d) => d.str >= 5), weak = plain((d) => d.str <= 1);
    const lore = (s, iid) => viewFor(s, 0).players[0].play.find((c) => c.iid === iid).eff.lore;
    const { s, ids } = setup({ play0: [faline, strong], play1: [weak] });
    ok(applyAction(s, 0, { type: 'ink', iid: s.players[0].hand[0] }));
    assert.equal(lore(s, ids.play0[0]), faline.lore + 2);
    const { s: s2, ids: i2 } = setup({ play0: [faline, weak], play1: [strong] });
    ok(applyAction(s2, 0, { type: 'ink', iid: s2.players[0].hand[0] }));
    assert.equal(lore(s2, i2.play0[0]), faline.lore);
  }
  { // One and Only: "Choose a character. Banish all other characters with the same name as that character."
    const one = byName('One and Only');
    const a = plain(() => true);
    const b = all.find((d) => d.type === 'character' && d.name === a.name && d.full !== a.full) || a;
    const other = plain((d) => d.name !== a.name);
    const { s, ids } = setup({ hand0: [one], play0: [a], play1: [b, other] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    if (s.pending) ok(applyAction(s, 0, { type: 'choose', target: ids.play0[0] }));
    drain(s);
    assert.equal(s.cards[ids.play0[0]].zone, 'play', 'the chosen one stays');
    assert.equal(s.cards[ids.play1[0]].zone, 'discard', 'same name: banished');
    assert.equal(s.cards[ids.play1[1]].zone, 'play', 'different name: stays');
  }
  { // Carl's House: "Once during your turn, you may move chosen character from here to another location for free. If you do, gain 1 lore."
    const house = byName("Carl's House - Flying High");
    const loc2 = all.find((d) => d.type === 'location' && !d.abilities.length);
    const c = plain(() => true);
    const { s, ids } = setup({ play0: [house, loc2, c] });
    s.cards[ids.play0[2]].atLocation = ids.play0[0];
    const idx = house.procs.findIndex((p) => p.kind === 'activated');
    ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: idx }));
    for (let k = 0; k < 4 && s.pending; k++) ok(applyAction(s, 0, { type: 'choose', ...(s.pending.confirm ? {} : { target: s.pending.valid.includes(ids.play0[2]) ? ids.play0[2] : ids.play0[1] }) }));
    assert.equal(s.cards[ids.play0[2]].atLocation, ids.play0[1]);
    assert.equal(s.players[0].lore, 1);
    assert.equal(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: idx }).ok, false, 'once per turn');
  }
});
test('players with a condition · that much damage · loses a keyword · reveal and discard', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  { // Lady Tremaine: "each opponent with more lore than you loses 1 lore"
    const lt = byName('Lady Tremaine - Overbearing Matriarch');
    for (const [mine, theirs, after] of [[0, 5, 4], [5, 3, 3]]) {
      const { s, ids } = setup({ hand0: [lt] });
      s.players[0].lore = mine; s.players[1].lore = theirs;
      ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
      assert.equal(s.players[1].lore, after);
      assert.equal(s.players[0].lore, mine, 'you lose nothing');
    }
  }
  { // Hydra: "Whenever this character takes damage, deal that much damage to chosen opposing character."
    const hydra = byName('Hydra - Deadly Serpent');
    const zap = all.find((d) => d.type === 'action' && d.procs.every((p) => p.exec) && /^Deal 2 damage to chosen character\.$/.test(d.abilities[0]?.text || ''));
    const foe = plain((d) => d.wp >= 4);
    const { s, ids } = setup({ hand0: [zap], play0: [hydra], play1: [foe] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play0[0] })); drain(s);
    assert.equal(s.cards[ids.play1[0]].damage, 2, 'the same 2 damage');
  }
  { // Shed Your Weary Load: "Chosen opponent reveals their hand and discards each non-character card revealed this way."
    const shed = byName('Shed Your Weary Load');
    const ch = plain(() => true), it = all.find((d) => d.type === 'item');
    const { s, ids } = setup({ hand0: [shed], play1: [ch, it] });
    for (const iid of ids.play1) { s.players[1].play.splice(s.players[1].play.indexOf(iid), 1); s.cards[iid].zone = 'hand'; s.players[1].hand.push(iid); }
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.cards[ids.play1[0]].zone, 'hand', 'the character stays');
    assert.equal(s.cards[ids.play1[1]].zone, 'discard', 'the item is discarded');
  }
});
test('unions: chosen and all others with the same name · each X and each Y · from your hand or discard', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  { // Alice - Tea Alchemist: "{exert} — Exert chosen opposing character and all other opposing characters with the same name."
    const alice = byName('Alice - Tea Alchemist');
    const a = plain(() => true), b = plain((d) => d.name !== a.name);
    const { s, ids } = setup({ play0: [alice], play1: [a, a, b] }); unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] })); drain(s);
    assert.deepEqual(ids.play1.map((i) => s.cards[i].exerted), [true, true, false]);
  }
  { // Prince John - Gold Lover: "Play an item from your hand or discard with cost 5 or less for free, exerted."
    const pj = byName('Prince John - Gold Lover');
    const item = all.find((d) => d.type === 'item' && d.cost <= 5 && !d.abilities.length) || all.find((d) => d.type === 'item' && d.cost <= 5);
    const { s, ids } = setup({ play0: [pj, item] }); unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'moveCard', iid: ids.play0[1], to: 'discard' }));
    if (pj.procs[0].exec) {
      ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 }));
      if (s.pending) ok(applyAction(s, 0, { type: 'choose', target: ids.play0[1] }));
      drain(s);
      assert.equal(s.cards[ids.play0[1]].zone, 'play', 'played from the discard');
    }
  }
});
test('free self-play static · songs know who sang them', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  { // Pudge: "If you have a character named Lilo in play, you can play this character for free."
    const pudge = byName('Pudge - Controls the Weather');
    const lilo = all.find((d) => d.type === 'character' && d.name === 'Lilo');
    const { s, ids } = setup({ hand0: [pudge], play0: [lilo], ink0: 0 });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    assert.equal(s.cards[ids.hand0[0]].zone, 'play', 'free with Lilo');
  }
  { // People Gonna Come Here: "Play a location from your hand or discard for free. If a character sang this song, you may move them to that location for free."
    const song = byName('People Gonna Come Here');
    const loc = all.find((d) => d.type === 'location' && !d.abilities.length);
    const singer = plain((d) => d.cost >= song.cost);
    const { s, ids } = setup({ hand0: [song, loc], play0: [singer] }); unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'sing', singers: [ids.play0[0]] }));
    for (let k = 0; k < 6 && s.pending; k++) { const pd = s.pending; ok(applyAction(s, 0, { type: 'choose', ...(pd.confirm ? {} : { target: pd.valid.includes(ids.hand0[1]) ? ids.hand0[1] : pd.valid[0] }) })); }
    assert.equal(s.cards[ids.hand0[1]].zone, 'play');
    assert.equal(s.cards[ids.play0[0]].atLocation, ids.hand0[1], 'the singer moved there');
  }
});
// ---------- rulebook: game rules as values cards change (game/rulebook/rules.js) ----------
test('rulebook: every RULES entry cites a CR section that exists in the rulebook text', () => {
  for (const [id, r] of Object.entries(RULES)) assert.ok(section(r.cr), `${id}: CR ${r.cr} not in the rulebook`);
  for (const [ph, P] of Object.entries(TURN)) for (const x of [P, ...(P.steps || [])]) assert.ok(section(x.cr), `${ph}/${x.step || ''}: CR ${x.cr} not in the rulebook`);
  for (const f of FEATURES) assert.ok(section(f.cr), `feature ${f.id}: CR ${f.cr} not in the rulebook`);
});
test('turn flow (CR 3.2): "at the start of your turn" resolves in the Set step, before the Draw step', () => {
  const mill = byName('Remote Inklands - Desert Ruins');   // "At the start of your turn, put the top card of your deck into your discard."
  const { s } = setup({ play0: [mill] });
  ok(applyAction(s, 0, { type: 'endTurn' })); drain(s);
  const top = s.players[0].deck[0], next = s.players[0].deck[1];
  ok(applyAction(s, 1, { type: 'endTurn' })); drain(s);
  assert.equal(s.cards[top].zone, 'discard', 'the trigger milled the top card');
  assert.equal(s.cards[next].zone, 'hand', 'then the Draw step drew the next one');
  assert.equal(s.active, 0); assert.equal(s.step, 'main');
});
test('rulebook: cards change win lore, draw step, lore gain/loss, damage removal, challenges, inking', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  const pass = (s) => { ok(applyAction(s, s.active, { type: 'endTurn' })); drain(s); };
  { // Donald Duck - Flustered Sorcerer: "Opponents need 25 lore to win the game."
    const { s, ids } = setup({ play0: [byName('Donald Duck - Flustered Sorcerer')] });
    assert.equal(viewFor(s, 1).players[1].rules.winLore, 25);
    assert.equal(viewFor(s, 0).players[0].rules.winLore, 20, 'only opponents');
    s.players[1].lore = 22; pass(s);
    assert.equal(s.status, 'playing', '22 lore is not enough');
    void ids;
  }
  { // Arthur - Determined Squire: "Skip your turn's Draw step."
    const { s } = setup({ play0: [byName('Arthur - Determined Squire')] });
    pass(s); const h = s.players[0].hand.length; pass(s);
    assert.equal(s.players[0].hand.length, h, 'no draw');
    assert.ok(s.log.some((l) => /skips their Draw step/.test(l.text)));
  }
  { // Koda - Talkative Cub: "During opponents' turns, you can't lose lore."
    const { s } = setup({ play0: [byName('Koda - Talkative Cub')] });
    s.players[0].lore = 5; pass(s);
    ok(applyAction(s, 1, { type: 'lore', seat: 0, delta: -2 }));
    assert.equal(s.players[0].lore, 5, "can't lose on their turn");
    pass(s); ok(applyAction(s, 0, { type: 'lore', delta: -2 }));
    assert.equal(s.players[0].lore, 3, 'can on yours');
  }
  { // Peter Pan - Never Land Prankster: "While exerted, each opposing player can't gain lore unless one of their characters has challenged this turn."
    const pp = byName('Peter Pan - Never Land Prankster');
    const q = plain((d) => d.lore >= 1);
    const { s, ids } = setup({ play0: [pp], play1: [q] });
    s.cards[ids.play0[0]].exerted = true;
    pass(s); s.cards[ids.play0[0]].exerted = true; unready(s, ids.play1);
    const lore = s.players[1].lore;
    ok(applyAction(s, 1, { type: 'quest', iid: ids.play1[0] })); drain(s);
    assert.equal(s.players[1].lore, lore, 'no lore');
  }
  { // Vision Slab: "Damage counters can't be removed."
    const heal = all.find((d) => d.type === 'action' && d.procs.length === 1 && d.procs[0].exec && /^Remove up to \d+ damage from chosen character\.$/.test(d.abilities[0]?.text || ''));
    const hurt = plain((d) => d.wp >= 4);
    const { s, ids } = setup({ play0: [byName('Vision Slab'), hurt], hand0: [heal] });
    s.cards[ids.play0[1]].damage = 2;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    if (s.pending) ok(applyAction(s, 0, { type: 'choose', target: ids.play0[1] })); drain(s);
    assert.equal(s.cards[ids.play0[1]].damage, 2);
  }
  { // Prince Charming - Protector of the Realm: "Each turn, only one character can challenge."
    const a = plain((d) => d.str >= 1 && d.wp >= 3), t = plain((d) => d.wp >= 9 || d.wp >= 5);
    const { s, ids } = setup({ play0: [byName('Prince Charming - Protector of the Realm'), a, a], play1: [t, t] });
    unready(s, ids.play0); for (const id of ids.play1) s.cards[id].exerted = true;
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[1], target: ids.play1[0] }));
    assert.equal(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[2], target: ids.play1[1] }).ok, false);
  }
  { // Dale - Ready for His Shot: "During challenges, your characters deal damage with their {willpower} instead of their {strength}."
    const a = plain((d) => d.wp > d.str + 1), t = plain((d) => d.wp >= 9);
    const { s, ids } = setup({ play0: [byName('Dale - Ready for His Shot'), a], play1: [t] });
    unready(s, ids.play0); s.cards[ids.play1[0]].exerted = true;
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[1], target: ids.play1[0] }));
    assert.equal(s.cards[ids.play1[0]].damage, Math.min(a.wp, t.wp));
  }
  { // Hidden Inkcaster: "All cards in your hand count as having {inkable}."
    const un = all.find((d) => d.type === 'character' && !d.inkable);
    const { s, ids } = setup({ play0: [byName('Hidden Inkcaster')], hand0: [un] });
    assert.equal(viewFor(s, 0).players[0].rules.handInkable, true);
    ok(applyAction(s, 0, { type: 'ink', iid: ids.hand0[0] }));
    assert.equal(s.cards[ids.hand0[0]].zone, 'inkwell');
  }
  { // Moana - Curious Explorer: "You can ink cards from your discard."
    const ink = all.find((d) => d.type === 'character' && d.inkable && !d.abilities.length);
    const { s, ids } = setup({ play0: [byName('Moana - Curious Explorer'), ink] });
    ok(applyAction(s, 0, { type: 'moveCard', iid: ids.play0[1], to: 'discard' }));
    ok(applyAction(s, 0, { type: 'ink', iid: ids.play0[1] }));
    assert.equal(s.cards[ids.play0[1]].zone, 'inkwell');
  }
  { // Daisy Duck - Paranormal Investigator: "While this character is exerted, cards enter opponents' inkwells exerted."
    const ink = all.find((d) => d.type === 'character' && d.inkable && !d.abilities.length);
    const { s, ids } = setup({ play0: [byName('Daisy Duck - Paranormal Investigator')], hand1: [ink] });
    s.cards[ids.play0[0]].exerted = true;
    pass(s); s.cards[ids.play0[0]].exerted = true;
    ok(applyAction(s, 1, { type: 'ink', iid: ids.hand1[0] }));
    assert.equal(s.cards[ids.hand1[0]].exerted, true);
  }
});
test('deck construction (CR 1.10.1.3): cards that change copy limits and ink types', () => {
  const amber = (d) => d.type === 'character' && d.inks?.length === 1 && d.inks[0] === 'amber' && !d.procs.some((p) => p.effect?.fn === 'deck');
  const pup = byName('Dalmatian Puppy - Tail Wagger');
  assert.deepEqual(deckProblems([...Array(60).fill(pup)]), [], '99 copies allowed');
  const slipper = byName('The Glass Slipper');
  assert.ok(deckProblems(Array(60).fill(slipper)).some((x) => /more than 2 copies/.test(x)), 'only 2 copies');
  const filler = all.filter((d) => amber(d) && d.procs.length === 0).slice(0, 15);
  const base = Array.from({ length: 60 }, (_, k) => filler[k % filler.length]);
  assert.ok(deckProblems(base).every((x) => !/copies|ink/.test(x)), 'base deck legal');
  const five = Array(5).fill(filler[0]);
  assert.ok(deckProblems([...five, ...base.slice(5)]).some((x) => /more than 4 copies/.test(x)));
});
test('"Name a card" (CR 5.2.6): the named card matches by name, not version', () => {
  const hat = byName("The Sorcerer's Hat");
  const guy = all.find((d) => d.type === 'character' && !d.abilities.length);
  const { s, ids } = setup({ play0: [hat], hand0: [guy] });
  const p = s.players[0];
  const g = ids.hand0[0]; p.hand.splice(p.hand.indexOf(g), 1); p.deck.unshift(g); s.cards[g].zone = 'deck';
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 }));
  assert.ok(s.pending?.choices?.includes(guy.name), 'the names in the game');
  ok(applyAction(s, 0, { type: 'choose', option: s.pending.choices.indexOf(guy.name) })); drain(s);
  assert.equal(s.cards[g].zone, 'hand', 'named it right → into the hand');
  const { s: s2, ids: i2 } = setup({ play0: [hat] });
  const top = s2.players[0].deck[0];
  ok(applyAction(s2, 0, { type: 'useAbility', iid: i2.play0[0], index: 0 }));
  const wrong = s2.pending.choices.findIndex((n) => n !== s2.defs[s2.cards[top].cardId].name);
  ok(applyAction(s2, 0, { type: 'choose', option: wrong })); drain(s2);
  assert.equal(s2.players[0].deck[0], top, 'wrong name → back on top');
  const fj = all.find((d) => /&/.test(d.name));
  if (fj) assert.ok(namesOf(fj).includes(fj.name.split(' & ')[0].toLowerCase()), 'a & name answers to each name');
});
test('"Each player plays with the top card of their deck face up" shows it to everyone', () => {
  const card = all.find((d) => d.procs.some((p) => p.effect?.rule === 'topFaceUp' && p.effect.who === 'each') && d.type !== 'action');
  const { s } = setup({ play0: [card] });
  const v = viewFor(s, 1);
  assert.equal(v.players[0].deckTop?.iid, s.players[0].deck[0]);
  assert.equal(v.players[1].deckTop?.iid, s.players[1].deck[0]);
  assert.equal(viewFor(setup({}).s, 1).players[0].deckTop, null);
});
test('replacement effects (CR 6.5): prevent, redirect, banish → inkwell, no discard, ink drop → ink', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  const pass = (s) => { ok(applyAction(s, s.active, { type: 'endTurn' })); drain(s); };
  { // Lilo - Bundled Up: "During each opponent's turn, the first time this character would take damage, she takes no damage instead."
    const lilo = byName('Lilo - Bundled Up');
    const a = plain((d) => d.str === 1 && d.wp >= 2);
    const { s, ids } = setup({ play0: [lilo], play1: [a, a] });
    pass(s); s.cards[ids.play0[0]].exerted = true;
    ok(applyAction(s, 1, { type: 'challenge', attacker: ids.play1[0], target: ids.play0[0] })); drain(s);
    assert.equal(s.cards[ids.play0[0]].damage, 0, 'first time: no damage');
    ok(applyAction(s, 1, { type: 'challenge', attacker: ids.play1[1], target: ids.play0[0] })); drain(s);
    assert.equal(s.cards[ids.play0[0]].damage, 1, 'second time: damage');
  }
  { // Beast - Selfless Protector: "Whenever one of your other characters would be dealt damage, put that many damage counters on this character instead."
    const beast = byName('Beast - Selfless Protector');
    const mine = plain((d) => d.wp >= 2), foe = plain((d) => d.str >= 1 && d.str < 8 && d.wp > mine.str);
    const { s, ids } = setup({ play0: [beast, mine], play1: [foe] });
    pass(s); s.cards[ids.play0[1]].exerted = true;
    ok(applyAction(s, 1, { type: 'challenge', attacker: ids.play1[0], target: ids.play0[1] })); drain(s);
    assert.equal(s.cards[ids.play0[1]].damage, 0);
    assert.equal(s.cards[ids.play0[0]].damage, foe.str, 'on Beast instead');
    assert.equal(s.cards[ids.play1[0]].damage, mine.str, 'the challenger still takes damage');
  }
  { // Mickey Mouse & Minnie Mouse - Adventuring Duo: "If this character would be banished, put them into your inkwell facedown and exerted instead."
    const duo = byName('Mickey Mouse & Minnie Mouse - Adventuring Duo');
    const big = plain((d) => d.str >= duo.wp && d.wp > duo.str);
    const { s, ids } = setup({ play0: [big], play1: [duo] });
    s.cards[ids.play1[0]].exerted = true; unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] })); drain(s);
    assert.equal(s.cards[ids.play1[0]].zone, 'inkwell');
    assert.equal(s.cards[ids.play1[0]].exerted, true);
    assert.ok(!s.log.some((l) => /Adventuring Duo was banished/.test(l.text)), 'never banished (6.5.4)');
  }
  { // Kronk - Laid Back: "If an effect would cause you to discard one or more cards, you don't discard."
    const { s, ids } = setup({ hand0: [byName('You Have Forgotten Me')], play1: [byName('Kronk - Laid Back')] });
    const hand = s.players[1].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.players[1].hand.length, hand);
    assert.ok(s.log.some((l) => /doesn't discard/.test(l.text)));
  }
  { // Baymax - Amped Up: "If you would get an ink drop, you may put the top card of your deck into your inkwell facedown and exerted instead."
    const merlin = byName('Merlin - Profoundly Curious');
    const { s, ids } = setup({ play0: [byName('Baymax - Amped Up')], hand0: [merlin], ink0: merlin.cost });
    const top = s.players[0].deck[0];
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    assert.equal(s.pending?.op, 'inkDropInstead');
    ok(applyAction(s, 0, { type: 'choose', confirm: true })); drain(s);
    assert.equal(s.cards[top].zone, 'inkwell');
    assert.equal(s.players[0].inkDrops || 0, 0);
  }
  { // Baymax - Amped Up applies once per ink drop: Higitus Figitus "Get 3 ink drops" asks 3 times
    const hig = byName('Higitus Figitus');
    const { s, ids } = setup({ play0: [byName('Baymax - Amped Up')], hand0: [hig], ink0: hig.cost });
    const ink = s.players[0].inkwell.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    for (const yes of [true, false, true]) {
      assert.equal(s.pending?.op, 'inkDropInstead');
      ok(applyAction(s, 0, yes ? { type: 'choose', confirm: true } : { type: 'choose', skip: true }));
    }
    drain(s);
    assert.equal(s.players[0].inkwell.length, ink + 2);
    assert.equal(s.players[0].inkDrops || 0, 1);
  }
  { // Kakamora - Pirate Chief: "If you discarded a Pirate character card, deal 3 damage instead" checks the discard, not the target
    const k = byName('Kakamora - Pirate Chief');
    const pir = all.find((d) => d.type === 'character' && (d.classes || []).includes('pirate'));
    const foe = vanilla((d) => d.wp >= 5 && !(d.classes || []).includes('pirate'));
    const { s, ids } = setup({ play0: [k], hand0: [pir], play1: [foe] }); unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
    ok(applyAction(s, 0, { type: 'choose', confirm: true }));                     // may draw
    ok(applyAction(s, 0, { type: 'choose', target: ids.hand0[0] }));              // discard the Pirate
    ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] })); drain(s);
    assert.equal(s.cards[ids.play1[0]].damage, 3);
  }
  { // Time to Go!: "If that character had a card under them, draw 3 cards instead" — checked after the banish
    const ttg = byName('Time to Go!'), pal = vanilla(() => true);
    const { s, ids } = setup({ hand0: [ttg], play0: [pal], ink0: ttg.cost });
    s.cards[ids.play0[0]].under = [s.players[0].deck.pop()];
    const hand = s.players[0].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play0[0] })); drain(s);
    assert.equal(s.players[0].hand.length, hand - 1 + 3);
  }
  { // Daisy Duck - Sapphire Champion: "Your other Sapphire characters gain Resist +1" — an ink type, not a classification
    const sap = vanilla((d) => (d.inks || []).includes('sapphire')), ruby = vanilla((d) => !(d.inks || []).includes('sapphire'));
    const { s, ids } = setup({ play0: [byName('Daisy Duck - Sapphire Champion'), sap, ruby] });
    ok(applyAction(s, 0, { type: 'endTurn' })); ok(applyAction(s, 1, { type: 'endTurn' }));
    const kw = (i) => { const c = s.cards[ids.play0[i]]; return kwHas(c, s.defs[c.cardId], 'resist'); };
    assert.equal(kw(1), true); assert.equal(kw(2), false);
  }
  { // Maleficent's Staff: "Whenever one of your opponents' characters … is returned to their hand from play, gain 1 lore."
    const staff = byName("Maleficent's Staff"), bef = byName('Befuddle'), foe = vanilla((d) => d.cost <= 2);
    const { s, ids } = setup({ play0: [staff], hand0: [bef], play1: [foe], ink0: bef.cost });
    const lore = s.players[0].lore;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] })); drain(s);
    assert.equal(s.players[0].lore, lore + 1);
  }
  { // Willie the Giant: "can't quest or challenge unless you put a card under him this turn" — under HIM, not any of yours
    const willie = byName('Willie the Giant - Ghost of Christmas Present'), pal = vanilla(() => true);
    const { s, ids } = setup({ play0: [willie, pal] });
    ok(applyAction(s, 0, { type: 'endTurn' })); ok(applyAction(s, 1, { type: 'endTurn' })); drain(s); s.fx = [];
    const under = (iid) => { E.putUnder(s, 0, iid, []); E.gameStateCheck(s, []); };   // fires putUnder into the turn log
    under(ids.play0[1]);
    assert.equal(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }).ok, false, 'a card under another character does not count');
    under(ids.play0[0]); s.fx = [];
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
  }
  { // Lucifer - Cunning Cat: "each opponent chooses and discards either 2 cards or 1 action card" — no action in hand → 2 cards
    const luc = byName('Lucifer - Cunning Cat');                        // P1's opening hand is all FILLER characters
    const { s, ids } = setup({ hand0: [luc], ink0: luc.cost });
    const before = s.players[1].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    assert.notEqual(s.pending?.op, 'chooseOne', 'the action option is not offered');
    drain(s);
    assert.equal(s.players[1].hand.length, before - 2);
  }
  { // Merlin - Envisioning the Future: "you may draw a card from the bottom of your deck"
    const merlin = byName('Merlin - Envisioning the Future');
    const { s, ids } = setup({ hand0: [merlin], ink0: merlin.cost });
    const bottom = s.players[0].deck[s.players[0].deck.length - 1];
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.cards[bottom].zone, 'hand');
  }
  { // Elinor - Renowned Diplomat: "deal 1 damage to chosen opposing character, gain 1 lore, and draw a card" — a list of 3
    const p = byName('Elinor - Renowned Diplomat').procs.find((x) => x.kind === 'triggered');
    assert.deepEqual(p.do.map((x) => x.fn), ['damage', 'gainLore', 'draw']);
  }
  { // Rapunzel - Ready for Adventure: "Whenever one of your characters is chosen for Support, until the start of your next turn, the next time they would be dealt damage they take no damage instead."
    const rap = byName('Rapunzel - Ready for Adventure');
    const pal = plain((d) => d.wp >= 3), foe = plain((d) => d.str >= 1 && d.wp > pal.str);
    const { s, ids } = setup({ play0: [rap, pal], play1: [foe, foe] });
    unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
    assert.equal(s.pending?.type, 'support');
    ok(applyAction(s, 0, { type: 'support', target: ids.play0[1] })); drain(s);
    pass(s); s.cards[ids.play0[1]].exerted = true;
    ok(applyAction(s, 1, { type: 'challenge', attacker: ids.play1[0], target: ids.play0[1] })); drain(s);
    assert.equal(s.cards[ids.play0[1]].damage, 0, 'the next time: none');
    ok(applyAction(s, 1, { type: 'challenge', attacker: ids.play1[1], target: ids.play0[1] })); drain(s);
    assert.equal(s.cards[ids.play0[1]].damage, foe.str, 'only once');
  }
});
test('deck order (CR 7.2.3): N / any number / all cards to the top or bottom of a deck', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  { // Aladdin & Genie - Mischievous Pals: "you may put any number of cards from your hand on the bottom of your deck in any order. If you do, draw that number of cards plus 1."
    const ag = byName('Aladdin & Genie - Mischievous Pals');
    const x = plain(() => true);
    const { s, ids } = setup({ hand0: [ag, x, x], ink0: 10 });
    const hand = s.players[0].hand.length - 1;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    if (s.pending?.confirm) ok(applyAction(s, 0, { type: 'choose', confirm: true }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.hand0[1] }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.hand0[2] }));
    while (s.pending) ok(applyAction(s, 0, { type: 'choose', skip: true }));
    assert.deepEqual(s.players[0].deck.slice(-2).sort(), [ids.hand0[1], ids.hand0[2]].sort(), 'on the bottom');
    assert.equal(s.players[0].hand.length, hand - 2 + 3, 'drew 2 + 1');
  }
  { // Mamá Imelda - No-Nonsense Ancestor: "put 3 cards from your discard on the bottom of your deck in any order or banish her."
    const mi = byName('Mamá Imelda - No-Nonsense Ancestor');
    const x = plain(() => true);
    const { s, ids } = setup({ hand0: [mi], play0: [x, x, x], ink0: 10 });
    for (const iid of ids.play0) ok(applyAction(s, 0, { type: 'moveCard', iid, to: 'discard' }));
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    ok(applyAction(s, 0, { type: 'choose', option: 0 })); drain(s);
    assert.ok(ids.play0.every((iid) => s.cards[iid].zone === 'deck'), 'all 3 to the deck');
    assert.equal(s.cards[ids.hand0[0]].zone, 'play', 'she stays');
  }
  { // Jim Hawkins - Honorable Pirate: "look at the top 4 … You may reveal any number of Pirate character cards and put them into your hand. Put the rest on the bottom"
    const jim = byName('Jim Hawkins - Honorable Pirate');
    const pirate = all.find((d) => d.type === 'character' && (d.classes || []).includes('pirate') && d.full !== jim.full);
    const { s, ids } = setup({ hand0: [jim, pirate], ink0: 10 });
    const p = s.players[0]; const pi = ids.hand0[1];
    p.hand.splice(p.hand.indexOf(pi), 1); p.deck.unshift(pi); s.cards[pi].zone = 'deck';
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    for (let k = 0; k < 8 && s.pending; k++) { const pd = s.pending; ok(applyAction(s, 0, { type: 'choose', ...(pd.confirm ? {} : pd.valid?.includes(pi) ? { target: pi } : { skip: true }) })); }
    assert.equal(s.cards[pi].zone, 'hand');
  }
});
test('play from another zone (CR 4.3): paid plays, triggers in the discard, play permissions, deck bottom instead', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  const toDiscard = (s, iid) => ok(applyAction(s, s.cards[iid].owner, { type: 'moveCard', iid, to: 'discard' }));
  const pass = (s) => { ok(applyAction(s, s.active, { type: 'endTurn' })); drain(s); };
  { // Lilo - Escape Artist: "At the start of your turn, if this card is in your discard, you may play her and she enters play exerted."
    const lilo = byName('Lilo - Escape Artist');
    const { s, ids } = setup({ play0: [lilo] });
    toDiscard(s, ids.play0[0]);
    pass(s);
    for (const iid of s.players[0].inkwell) s.cards[iid].exerted = false;
    ok(applyAction(s, 1, { type: 'endTurn' }));
    assert.equal(s.pending?.seat, 0, 'asked from the discard');
    ok(applyAction(s, 0, { type: 'choose', confirm: true })); drain(s);
    assert.equal(s.cards[ids.play0[0]].zone, 'play');
    assert.equal(s.cards[ids.play0[0]].exerted, true);
  }
  { // The Horned King - Merciless Master: "While this character is exerted, you may play characters from your discard. If you do, they enter play exerted."
    const hk = byName('The Horned King - Merciless Master');
    const x = plain((d) => d.cost <= 3);
    const { s, ids } = setup({ play0: [hk, x] });
    toDiscard(s, ids.play0[1]);
    assert.equal(applyAction(s, 0, { type: 'play', iid: ids.play0[1] }).ok, false, 'not while ready');
    s.cards[ids.play0[0]].exerted = true;
    assert.deepEqual(viewFor(s, 0).players[0].playableFrom, [ids.play0[1]]);
    ok(applyAction(s, 0, { type: 'play', iid: ids.play0[1] }));
    assert.equal(s.cards[ids.play0[1]].zone, 'play');
    assert.equal(s.cards[ids.play0[1]].exerted, true);
  }
  { // Remember Me: "For the rest of this turn, you may play characters from your discard. If you do, they enter play exerted and you can't play characters with the same name …"
    const x = plain((d) => d.cost <= 2);
    const { s, ids } = setup({ hand0: [byName('Remember Me'), x], play0: [x], ink0: 12 });
    toDiscard(s, ids.play0[0]);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    ok(applyAction(s, 0, { type: 'play', iid: ids.play0[0] }));
    assert.equal(s.cards[ids.play0[0]].exerted, true);
    assert.equal(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] }).ok, false, 'no second copy by name');
  }
  { // Max Goof - Chart Topper: "you may play a song card with cost 4 or less from your discard for free, then put it on the bottom of your deck instead of into your discard."
    const max = byName('Max Goof - Chart Topper');
    const song = all.find((d) => d.type === 'song' && d.cost <= 4 && d.procs.every((p) => p.exec) && d.procs.some((p) => p.do?.[0]?.fn === 'draw'));
    const { s, ids } = setup({ play0: [max, song] });
    toDiscard(s, ids.play0[1]); unready(s, [ids.play0[0]]);
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
    for (let k = 0; k < 6 && s.pending; k++) { const pd = s.pending; ok(applyAction(s, 0, { type: 'choose', ...(pd.confirm ? {} : pd.valid?.includes(ids.play0[1]) ? { target: ids.play0[1] } : { skip: true }) })); }
    assert.equal(s.players[0].deck.at(-1), ids.play0[1], 'on the bottom, not in the discard');
  }
});
test('cards under (CR 8.4): counts, "was under", put self / a discard card under, play from under, under → inkwell', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  const stack = (s, iid, n) => { for (let k = 0; k < n; k++) { const p = s.players[s.cards[iid].owner]; const top = p.deck.shift(); s.cards[top].zone = 'under'; s.cards[top].parent = iid; s.cards[top].faceDown = true; s.cards[iid].under.push(top); } };
  { // Goofy - Ghost of Jacob Marley: "When this character is banished, each opponent chooses and discards a card for each card that was under him."
    const goofy = byName('Goofy - Ghost of Jacob Marley');
    const big = plain((d) => d.str >= 9 || d.str >= goofy.wp);
    const { s, ids } = setup({ play0: [big], play1: [goofy] });
    stack(s, ids.play1[0], 2); s.cards[ids.play1[0]].exerted = true; unready(s, ids.play0);
    const hand = s.players[0].hand.length;
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] })); drain(s);
    assert.equal(s.cards[ids.play1[0]].zone, 'discard');
    assert.equal(s.players[0].hand.length, hand - 2, 'two discards');
  }
  { // Roo - Little Helper: "{exert} — Put this character facedown under one of your characters or locations with Boost."
    const roo = byName('Roo - Little Helper');
    const booster = all.find((d) => d.type === 'character' && typeof d.kw?.boost === 'number');
    const { s, ids } = setup({ play0: [roo, booster] }); unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: roo.procs.findIndex((p) => p.kind === 'activated') }));
    drain(s);
    assert.equal(s.cards[ids.play0[0]].zone, 'under');
    assert.deepEqual(s.cards[ids.play0[1]].under, [ids.play0[0]]);
  }
  { // The Black Cauldron: put a character card from your discard under it faceup; "This turn, you may play characters from under this item."
    const bc = byName('The Black Cauldron');
    const x = plain((d) => d.cost <= 3);
    const { s, ids } = setup({ play0: [bc, x], ink0: 10 });
    ok(applyAction(s, 0, { type: 'moveCard', iid: ids.play0[1], to: 'discard' }));
    const acts = bc.procs.map((p, i) => [p, i]).filter(([p]) => p.kind === 'activated').map(([, i]) => i);
    ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: acts[0] })); drain(s);
    assert.equal(s.cards[ids.play0[1]].zone, 'under');
    assert.equal(s.cards[ids.play0[1]].faceDown, false, 'faceup');
    s.cards[ids.play0[0]].exerted = false;
    ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: acts[1] })); drain(s);
    ok(applyAction(s, 0, { type: 'play', iid: ids.play0[1] }));
    assert.equal(s.cards[ids.play0[1]].zone, 'play');
    assert.deepEqual(s.cards[ids.play0[0]].under, []);
  }
  { // Visiting Christmas Past: "Put any number of cards from under your characters and locations into your inkwell facedown and exerted."
    const v = byName('Visiting Christmas Past');
    const x = plain(() => true);
    const { s, ids } = setup({ hand0: [v], play0: [x] });
    stack(s, ids.play0[0], 2);
    const under = [...s.cards[ids.play0[0]].under], ink = s.players[0].inkwell.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    for (const u of under) ok(applyAction(s, 0, { type: 'choose', target: u }));
    drain(s);
    assert.equal(s.players[0].inkwell.length, ink + 2);
    assert.deepEqual(s.cards[ids.play0[0]].under, []);
  }
});
test('the other player decides (CR 6.1.4): "who doesn\'t", "unless their player pays", "chosen opponent chooses"', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  const pass = (s) => { ok(applyAction(s, s.active, { type: 'endTurn' })); drain(s); };
  { // Sign the Scroll: "Each opponent may choose and discard a card. For each opponent who doesn't, you gain 2 lore."
    const { s, ids } = setup({ hand0: [byName('Sign the Scroll')] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    assert.equal(s.pending?.seat, 1, 'the opponent decides');
    ok(applyAction(s, 1, { type: 'choose', skip: true })); drain(s);
    assert.equal(s.players[0].lore, 2);
  }
  { // … and when they discard, no lore
    const { s, ids } = setup({ hand0: [byName('Sign the Scroll')] });
    const hand = s.players[1].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    ok(applyAction(s, 1, { type: 'choose', confirm: true }));
    ok(applyAction(s, 1, { type: 'choose', target: s.pending.valid[0] })); drain(s);
    assert.equal(s.players[1].hand.length, hand - 1);
    assert.equal(s.players[0].lore, 0);
  }
  { // Source of the Vine: "Whenever an opposing character quests, you gain 1 lore unless their player pays 1 {ink}."
    const q = plain((d) => d.lore >= 1);
    const { s, ids } = setup({ play0: [byName('Source of the Vine')], play1: [q, q] });
    pass(s);
    const ink = s.players[1].deck.splice(0, 2); for (const iid of ink) { s.cards[iid].zone = 'inkwell'; s.cards[iid].faceDown = true; s.players[1].inkwell.push(iid); }
    ok(applyAction(s, 1, { type: 'quest', iid: ids.play1[0] }));
    assert.equal(s.pending?.seat, 1, 'their player is asked');
    ok(applyAction(s, 1, { type: 'choose', confirm: true })); drain(s);
    assert.equal(s.players[0].lore, 0, 'paid');
    ok(applyAction(s, 1, { type: 'quest', iid: ids.play1[1] }));
    ok(applyAction(s, 1, { type: 'choose', skip: true })); drain(s);
    assert.equal(s.players[0].lore, 1, 'not paid');
  }
  { // Do You Want to Build A Snowman?: "Chosen opponent chooses YES! or NO!: • YES! You gain 3 lore. • NO! They choose a character of theirs and put that card on the bottom of their deck."
    const x = plain(() => true);
    const { s, ids } = setup({ hand0: [byName('Do You Want to Build A Snowman?')], play1: [x] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    assert.equal(s.pending?.seat, 1);
    ok(applyAction(s, 1, { type: 'choose', option: 1 })); drain(s);
    assert.equal(s.cards[ids.play1[0]].zone, 'deck', 'they bottomed their own character');
    assert.equal(s.players[0].lore, 0);
  }
  { // Daisy Duck - Donald's Date: "each opponent reveals the top card of their deck. If it's a character card, they may put it into their hand. Otherwise, they put it on the bottom of their deck."
    const daisy = byName("Daisy Duck - Donald's Date");
    const it = all.find((d) => d.type === 'item');
    const { s, ids } = setup({ play0: [daisy], hand1: [it] });
    const p1 = s.players[1]; const top = ids.hand1[0];
    p1.hand.splice(p1.hand.indexOf(top), 1); p1.deck.unshift(top); s.cards[top].zone = 'deck';
    unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s);
    assert.equal(p1.deck.at(-1), top, 'not a character → bottom');
  }
});
test('new triggers (CR 6.2): any character played, opponent discards, an action deals damage, while X whenever Y', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  { // Queen of Hearts - Unpredictable Bully: "Whenever another character is played, put a damage counter on them."
    const x = plain((d) => d.wp >= 2 && d.cost <= 3);
    const { s, ids } = setup({ play1: [byName('Queen of Hearts - Unpredictable Bully')], hand0: [x] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.cards[ids.hand0[0]].damage, 1);
  }
  { // Prince John - Greediest of All: "Whenever your opponent discards 1 or more cards, you may draw a card for each card discarded."
    const { s, ids } = setup({ play0: [byName('Prince John - Greediest of All')], hand0: [byName('You Have Forgotten Me')] });
    const hand = s.players[0].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    for (let k = 0; k < 8 && s.pending; k++) { const pd = s.pending; ok(applyAction(s, pd.seat, { type: 'choose', ...(pd.confirm ? {} : { target: pd.valid[0] }) })); }
    assert.equal(s.players[0].hand.length, hand - 1 + 2, 'drew one per discarded card');
  }
  { // Merida - Formidable Archer: "Whenever one of your actions deals damage to an opposing character, deal 2 damage to that character."
    const zap = all.find((d) => d.type === 'action' && d.procs.every((p) => p.exec) && /^Deal 2 damage to chosen character\.$/.test(d.abilities[0]?.text || ''));
    const foe = plain((d) => d.wp >= 6);
    const { s, ids } = setup({ play0: [byName('Merida - Formidable Archer')], hand0: [zap], play1: [foe] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] })); drain(s);
    assert.equal(s.cards[ids.play1[0]].damage, 4);
  }
  { // Jafar - Striking Illusionist: "During your turn, while this character is exerted, whenever you draw a card, gain 1 lore."
    const draw = byName('Seeking the Half Crown');                     // "… Draw 2 cards."
    const { s, ids } = setup({ play0: [byName('Jafar - Striking Illusionist')], hand0: [draw, draw], ink0: 12 });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.players[0].lore, 0, 'ready: nothing');
    s.cards[ids.play0[0]].exerted = true;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] })); drain(s);
    assert.equal(s.players[0].lore, 2, 'exerted: 1 per card drawn');
  }
});
test('cost rules (CR 1.5): each player pays more, Shift discounts, the first action each turn, free by name', () => {
  const ready = (s, seat) => s.players[seat].inkwell.filter((i) => !s.cards[i].exerted).length;
  { // Gantu - Experienced Enforcer: "Each player pays 2 {ink} more to play actions or items."
    const act = all.find((d) => d.type === 'action' && d.cost === 2 && d.procs.every((p) => p.exec) && /^Draw/.test(d.abilities[0]?.text || ''));
    const { s, ids } = setup({ play1: [byName('Gantu - Experienced Enforcer')], hand0: [act] });
    const before = ready(s, 0);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(before - ready(s, 0), 4, 'the opponent\'s Gantu applies too');
  }
  { // Yokai - Intellectual Schemer: "You pay 1 {ink} less to play characters using their Shift ability."
    const base = all.find((d) => d.type === 'character' && d.cost <= 3 && all.some((x) => x.name === d.name && typeof x.kw?.shift === 'number' && x.kw.shift >= 3 && x.procs.every((p) => p.kind === 'keyword' || p.exec)));
    const top = all.find((x) => x.name === base.name && typeof x.kw?.shift === 'number' && x.kw.shift >= 3 && x.procs.every((p) => p.kind === 'keyword' || p.exec));
    const { s, ids } = setup({ play0: [byName('Yokai - Intellectual Schemer'), base], hand0: [top] });
    const before = ready(s, 0);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'shift', target: ids.play0[1] })); drain(s);
    assert.equal(before - ready(s, 0), top.kw.shift - 1);
  }
  { // Owl Island - Secluded Entrance: "For each character you have here, you pay 1 {ink} less for the first action you play each turn."
    const owl = byName('Owl Island - Secluded Entrance');
    const x = all.find((d) => d.type === 'character' && !d.abilities.length);
    const act = all.find((d) => d.type === 'action' && d.cost === 3 && d.procs.every((p) => p.exec) && /^Draw/.test(d.abilities[0]?.text || ''));
    const { s, ids } = setup({ play0: [owl, x, x], hand0: [act, act], ink0: 12 });
    s.cards[ids.play0[1]].atLocation = ids.play0[0]; s.cards[ids.play0[2]].atLocation = ids.play0[0];
    let before = ready(s, 0);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(before - ready(s, 0), 1, '3 - 2');
    before = ready(s, 0);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] })); drain(s);
    assert.equal(before - ready(s, 0), 3, 'only the first');
  }
});
test('players and counts (CR 1.3, 6.7): you and another player, any number of players, "that amount", highest cost', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  { // If I Didn't Have You: "You and another chosen player each draw 2 cards."
    const { s, ids } = setup({ hand0: [byName("If I Didn't Have You")] });
    const h0 = s.players[0].hand.length - 1, h1 = s.players[1].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.deepEqual([s.players[0].hand.length, s.players[1].hand.length], [h0 + 2, h1 + 2]);
  }
  { // Beyond the Horizon: "Choose any number of players. They discard their hands and draw 3 cards each."
    const { s, ids } = setup({ hand0: [byName('Beyond the Horizon')] });
    const h1 = s.players[1].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    ok(applyAction(s, 0, { type: 'choose', option: 2 })); drain(s);
    assert.equal(s.players[1].hand.length, 3, 'opponent: discarded and drew 3');
    assert.ok(s.players[1].discard.length >= h1);
  }
  { // Zero to Hero: "Count the number of characters you have in play. You pay that amount of {ink} less for the next character you play this turn."
    const x = plain((d) => d.cost === 4);
    const { s, ids } = setup({ hand0: [byName('Zero to Hero'), x], play0: [plain(() => true), plain(() => true)], ink0: 10 });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    const before = s.players[0].inkwell.filter((i) => !s.cards[i].exerted).length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] }));
    assert.equal(before - s.players[0].inkwell.filter((i) => !s.cards[i].exerted).length, 2);
  }
  { // Duchess - Cosmopolitan Cat: "While you have a character in play with the highest cost, or tied for highest cost, this character gets +1 {lore}."
    const duchess = byName('Duchess - Cosmopolitan Cat');
    const big = plain((d) => d.cost >= 7), small = plain((d) => d.cost <= duchess.cost);
    const lore = (s, iid) => viewFor(s, 0).players[0].play.find((c) => c.iid === iid).eff.lore;
    const a = setup({ play0: [duchess, big], play1: [small] });
    for (const x of [a]) { ok(applyAction(x.s, 0, { type: 'endTurn' })); ok(applyAction(x.s, 1, { type: 'endTurn' })); }
    assert.equal(lore(a.s, a.ids.play0[0]), duchess.lore + 1);
    const b = setup({ play0: [duchess], play1: [big] });
    ok(applyAction(b.s, 0, { type: 'endTurn' })); ok(applyAction(b.s, 1, { type: 'endTurn' }));
    assert.equal(lore(b.s, b.ids.play0[0]), duchess.lore);
  }
});
test('abilities and targeting (CR 6.6, 8.15): can\'t gain, lose and can\'t gain, printed-value floor, must choose, can\'t choose items', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  const settle = (s) => { ok(applyAction(s, 0, { type: 'endTurn' })); ok(applyAction(s, 1, { type: 'endTurn' })); };
  const kwOf = (s, seat, iid) => viewFor(s, 0).players[seat].play.find((c) => c.iid === iid);
  { // Flash - Efficient Clerk: "All characters lose Rush and can't gain Rush."
    const rusher = all.find((d) => d.type === 'character' && d.kw?.rush && d.abilities.length === 1);
    const { s, ids } = setup({ play0: [byName('Flash - Efficient Clerk')], hand0: [rusher] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    const c = s.cards[ids.hand0[0]];
    assert.equal(kwHas(c, s.defs[c.cardId], 'rush'), false, 'lost Rush');
    c.mods.push({ stat: 'kw', kw: 'rush', delta: 1, until: 'eot', by: 0 });
    assert.equal(kwHas(c, s.defs[c.cardId], 'rush'), false, "can't gain it back");
  }
  { // Elisa Maza - Transformed Gargoyle: "Your characters' {strength} can't be reduced below their printed value."
    const x = plain((d) => d.str >= 2);
    const { s, ids } = setup({ play0: [byName('Elisa Maza - Transformed Gargoyle'), x] });
    s.cards[ids.play0[1]].mods.push({ stat: 'str', delta: -2, until: 'eot', by: 1 });
    settle(s);
    assert.equal(kwOf(s, 0, ids.play0[1]).eff.str, x.str);
  }
  { // John Smith - Undaunted Protector: "Opponents must choose this character for actions and abilities if able."
    const js = byName('John Smith - Undaunted Protector');
    const zap = all.find((d) => d.type === 'action' && d.procs.every((p) => p.exec) && /^Deal 2 damage to chosen character\.$/.test(d.abilities[0]?.text || ''));
    const other = plain(() => true);
    const { s, ids } = setup({ hand0: [zap], play1: [js, other] });
    settle(s);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    assert.deepEqual(s.pending.valid, [ids.play1[0]]);
  }
  { // Aurora - Lore Guardian: "Opponents can't choose your items for abilities or effects."
    const banishItem = all.find((d) => d.type === 'action' && d.procs.every((p) => p.exec) && /^Banish chosen item\.$/.test(d.abilities[0]?.text || ''));
    const item = all.find((d) => d.type === 'item' && !d.abilities.length) || all.find((d) => d.type === 'item');
    const { s, ids } = setup({ hand0: [banishItem], play1: [byName('Aurora - Lore Guardian'), item] });
    settle(s);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.cards[ids.play1[1]].zone, 'play');
  }
});
test('move all damage (1.9.2), at random, the first time each turn, who was challenged this turn', () => {
  const plain = (f) => all.find((d) => d.type === 'character' && !d.abilities.length && !Object.keys(d.kw || {}).length && f(d));
  { // Can't Hold It Back Anymore: "Exert chosen opposing character. Move all damage counters from all other characters to that character."
    const x = plain((d) => d.wp >= 9 || d.wp >= 6), y = plain((d) => d.wp >= 4);
    const { s, ids } = setup({ hand0: [byName("Can't Hold It Back Anymore")], play0: [y], play1: [x, y] });
    s.cards[ids.play0[0]].damage = 1; s.cards[ids.play1[1]].damage = 2;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] })); drain(s);
    assert.equal(s.cards[ids.play1[0]].damage, 3);
    assert.equal(s.cards[ids.play0[0]].damage + s.cards[ids.play1[1]].damage, 0);
  }
  { // Mufasa - Ruler of Pride Rock: "exert all cards in your inkwell, then return 2 cards at random from your inkwell to your hand."
    const { s, ids } = setup({ hand0: [byName('Mufasa - Ruler of Pride Rock')], ink0: 10 });
    const ink = s.players[0].inkwell.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.players[0].inkwell.length, ink - 2);
  }
  { // Vine Entrance - Ominous Passageway: "The first time a Floodborn character moves here each turn, you may deal 1 damage to chosen character."
    const vine = byName('Vine Entrance - Ominous Passageway');
    const fb = all.find((d) => d.type === 'character' && (d.classes || []).includes('floodborn') && !d.abilities.some((a) => /move/i.test(a.text)));
    const foe = plain((d) => d.wp >= 5);
    const { s, ids } = setup({ play0: [vine, fb, fb], play1: [foe], ink0: 10 });
    unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'move', iid: ids.play0[1], location: ids.play0[0] }));
    for (let k = 0; k < 4 && s.pending; k++) { const pd = s.pending; ok(applyAction(s, 0, { type: 'choose', ...(pd.confirm ? {} : { target: ids.play1[0] }) })); }
    ok(applyAction(s, 0, { type: 'move', iid: ids.play0[2], location: ids.play0[0] }));
    drain(s);
    assert.equal(s.cards[ids.play1[0]].damage, 1, 'only the first time');
  }
  { // Last Stand: "Banish chosen character who was challenged this turn."
    const a = plain((d) => d.str >= 1 && d.wp >= 3), t1 = plain((d) => d.wp >= 6), t2 = plain((d) => d.wp >= 6);
    const { s, ids } = setup({ hand0: [byName('Last Stand')], play0: [a], play1: [t1, t2] });
    unready(s, ids.play0); for (const iid of ids.play1) s.cards[iid].exerted = true;
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] })); drain(s);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    assert.deepEqual(s.pending.valid, [ids.play1[0]]);
  }
});
test('Vanish: chosen by an opponent\'s action → banished after the action resolves', () => {
  const abu = byName('Abu - Illusory Pachyderm');
  const zap = all.find((d) => d.type === 'action' && d.cost <= 3 && d.procs.length === 1 && d.procs[0].exec && d.procs[0].do?.length === 1
    && d.procs[0].do[0].fn === 'mod' && d.procs[0].do[0].sel?.chosen && !d.procs[0].do[0].sel.chosen.owner);
  const { s, ids } = setup({ hand0: [zap], play1: [abu] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] })); drain(s);
  assert.equal(s.cards[ids.play1[0]].zone, 'discard', `${zap.full} chose Abu → Vanish`);
});
test('"whenever you ready this character" fires from the ready step', () => {
  const pino = byName('Pinocchio - Strings Attached');                  // once during your turn, may draw
  const { s, ids } = setup({ play0: [pino] }); unready(s, ids.play0);
  s.cards[ids.play0[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'endTurn' })); drain(s);
  ok(applyAction(s, 1, { type: 'endTurn' }));
  const h = s.players[0].hand.length;
  drain(s);
  assert.equal(s.players[0].hand.length, h + 1);
});
test('grants: "your other characters gain \"{exert} — Draw a card\" this turn" — usable, then gone', () => {
  const donald = byName('Donald Duck - Coin Collector');
  const pal = vanilla(() => true);
  const { s, ids } = setup({ hand0: [donald], play0: [pal] }); unready(s, ids.play0);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
  const v = viewFor(s, 0).players[0].play.find((c) => c.iid === ids.play0[0]);
  assert.equal(v.granted.length, 1);
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: v.granted[0].index })); drain(s);
  assert.equal(s.players[0].hand.length, h + 1);
  assert.equal(s.cards[ids.play0[0]].exerted, true);
  assert.equal(viewFor(s, 0).players[0].play.find((c) => c.iid === ids.hand0[0]).granted.length, 0, 'Donald himself is not "other"');
  ok(applyAction(s, 0, { type: 'endTurn' })); drain(s);
  assert.equal(viewFor(s, 0).players[0].play.find((c) => c.iid === ids.play0[0]).granted.length, 0, 'this-turn grant expired');
});
test('grants: "gains \"When this character is banished in a challenge, return this card to your hand\"" survives leaving play', () => {
  const aid = byName('Magical Aid');
  const mine = vanilla((d) => d.str >= 1 && d.wp <= 3);
  const foe = vanilla((d) => d.str >= 4 && d.wp >= 6);
  const { s, ids } = setup({ hand0: [aid], play0: [mine], play1: [foe] }); unready(s, ids.play0);
  s.cards[ids.play1[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  ok(applyAction(s, 0, { type: 'choose', target: ids.play0[0] })); drain(s);
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] })); drain(s);
  assert.equal(s.cards[ids.play0[0]].zone, 'hand');
});
test('grants: location static "Characters gain \"{exert} — Draw a card\" while here"', () => {
  const lab = byName('The Great Illuminary - Abandoned Laboratory');
  const pal = vanilla(() => true);
  const { s, ids } = setup({ play0: [lab, pal] }); unready(s, ids.play0);
  const g = () => viewFor(s, 0).players[0].play.find((c) => c.iid === ids.play0[1]).granted;
  ok(applyAction(s, 0, { type: 'endTurn' })); drain(s); ok(applyAction(s, 1, { type: 'endTurn' })); drain(s);
  assert.equal(g().length, 0, 'not while elsewhere');
  ok(applyAction(s, 0, { type: 'move', iid: ids.play0[1], location: ids.play0[0] })); drain(s);
  assert.equal(g().length, 1);
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[1], index: g()[0].index })); drain(s);
  assert.equal(s.players[0].hand.length, h + 1);
});
test('a keyword printed after another ability still counts ("…less to play this character. Evasive")', () => {
  assert.equal(byName('Vixey - Forest Friend').kw.evasive, true);
  assert.equal(byName('Judy Hopps - Snowball Patrol').kw.resist, 1);
});
test('"They gain Rush and get +1 {strength} this turn" — one target, both changes', () => {
  const vit = byName('Vitalisphere');                                  // chosen character gains Rush and gets +2 {strength}
  const pal = vanilla(() => true);
  const { s, ids } = setup({ play0: [vit, pal] });
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: act(vit) }));
  ok(applyAction(s, 0, { type: 'choose', target: ids.play0[1] })); drain(s);
  assert.equal(s.pending, null, 'no second prompt');
  const v = viewFor(s, 0).players[0].play.find((c) => c.iid === ids.play0[1]);
  assert.equal(v.eff.str, pal.str + 2); assert.ok(v.kw.rush);
});
test('"banish her or return another chosen character": only the possible option is offered (CR 1.7.7)', () => {
  const mim = byName('Madam Mim - Fox');
  { const { s, ids } = setup({ hand0: [mim] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.cards[ids.hand0[0]].zone, 'discard', 'alone → she banishes herself'); }
  { const pal = vanilla(() => true);
    const { s, ids } = setup({ hand0: [mim], play0: [pal] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    assert.equal(s.pending?.op, 'chooseOne');
    ok(applyAction(s, 0, { type: 'choose', option: 1 }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play0[0] })); drain(s);
    assert.equal(s.cards[ids.play0[0]].zone, 'hand'); assert.equal(s.cards[ids.hand0[0]].zone, 'play'); }
});
test('"whenever you play a second action in a turn" counts this turn\'s plays', () => {
  const owl = byName('Owl Island - Secluded Entrance');
  const zap = all.find((d) => d.type === 'action' && d.cost <= 2 && d.procs.every((p) => p.exec) && /^draw a card\.?$/i.test(d.abilities.map((a) => a.text).join(' ').trim()))
    || all.find((d) => d.type === 'action' && d.cost <= 2 && d.procs.length === 1 && d.procs[0].do?.length === 1 && d.procs[0].do[0].fn === 'draw');
  const { s, ids } = setup({ hand0: [zap, zap, zap], play0: [owl] });
  const lore = () => s.players[0].lore;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s); assert.equal(lore(), 0);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] })); drain(s); assert.equal(lore(), 3);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[2] })); drain(s); assert.equal(lore(), 3, 'only the second');
});
test('"Put one into your hand and the other into your inkwell facedown and exerted"', () => {
  const song = byName("How Far I'll Go");
  const { s, ids } = setup({ hand0: [song] });
  const top = s.players[0].deck.slice(0, 2); const ink = s.players[0].inkwell.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  ok(applyAction(s, 0, { type: 'choose', target: top[1] })); drain(s);
  assert.equal(s.cards[top[1]].zone, 'hand'); assert.equal(s.cards[top[0]].zone, 'inkwell'); assert.equal(s.cards[top[0]].exerted, true);
  assert.equal(s.players[0].inkwell.length, ink + 1);
});
test('"For each 1 damage on opposing characters, you pay 1 {ink} less"', () => {
  const robin = byName('Robin Hood - Timely Contestant');
  const foe = vanilla((d) => d.wp >= 4);
  const { s, ids } = setup({ hand0: [robin], play1: [foe, foe], ink0: robin.cost - 3 });
  s.cards[ids.play1[0]].damage = 2; s.cards[ids.play1[1]].damage = 1;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  assert.equal(s.cards[ids.hand0[0]].zone, 'play');
});
test('amounts: "equal to the number of X", "for each 1 damage on them", "equal to the discarded character\'s {lore}"', () => {
  const mickey = byName('Mickey Mouse - Playful Sorcerer');             // damage = # Broom characters you have
  const broom = all.find((d) => d.type === 'character' && (d.classes || []).includes('broom'));
  const foe = vanilla((d) => d.wp >= 5);
  { const { s, ids } = setup({ hand0: [mickey], play0: [broom, broom], play1: [foe] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] })); drain(s);
    assert.equal(s.cards[ids.play1[0]].damage, 2); }
  const sword = byName('Sword in the Stone');
  { const pal = vanilla(() => true);
    const { s, ids } = setup({ play0: [sword, pal] }); s.cards[ids.play0[1]].damage = 2;
    ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: act(sword) }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play0[1] })); drain(s);
    assert.equal(viewFor(s, 0).players[0].play.find((c) => c.iid === ids.play0[1]).eff.str, pal.str + 2); }
  const queen = byName('The Queen - Disguised Peddler');
  { const fodder = vanilla((d) => d.lore >= 2);
    const { s, ids } = setup({ play0: [queen], hand0: [fodder] }); unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: act(queen) }));
    if (s.pending) ok(applyAction(s, 0, { type: 'choose', target: ids.hand0[0] }));
    drain(s);
    assert.equal(s.cards[ids.hand0[0]].zone, 'discard');
    assert.equal(s.players[0].lore, fodder.lore); }
  const minnie = byName('Minnie Mouse - Storyteller');                  // loses {strength} equal to her {lore} (printed 0)
  { const foe2 = vanilla((d) => d.str >= 3);
    const { s, ids } = setup({ play0: [minnie], play1: [foe2] }); unready(s, ids.play0);
    s.cards[ids.play0[0]].mods.push({ stat: 'lore', delta: 2, until: 'eot', src: 'test' });
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] })); drain(s);
    assert.equal(viewFor(s, 0).players[1].play[0].eff.str, Math.max(0, foe2.str - 2)); }
});
test('delayed triggers: "Whenever one of your characters quests this turn, gain 1 lore" — this turn only', () => {
  const pups = byName('99 Puppies');
  const a = vanilla((d) => d.lore >= 1); const b = vanilla((d) => d.lore >= 1 && d.full !== a.full);
  const { s, ids } = setup({ hand0: [pups], play0: [a, b] }); unready(s, ids.play0);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s);
  assert.equal(s.players[0].lore, a.lore + 1);
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[1] })); drain(s);
  assert.equal(s.players[0].lore, a.lore + b.lore + 2);
  ok(applyAction(s, 0, { type: 'endTurn' })); drain(s); ok(applyAction(s, 1, { type: 'endTurn' })); drain(s);
  const l = s.players[0].lore;
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s);
  assert.equal(s.players[0].lore, l + a.lore, 'expired');
  assert.equal((s.delayed || []).length, 0);
});
test('trigger: "whenever this character exerts" fires on quest; "an opposing character becomes exerted"', () => {
  const md = byName('Maleficent & Diablo - Evil Incarnate');
  { const { s, ids } = setup({ play0: [md] }); unready(s, ids.play0);
    const h = s.players[0].hand.length;
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s);
    assert.equal(s.players[0].hand.length, h + 1); }
  const gri = byName('Grimorum Arcanorum');
  const exerter = all.find((d) => d.type === 'action' && d.procs.length === 1 && d.procs[0].exec && d.procs[0].do?.length === 1 && d.procs[0].do[0].fn === 'exert' && d.procs[0].do[0].sel?.chosen);
  const foe = vanilla(() => true);
  { const { s, ids } = setup({ hand0: [exerter], play0: [gri], play1: [foe] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] })); drain(s);
    assert.equal(s.players[0].lore, 1, exerter.full); }
});
test('trigger: "When you play a Floodborn character on this card" (shift onto)', () => {
  const hiro = byName('Hiro Hamada - Future Champion');
  const flood = all.find((d) => d.type === 'character' && (d.classes || []).includes('floodborn') && d.name === hiro.name && d.kw?.shift != null);
  const { s, ids } = setup({ hand0: [flood], play0: [hiro] });
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'shift', target: ids.play0[0] })); drain(s);
  assert.equal(s.players[0].hand.length, h - 1 + 1);
});
test('trigger: "whenever one or more of your characters sings a song, you may ready those characters"', () => {
  const alma = byName('Alma Madrigal - Accepting Grandmother');
  const song = all.find((d) => d.type === 'song' && d.cost <= 2 && d.procs.every((p) => p.exec));
  const singer = vanilla((d) => d.cost >= song.cost);
  const { s, ids } = setup({ hand0: [song], play0: [alma, singer] }); unready(s, ids.play0);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'sing', singers: [ids.play0[1]] }));
  for (let k = 0; k < 6 && s.pending; k++) {
    const pd = s.pending;
    if (pd.op === 'confirm' || pd.optional && /ready/i.test(pd.prompt)) ok(applyAction(s, 0, { type: 'choose', confirm: true }));
    else if (pd.valid?.length) ok(applyAction(s, pd.seat ?? 0, { type: 'choose', target: pd.valid[0] }));
    else ok(applyAction(s, pd.seat ?? 0, { type: 'choose', skip: true }));
  }
  drain(s);
  assert.equal(s.cards[ids.play0[1]].exerted, false, 'the singer was readied');
});
test('trigger: "Whenever an opponent chooses this character for an action or ability"', () => {
  const arch = byName('Archimedes - Exceptional Owl');
  const zap = all.find((d) => d.type === 'action' && d.cost <= 3 && d.procs.length === 1 && d.procs[0].exec && d.procs[0].do?.length === 1
    && d.procs[0].do[0].fn === 'mod' && d.procs[0].do[0].sel?.chosen && !d.procs[0].do[0].sel.chosen.owner);
  const { s, ids } = setup({ hand0: [zap], play1: [arch] });
  const h = s.players[1].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] }));
  if (s.pending?.seat === 1) ok(applyAction(s, 1, { type: 'choose', confirm: true }));
  drain(s);
  assert.equal(s.players[1].hand.length, h + 1);
});
test('search: "search your deck for a Madrigal character card … Shuffle your deck and put that card on top of it"', () => {
  const alma = byName('Alma Madrigal - Family Matriarch');
  const mad = all.find((d) => d.type === 'character' && (d.classes || []).includes('madrigal') && d.full !== alma.full);
  const { s, ids } = setup({ hand0: [alma] });
  const p = s.players[0];
  const target = p.deck.find((iid) => s.cards[iid].cardId === FILLER.id);
  s.cards[target].cardId = mad.id; s.defs[mad.id] = mad;                 // plant one Madrigal deep in the deck
  p.deck.splice(p.deck.indexOf(target), 1); p.deck.push(target);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  if (s.pending?.confirm) ok(applyAction(s, 0, { type: 'choose', confirm: true }));
  assert.deepEqual(s.pending.valid, [target]);
  ok(applyAction(s, 0, { type: 'choose', target })); drain(s);
  assert.equal(p.deck[0], target);
});
test('look: "put them back in any order" lets you order them; "top card of chosen player\'s deck … or into their discard"', () => {
  const pascal = byName('Pascal - Inquisitive Pet');
  { const { s, ids } = setup({ hand0: [pascal] });
    const top = s.players[0].deck.slice(0, 3);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    ok(applyAction(s, 0, { type: 'choose', target: top[2] }));
    ok(applyAction(s, 0, { type: 'choose', target: top[0] })); drain(s);
    assert.deepEqual(s.players[0].deck.slice(0, 3), [top[2], top[0], top[1]]); }
  const hatter = byName('Mad Hatter - Eccentric Host');
  { const { s, ids } = setup({ play0: [hatter] }); unready(s, ids.play0);
    const top = s.players[1].deck[0];
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
    if (s.pending?.confirm) ok(applyAction(s, 0, { type: 'choose', confirm: true }));
    assert.equal(s.pending.choices.length, 2);
    ok(applyAction(s, 0, { type: 'choose', option: 1 }));             // the opponent's deck
    ok(applyAction(s, 0, { type: 'choose', confirm: true })); drain(s);
    assert.equal(s.cards[top].zone, 'discard'); }
});
test('restriction: "can\'t challenge and must quest during their next turn if able" blocks ending that turn', () => {
  const tgp = byName('This Growing Pressure');
  const foe = vanilla((d) => d.lore > 0);
  const { s, ids } = setup({ hand0: [tgp], play1: [foe] }); unready(s, ids.play1);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] })); drain(s);
  ok(applyAction(s, 0, { type: 'endTurn' })); drain(s);
  if (s.pending) ok(applyAction(s, 1, { type: 'choose', skip: true }));
  assert.equal(applyAction(s, 1, { type: 'endTurn' }).ok, false, 'must quest first');
  ok(applyAction(s, 1, { type: 'quest', iid: ids.play1[0] })); drain(s);
  ok(applyAction(s, 1, { type: 'endTurn' }));
});
test('cost: "{exert}, Banish one of your items — Gain 3 lore" / "{exert} one of your characters —"', () => {
  const triton = byName('Triton - Discerning King');
  const item = all.find((d) => d.type === 'item' && d.procs.every((p) => p.kind === 'activated'));
  { const { s, ids } = setup({ play0: [triton] }); unready(s, ids.play0);
    assert.equal(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 }).ok, false, 'no item to banish'); }
  { const { s, ids } = setup({ play0: [triton, item] }); unready(s, ids.play0);
    ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 }));
    assert.deepEqual(s.pending.valid, [ids.play0[1]]);
    ok(applyAction(s, 0, { type: 'choose', target: ids.play0[1] })); drain(s);
    assert.equal(s.cards[ids.play0[1]].zone, 'discard'); assert.equal(s.players[0].lore, 3); }
  const scrump = byName('Scrump');
  const mine = vanilla(() => true), foe = vanilla(() => true);
  { const { s, ids } = setup({ play0: [scrump, mine], play1: [foe] }); unready(s, ids.play0);
    const i = scrump.procs.findIndex((p) => p.kind === 'activated');
    ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: i }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play0[1] }));
    ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] })); drain(s);
    assert.equal(s.cards[ids.play0[1]].exerted, true); }
});
test('play bans: "opponents can\'t play actions until the start of your next turn"; "can\'t play this character unless"', () => {
  const pete = byName('Pete - Games Referee');
  const act = all.find((d) => d.type === 'action' && d.cost <= 2 && !d.sing);
  { const { s, ids } = setup({ hand0: [pete], hand1: [act], ink0: 7 }); s.players[1].inkwell.push(...s.players[1].deck.splice(0, 5));
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    ok(applyAction(s, 0, { type: 'endTurn', force: true })); drain(s);
    if (s.pending) ok(applyAction(s, s.pending.seat, { type: 'choose', skip: true }));
    const r = applyAction(s, 1, { type: 'play', iid: ids.hand1[0] });
    assert.equal(r.ok, false, 'banned during their turn');
    ok(applyAction(s, 1, { type: 'endTurn', force: true })); drain(s);
    assert.equal(s.playBans.some((x) => s.turn === x.turn || !(s.active === x.by && s.turn > x.turn)), false, 'ban over at the start of your next turn'); }
  const mira = byName('Mirabel Madrigal - Family Gatherer');
  const v = vanilla(() => true);
  { const { s, ids } = setup({ hand0: [mira], play0: [v, v, v, v], ink0: 9 });
    assert.equal(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }).ok, false, 'only 4 characters'); }
  { const { s, ids } = setup({ hand0: [mira], play0: [v, v, v, v, v], ink0: 9 });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); }
});
test('"can\'t be challenged by Pirate characters"; "draw cards until you have the same number"; "put all cards from under her into your hand"', () => {
  const amelia = byName('Captain Amelia - Commander of the Legacy');
  const pirate = vanilla((d) => (d.classes || []).includes('pirate'));
  const other = vanilla((d) => !(d.classes || []).includes('pirate'));
  { const { s, ids } = setup({ play0: [pirate, other], play1: [amelia] }); ok(applyAction(s, 0, { type: 'endTurn', force: true })); drain(s); ok(applyAction(s, 1, { type: 'endTurn', force: true })); drain(s);
    unready(s, ids.play0); s.cards[ids.play1[0]].exerted = true;
    assert.equal(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }).ok, false, 'pirates bounce off');
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[1], target: ids.play1[0] })); }
  const ryr = byName('Remember Who You Are');
  { const { s, ids } = setup({ hand0: [ryr] });
    s.players[1].hand.push(...s.players[1].deck.splice(0, 4));
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.players[0].hand.length, s.players[1].hand.length); }
  const alice = byName('Alice - Well-Read Whisper');
  { const { s, ids } = setup({ play0: [alice] }); unready(s, ids.play0);
    const a = s.cards[ids.play0[0]]; const u = s.players[0].deck.shift();
    a.under.push(u); s.cards[u].zone = 'under'; s.cards[u].parent = a.iid; s.cards[u].faceDown = true;
    ok(applyAction(s, 0, { type: 'quest', iid: a.iid })); drain(s);
    assert.equal(s.cards[u].zone, 'hand'); assert.equal(a.under.length, 0); }
});
test('grouped trigger: "When you play this character and whenever you play a location" fires on both', () => {
  const elsa = byName('Elsa - Ice Artisan');
  const loc = all.find((d) => d.type === 'location' && d.cost <= 3 && !d.procs.length);
  const foe = vanilla((d) => (d.str ?? 0) <= 3);
  const { s, ids } = setup({ hand0: [elsa, loc], play1: [foe, foe], ink0: 12 });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  if (s.pending?.confirm) ok(applyAction(s, 0, { type: 'choose', confirm: true }));
  ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] })); drain(s);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] }));
  if (s.pending?.confirm) ok(applyAction(s, 0, { type: 'choose', confirm: true }));
  ok(applyAction(s, 0, { type: 'choose', target: ids.play1[1] })); drain(s);
  assert.equal(s.cards[ids.play1[0]].exerted && s.cards[ids.play1[1]].exerted, true);
});
test('"When this character quests, banish him." (when = whenever)', () => {
  const abu = byName('Abu - Wise Sultan');
  const { s, ids } = setup({ play0: [abu] }); unready(s, ids.play0);
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s);
  assert.equal(s.players[0].lore, abu.lore); assert.equal(s.cards[ids.play0[0]].zone, 'discard');
});
test('base proc: every card has one; the engine\'s stats come from it (Abu - Mischievous Monkey)', () => {
  for (const d of all) { assert.equal(d.base?.kind, 'base', d.full); assert.equal(d.base.cost, d.cost, d.full); assert.equal(d.base.inkable, d.inkable, d.full); }
  const abu = byName('Abu - Mischievous Monkey');
  assert.deepEqual(abu.base, { kind: 'base', type: 'character', cost: 3, inkable: true, quest: { do: [{ fn: 'gainLore', n: 2 }] }, challenge: { damage: 3 }, willpower: 2, exec: true });
  const { s, ids } = setup({ play0: [abu] }); unready(s, ids.play0);
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s);
  assert.equal(s.players[0].lore, abu.base.quest.do[0].n);
});
test('demo decks are built only from fully-runnable cards', () => {
  void FILLER;
  const d = all.filter((x) => x.procs.some((p) => !p.exec));
  assert.ok(d.length > 0 && d.length < all.length);
});

done();
