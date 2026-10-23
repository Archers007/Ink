// Batch 3: FAQ rulings for Belle … Magic Broom (set 1–4 cards).
import { assert, applyAction, checkInvariants, all, byName, ok, setup, oracle, untestable, vanilla, put, giveInk, drain, choose, yes, no, passTo, settle, eff, kw, viewFor } from './lib.mjs';

const inkReady = (s, seat) => s.players[seat].inkwell.filter((iid) => !s.cards[iid].exerted).length + (s.players[seat].inkDrops || 0);
// keep only `keep` (plus the first n others) in a player's hand; the rest go back to the deck
const trimHand = (s, seat, keep = [], n = 0) => {
  const p = s.players[seat];
  const others = p.hand.filter((iid) => !keep.includes(iid));
  for (const iid of others.slice(n)) { p.hand.splice(p.hand.indexOf(iid), 1); s.cards[iid].zone = 'deck'; p.deck.push(iid); }
};
const dry = (s, ...iids) => { for (const iid of iids) s.cards[iid].drying = false; };
const pendSrcName = (s) => s.pending && s.defs[s.cards[s.pending.src]?.cardId]?.full;
// a character with no abilities or keywords — nothing of its own fires
const plain = (f) => vanilla(f);
const noFx = (d) => d.procs.every((p) => p.kind === 'keyword' || p.kind === 'reminder' || p.kind === 'activated');

// ---------- Belle - Strange but Special: "you may ink an additional card" ----------
oracle('7633a3c986', 'Read a Book: a second card can be inked during your turn (not a third)', () => {
  const belle = byName('Belle - Strange but Special');
  const ink1 = vanilla((d) => d.inkable);
  for (const withBelle of [true, false]) {
    const { s, ids } = setup({ play0: withBelle ? [belle] : [], hand0: [ink1, ink1, ink1] });
    ok(applyAction(s, 0, { type: 'ink', iid: ids.hand0[0] }));
    const r2 = applyAction(s, 0, { type: 'ink', iid: ids.hand0[1] });
    assert.equal(r2.ok, withBelle, withBelle ? `second ink allowed with Belle: ${r2.error}` : 'second ink refused without Belle');
    if (withBelle) assert.equal(applyAction(s, 0, { type: 'ink', iid: ids.hand0[2] }).ok, false, 'only ONE additional card');
  }
});

// ---------- Belle's House - Maurice's Workshop ----------
oracle('a55c3a2954', "2 characters at one Belle's House → 1 less; one at each of 2 copies → 2 less", () => {
  const house = byName("Belle's House - Maurice's Workshop");
  const item = all.find((d) => d.type === 'item' && d.cost >= 3 && d.procs.every((p) => p.kind === 'activated'));
  const ch = vanilla((d) => d.cost === 1);
  for (const [houses, want] of [[1, 1], [2, 2]]) {
    const { s, ids } = setup({ play0: [ch, ch], hand0: [item] });
    const locs = Array.from({ length: houses }, () => put(s, 0, house, 'play'));
    s.cards[ids.play0[0]].atLocation = locs[0];
    s.cards[ids.play0[1]].atLocation = locs[houses - 1];
    ok(applyAction(s, 0, { type: 'lore', seat: 0, delta: 0 }));
    const before = inkReady(s, 0);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
    assert.equal(before - inkReady(s, 0), item.cost - want, `${houses} house(s): pay ${want} less for ${item.full}`);
  }
});

// ---------- Bernard - Brand-New Agent ----------
oracle('6c37a2c57e', 'two exerted Bernards: the one readied by the other no longer resolves (must be exerted)', () => {
  const b = byName('Bernard - Brand-New Agent'); const other = vanilla((d) => d.cost === 2);
  const { s, ids } = setup({ play0: [b, b, other] });
  const [b1, b2, c] = ids.play0;
  for (const iid of ids.play0) s.cards[iid].exerted = true;
  ok(applyAction(s, 0, { type: 'endTurn', force: true }));
  assert.ok(s.pending, 'a Bernard trigger asks');
  const first = s.pending.src; const second = first === b1 ? b2 : b1;
  if (s.pending.confirm) yes(s);
  choose(s, second);
  assert.equal(s.cards[second].exerted, false, 'the second Bernard was readied');
  const offered = !!s.pending;
  drain(s, 'yes');
  assert.equal(s.cards[c].exerted, true, `the readied Bernard's ability must not ready ${other.full}${offered ? ' (it was offered)' : ''}`);
});

