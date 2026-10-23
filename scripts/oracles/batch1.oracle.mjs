// Batch 1: Attack of the Vine release notes (Woody … Dash & Violet) and Fabled release notes (Stitch … Powerline).
import { assert, applyAction, checkInvariants, all, byName, ok, setup, oracle, untestable, vanilla, put, giveInk, drain, choose, yes, no, passTo, settle, eff, kw } from './lib.mjs';

const inkReady = (s, seat) => s.players[seat].inkwell.filter((iid) => !s.cards[iid].exerted).length + (s.players[seat].inkDrops || 0);
// keep only `keep` in a player's hand — the rest goes back into the deck
const trimHand = (s, seat, keep = []) => {
  const p = s.players[seat];
  for (const iid of [...p.hand]) if (!keep.includes(iid)) { p.hand.splice(p.hand.indexOf(iid), 1); s.cards[iid].zone = 'deck'; p.deck.push(iid); }
};
// a plain character by name (no Shift of its own), for Shift bases
const base = (name, f = () => true) => all.find((d) => d.type === 'character' && d.name === name && !d.shifts && d.procs.every((p) => p.kind === 'keyword' || p.exec) && f(d));
// put a card of `def` under `parent` (faceDown as given)
const under = (s, parent, def, faceDown) => {
  const seat = s.cards[parent].owner;
  const iid = put(s, seat, def, 'discard');
  const p = s.players[seat]; p.discard.splice(p.discard.indexOf(iid), 1);
  Object.assign(s.cards[iid], { zone: 'under', parent, faceDown });
  s.cards[parent].under.push(iid);
  return iid;
};
const shift = (s, a) => applyAction(s, 0, { type: 'play', mode: 'shift', ...a });
// statics re-apply on any action — a no-op lore change triggers the game state check
const touch = (s) => ok(applyAction(s, 0, { type: 'lore', seat: 0, delta: 0 }));

// ───────────────────────────── Attack of the Vine ─────────────────────────────

oracle('26a71c151f', 'Woody with another Toy: return from discard first, then play cost ≤2 for free', () => {
  const woody = byName('Woody - Helping a Friend');
  const toy = all.find((d) => d.type === 'character' && d.classes.includes('toy') && !d.abilities.length);
  const two = vanilla((d) => d.cost === 2 && !d.classes.includes('toy'));
  const { s, ids } = setup({ hand0: [woody], play0: [toy] });
  trimHand(s, 0, ids.hand0);
  const x = put(s, 0, two, 'discard');
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  // first: return a cost-2-or-less character card from discard
  assert.ok(s.pending?.valid?.includes(x), `first prompt is the return from discard: ${s.pending?.prompt}`);
  choose(s, x);
  assert.equal(s.cards[x].zone, 'hand', 'returned to hand');
  // then: play a cost-2-or-less character for free — the one just returned is there to be played
  assert.ok(s.pending?.valid?.includes(x), `second prompt is the free play: ${s.pending?.prompt}`);
  choose(s, x); drain(s, 'no');
  assert.equal(s.cards[x].zone, 'play', 'played for free');
  assert.equal(inkReady(s, 0), 10 - woody.cost, 'only Woody paid for');
});

oracle('43d8e92d1b', 'Sulley & Boo banished: faceup and facedown cards under it can both be played', () => {
  const sb = byName('Sulley & Boo - Scare Buddies'); const pa = byName('Piercing Attack');
  const a = vanilla((d) => d.cost === 2), b = vanilla((d) => d.cost === 3);
  const { s, ids } = setup({ play0: [sb], hand0: [pa] });
  const up = under(s, ids.play0[0], a, false), down = under(s, ids.play0[0], b, true);
  s.cards[ids.play0[0]].damage = sb.wp - 2;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); choose(s, ids.play0[0]);
  assert.equal(s.cards[ids.play0[0]].zone, 'discard', 'Sulley & Boo banished');
  drain(s, 'yes');
  assert.equal(s.cards[up].zone, 'play', 'the faceup card was played');
  assert.equal(s.cards[down].zone, 'play', 'the facedown card was played');
  assert.equal(s.cards[down].faceDown, false);
  checkInvariants(s);
});

oracle('320480fecc', 'two Winnie the Pooh - Hunny Archmage count each other as "other Hunny"', () => {
  const pooh = byName('Winnie the Pooh - Hunny Archmage'); const piglet = byName('Piglet - Hunny Mage Apprentice');
  { const { s, ids } = setup({ play0: [pooh, pooh, piglet] }); touch(s);
    assert.equal(eff(s, ids.play0[0]).lore, pooh.lore + 2); assert.equal(eff(s, ids.play0[1]).lore, pooh.lore + 2); }
  { const { s, ids } = setup({ play0: [pooh, piglet] }); touch(s);
    assert.equal(eff(s, ids.play0[0]).lore, pooh.lore, 'control: only 1 other Hunny'); }
});

