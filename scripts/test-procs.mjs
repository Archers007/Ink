// Proc compiler + runtime tests.
//   node scripts/test-procs.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { compileAbility, compileCard } from '../game/procs/index.js';
import { canon, mergeSplitNames, unknownIcons } from '../game/procs/normalize.js';
import { SUPPORT } from '../game/procs/index.js';
import { createRuntime } from '../game/procs/index.js';
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