// ---------- Bibbidi Bobbidi Boo ----------
oracle('92c54454a8', 'return shifted Artful Rogue (cost 7) → play a cost 7 or lower', () => {
  const rogue = byName('Mickey Mouse - Artful Rogue'); const tailor = byName('Mickey Mouse - Brave Little Tailor'); const bbb = byName('Bibbidi Bobbidi Boo');
  const seven = vanilla((d) => d.cost === 7) || all.find((d) => d.type === 'character' && d.cost === 7 && noFx(d) && !d.kw.shift);
  const eight = vanilla((d) => d.cost === 8) || all.find((d) => d.type === 'character' && d.cost === 8 && noFx(d) && !d.kw.shift);
  const { s, ids } = setup({ play0: [tailor], hand0: [rogue, bbb, seven, eight], ink0: 10 });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'shift', target: ids.play0[0] }));
  giveInk(s, 0, 3);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] }));
  if (s.pending?.valid?.includes(ids.hand0[0])) choose(s, ids.hand0[0]);
  assert.equal(s.cards[ids.hand0[0]].zone, 'hand', 'Artful Rogue returned');
  assert.ok(s.pending, 'asked what to play');
  const v = s.pending.valid;
  assert.ok(v.includes(ids.hand0[2]), `cost-7 ${seven.full} can be played`);
  assert.ok(v.includes(ids.hand0[0]), 'Artful Rogue (cost 7) itself can be played');
  assert.ok(!v.includes(ids.hand0[3]), `cost-8 ${eight.full} cannot`);
  assert.ok(!v.includes(ids.play0[0]), 'Brave Little Tailor (cost 8) cannot');
  choose(s, ids.hand0[2]); drain(s, 'no');
  assert.equal(s.cards[ids.hand0[2]].zone, 'play');
});

// ---------- Binding Contract ----------
oracle('222b7e3dd6', "can't exert a character played this turn to pay For All Eternity", () => {
  const bc = byName('Binding Contract'); const ch = vanilla((d) => d.cost === 2); const opp = vanilla((d) => d.cost === 3);
  for (const fresh of [true, false]) {
    const { s, ids } = setup({ hand0: [ch], play1: [opp] });
    const item = put(s, 0, bc, 'play');
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
    if (!fresh) dry(s, ids.hand0[0]);
    const r = applyAction(s, 0, { type: 'useAbility', iid: item, index: 0 });
    if (r.ok && s.pending?.valid?.includes(ids.hand0[0])) choose(s, ids.hand0[0]);
    if (s.pending?.valid?.includes(ids.play1[0])) choose(s, ids.play1[0]);
    drain(s, 'no');
    assert.equal(s.cards[ids.play1[0]].exerted, !fresh, fresh ? 'a just-played character must not pay the cost' : 'a dry character pays it');
    if (fresh) assert.equal(s.cards[ids.hand0[0]].exerted, false, 'just-played character not exerted');
  }
});

// ---------- Bucky - Squirrel Squeak Tutor (errata: only when Shift was used) ----------
oracle('1071d9ab17', 'Squeak: opponent discards only when the Floodborn was played with Shift', () => {
  const bucky = byName('Bucky - Squirrel Squeak Tutor');
  const tc = byName('Cogsworth - Talking Clock'); const gc = byName('Cogsworth - Grandfather Clock');
  for (const shift of [true, false]) {
    const { s, ids } = setup({ play0: [bucky, tc], hand0: [gc] });
    const h1 = s.players[1].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], ...(shift ? { mode: 'shift', target: ids.play0[1] } : {}) }));
    if (s.pending?.seat === 1 && s.pending.valid?.length) choose(s, s.pending.valid[0]);
    drain(s, 'no');
    assert.equal(h1 - s.players[1].hand.length, shift ? 1 : 0, shift ? 'shifted → discard 1' : 'played normally → no discard');
  }
});

// ---------- Chernabog - Evildoer + Perdita ----------
oracle('162580cc5b', 'Chernabog with 10 characters in discard still costs 10 → not a Perdita target', () => {
  const cher = byName('Chernabog - Evildoer'); const perd = byName('Perdita - Devoted Mother'); const one = vanilla((d) => d.cost === 1);
  const { s, ids } = setup({ hand0: [perd] });
  const ch = put(s, 0, cher, 'discard');
  for (let k = 0; k < 10; k++) put(s, 0, one, 'discard');
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  if (s.pending?.confirm) yes(s);
  assert.ok(s.pending, 'Perdita asks what to play');
  assert.ok(!s.pending.valid.includes(ch), 'Chernabog is cost 10 — not playable as "cost 2 or less"');
  assert.ok(s.pending.valid.length > 0, 'cost-1 characters are');
});

// ---------- Cheshire Cat + Marshmallow ----------
oracle('673846cc23', 'Cheshire banishes Marshmallow during the challenge → Durable returns it to hand', () => {
  const cat = byName('Cheshire Cat - Not All There'); const mm = byName('Marshmallow - Persistent Guardian');
  const { s, ids } = setup({ play0: [mm], play1: [cat] });
  s.cards[ids.play1[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }));
  for (let k = 0; k < 6 && s.pending; k++) { if (s.pending.confirm) yes(s); else choose(s, s.pending.valid.includes(ids.play0[0]) ? ids.play0[0] : s.pending.valid[0]); }
  assert.equal(s.cards[ids.play1[0]].zone, 'discard', 'Cheshire banished');
  assert.equal(s.cards[ids.play0[0]].zone, 'hand', 'Marshmallow was banished in the challenge and returned to hand');
});