oracle('4ee247f5e0', 'Merida - Wisp Conjurer enters play exerted (chosen as she is played) to draw', () => {
  const m = byName('Merida - Wisp Conjurer');
  // a second Merida in play: her Beckon sees the new one *enter play* exerted
  const { s, ids } = setup({ play0: [m], hand0: [m] });
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], enterExerted: true }));
  for (let k = 0; k < 6 && s.pending; k++) s.pending.confirm ? yes(s) : drain(s, 'yes');
  assert.equal(s.cards[ids.hand0[0]].exerted, true, 'entered exerted');
  assert.equal(s.players[0].hand.length - (h - 1), 2, 'drew 1 (Focused Energy) + 1 (the other Merida\'s Beckon: another character entered play exerted)');
});

oracle('bd23de30c6', 'Heihei (Floodborn) questing triggers his own Botanical Remedy', () => {
  const hh = byName('Heihei - Created by the Vine'); const mine = vanilla((d) => d.wp >= 3); const foe = vanilla((d) => d.wp >= 3);
  const { s, ids } = setup({ play0: [hh, mine], play1: [foe] });
  s.cards[ids.play0[1]].damage = 1;
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
  assert.ok(s.pending, 'Botanical Remedy triggered');
  for (let k = 0; k < 4 && s.pending; k++) {
    const p = s.pending;
    if (p.confirm) yes(s); else if (p.valid.includes(ids.play0[1])) choose(s, ids.play0[1]); else choose(s, ids.play1[0]);
  }
  assert.equal(s.cards[ids.play0[1]].damage, 0); assert.equal(s.cards[ids.play1[0]].damage, 1);
});

oracle('c0be48e422', 'Morph: a Puppy Shift character can shift onto him', () => {
  const morph = byName('Morph - Little Imitator'); const tb = byName('Thunderbolt - Wonder Dog');
  const plain = vanilla((d) => !d.classes.includes('puppy'));
  const { s, ids } = setup({ hand0: [tb], play0: [plain, morph] });
  assert.equal(shift(s, { iid: ids.hand0[0], target: ids.play0[0] }).ok, false, 'control: not onto a non-Puppy');
  ok(shift(s, { iid: ids.hand0[0], target: ids.play0[1] }));
  assert.deepEqual(s.cards[ids.hand0[0]].under, [ids.play0[1]]);
});

untestable('b748b799e9', 'deck-building rule (ink types allowed in a deck)');

oracle('555c98c78b', 'Winnie the Pooh & Piglet + another Amethyst character → 2 lore (2 ink types)', () => {
  const pp = byName('Winnie the Pooh & Piglet - Hunny Mages');
  const ame = vanilla((d) => d.inks.length === 1 && d.inks[0] === 'amethyst');
  const steel = vanilla((d) => d.inks.length === 1 && d.inks[0] === 'steel');
  for (const [extra, want] of [[[ame], 2], [[ame, steel], 3]]) {
    const { s, ids } = setup({ play0: [pp, ...extra] }); touch(s);
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s, 'no');
    assert.equal(s.players[0].lore, want, `${extra.length} other(s) → ${want}`);
  }
});

oracle('aeb8f775cd', 'With a Few Good Friends: a dual-ink character counts as both ink types', () => {
  const song = byName('With a Few Good Friends'); const pp = byName('Winnie the Pooh & Piglet - Hunny Mages');   // amethyst + sapphire
  const { s, ids } = setup({ play0: [pp], hand0: [song] });
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  for (let k = 0; k < 4 && s.pending; k++) { const p = s.pending; if (p.choices) { const i = p.choices.findIndex((c) => /P0|you/i.test(String(c.label ?? c))); ok(applyAction(s, 0, { type: 'choose', option: i >= 0 ? i : 0 })); } else drain(s, 'yes'); }
  assert.equal(s.players[0].hand.length - (h - 1), 2, 'drew 2: Amethyst and Sapphire');
});

oracle('302c167aed', 'One and Only on Hunny Wizard banishes Hunny Archmage (same name, any version)', () => {
  const wiz = byName('Winnie the Pooh - Hunny Wizard'), arch = byName('Winnie the Pooh - Hunny Archmage'), oao = byName('One and Only');
  const other = vanilla((d) => d.name !== 'Winnie the Pooh');
  const { s, ids } = setup({ play1: [wiz, arch, other], hand0: [oao] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); choose(s, ids.play1[0]); drain(s, 'no');
  assert.equal(s.cards[ids.play1[1]].zone, 'discard', 'Archmage banished');
  assert.equal(s.cards[ids.play1[0]].zone, 'play', 'the chosen one stays');
  assert.equal(s.cards[ids.play1[2]].zone, 'play', 'differently named stays');
});

oracle('7e68b254f3', 'Narrow Escape: up to 2 targets each cost ≤2 (a cost 1 and a cost 2)', () => {
  const ne = byName('Narrow Escape');
  const one = vanilla((d) => d.cost === 1), two = vanilla((d) => d.cost === 2), three = vanilla((d) => d.cost === 3);
  const { s, ids } = setup({ play1: [one, two, three], hand0: [ne] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  assert.ok(!s.pending.valid.includes(ids.play1[2]), 'cost 3 not eligible');
  choose(s, ids.play1[0]); choose(s, ids.play1[1]); drain(s, 'no');
  assert.equal(s.cards[ids.play1[0]].zone, 'hand'); assert.equal(s.cards[ids.play1[1]].zone, 'hand');
  assert.equal(s.cards[ids.play1[2]].zone, 'play');
});

oracle('9647304f66', 'two Roo - Hunny Rogue give each other Evasive', () => {
  const roo = byName('Roo - Hunny Rogue');
  { const { s, ids } = setup({ play0: [roo, roo] }); touch(s);
    assert.ok(kw(s, ids.play0[0]).evasive && kw(s, ids.play0[1]).evasive, 'both Evasive'); }
  { const { s, ids } = setup({ play0: [roo] }); touch(s);
    assert.ok(!kw(s, ids.play0[0]).evasive, 'control: alone → no Evasive'); }
});

oracle('51187cbfa1', 'Posey (Potato Shift) can shift onto Morph', () => {
  const morph = byName('Morph - Little Imitator'), posey = byName('Posey - Vampire Potato');
  const { s, ids } = setup({ hand0: [posey], play0: [morph] });
  ok(shift(s, { iid: ids.hand0[0], target: ids.play0[0] }));
  assert.deepEqual(s.cards[ids.hand0[0]].under, [ids.play0[0]]);
  assert.equal(s.players[0].inkwell.filter((i) => s.cards[i].exerted).length, 5);
});

oracle('69c664bed5', 'Duo Shift can\'t go onto a single Mickey Mouse & Minnie Mouse', () => {
  const duo = byName('Mickey Mouse & Minnie Mouse - Adventuring Duo');
  const { s, ids } = setup({ hand0: [duo], play0: [duo] });
  assert.equal(shift(s, { iid: ids.hand0[0], target: ids.play0[0] }).ok, false, 'target');
  assert.equal(shift(s, { iid: ids.hand0[0], targets: [ids.play0[0]] }).ok, false, 'targets');
  assert.equal(s.cards[ids.hand0[0]].zone, 'hand');
});

const comboState = (top, nameA, nameB) => () => {
  const d = byName(top); const A = base(nameA), B = base(nameB);
  { const { s, ids } = setup({ hand0: [d], play0: [A, B] });
    s.cards[ids.play0[1]].drying = true;
    ok(shift(s, { iid: ids.hand0[0], targets: ids.play0 })); drain(s, 'no');
    assert.equal(s.cards[ids.hand0[0]].drying, true, 'dry + drying → drying'); }
  { const { s, ids } = setup({ hand0: [d], play0: [A, B] });
    s.cards[ids.play0[1]].exerted = true;
    ok(shift(s, { iid: ids.hand0[0], targets: ids.play0 })); drain(s, 'no');
    assert.equal(s.cards[ids.hand0[0]].exerted, true, 'ready + exerted → exerted');
    assert.equal(s.cards[ids.hand0[0]].drying, false, 'both dry → dry'); }
};
oracle('a86b7f0621', 'Duo Shift onto dry + drying → drying; ready + exerted → exerted', comboState('Mickey Mouse & Minnie Mouse - Adventuring Duo', 'Mickey Mouse', 'Minnie Mouse'));

oracle('b203aa11d0', 'Piercing Attack on Omnidroid (Resist +2) → 2 damage', () => {
  const omni = byName('Omnidroid - Ultimate Iteration'), pa = byName('Piercing Attack');
  const plain = all.find((d) => d.type === 'action' && d.procs.length === 1 && JSON.stringify(d.procs[0].do) === JSON.stringify([{ fn: 'damage', n: 2, sel: { chosen: { types: ['character'] } } }]));
  for (const [card, want] of [[pa, 2], [plain, 0]]) {
    const { s, ids } = setup({ play1: [omni], hand0: [card] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); choose(s, ids.play1[0]); drain(s, 'no');
    assert.equal(s.cards[ids.play1[0]].damage, want, `${card.full}: ${want}`);
  }
});

oracle('a9d984e756', 'Boo challenges Piglet (2 str) → Piglet banished before damage, Boo takes none', () => {
  const boo = byName('Boo - Energetic Child'), piglet = byName('Piglet - Hunny Mage Apprentice');
  const { s, ids } = setup({ play0: [boo], play1: [piglet] });
  s.cards[ids.play1[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] })); drain(s, 'yes');
  assert.equal(s.cards[ids.play1[0]].zone, 'discard', 'Piglet banished');
  assert.equal(s.cards[ids.play0[0]].zone, 'play', 'Boo (1 willpower) survives');
  assert.equal(s.cards[ids.play0[0]].damage, 0, 'no challenge damage dealt');
});

oracle('0455f9c80b', 'Ming Lee readied by Path of Destruction stays in the challenge', () => {
  const ming = byName('Ming Lee - Giant Red Panda'); const foe = vanilla((d) => d.str >= 2 && d.wp <= 5);
  const { s, ids } = setup({ play0: [ming], play1: [foe] });
  s.cards[ids.play1[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] })); drain(s, 'yes');
  assert.equal(s.cards[ids.play0[0]].exerted, false, 'readied');
  assert.equal(s.cards[ids.play0[0]].damage, foe.str, 'still took challenge damage');
  assert.equal(s.cards[ids.play1[0]].zone, 'discard', 'still dealt challenge damage');
  assert.equal(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }).ok, false, "can't quest");
});