// ---------- Support wording: "another chosen character's {S}" ----------
oracle('07215d81ca', "Support adds to ANOTHER chosen character's {S} — not itself", () => {
  const hh = byName('Heihei - Boat Snack'); const other = vanilla((d) => d.cost === 2);
  const { s, ids } = setup({ play0: [hh, other] });
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
  assert.equal(s.pending?.type, 'support');
  assert.equal(applyAction(s, 0, { type: 'support', target: ids.play0[0] }).ok, false, "can't support itself");
  ok(applyAction(s, 0, { type: 'support', target: ids.play0[1] }));
  assert.equal(eff(s, ids.play0[1]).str, other.str + hh.str);
});

// ---------- Christopher Robin - Adventurer ----------
oracle('bd074fca8c', 'We\'ll Always Be Together triggers each time he is readied in a turn', () => {
  const cr = byName('Christopher Robin - Adventurer'); const fan = byName('Fan the Flames'); const one = vanilla((d) => d.cost === 1);
  const { s, ids } = setup({ play0: [cr, one, one], hand0: [fan, fan] });
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
  const l0 = s.players[0].lore;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); choose(s, ids.play0[0]); drain(s, 'yes');
  assert.equal(s.players[0].lore - l0, 2, 'first ready → +2');
  ok(applyAction(s, 0, { type: 'exert', iid: ids.play0[0], exerted: true }));
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] })); choose(s, ids.play0[0]); drain(s, 'yes');
  assert.equal(s.players[0].lore - l0, 4, 'second ready → +2 again');
});

// ---------- Cinderella - Stouthearted ----------
oracle('afa417c0c3', 'song played before Stouthearted is shifted in → she can\'t challenge ready characters', () => {
  const st = byName('Cinderella - Stouthearted'); const kit = byName('Cinderella - Knight in Training'); const z = byName('Zero to Hero');
  const opp = vanilla((d) => d.cost === 2);
  // she's not in play when the song is played
  {
    const { s, ids } = setup({ play0: [kit], hand0: [z, st], play1: [opp] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1], mode: 'shift', target: ids.play0[0] })); drain(s, 'no');
    assert.equal(s.cards[ids.hand0[1]].drying, false, 'shifted onto a dry character → can act');
    assert.equal(applyAction(s, 0, { type: 'challenge', attacker: ids.hand0[1], target: ids.play1[0] }).ok, false, 'no ready-challenge');
  }
  // control: she's in play when the song is played
  {
    const { s, ids } = setup({ play0: [st], hand0: [z], play1: [opp] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }));
  }
});

// ---------- Cogsworth - Grandfather Clock ×2 ----------
oracle('62373018bc', '2 Grandfather Clocks: each other gets Resist 1, other characters Resist 2', () => {
  const gc = byName('Cogsworth - Grandfather Clock'); const one = vanilla((d) => d.cost === 1);
  const { s, ids } = setup({ play0: [gc, gc, one] });
  settle(s);
  assert.equal(kw(s, ids.play0[0]).resist, 1);
  assert.equal(kw(s, ids.play0[1]).resist, 1);
  assert.equal(kw(s, ids.play0[2]).resist, 2, 'additive');
});

// ---------- Cogsworth - Talking Clock + reckless Basil ----------
oracle('c9bc637a31', 'Wait a Minute "{E} — gain 1 lore" is not questing → no Support', () => {
  const cog = byName('Cogsworth - Talking Clock'); const basil = byName('Basil - Of Baker Street'); const tbm = byName('The Beast is Mine!');
  const { s, ids } = setup({ play0: [basil, cog], hand1: [tbm] });
  giveInk(s, 1, 3); passTo(s, 1);
  ok(applyAction(s, 1, { type: 'play', iid: ids.hand1[0] })); choose(s, ids.play0[0]); drain(s, 'no');
  passTo(s, 0);
  assert.ok(kw(s, ids.play0[0]).reckless, 'Basil is reckless this turn');
  const v = viewFor(s, 0).players[0].play.find((c) => c.iid === ids.play0[0]);
  const g = v.granted.find((x) => /Gain 1 lore/i.test(x.text));
  assert.ok(g, 'Basil got the granted ability');
  const l0 = s.players[0].lore;
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: g.index }));
  assert.ok(!s.pending || s.pending.type !== 'support', 'Support must not be offered');
  drain(s, 'no');
  assert.equal(s.players[0].lore - l0, 1);
  assert.equal(eff(s, ids.play0[1]).str, cog.str, 'Cogsworth not supported');
});

// ---------- Divebomb + supported Felicia ----------
oracle('f3308bb250', 'Divebomb compares to the banished Felicia\'s Strength when banished (6 with Support)', () => {
  const dive = byName('Divebomb'); const fel = byName('Felicia - Always Hungry'); const phil = byName('Philoctetes - Trainer of Heroes');
  const five = vanilla((d) => d.str === 5); const six = vanilla((d) => d.str === 6);
  const { s, ids } = setup({ play0: [fel, phil], play1: [five, six], hand0: [dive] });
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[1] }));
  ok(applyAction(s, 0, { type: 'support', target: ids.play0[0] }));
  assert.equal(eff(s, ids.play0[0]).str, 6);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  if (s.pending?.valid?.includes(ids.play0[0])) choose(s, ids.play0[0]);
  assert.equal(s.cards[ids.play0[0]].zone, 'discard', 'Felicia banished');
  assert.ok(s.pending?.valid?.includes(ids.play1[0]), `${five.full} (5 {S}) must be choosable (< Felicia's 6 when banished)`);
  assert.ok(!s.pending.valid.includes(ids.play1[1]), `${six.full} (6 {S}) cannot`);
  choose(s, ids.play1[0]);
  assert.equal(s.cards[ids.play1[0]].zone, 'discard');
});

// ---------- Dr. Facilier - Agent Provocateur ----------
oracle('5c7e648886', 'a shifted character banished in a challenge → only the top card returns to hand', () => {
  const fac = byName('Dr. Facilier - Agent Provocateur'); const tc = byName('Cogsworth - Talking Clock'); const gc = byName('Cogsworth - Grandfather Clock');
  const big = vanilla((d) => d.str >= 5 && d.wp >= 3);
  const { s, ids } = setup({ play0: [fac, tc], hand0: [gc], play1: [big] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'shift', target: ids.play0[1] })); drain(s, 'no');
  s.cards[ids.play1[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.hand0[0], target: ids.play1[0] }));
  assert.ok(s.pending, 'Into the Shadows asks');
  if (s.pending.confirm) yes(s); else choose(s, ids.hand0[0]);
  drain(s, 'no');
  assert.equal(s.cards[ids.hand0[0]].zone, 'hand', 'top card (Grandfather Clock) to hand');
  assert.equal(s.cards[ids.play0[1]].zone, 'discard', 'Talking Clock (under it) stays in the discard');
});

// ---------- Dr. Facilier - Remarkable Gentleman + Friends on the Other Side ----------
oracle('2eabcb7046', 'the song resolves fully (draw 2) before Dreams Made Real', () => {
  const fac = byName('Dr. Facilier - Remarkable Gentleman'); const fot = byName('Friends on the Other Side');
  const { s, ids } = setup({ play0: [fac], hand0: [fot] });
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  assert.ok(s.pending, 'Dreams Made Real asks');
  assert.equal(s.players[0].hand.length, h - 1 + 2, 'already drew 2 when Facilier\'s ability resolves');
  drain(s, 'no');
});

// ---------- Dragon Gem ----------
oracle('df9cacbefa', 'Alice - Growing Girl in the discard has no Support → not a Dragon Gem target', () => {
  const gem = byName('Dragon Gem'); const alice = byName('Alice - Growing Girl'); const hh = byName('Heihei - Boat Snack');
  const { s, ids } = setup({ play0: [alice] });
  const g = put(s, 0, gem, 'play');
  const a2 = put(s, 0, alice, 'discard'); const h = put(s, 0, hh, 'discard');
  ok(applyAction(s, 0, { type: 'useAbility', iid: g, index: 0 }));
  if (s.pending?.valid?.length) {
    assert.ok(!s.pending.valid.includes(a2), 'Alice not offered');
    assert.ok(s.pending.valid.includes(h), 'Heihei (Support) offered');
    choose(s, h);
  }
  drain(s, 'no');
  assert.equal(s.cards[a2].zone, 'discard');
  assert.equal(s.cards[h].zone, 'hand');
});

// ---------- Fairy Godmother - Mystic Armorer ----------
oracle('0706ff2be7', 'characters played after the quest don\'t gain Challenger +3', () => {
  const fg = byName('Fairy Godmother - Mystic Armorer'); const maui = byName('Maui - Hero to All'); const one = vanilla((d) => d.cost === 1);
  const { s, ids } = setup({ play0: [fg, one], hand0: [maui] });
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s, 'no');
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
  assert.equal(kw(s, ids.play0[1]).challenger, 3, 'a character in play at the quest gains Challenger +3');
  assert.ok(!kw(s, ids.hand0[0]).challenger, 'Maui, played after, does not');
});