// a deck of exactly one card (the rest goes to the discard), so "shuffle, reveal the top card" is known
const deckOf = (s, seat, def) => {
  const p = s.players[seat];
  const iid = put(s, seat, def, 'discard'); p.discard.splice(p.discard.indexOf(iid), 1);
  for (const id of p.deck) { s.cards[id].zone = 'discard'; p.discard.push(id); }
  p.deck = [iid]; s.cards[iid].zone = 'deck';
  return iid;
};
oracle('e1159aeaba', 'Prophetic Vision: playing the revealed action → no lore gain/loss; declining → gain/loss', () => {
  const pv = byName('Prophetic Vision'), freeze = byName('Freeze'); const foe = vanilla();
  const go = (play) => {
    const { s, ids } = setup({ hand0: [pv], play1: [foe] });
    s.players[1].lore = 3;
    const top = deckOf(s, 0, freeze);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    for (let k = 0; k < 6 && s.pending; k++) { const p = s.pending; if (p.confirm || (p.optional && p.valid.includes(top))) play ? (p.confirm ? yes(s) : choose(s, top)) : no(s); else if (p.valid.includes(ids.play1[0])) choose(s, ids.play1[0]); else drain(s, 'yes'); }
    return { s, top, foe: ids.play1[0] };
  };
  { const { s, top, foe: f } = go(true);
    assert.equal(s.cards[top].zone, 'discard', 'Freeze played'); assert.equal(s.cards[f].exerted, true);
    assert.deepEqual([s.players[0].lore, s.players[1].lore], [0, 3], 'no lore change'); }
  { const { s, top } = go(false);
    assert.equal(s.cards[top].zone, 'deck');
    assert.deepEqual([s.players[0].lore, s.players[1].lore], [1, 2], 'declined → +1 / −1'); }
});

oracle('2cbb9c588b', 'Look What You\'ve Done going to discard after resolving is not "discarding" it', () => {
  const lw = byName("Look What You've Done"); const foe = vanilla((d) => d.wp >= 4);
  { // control: discarding it from hand during my turn (Freeze the Vine) does offer the replay
    const fv = byName('Freeze the Vine');
    const { s, ids } = setup({ hand0: [fv, lw], play1: [foe] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    choose(s, ids.hand0[1]);
    assert.ok(s.pending?.confirm && /Look What/.test(s.pending.prompt), 'discarded → may play it from discard');
    no(s);
  }
  const { s, ids } = setup({ hand0: [lw], play1: [foe] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  if (s.pending?.valid?.includes(ids.play1[0])) choose(s, ids.play1[0]);
  assert.equal(s.pending, null, 'no offer to play it again');
  assert.equal(s.cards[ids.hand0[0]].zone, 'discard');
  assert.equal(s.cards[ids.play1[0]].damage, 2, 'its 2 damage was dealt (the premise: "after dealing damage")');
});

oracle('93c78b9ce3', 'Combo Shift onto dry + drying → drying; ready + exerted → exerted', comboState('Dash Parr & Violet Parr - Super Siblings', 'Dash Parr', 'Violet Parr'));

// ───────────────────────────── Fabled ─────────────────────────────

oracle('107c76f419', 'Lantern reduces the ink paid, not the cost: a cost-3 character doesn\'t trigger Adoring Fans', () => {
  const stitch = byName('Stitch - Rock Star'), lantern = byName('Lantern');
  const three = vanilla((d) => d.cost === 3), two = vanilla((d) => d.cost === 2);
  for (const [c, fires] of [[three, false], [two, true]]) {
    const { s, ids } = setup({ play0: [stitch, lantern], hand0: [c] });
    ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[1], index: 0 })); drain(s);
    const before = inkReady(s, 0);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    assert.equal(before - inkReady(s, 0), c.cost - 1, 'Lantern: 1 less');
    assert.equal(!!s.pending, fires, `cost ${c.cost}: Adoring Fans ${fires ? 'offered' : 'must not trigger'}`);
    drain(s, 'no');
  }
});

oracle('f213bec6ed', '3 Pongo - Determined Father: Twilight Bark once per copy', () => {
  const pongo = byName('Pongo - Determined Father');
  const { s, ids } = setup({ play0: [pongo, pongo, pongo] });
  for (const iid of ids.play0) { ok(applyAction(s, 0, { type: 'useAbility', iid, index: 0 })); drain(s, 'yes'); }
  assert.equal(10 - inkReady(s, 0), 6, '3 uses × 2 ink');
  assert.equal(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 }).ok, false, 'a 4th use on the same copy is refused');
});

oracle('c6f79ae3c9', 'The Queen exerted by an effect: no draw, and I Summon Thee unusable until readied', () => {
  const q = byName('The Queen - Wicked and Vain'), u = byName('Ursula - Sea Witch Queen');
  const { s, ids } = setup({ play0: [q, u] });
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[1] }));
  choose(s, ids.play0[0]); drain(s, 'no');
  assert.equal(s.cards[ids.play0[0]].exerted, true);
  assert.equal(s.players[0].hand.length, h, 'no draw');
  assert.equal(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 }).ok, false, 'can\'t pay the exert cost');
});

oracle('d4041638ae', 'Ursula - Sea Witch: You\'re Too Late may choose a ready character, and doesn\'t exert it', () => {
  const urs = byName('Ursula - Sea Witch'); const foe = vanilla();
  const { s, ids } = setup({ play0: [urs], play1: [foe] });
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
  assert.ok(s.pending?.valid?.includes(ids.play1[0]), 'the ready character is a valid choice');
  choose(s, ids.play1[0]); drain(s, 'no');
  assert.equal(s.cards[ids.play1[0]].exerted, false, 'not exerted');
  passTo(s, 1);
  assert.equal(s.cards[ids.play1[0]].exerted, false);
  ok(applyAction(s, 1, { type: 'quest', iid: ids.play1[0] }));
});

oracle('613315b3ca', 'Jafar (2 cards in hand) challenges Flynn Rider: discard first → Jafar deals 1', () => {
  const jafar = byName('Jafar - Keeper of Secrets'), flynn = byName('Flynn Rider - Charming Rogue');
  const { s, ids } = setup({ play0: [jafar], play1: [flynn] });
  trimHand(s, 0, s.players[0].hand.slice(0, 2));
  s.cards[ids.play1[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }));
  for (let k = 0; k < 4 && s.pending; k++) { const p = s.pending; ok(applyAction(s, p.seat, { type: 'choose', target: p.valid[0] })); }
  assert.equal(s.players[0].hand.length, 1, 'discarded 1');
  assert.equal(s.cards[ids.play1[0]].zone, 'play', 'Flynn (2 wp) survives');
  assert.equal(s.cards[ids.play1[0]].damage, 1, 'Jafar had +1 strength');
});