// ---------- Fan the Flames + Elsa - Spirit of Winter ----------
oracle('bca5cb5381', 'characters held by Deep Freeze can still be readied by Fan the Flames', () => {
  const elsa = byName('Elsa - Spirit of Winter'); const fan = byName('Fan the Flames'); const a = vanilla((d) => d.cost === 2); const b = vanilla((d) => d.cost === 3);
  const { s, ids } = setup({ hand0: [elsa], play1: [a, b], hand1: [fan] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  for (const t of ids.play1) if (s.pending?.valid?.includes(t)) choose(s, t);
  drain(s, 'no');
  assert.ok(ids.play1.every((t) => s.cards[t].exerted), 'both exerted');
  giveInk(s, 1, 1); passTo(s, 1);
  assert.ok(ids.play1.every((t) => s.cards[t].exerted), "they didn't ready at the start of the turn");
  ok(applyAction(s, 1, { type: 'play', iid: ids.hand1[0] })); choose(s, ids.play1[0]); drain(s, 'no');
  assert.equal(s.cards[ids.play1[0]].exerted, false, 'Fan the Flames readied it');
});

// ---------- Fishbone Quill ----------
oracle('7715f815cb', "Fishbone Quill: the card put into the inkwell isn't shown to the opponent", () => {
  const q = byName('Fishbone Quill'); const secret = byName('Mickey Mouse - Artful Rogue');   // no inkwell symbol
  const { s, ids } = setup({ hand0: [secret] });
  const item = put(s, 0, q, 'play');
  const evs = [];
  const r1 = ok(applyAction(s, 0, { type: 'useAbility', iid: item, index: 0 })); evs.push(...r1.events);
  if (s.pending) evs.push(...ok(applyAction(s, 0, { type: 'choose', target: ids.hand0[0] })).events);
  assert.equal(s.cards[ids.hand0[0]].zone, 'inkwell');
  const mv = evs.filter((e) => e.k === 'move' && e.iid === ids.hand0[0]);
  assert.ok(mv.length && mv.every((e) => e.privateTo === 0 || (!e.revealed && e.redacted)), `the move is private: ${JSON.stringify(mv)}`);
  assert.ok(!evs.some((e) => e.k === 'reveal' && e.iid === ids.hand0[0]), 'no reveal event');
  const seen = viewFor(s, 1).log.filter((l) => l.text.includes('Artful Rogue')).map((l) => l.text);
  assert.deepEqual(seen, [], "the opponent's log doesn't name the card");
});

// ---------- Flynn Rider - Charming Rogue + Jafar - Keeper of Secrets ----------
oracle('96c0cbffe6', 'Smolder discard happens before damage → Jafar deals 1', () => {
  const fl = byName('Flynn Rider - Charming Rogue'); const jaf = byName('Jafar - Keeper of Secrets');
  const { s, ids } = setup({ play0: [jaf], play1: [fl] });
  trimHand(s, 0, [], 2);
  assert.equal(s.players[0].hand.length, 2);
  s.cards[ids.play1[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }));
  assert.ok(s.pending && s.pending.seat === 0, 'the challenging player discards');
  choose(s, s.pending.valid[0]); drain(s, 'no');
  assert.equal(s.players[0].hand.length, 1);
  assert.equal(s.cards[ids.play1[0]].damage, 1, 'Flynn takes 1');
  assert.equal(s.cards[ids.play1[0]].zone, 'play');
});

// ---------- Flynn Rider - His Own Biggest Fan ----------
oracle('fdec9eb2f3', '-1 lore per card in opponents\' hands combined (2-player: 3 cards → 1 lore)', () => {
  const fl = byName('Flynn Rider - His Own Biggest Fan');
  const { s, ids } = setup({ play0: [fl] });
  trimHand(s, 1, [], 3);
  ok(applyAction(s, 0, { type: 'lore', seat: 0, delta: 0 }));
  assert.equal(eff(s, ids.play0[0]).lore, 1);
  trimHand(s, 1, [], 0);
  ok(applyAction(s, 0, { type: 'lore', seat: 0, delta: 0 }));
  assert.equal(eff(s, ids.play0[0]).lore, 4, 'empty hands → printed 4');
});

// ---------- Freeze + The Queen - Wicked and Vain ----------
oracle('f3af2de0f4', 'exerting The Queen with Freeze doesn\'t draw — the cost wasn\'t paid', () => {
  const fz = byName('Freeze'); const q = byName('The Queen - Wicked and Vain');
  const { s, ids } = setup({ hand0: [fz], play1: [q] });
  const h1 = s.players[1].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  if (s.pending?.valid?.includes(ids.play1[0])) choose(s, ids.play1[0]);
  drain(s, 'no');
  assert.equal(s.cards[ids.play1[0]].exerted, true);
  assert.equal(s.players[1].hand.length, h1, 'no card drawn');
});

// ---------- Friar Tuck - Priest of Nottingham ----------
oracle('3c8c7e02ac', 'hand counts after Friar Tuck is played: 3 vs 3 → both discard', () => {
  const ft = byName('Friar Tuck - Priest of Nottingham');
  const { s, ids } = setup({ hand0: [ft] });
  trimHand(s, 0, ids.hand0, 3); trimHand(s, 1, [], 3);
  assert.deepEqual([s.players[0].hand.length, s.players[1].hand.length], [4, 3]);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  for (let k = 0; k < 4 && s.pending; k++) choose(s, s.pending.valid[0]);
  assert.deepEqual([s.players[0].hand.length, s.players[1].hand.length], [2, 2], 'both discarded 1');
});

// ---------- Go the Distance ----------
oracle('0ea9fd78e2', 'Go the Distance with no damaged character → just draw', () => {
  const g = byName('Go the Distance'); const one = vanilla((d) => d.cost === 1);
  const { s, ids } = setup({ hand0: [g], play0: [one] });
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
  assert.equal(s.cards[ids.hand0[0]].zone, 'discard');
  assert.equal(s.players[0].hand.length, h - 1 + 1, 'drew a card');
});

// ---------- Gramma Tala - Spirit of the Ocean + Let It Go ----------
oracle('c15ad5ac3f', 'Gramma Tala put into the inkwell by Let It Go → no lore (also when shifted)', () => {
  const gt = byName('Gramma Tala - Spirit of the Ocean'); const gs = byName('Gramma Tala - Storyteller'); const lig = byName('Let It Go');
  const inkable = vanilla((d) => d.inkable);
  for (const shifted of [false, true]) {
    const { s, ids } = setup({ play0: shifted ? [gs] : [gt], hand0: shifted ? [gt, inkable] : [inkable], hand1: [lig] });
    let tala = ids.play0[0];
    if (shifted) { ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'shift', target: ids.play0[0] })); drain(s, 'no'); tala = ids.hand0[0]; }
    const l = s.players[0].lore;
    ok(applyAction(s, 0, { type: 'ink', iid: ids.hand0.at(-1) })); drain(s, 'no');
    assert.equal(s.players[0].lore - l, 1, 'control: inking a card → +1');
    giveInk(s, 1, 5); passTo(s, 1);
    const l2 = s.players[0].lore;
    ok(applyAction(s, 1, { type: 'play', iid: ids.hand1[0] })); choose(s, tala); drain(s, 'no');
    assert.equal(s.cards[tala].zone, 'inkwell');
    assert.equal(s.players[0].lore, l2, `${shifted ? 'shifted ' : ''}Gramma Tala left play first → no lore`);
  }
});