oracle('de07c4dcbf', 'Deep Freeze only stops the Ready step: Fan the Flames can ready them on their turn', () => {
  const elsa = byName('Elsa - Spirit of Winter'), fan = byName('Fan the Flames'); const a = vanilla(), b = vanilla((d) => d.full !== a.full);
  const { s, ids } = setup({ hand0: [elsa], play1: [a, b], hand1: [fan] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  choose(s, ids.play1[0]); choose(s, ids.play1[1]); drain(s, 'no');
  giveInk(s, 1, 2);
  passTo(s, 1);
  assert.ok(s.cards[ids.play1[0]].exerted && s.cards[ids.play1[1]].exerted, 'not readied in the Ready step');
  ok(applyAction(s, 1, { type: 'play', iid: ids.hand1[0] })); choose(s, ids.play1[0]); drain(s, 'no');
  assert.equal(s.cards[ids.play1[0]].exerted, false, 'Fan the Flames readied it');
});

oracle('ab26009c13', 'Mickey - Trumpeter: Sound the Call can play a character with Shift (ink-only Shift) for free', () => {
  const mickey = byName('Mickey Mouse - Trumpeter'), rock = byName('Stitch - Rock Star'); const st = base('Stitch');
  const { s, ids } = setup({ play0: [mickey, st], hand0: [rock] });
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 }));
  for (let k = 0; k < 6 && s.pending; k++) {
    const p = s.pending;
    if (p.valid?.includes(ids.hand0[0])) choose(s, ids.hand0[0]);
    else if (p.valid?.includes(ids.play0[1])) choose(s, ids.play0[1]);            // the Shift target, if asked
    else if (p.choices) { const i = p.choices.findIndex((c) => /shift/i.test(JSON.stringify(c))); ok(applyAction(s, 0, { type: 'choose', option: Math.max(0, i) })); }
    else drain(s, 'no');
  }
  assert.equal(s.cards[ids.hand0[0]].zone, 'play');
  assert.deepEqual(s.cards[ids.hand0[0]].under, [ids.play0[1]], 'played using Shift, on top of Stitch');
  assert.equal(10 - inkReady(s, 0), 2, 'only the ability\'s 2 ink');
});

oracle('bf71cfafe3', 'Donald Duck - Perfect Gentleman: I decline the draw, the opponent still may draw', () => {
  const dd = byName('Donald Duck - Perfect Gentleman');
  const { s } = setup({ play0: [dd] });
  ok(applyAction(s, 0, { type: 'endTurn', force: true })); drain(s, 'no');
  ok(applyAction(s, 1, { type: 'endTurn', force: true }));
  const h = [s.players[0].hand.length, s.players[1].hand.length];
  for (let k = 0; k < 4 && s.pending; k++) s.pending.seat === 0 ? no(s) : yes(s);
  assert.equal(s.players[0].hand.length - h[0], 1, 'I declined: only the draw-step card');
  assert.equal(s.players[1].hand.length - h[1], 1, 'opponent drew');
});

oracle('b4c9490208', 'Grand Pabbie: removing damage from 3 characters at once → 6 lore', () => {
  const gp = byName('Grand Pabbie - Oldest and Wisest'), fa = byName('First Aid'); const a = vanilla((d) => d.wp >= 3), b = vanilla((d) => d.wp >= 3 && d.full !== a.full);
  const { s, ids } = setup({ play0: [gp, a, b], hand0: [fa] });
  for (const iid of ids.play0) s.cards[iid].damage = 1;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'yes');
  assert.ok(ids.play0.every((iid) => s.cards[iid].damage === 0));
  assert.equal(s.players[0].lore, 6);
});

oracle('71131fb1b7', 'Pluto - Determined Defender: may remove 0 of the "up to 3" damage', () => {
  const pl = byName('Pluto - Determined Defender');
  const { s, ids } = setup({ play0: [pl] });
  s.cards[ids.play0[0]].damage = 3;
  ok(applyAction(s, 0, { type: 'endTurn', force: true })); drain(s, 'no');
  ok(applyAction(s, 1, { type: 'endTurn', force: true }));
  assert.ok(s.pending, 'asked how much to remove');
  for (let k = 0; k < 4 && s.pending; k++) {
    const p = s.pending;
    if (p.choices) { const i = p.choices.findIndex((c) => /\b0\b|none|no/i.test(JSON.stringify(c))); ok(applyAction(s, 0, { type: 'choose', option: i >= 0 ? i : 0 })); }
    else no(s);
  }
  assert.equal(s.cards[ids.play0[0]].damage, 3, 'kept all 3 damage');
});

oracle('ac0c607895', 'Pluto - Determined Defender: Shift + Bodyguard → enters exerted', () => {
  const pl = byName('Pluto - Determined Defender'); const b0 = base('Pluto');
  const { s, ids } = setup({ play0: [b0], hand0: [pl] });
  ok(shift(s, { iid: ids.hand0[0], target: ids.play0[0], enterExerted: true })); drain(s, 'no');
  assert.equal(s.cards[ids.hand0[0]].shifted, true);
  assert.equal(s.cards[ids.hand0[0]].exerted, true);
});