// ---------- Gramma Tala - Storyteller + Dr. Facilier - Agent Provocateur ----------
oracle('fea4aa8b4f', 'both trigger on the banish: you choose hand (Facilier) or inkwell (Tala)', () => {
  const gs = byName('Gramma Tala - Storyteller'); const fac = byName('Dr. Facilier - Agent Provocateur');
  const opp = vanilla((d) => d.str >= 1 && d.wp >= 3);
  for (const want of ['hand', 'inkwell']) {
    const { s, ids } = setup({ play0: [fac, gs], play1: [opp] });
    s.cards[ids.play1[0]].exerted = true;
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[1], target: ids.play1[0] }));
    for (let k = 0; k < 6 && s.pending; k++) {
      const accept = (pendSrcName(s) === fac.full) === (want === 'hand');
      if (accept) { if (s.pending.confirm) yes(s); else choose(s, s.pending.valid.includes(ids.play0[1]) ? ids.play0[1] : s.pending.valid[0]); } else no(s);
    }
    assert.equal(s.cards[ids.play0[1]].zone, want, `chose ${want}`);
  }
});

// ---------- Hiram Flaversham - Toymaker ----------
untestable('6a531d4897', 'tournament ban notice (Core/Infinity Constructed legality) — a deck-building rule, not a game state');

// ---------- Hydra - Deadly Serpent + Mouse Armor + Minnie ----------
oracle('813edbb69b', 'Resist +1 prevents Minnie\'s 1 damage → Watch the Teeth doesn\'t trigger', () => {
  const hy = byName('Hydra - Deadly Serpent'); const mn = byName('Minnie Mouse - Always Classy'); const ma = byName('Mouse Armor');
  const other = vanilla((d) => d.wp >= 4 && d.str <= 2);
  for (const armored of [true, false]) {
    const { s, ids } = setup({ play0: [hy], play1: [mn, other] });
    if (armored) { const a = put(s, 0, ma, 'play'); ok(applyAction(s, 0, { type: 'useAbility', iid: a, index: 0 })); choose(s, ids.play0[0]); }
    s.cards[ids.play1[0]].exerted = true;
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }));
    const asked = !!s.pending;
    if (s.pending?.valid?.includes(ids.play1[1])) choose(s, ids.play1[1]);
    drain(s, 'no');
    assert.equal(s.cards[ids.play0[0]].damage, armored ? 0 : 1);
    assert.equal(asked, !armored, armored ? 'no Watch the Teeth' : 'control: 1 damage → trigger');
    assert.equal(s.cards[ids.play1[1]].damage, armored ? 0 : 1);
  }
});

// ---------- It Calls Me ----------
oracle('aae17ba98a', 'It Calls Me can shuffle 0 of the opponent\'s discard', () => {
  const icm = byName('It Calls Me'); const one = vanilla((d) => d.cost === 1);
  const { s, ids } = setup({ hand0: [icm] });
  const d1 = [put(s, 1, one, 'discard'), put(s, 1, one, 'discard')];
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  for (let k = 0; k < 4 && s.pending; k++) {
    if (s.pending.valid?.some((x) => d1.includes(x))) { assert.ok(s.pending.optional, 'choosing discard cards is optional'); no(s); }
    else if (s.pending.confirm) yes(s); else choose(s, s.pending.valid[0]);
  }
  assert.ok(d1.every((x) => s.cards[x].zone === 'discard'), 'nothing shuffled');
});