oracle('c8231aad36', 'Shell Necklace: overpaying a song with a singer\'s cost makes no ink for Now, Sing!', () => {
  const nk = byName("Ursula's Shell Necklace");
  const song = all.find((d) => d.type === 'song' && d.cost === 2 && !d.kw?.singTogether && d.procs.every((p) => p.exec) && /draw|lore/i.test(JSON.stringify(d.procs)) && !/chosen/i.test(JSON.stringify(d.procs)));
  const singer = vanilla((d) => d.cost === 3);
  for (const [ink, draws] of [[0, false], [1, true]]) {
    const { s, ids } = setup({ play0: [nk, singer], hand0: [song], ink0: ink });
    const h = s.players[0].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'sing', singers: [ids.play0[1]] }));
    const songDraw = s.players[0].hand.length - (h - 1);
    for (let k = 0; k < 4 && s.pending; k++) s.pending.confirm ? yes(s) : drain(s, 'yes');
    assert.equal(s.players[0].hand.length - (h - 1) - songDraw, draws ? 1 : 0, `${ink} ink → ${draws ? 'draw' : 'no draw'}`);
  }
});

oracle('adcbc53099', 'Queen of Hearts draw on challenge declaration → Jafar has +2 → Flounder takes 2', () => {
  const qoh = byName('Queen of Hearts - Sensing Weakness'), jafar = byName('Jafar - Keeper of Secrets'), fl = byName('Flounder - Voice of Reason');
  const { s, ids } = setup({ play0: [qoh, jafar], play1: [fl] });
  trimHand(s, 0, s.players[0].hand.slice(0, 1));
  s.cards[ids.play1[0]].exerted = true;
  const dmg = [];
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[1], target: ids.play1[0] }));
  for (let k = 0; k < 4 && s.pending; k++) s.pending.confirm ? yes(s) : drain(s, 'yes');
  void dmg;
  assert.equal(s.players[0].hand.length, 2, 'drew');
  assert.equal(s.cards[ids.play1[0]].zone, 'discard', 'Flounder (2 wp) took 2 → banished');
  assert.ok(s.log.some((l) => /Flounder/.test(l.text) && /\b2\b/.test(l.text) && /damage/i.test(l.text)), '2 damage dealt');
});

oracle('c6293ec3e2', 'Dinner Bell on an undamaged character: draw 0, still banished', () => {
  const db = byName('Dinner Bell'); const v = vanilla();
  const { s, ids } = setup({ play0: [db, v] });
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 }));
  assert.ok(s.pending?.valid?.includes(ids.play0[1]), 'an undamaged character can be chosen');
  choose(s, ids.play0[1]); drain(s, 'no');
  assert.equal(s.players[0].hand.length, h, 'drew 0');
  assert.equal(s.cards[ids.play0[1]].zone, 'discard', 'banished');
});

oracle('b222ffbbc3', 'Last-Ditch Effort with only a Ward opponent: still give Challenger +2', () => {
  const lde = byName('Last-Ditch Effort'); const roo = byName('Roo - Hunny Rogue'); const mine = vanilla();
  const { s, ids } = setup({ play0: [mine], play1: [roo], hand0: [lde] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  for (let k = 0; k < 4 && s.pending; k++) { if (s.pending.valid.includes(ids.play0[0])) choose(s, ids.play0[0]); else drain(s, 'no'); }
  assert.equal(s.cards[ids.play1[0]].exerted, false, 'Ward: not exerted');
  assert.equal(kw(s, ids.play0[0]).challenger, 2, 'Challenger +2');
});

oracle('939d268d91', 'Moana - Of Motunui readies ALL other exerted Princesses (no picking); declined → they quest normally', () => {
  const moana = byName('Moana - Of Motunui');
  const pr = all.filter((d) => d.type === 'character' && d.classes.includes('princess') && d.lore >= 1 && d.procs.every((p) => p.kind === 'keyword' && !Object.keys(d.kw).some((k) => ['reckless'].includes(k))) && d.name !== 'Moana');
  const [a, b] = [pr[0], pr.find((d) => d.full !== pr[0].full)];
  { const { s, ids } = setup({ play0: [moana, a, b] });
    s.cards[ids.play0[1]].exerted = s.cards[ids.play0[2]].exerted = true;
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
    assert.ok(s.pending?.confirm || s.pending?.optional, 'a may');
    assert.ok(!s.pending.valid?.length || s.pending.confirm, 'no picking of individual princesses');
    s.pending.confirm ? yes(s) : drain(s, 'yes');
    assert.ok(!s.cards[ids.play0[1]].exerted && !s.cards[ids.play0[2]].exerted, 'both readied');
    assert.equal(applyAction(s, 0, { type: 'quest', iid: ids.play0[1] }).ok, false, "can't quest"); }
  { const { s, ids } = setup({ play0: [moana, a] });
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s, 'no');
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[1] })); }
});