// ---------- Jafar - Striking Illusionist ----------
oracle('b5ba31b57b', 'Jafar sings Friends on the Other Side → exerted already → +2 lore', () => {
  const jaf = byName('Jafar - Striking Illusionist'); const fot = byName('Friends on the Other Side');
  const { s, ids } = setup({ play0: [jaf], hand0: [fot] });
  const l = s.players[0].lore;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'sing', singers: [ids.play0[0]] })); drain(s, 'no');
  assert.equal(s.players[0].lore - l, 2);
});
oracle('5b02e2f896', 'Jafar readies before the turn\'s draw → no lore from that draw', () => {
  const jaf = byName('Jafar - Striking Illusionist');
  const { s, ids } = setup({ play0: [jaf] });
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s, 'no');
  const l = s.players[0].lore;
  passTo(s, 1); passTo(s, 0);
  assert.equal(s.cards[ids.play0[0]].exerted, false);
  assert.equal(s.players[0].lore, l, 'the draw-step draw gains nothing');
});

// ---------- Jim Hawkins - Space Traveler ----------
oracle('5fb5376d06', 'a location played with This Is It! → Jim may move there with Take the Helm', () => {
  const jim = byName('Jim Hawkins - Space Traveler');
  const loc = all.find((d) => d.type === 'location' && d.cost <= 4 && d.procs.every((p) => p.kind !== 'triggered'));
  const { s, ids } = setup({ hand0: [jim, loc] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  for (let k = 0; k < 6 && s.pending; k++) { if (s.pending.confirm) yes(s); else choose(s, s.pending.valid.includes(ids.hand0[1]) ? ids.hand0[1] : s.pending.valid[0]); }
  assert.equal(s.cards[ids.hand0[1]].zone, 'play', `${loc.full} played for free`);
  assert.equal(s.cards[ids.hand0[0]].atLocation, ids.hand0[1], 'Jim moved there');
});

// ---------- Kida - Protector of Atlantis ----------
oracle('64c4768e1d', 'Kida\'s -3 {S} only affects characters in play when she was played', () => {
  const kida = byName('Kida - Protector of Atlantis'); const maui = byName('Maui - Hero to All'); const there = vanilla((d) => d.str >= 4);
  const { s, ids } = setup({ hand0: [kida], play1: [there], hand1: [maui] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
  giveInk(s, 1, 5); passTo(s, 1);
  ok(applyAction(s, 1, { type: 'play', iid: ids.hand1[0] })); drain(s, 'no');
  assert.equal(eff(s, ids.play1[0]).str, there.str - 3, 'in play when Kida was played → -3');
  assert.equal(eff(s, ids.hand1[0]).str, maui.str, 'Maui played later → full strength');
});

// ---------- King Louie - Jungle VIP ----------
oracle('f2eaa1d413', 'Louie (6 damage) and the 2-{S} defender are banished together → no heal', () => {
  const kl = byName('King Louie - Jungle VIP'); const two = vanilla((d) => d.str === 2 && d.wp <= 3);
  const { s, ids } = setup({ play0: [kl], play1: [two] });
  s.cards[ids.play0[0]].damage = 6; s.cards[ids.play1[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }));
  drain(s, 'yes');
  assert.equal(s.cards[ids.play1[0]].zone, 'discard');
  assert.equal(s.cards[ids.play0[0]].zone, 'discard', 'King Louie is banished too');
});

// ---------- Lady Tremaine - Imperious Queen ----------
oracle('5f451e0b1b', 'the opponent chooses → Ward doesn\'t stop Prince John from being chosen', () => {
  const lt = byName('Lady Tremaine - Imperious Queen'); const lilo = byName('Lilo - Making a Wish'); const pj = byName('Prince John - Greediest of All');
  const { s, ids } = setup({ hand0: [lt], play1: [lilo, pj] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  assert.ok(s.pending && s.pending.seat === 1, 'the opponent chooses');
  assert.ok(s.pending.valid.includes(ids.play1[0]) && s.pending.valid.includes(ids.play1[1]), 'either character');
  choose(s, ids.play1[1]); drain(s, 'no');
  assert.equal(s.cards[ids.play1[1]].zone, 'discard', 'Prince John banished');
  assert.equal(s.cards[ids.play1[0]].zone, 'play');
});

// ---------- Let the Storm Rage On ----------
oracle('04001ba641', 'Let the Storm Rage On with no characters in play → just draw', () => {
  const g = byName('Let the Storm Rage On');
  const { s, ids } = setup({ hand0: [g] });
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
  assert.equal(s.cards[ids.hand0[0]].zone, 'discard');
  assert.equal(s.players[0].hand.length, h - 1 + 1);
});

// ---------- Lucifer - Cunning Cat ----------
oracle('3c6dc605bb', 'no action in hand → must discard 2 (all you have: the 1 character)', () => {
  const luc = byName('Lucifer - Cunning Cat');
  const { s, ids } = setup({ hand0: [luc] });
  trimHand(s, 1, [], 1);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  for (let k = 0; k < 4 && s.pending; k++) {
    const p = s.pending;
    if (p.choices) { const r = applyAction(s, p.seat, { type: 'choose', option: 1 }); if (!r.ok) choose1(s); }   // try to pick "1 action card"
    else if (p.valid?.length) choose(s, p.valid[0]); else no(s);
  }
  assert.equal(s.players[1].hand.length, 0, 'the only card was discarded');
});
function choose1(s) { ok(applyAction(s, s.pending.seat, { type: 'choose', option: 0 })); }

// ---------- Lucky - The 15th Puppy ----------
oracle('845e847a95', 'Good As New: all revealed cost-2-or-less characters or none', () => {
  const lucky = byName('Lucky - The 15th Puppy');
  const { s, ids } = setup({ play0: [lucky] });
  const top = s.players[0].deck.slice(0, 3);
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 }));
  assert.ok(s.pending, 'asks');
  // try to take only one of the revealed cards
  const p = s.pending;
  let picked = 0;
  if (p.confirm) yes(s);
  else if (p.valid?.length) { choose(s, p.valid[0]); picked++; while (s.pending && s.pending.optional && !s.pending.confirm) { no(s); break; } }
  drain(s, 'no');
  const got = s.players[0].hand.length - h;
  assert.ok(got === 0 || got === top.length, `took ${got} of ${top.length} eligible cards — must be all or none`);
});

// ---------- Madam Mim - Rival of Merlin + Arthur ----------
// Played with Gruesome and Grim, returned by Arthur (then, in the second oracle, played again from hand): the card is
// a new object after it changes zones (CR 1.x), so Mim's "banish them at the end of the turn" no longer refers to it.
const mimCase = (replay) => () => {
  const mim = byName('Madam Mim - Rival of Merlin'); const art = byName("Arthur - Wizard's Apprentice"); const ch = vanilla((d) => d.cost === 3);
  const { s, ids } = setup({ play0: [mim, art], hand0: [ch] });
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: mim.procs.findIndex((p) => p.kind === 'activated') }));
  if (s.pending?.valid?.includes(ids.hand0[0])) choose(s, ids.hand0[0]);
  drain(s, 'no');
  assert.equal(s.cards[ids.hand0[0]].zone, 'play');
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[1] }));
  if (s.pending?.confirm) yes(s);
  choose(s, ids.hand0[0]); drain(s, 'no');
  assert.equal(s.cards[ids.hand0[0]].zone, 'hand', 'Arthur returned it');
  if (replay) { ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no'); }
  ok(applyAction(s, 0, { type: 'endTurn', force: true })); drain(s, 'no');
  assert.equal(s.cards[ids.hand0[0]].zone, replay ? 'play' : 'hand', replay ? 'replayed from hand → a new character, Mim\'s end-of-turn banish must not hit it' : 'still in hand');
};
oracle('e40d30af86', 'a Gruesome and Grim character returned to hand isn\'t banished at end of turn', mimCase(false));
oracle('e40d30af86', '… nor after it is played again from hand that turn (a new character)', mimCase(true));