oracle('0559720810', 'Pluto - Friendly Pooch reduces the ink for a Shift cost', () => {
  const pooch = byName('Pluto - Friendly Pooch'), rock = byName('Stitch - Rock Star'); const st = base('Stitch');
  const { s, ids } = setup({ play0: [pooch, st], hand0: [rock] });
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 })); drain(s);
  ok(shift(s, { iid: ids.hand0[0], target: ids.play0[1] })); drain(s, 'no');
  assert.equal(10 - inkReady(s, 0), rock.kw.shift - 1);
});

oracle('92b256bbf8', 'Dragon Gem can\'t return Alice - Growing Girl; two Alices give each other Support', () => {
  const alice = byName('Alice - Growing Girl'), gem = byName('Dragon Gem');
  { const { s, ids } = setup({ play0: [gem] });
    const a = put(s, 0, alice, 'discard');
    const r = applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 });
    if (r.ok) { assert.ok(!s.pending?.valid?.includes(a), 'Alice is not a choice'); drain(s, 'no'); }
    assert.equal(s.cards[a].zone, 'discard'); }
  { const { s, ids } = setup({ play0: [alice, alice] }); touch(s);
    assert.ok(kw(s, ids.play0[0]).support && kw(s, ids.play0[1]).support, 'each has Support'); }
});

oracle('c8ceaf64b6', 'Ursula - Voice Stealer with no opposing ready character: no song', () => {
  const urs = byName('Ursula - Voice Stealer'); const foe = vanilla((d) => d.cost >= 3);
  const song = all.find((d) => d.type === 'song' && d.cost <= 2 && d.procs.every((p) => p.exec));
  const { s, ids } = setup({ hand0: [urs, song], play1: [foe] });
  s.cards[ids.play1[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  assert.ok(!s.pending?.valid?.includes(ids.hand0[1]), 'the song is not offered');
  drain(s, 'yes');
  assert.equal(s.cards[ids.hand0[1]].zone, 'hand');
});

oracle('dbaae3f563', 'I2I sung by 1 character, readied later → can quest; by 2 → readied, can\'t quest', () => {
  const i2i = byName('I2I'); const big = vanilla((d) => d.cost >= 9); const five = vanilla((d) => d.cost === 5);
  { const { s, ids } = setup({ play0: [big], hand0: [i2i] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'singTogether', singers: [ids.play0[0]] })); drain(s, 'no');
    assert.equal(s.cards[ids.play0[0]].exerted, true, '1 singer stays exerted');
    ok(applyAction(s, 0, { type: 'exert', iid: ids.play0[0], exerted: false }));          // "somehow" readied
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); }
  { const { s, ids } = setup({ play0: [five, five], hand0: [i2i] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'singTogether', singers: ids.play0 })); drain(s, 'no');
    assert.equal(s.cards[ids.play0[0]].exerted, false, '2 singers readied');
    assert.equal(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }).ok, false); }
});

oracle('54369e78cd', 'Cruella - Style Icon: an opposing cost ≤2 character banished triggers Out of Season', () => {
  const cru = byName('Cruella De Vil - Style Icon'); const atk = vanilla((d) => d.str >= 3 && d.wp >= 4); const foe = vanilla((d) => d.cost <= 2 && d.wp <= 2);
  const { s, ids } = setup({ play0: [cru, atk], play1: [foe] });
  s.cards[ids.play1[0]].exerted = true;
  const n = s.players[0].inkwell.length;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[1], target: ids.play1[0] })); drain(s, 'yes');
  assert.equal(s.cards[ids.play1[0]].zone, 'discard');
  assert.equal(s.players[0].inkwell.length - n, 1, 'inked the top card');
});

oracle('14b346edee', 'Powerline played after a song this turn has Rush', () => {
  const pw = byName('Powerline - Musical Superstar'); const foe = vanilla((d) => d.wp >= 5);
  const song = all.find((d) => d.type === 'song' && d.cost <= 2 && !d.kw?.singTogether && d.procs.every((p) => p.exec) && !/chosen|opp/i.test(JSON.stringify(d.procs)));
  const { s, ids } = setup({ hand0: [song, pw], play1: [foe] });
  s.cards[ids.play1[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] })); drain(s, 'no');
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.hand0[1], target: ids.play1[0] }));
});