// ---------- Magic Broom - Bucket Brigade + 2 Mickey Mouse - Wayward Sorcerer ----------
oracle('c69ac76893', '2 Wayward Sorcerers → Broom costs 2 less', () => {
  const mb = byName('Magic Broom - Swift Cleaner'); const mm = byName('Mickey Mouse - Wayward Sorcerer'); const bb = byName('Magic Broom - Bucket Brigade');
  for (const n of [1, 2]) {
    const { s, ids } = setup({ play0: Array(n).fill(mm), hand0: [bb, mb] });
    let before = inkReady(s, 0);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
    assert.equal(before - inkReady(s, 0), bb.cost - n, `Bucket Brigade with ${n} Mickey(s)`);
    before = inkReady(s, 0);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] })); drain(s, 'no');
    assert.equal(before - inkReady(s, 0), mb.cost - n, `Swift Cleaner with ${n} Mickey(s)`);
  }
});

// ---------- Magic Broom - Dancing Duster ----------
oracle('b8dfbaa538', 'Power Clean can choose an already exerted character; it still doesn\'t ready', () => {
  const md = byName('Magic Broom - Dancing Duster'); const mm = byName('Mickey Mouse - Wayward Sorcerer'); const opp = vanilla((d) => d.cost === 2);
  const { s, ids } = setup({ play0: [mm], hand0: [md], play1: [opp] });
  s.cards[ids.play1[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  if (s.pending?.confirm) yes(s);
  assert.ok(s.pending?.valid?.includes(ids.play1[0]), 'the exerted character can be chosen');
  choose(s, ids.play1[0]); drain(s, 'no');
  passTo(s, 1);
  assert.equal(s.cards[ids.play1[0]].exerted, true, "can't ready at the start of their next turn");
});

// ---------- Magic Broom - Swift Cleaner ----------
oracle('0aaf2f7cc1', 'Clean This, Clean That shuffles cards with the Broom classification only', () => {
  const sc = byName('Magic Broom - Swift Cleaner'); const bb = byName('Magic Broom - Bucket Brigade'); const one = vanilla((d) => d.cost === 1);
  const { s, ids } = setup({ hand0: [sc] });
  const broom = put(s, 0, bb, 'discard'); const not = put(s, 0, one, 'discard');
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  if (s.pending?.confirm) yes(s);
  drain(s, 'no');
  assert.equal(s.cards[broom].zone, 'deck', 'Broom card shuffled in');
  assert.equal(s.cards[not].zone, 'discard', 'non-Broom card stays');
});
