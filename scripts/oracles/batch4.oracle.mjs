// Batch 4 oracles: set 1–3 FAQ rulings (Magic Carpet … Zero to Hero).
import { assert, applyAction, checkInvariants, all, byName, ok, setup, oracle, untestable, vanilla, put, giveInk, drain, choose, yes, no, passTo, settle, eff, kw, viewFor } from './lib.mjs';

const inkReady = (s, seat) => s.players[seat].inkwell.filter((iid) => !s.cards[iid].exerted).length + (s.players[seat].inkDrops || 0);
// a copy of `def` on top of seat's deck
const toTop = (s, seat, def) => {
  const iid = put(s, seat, def, 'hand');
  const p = s.players[seat];
  p.hand.splice(p.hand.indexOf(iid), 1); p.deck.unshift(iid); s.cards[iid].zone = 'deck';
  return iid;
};
const dry = (s, ...iids) => { for (const iid of iids) s.cards[iid].drying = false; };
const simple = (d) => d.procs.every((p) => p.kind === 'keyword');

// Magic Carpet - Flying Rug: Find the Way can't move a character to an opposing location
oracle('af48cd2894', 'Find the Way only moves to your own locations', () => {
  const carpet = byName('Magic Carpet - Flying Rug'); const guy = vanilla((d) => d.cost === 2);
  const loc = byName('Zootopia - Tundratown'); const loc2 = byName('Never Land - Mermaid Lagoon');
  const { s, ids } = setup({ play0: [carpet, guy] });
  const theirs = put(s, 1, loc, 'play'); const mine = put(s, 0, loc2, 'play');
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 1 }));
  for (let k = 0; k < 4 && s.pending; k++) {
    const p = s.pending;
    if (p.valid.includes(mine) || p.valid.includes(theirs)) { assert.ok(!p.valid.includes(theirs), 'opposing location offered'); choose(s, mine); }
    else choose(s, p.valid.includes(ids.play0[1]) ? ids.play0[1] : p.valid[0]);
  }
  for (const iid of ids.play0) assert.notEqual(s.cards[iid].atLocation, theirs, 'moved to an opposing location');
  assert.equal(s.cards[ids.play0[1]].atLocation, mine, 'control: moved to own location');
});

// Magica De Spell - The Midas Touch: 0 lore from the quest + the chosen item's cost (1 or 7)
oracle('1322a8f23d', 'All Mine: gain the chosen item\'s cost (Pawpsicle 1 / Lucky Dime 7)', () => {
  const mag = byName('Magica De Spell - The Midas Touch');
  for (const [pick, want] of [['Lucky Dime', 7], ['Pawpsicle', 1]]) {
    const { s, ids } = setup({ play0: [mag] });
    const dime = put(s, 0, byName('Lucky Dime'), 'play'); const paw = put(s, 0, byName('Pawpsicle'), 'play');
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
    assert.ok(s.pending?.valid?.includes(dime) && s.pending.valid.includes(paw), 'choose one of your items');
    choose(s, pick === 'Lucky Dime' ? dime : paw); drain(s, 'no');
    assert.equal(s.players[0].lore, want);
  }
});

// Maleficent - Mistress of All Evil: each drawn card = one move of 1 damage; Flounder (2 wp) dies after 2
oracle('896d2e7e50', 'Divination per card drawn; only 2 counters move before Flounder is banished', () => {
  const mal = byName('Maleficent - Mistress of All Evil'); const beast = byName('Beast - Tragic Hero');
  const fl = byName('Flounder - Voice of Reason'); const awnw = byName('A Whole New World');
  const { s, ids } = setup({ play0: [mal, beast], play1: [fl], hand0: [awnw] });
  const B = ids.play0[1]; const F = ids.play1[0];
  s.cards[B].damage = 4;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  let offers = 0;
  for (let k = 0; k < 60 && s.pending; k++) {
    const p = s.pending;
    if (p.seat !== 0) { drain(s, 'yes'); continue; }
    if (p.confirm) { offers++; yes(s); continue; }
    if (p.valid.includes(B)) { choose(s, B); continue; }
    if (p.valid.includes(F)) { choose(s, F); continue; }
    if (p.optional) no(s); else choose(s, p.valid[0]);
  }
  assert.equal(s.cards[F].zone, 'discard', 'Flounder banished');
  assert.equal(s.cards[B].damage, 2, 'only 2 of the 4 counters moved');
  assert.ok(offers >= 2 || s.log.filter((l) => /Divination/.test(l.text)).length >= 2, 'Divination used once per card drawn');
  checkInvariants(s);
});

// Merlin - Crab: put into the inkwell by Let It Go = leaves play → Ready or Not! triggers
oracle('2f6c09f53c', 'inkwelled by Let It Go → "when he leaves play" triggers', () => {
  const merlin = byName('Merlin - Crab'); const lig = byName('Let It Go'); const guy = vanilla((d) => d.cost === 2);
  const { s, ids } = setup({ play0: [merlin, guy], hand0: [lig] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  choose(s, ids.play0[0]);
  assert.equal(s.cards[ids.play0[0]].zone, 'inkwell');
  assert.ok(s.pending?.valid?.includes(ids.play0[1]), 'Ready or Not! asks for a character');
  choose(s, ids.play0[1]); drain(s, 'no');
  assert.equal(kw(s, ids.play0[1]).challenger, 3);
});

// Minnie Mouse - Wide-Eyed Diver: the +2 lore stays when another copy shifts onto her → 3 lore
oracle('17f24d590c', 'shifted-onto Minnie keeps +2 lore; the new one\'s ability does not add more', () => {
  const minnie = byName('Minnie Mouse - Wide-Eyed Diver'); const sail = byName('Sail the Azurite Sea');
  const { s, ids } = setup({ play0: [minnie], hand0: [minnie, sail, sail] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] })); drain(s, 'no');
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[2] })); drain(s, 'no');
  assert.equal(eff(s, ids.play0[0]).lore, 3, 'first copy got +2');
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'shift', target: ids.play0[0] })); drain(s, 'no');
  assert.equal(eff(s, ids.hand0[0]).lore, 3);
});

// Moana - Born Leader: Welcome to My Boat stops a ready character at the location from questing this turn
oracle('30faf3af72', 'ready Alice at Moana\'s location can\'t quest after Moana quests', () => {
  const moana = byName('Moana - Born Leader'); const alice = byName('Alice - Growing Girl'); const loc = byName('Zootopia - Tundratown');
  const { s, ids } = setup({ play0: [moana, alice] });
  const L = put(s, 0, loc, 'play');
  ok(applyAction(s, 0, { type: 'move', iid: ids.play0[0], location: L }));
  ok(applyAction(s, 0, { type: 'move', iid: ids.play0[1], location: L }));
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s, 'no');
  assert.equal(s.cards[ids.play0[1]].exerted, false);
  assert.equal(applyAction(s, 0, { type: 'quest', iid: ids.play0[1] }).ok, false, 'Alice must not be able to quest');
});

// Mother Gothel - Withered and Wicked: enters with 3 damage even with Resist (not damage dealt)
oracle('a1bfc8c45e', 'enters play with 3 damage despite Cogsworth\'s Resist +1', () => {
  const g = byName('Mother Gothel - Withered and Wicked'); const cog = byName('Cogsworth - Grandfather Clock');
  const { s, ids } = setup({ play0: [cog], hand0: [g] });
  settle(s);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
  assert.equal(kw(s, ids.hand0[0]).resist, 1, 'Gothel has Resist +1');
  assert.equal(s.cards[ids.hand0[0]].damage, 3);
});

// Mufasa - Betrayed Leader: a revealed non-character goes back on top, face down
oracle('d717765ef3', 'revealed action goes back on top of the deck face down', () => {
  const muf = byName('Mufasa - Betrayed Leader'); const act = byName('Sail the Azurite Sea');
  const big = vanilla((d) => d.str >= 3 && d.wp >= 4);
  const { s, ids } = setup({ play0: [muf], play1: [big] });
  const top = toTop(s, 0, act);
  s.cards[ids.play1[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }));
  assert.equal(s.cards[ids.play0[0]].zone, 'discard', 'Mufasa banished');
  for (let k = 0; k < 4 && s.pending; k++) { if (s.pending.confirm) yes(s); else drain(s, 'no'); }
  assert.equal(s.players[0].deck[0], top, 'back on top');
  assert.equal(s.cards[top].zone, 'deck');
  assert.equal(viewFor(s, 1).players[0].deckTop, null, 'top card is not face up');
});

// Mulan - Reflecting: a revealed song you decline to play goes back on top of the deck
oracle('4f4aedfec5', 'declined song stays on top of the deck', () => {
  const mulan = byName('Mulan - Reflecting'); const bp = byName('Be Prepared');
  const { s, ids } = setup({ play0: [mulan] });
  const top = toTop(s, 0, bp);
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
  assert.ok(s.pending?.confirm, 'may reveal'); yes(s);
  assert.ok(s.pending?.confirm, 'may play it for free'); no(s);
  drain(s, 'no');
  assert.equal(s.players[0].deck[0], top);
  assert.equal(s.cards[ids.play0[0]].zone, 'play', 'Be Prepared not played');
});

// On Your Feet! Now!: all your characters can't quest — even one whose damage Resist prevented, even one already ready
oracle('e9ed335714', 'readied characters can\'t quest, whatever Resist did', () => {
  const oyf = byName('On Your Feet! Now!');
  const res = all.find((d) => d.type === 'character' && d.kw?.resist === 1 && Object.keys(d.kw).length === 1 && simple(d) && d.wp >= 2);
  const plain = vanilla((d) => d.wp >= 2);
  const { s, ids } = setup({ play0: [res, plain], hand0: [oyf] });
  s.cards[ids.play0[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
  assert.equal(s.cards[ids.play0[0]].exerted, false, 'readied');
  assert.equal(s.cards[ids.play0[0]].damage, 0, 'Resist +1 prevented the 1 damage');
  assert.equal(s.cards[ids.play0[1]].damage, 1);
  for (const iid of ids.play0) assert.equal(applyAction(s, 0, { type: 'quest', iid }).ok, false, `${s.defs[s.cards[iid].cardId].full} quested`);
});

// Painting the Roses Red: the two chosen characters must be different
oracle('04aff475fa', 'can\'t choose the same character twice', () => {
  const ptr = byName('Painting the Roses Red'); const a = vanilla((d) => d.str >= 2); const b = vanilla((d) => d.str >= 2 && d.id !== a.id);
  const { s, ids } = setup({ play1: [a, b], hand0: [ptr] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  choose(s, ids.play1[0]);
  assert.ok(s.pending && !s.pending.valid.includes(ids.play1[0]), 'same character offered again');
  assert.equal(applyAction(s, 0, { type: 'choose', target: ids.play1[0] }).ok, false);
  choose(s, ids.play1[1]); drain(s, 'no');
  assert.equal(eff(s, ids.play1[0]).str, a.str - 1);
  assert.equal(eff(s, ids.play1[1]).str, b.str - 1);
});

// Perdita - Devoted Mother: Madam Mim - Snake played for free from the discard still triggers "banish her or return"
oracle('7de803544a', 'Mim played by Come Along, Children still asks: banish her or return a character', () => {
  const per = byName('Perdita - Devoted Mother'); const mim = byName('Madam Mim - Snake');
  for (const opt of [0, 1]) {
    const { s, ids } = setup({ hand0: [per] });
    const M = put(s, 0, mim, 'discard');
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    if (s.pending?.confirm) yes(s);
    assert.ok(s.pending?.valid?.includes(M), 'Mim offered from the discard'); choose(s, M);
    assert.equal(s.cards[M].zone, 'play');
    assert.deepEqual(s.pending?.choices?.length, 2, 'Just You Wait must resolve');
    ok(applyAction(s, 0, { type: 'choose', option: opt }));
    if (opt === 1) choose(s, ids.hand0[0]);
    drain(s, 'no');
    if (opt === 0) assert.equal(s.cards[M].zone, 'discard', 'Mim banished');
    else { assert.equal(s.cards[ids.hand0[0]].zone, 'hand', 'Perdita returned'); assert.equal(s.cards[M].zone, 'play'); }
  }
});

// Peter Pan - Lost Boy Leader: the first move each turn pays; moving back to the 2-lore location gives nothing
oracle('749c21e811', 'once per turn: first move (De Vil Manor) +1, moving back +0', () => {
  const pp = byName('Peter Pan - Lost Boy Leader');
  const { s, ids } = setup({ play0: [pp] });
  const castle = put(s, 0, byName("The Queen's Castle - Mirror Chamber"), 'play'); const manor = put(s, 0, byName("De Vil Manor - Cruella's Estate"), 'play');
  s.cards[ids.play0[0]].atLocation = castle;
  ok(applyAction(s, 0, { type: 'move', iid: ids.play0[0], location: manor })); drain(s, 'yes');
  assert.equal(s.players[0].lore, 1, 'De Vil Manor: 1 lore');
  ok(applyAction(s, 0, { type: 'move', iid: ids.play0[0], location: castle })); drain(s, 'yes');
  assert.equal(s.players[0].lore, 1, 'no second use this turn');
});

// Prince John - Greediest of All: draw exactly as many as were discarded (2) or none
oracle('3f32d3be0c', 'I Sentence You: 2 discarded → draw 2 or 0, never 1', () => {
  const pj = byName('Prince John - Greediest of All'); const yhfm = byName('You Have Forgotten Me');
  for (const take of [true, false]) {
    const { s, ids } = setup({ play0: [pj], hand0: [yhfm] });
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    const h = s.players[0].hand.length;
    for (let k = 0; k < 2 && s.pending?.seat === 1; k++) choose(s, s.pending.valid[0]);
    assert.equal(s.players[1].discard.length, 2, 'opponent discarded 2');
    assert.ok(s.pending?.seat === 0 && s.pending.confirm && !s.pending.choices, 'a yes/no — no partial draw');
    if (take) yes(s); else no(s);
    assert.equal(s.players[0].hand.length - h, take ? 2 : 0, 'one answer draws 2 (or 0)');
    assert.ok(!s.pending, 'a second I Sentence You prompt — would let you draw only 1');
  }
});

// Prince John - Phony King: lore from the quest comes first — 10+2 = 12 vs 12 → opponent doesn't lose lore
oracle('8528dbcf9d', 'Collect Taxes checks lore after the quest lore is gained', () => {
  const pj = byName('Prince John - Phony King');
  for (const [mine, theirs, want] of [[10, 12, 12], [9, 12, 10]]) {
    const { s, ids } = setup({ play0: [pj] });
    s.players[0].lore = mine; s.players[1].lore = theirs;
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s, 'yes');
    assert.equal(s.players[0].lore, mine + 2);
    assert.equal(s.players[1].lore, want, `me ${mine}+2 vs ${theirs}`);
  }
});

// Queen of Hearts - Capricious Monarch: an opposing challenger banished on its owner's turn still readies her
oracle('56d8203c19', 'opposing attacker banished in its own turn → may ready Queen of Hearts', () => {
  const qoh = byName('Queen of Hearts - Capricious Monarch'); const atk = vanilla((d) => d.str <= 4 && d.wp <= 5);
  const { s, ids } = setup({ play0: [qoh], play1: [atk] });
  passTo(s, 1);
  s.cards[ids.play0[0]].exerted = true; dry(s, ids.play1[0]);
  ok(applyAction(s, 1, { type: 'challenge', attacker: ids.play1[0], target: ids.play0[0] }));
  assert.equal(s.cards[ids.play1[0]].zone, 'discard');
  assert.ok(s.pending?.seat === 0 && s.pending.confirm, 'Off With Their Heads! offered'); yes(s); drain(s, 'no');
  assert.equal(s.cards[ids.play0[0]].exerted, false, 'Queen readied');
});

// Rapunzel - Gifted Artist: Hakuna Matata heals 3 characters → 3 triggers → 3 cards
oracle('9e5aff6bfa', 'one draw per character healed', () => {
  const rap = byName('Rapunzel - Gifted Artist'); const hm = byName('Hakuna Matata');
  const g = vanilla((d) => d.wp >= 3);
  const { s, ids } = setup({ play0: [rap, g, g, g], hand0: [hm] });
  for (const iid of ids.play0.slice(1)) s.cards[iid].damage = 2;
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'sing', singers: [ids.play0[0]] }));
  let offers = 0;
  for (let k = 0; k < 10 && s.pending; k++) { if (s.pending.confirm) { offers++; yes(s); } else drain(s, 'no'); }
  for (const iid of ids.play0) assert.equal(s.cards[iid].damage, 0);
  assert.equal(offers, 3);
  assert.equal(s.players[0].hand.length - h, -1 + 3);
});

// Ratigan - Very Large Mouse: no opposing character with ≤3 {S} → still ready one of yours (can't quest)
oracle('81da5b0ac2', 'no valid exert target → still readies your character', () => {
  const rat = byName('Ratigan - Very Large Mouse'); const big = vanilla((d) => d.str >= 4); const mine = vanilla((d) => d.cost === 2);
  const { s, ids } = setup({ play0: [mine], play1: [big], hand0: [rat] });
  s.cards[ids.play0[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  assert.ok(s.pending?.valid?.includes(ids.play0[0]), 'choose one of your characters');
  assert.ok(!s.pending.valid.includes(ids.play1[0]));
  choose(s, ids.play0[0]); drain(s, 'no');
  assert.equal(s.cards[ids.play1[0]].exerted, false, 'the big opposing character is not exerted');
  assert.equal(s.cards[ids.play0[0]].exerted, false, 'readied');
  assert.equal(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }).ok, false, "can't quest");
});

// Revive: play a character with cost 5 or less from your discard for free
oracle('82f4db0e57', 'Revive plays a cost-5 character from the discard free, not a cost-6 one', () => {
  const rev = byName('Revive'); const five = vanilla((d) => d.cost === 5); const six = vanilla((d) => d.cost === 6);
  const { s, ids } = setup({ hand0: [rev] });
  const F = put(s, 0, five, 'discard'); const X = put(s, 0, six, 'discard');
  const before = inkReady(s, 0);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  assert.ok(s.pending?.valid?.includes(F) && !s.pending.valid.includes(X), 'cost ≤ 5 only');
  choose(s, F); drain(s, 'no');
  assert.equal(s.cards[F].zone, 'play');
  assert.equal(before - inkReady(s, 0), rev.cost, 'the character was free');
});

// Sail the Azurite Sea (updated text): this turn you may ink an additional card; draw a card
oracle('e656b0d472', 'one extra ink this turn + draw a card', () => {
  const sail = byName('Sail the Azurite Sea');
  const { s, ids } = setup({ hand0: [sail] });
  const inkable = () => s.players[0].hand.find((iid) => s.defs[s.cards[iid].cardId].inkable && iid !== ids.hand0[0]);
  ok(applyAction(s, 0, { type: 'ink', iid: inkable() }));
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
  assert.equal(s.players[0].hand.length - h, -1 + 1, 'drew a card');
  ok(applyAction(s, 0, { type: 'ink', iid: inkable() }));
  assert.equal(applyAction(s, 0, { type: 'ink', iid: inkable() }).ok, false, 'only one additional');
});

// Sheriff of Nottingham - Corrupt Official: A Whole New World discards 7 at once → 7 triggers
oracle('c0cefe3db5', 'discarding 7 at once → Taxes Should Hurt 7 times', () => {
  const sh = byName('Sheriff of Nottingham - Corrupt Official'); const awnw = byName('A Whole New World');
  const tank = byName('Eudora - Accomplished Seamstress');
  const { s, ids } = setup({ play0: [sh], play1: [tank], hand0: [awnw] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  const T = ids.play1[0];
  for (let k = 0; k < 40 && s.pending; k++) {
    const p = s.pending;
    if (p.seat !== 0) { drain(s, 'no'); continue; }
    if (p.confirm) yes(s); else if (p.valid.includes(T)) choose(s, T); else no(s);
  }
  assert.equal(s.cards[T].damage, 7);
});

// Simba - Rightful Heir: banishing a shifted character = one character banished → 1 lore
oracle('6973c2c42c', 'shifted stack counts as one character banished → 1 lore', () => {
  const simba = byName('Simba - Rightful Heir');
  const base = byName('Fix-It Felix, Jr. - Trusty Builder'); const top = byName('Fix-It Felix, Jr. - Niceland Steward');
  const { s, ids } = setup({ play0: [simba], play1: [base], hand1: [top] });
  giveInk(s, 1, 5); passTo(s, 1);
  ok(applyAction(s, 1, { type: 'play', iid: ids.hand1[0], mode: 'shift', target: ids.play1[0] })); drain(s, 'no');
  passTo(s, 0);
  const F = ids.hand1[0];
  Object.assign(s.cards[F], { exerted: true, damage: top.wp - simba.str });
  const l0 = s.players[0].lore;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: F })); drain(s, 'yes');
  assert.equal(s.cards[F].zone, 'discard'); assert.equal(s.cards[ids.play1[0]].zone, 'discard');
  assert.equal(s.players[0].lore - l0, 1);
});

// Sisu - Divine Water Dragon: I Trust You is not optional — the look happens, unpicked cards go to the bottom
oracle('c00026795d', 'must look; cards not taken go to the bottom', () => {
  const sisu = byName('Sisu - Divine Water Dragon');
  const { s, ids } = setup({ play0: [sisu] });
  const top2 = s.players[0].deck.slice(0, 2);
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
  assert.ok(s.pending && !s.pending.confirm, 'no "may" for the whole ability');
  assert.ok(top2.every((iid) => s.pending.valid.includes(iid)), 'shows the top 2');
  if (s.pending.optional) no(s); else choose(s, top2[0]);
  drain(s, 'no');
  const deck = s.players[0].deck; const kept = top2.filter((iid) => s.cards[iid].zone === 'deck');
  assert.deepEqual(deck.slice(-kept.length).sort(), [...kept].sort(), 'the rest on the bottom');
  assert.ok(!top2.includes(deck[0]) && !top2.includes(deck[1]));
});

// Sleepy's Flute: may be used without a song played — exerts, no lore
oracle('998856ebfd', 'A Silly Song without a song this turn: exert, gain nothing', () => {
  const fl = byName("Sleepy's Flute"); const song = byName('A Very Merry Unbirthday');
  for (const sang of [false, true]) {
    const { s, ids } = setup({ hand0: [song] });
    const F = put(s, 0, fl, 'play');
    if (sang) { ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no'); }
    ok(applyAction(s, 0, { type: 'useAbility', iid: F, index: 0 })); drain(s, 'no');
    assert.equal(s.cards[F].exerted, true);
    assert.equal(s.players[0].lore, sang ? 1 : 0);
  }
});

// Sword in the Stone: an undamaged character may be chosen; it gets +0
oracle('da90d50c82', 'undamaged character is a legal choice and gains nothing', () => {
  const sw = byName('Sword in the Stone'); const g = vanilla((d) => d.str >= 1);
  const { s, ids } = setup({ play0: [g] });
  const S = put(s, 0, sw, 'play');
  ok(applyAction(s, 0, { type: 'useAbility', iid: S, index: 0 }));
  assert.ok(s.pending?.valid?.includes(ids.play0[0])); choose(s, ids.play0[0]); drain(s, 'no');
  assert.equal(eff(s, ids.play0[0]).str, g.str);
  assert.equal(s.cards[S].exerted, true);
});

// Teeth and Ambitions: Resist 2 prevents all the damage to your character — the 2 damage to the other is still dealt
oracle('aaea467015', 'own Resist-2 character takes 0 → still deal 2 to another character', () => {
  const ta = byName('Teeth and Ambitions');
  const r2 = all.find((d) => d.name === 'Cinderella' && d.kw?.resist === 2) || all.find((d) => d.type === 'character' && d.kw?.resist === 2 && simple(d));
  const foe = vanilla((d) => d.wp >= 3);
  const { s, ids } = setup({ play0: [r2], play1: [foe], hand0: [ta] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  if (s.pending?.valid?.includes(ids.play0[0])) choose(s, ids.play0[0]);
  assert.equal(s.cards[ids.play0[0]].damage, 0, 'Resist 2 prevented it');
  assert.ok(s.pending?.valid?.includes(ids.play1[0]), 'the second part still happens');
  choose(s, ids.play1[0]); drain(s, 'no');
  assert.equal(s.cards[ids.play1[0]].damage, 2);
});

// The Lamp: Jafar (any number) → draw 2 once; Genie → must return a chosen cost ≤4 character; both happen
oracle('be0a4fb4bb', 'two Jafars still draw 2; Genie\'s return is mandatory; both apply', () => {
  const lamp = byName('The Lamp'); const jafar = byName('Jafar - Lamp Thief'); const genie = byName('Genie - Supportive Friend');
  const foe = vanilla((d) => d.cost <= 4);
  const { s, ids } = setup({ play0: [jafar, jafar, genie], play1: [foe] });
  const L = put(s, 0, lamp, 'play');
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'useAbility', iid: L, index: 0 }));
  assert.equal(s.players[0].hand.length - h, 2, 'draw 2, not 4');
  assert.ok(s.pending?.valid?.includes(ids.play1[0]), 'Genie part: choose a character');
  assert.equal(s.pending.optional, false, 'not optional');
  choose(s, ids.play1[0]); drain(s, 'no');
  assert.equal(s.cards[ids.play1[0]].zone, 'hand');
  assert.equal(s.cards[L].zone, 'discard');
});

// The Most Diabolical Scheme: playable without a Villain, but then nothing is banished
oracle('c0e5ab2767', 'no Villain to banish → no opposing character banished', () => {
  const sch = byName('The Most Diabolical Scheme'); const hero = vanilla((d) => !(d.classes || []).includes('villain'));
  const foe = vanilla((d) => d.wp >= 1);
  const { s, ids } = setup({ play0: [hero], play1: [foe], hand0: [sch] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  for (let k = 0; k < 4 && s.pending; k++) {
    assert.ok(!s.pending.valid?.includes(ids.play1[0]), 'offered to banish an opposing character');
    drain(s, 'no');
  }
  assert.equal(s.cards[ids.hand0[0]].zone, 'discard', 'the song was played');
  assert.equal(s.cards[ids.play1[0]].zone, 'play');
  assert.equal(s.cards[ids.play0[0]].zone, 'play');
});

// The Queen - Commanding Presence: -4 to an opposing character (required), +4 to any character (required)
oracle('f077cfb436', '-4 only on opposing characters, +4 on any; neither optional', () => {
  const q = byName('The Queen - Commanding Presence'); const fl = byName('Flounder - Voice of Reason');
  const mm = byName('Mickey Mouse - True Friend'); const ms = byName('Maleficent - Sorceress');
  const { s, ids } = setup({ play0: [q, fl], play1: [mm, ms] });
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
  assert.deepEqual([...s.pending.valid].sort(), [...ids.play1].sort(), '-4: opposing only');
  assert.equal(s.pending.optional, false);
  choose(s, ids.play1[0]);
  assert.deepEqual([...s.pending.valid].sort(), [...ids.play0, ...ids.play1].sort(), '+4: any character');
  assert.equal(s.pending.optional, false);
  choose(s, ids.play0[1]); drain(s, 'no');
  assert.ok(eff(s, ids.play1[0]).str <= mm.str - 4 || eff(s, ids.play1[0]).str === 0, 'got -4');
  assert.equal(eff(s, ids.play0[1]).str, fl.str + 4);
});

// The Queen - Disguised Peddler: 0 {L} characters can quest; they gain 0
oracle('ca1c510669', '0-lore character can quest for 0', () => {
  const q = byName('The Queen - Disguised Peddler');
  const { s, ids } = setup({ play0: [q] });
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s, 'no');
  assert.equal(s.cards[ids.play0[0]].exerted, true);
  assert.equal(s.players[0].lore, 0);
});

// The Sorcerer's Hat: naming a card needs no version — "Flounder" matches Flounder - Voice of Reason
oracle('1f4d93da45', 'name without version; the revealed matching card goes to hand', () => {
  const hat = byName("The Sorcerer's Hat"); const fl = byName('Flounder - Voice of Reason');
  const { s } = setup({});
  const H = put(s, 0, hat, 'play'); const top = toTop(s, 0, fl);
  ok(applyAction(s, 0, { type: 'useAbility', iid: H, index: 0 }));
  const k = s.pending?.choices?.indexOf('Flounder');
  assert.ok(k >= 0, 'can name just "Flounder"');
  ok(applyAction(s, 0, { type: 'choose', option: k })); drain(s, 'no');
  assert.equal(s.cards[top].zone, 'hand');
});

// Tiana's Palace - Jazz Restaurant: the only Bodyguard is there (can't be challenged) → challenge anyone
oracle('659940e4b4', 'Bodyguard at Tiana\'s Palace doesn\'t restrict challenges', () => {
  const tp = byName("Tiana's Palace - Jazz Restaurant");
  const bg = all.find((d) => d.type === 'character' && d.kw?.bodyguard && Object.keys(d.kw).length === 1 && simple(d));
  const other = vanilla((d) => d.wp >= 3); const atk = vanilla((d) => d.str >= 1);
  const { s, ids } = setup({ play0: [atk], play1: [bg, other] });
  const P = put(s, 1, tp, 'play');
  s.cards[ids.play1[0]].atLocation = P;
  settle(s);
  for (const iid of ids.play1) s.cards[iid].exerted = true;
  assert.equal(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }).ok, false, 'Bodyguard at the Palace can\'t be challenged');
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[1] }));
});

// Tinker Bell - Peter Pan's Ally: two copies → Peter Pan has Challenger +2
oracle('265693844d', 'Challenger is additive: two Tinker Bells → Challenger +2', () => {
  const tb = byName("Tinker Bell - Peter Pan's Ally"); const pp = byName('Peter Pan - Lost Boy Leader');
  const tank = byName('Eudora - Accomplished Seamstress');
  const { s, ids } = setup({ play0: [tb, tb, pp], play1: [tank] });
  settle(s);
  assert.equal(kw(s, ids.play0[2]).challenger, 2);
  s.cards[ids.play1[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[2], target: ids.play1[0] })); drain(s, 'no');
  assert.equal(s.cards[ids.play1[0]].damage, pp.str + 2);
});

// Ursula - Deceiver of All: What a Deal is used right when she sings — not later in the turn
oracle('75cc562362', 'the replay is offered at once; declined → can\'t play it later', () => {
  const urs = byName('Ursula - Deceiver of All'); const song = byName('A Very Merry Unbirthday');
  for (const take of [true, false]) {
    const { s, ids } = setup({ play0: [urs], hand0: [song] });
    const S = ids.hand0[0]; const d1 = s.players[1].discard.length;
    ok(applyAction(s, 0, { type: 'play', iid: S, mode: 'sing', singers: [ids.play0[0]] }));
    assert.ok(s.pending?.seat === 0 && s.pending.confirm, 'What a Deal offered right after the song');
    if (take) { yes(s); drain(s, 'no'); assert.equal(s.players[1].discard.length - d1, 4, 'played twice'); assert.equal(s.players[0].deck.at(-1), S); continue; }
    no(s); drain(s, 'no');
    assert.equal(s.cards[S].zone, 'discard');
    assert.equal(applyAction(s, 0, { type: 'play', iid: S }).ok, false, 'can\'t play it from the discard later');
  }
});

// Ursula - Deceiver of All + Let the Storm Rage On: she's the only target and is banished — What a Deal still works
oracle('7b6eff1898', 'banished by her own song → still replay it (no target, still draw)', () => {
  const urs = byName('Ursula - Deceiver of All'); const song = byName('Let the Storm Rage On');
  const { s, ids } = setup({ play0: [urs], hand0: [song] });
  const U = ids.play0[0]; const S = ids.hand0[0];
  s.cards[U].damage = 1;
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: S, mode: 'sing', singers: [U] }));
  if (s.pending?.valid?.includes(U)) choose(s, U);
  assert.equal(s.cards[U].zone, 'discard', 'Ursula banished');
  assert.ok(s.pending?.seat === 0 && s.pending.confirm, 'What a Deal still offered'); yes(s);
  drain(s, 'no');
  assert.equal(s.players[0].hand.length - h, -1 + 2, 'drew a card each time');
  assert.equal(s.players[0].deck.at(-1), S, 'the song went to the bottom of the deck');
});

// Ursula - Deceiver of All + The Boss is on a Roll: the replayed song goes under everything it put on the bottom
oracle('1d95099821', 'the replayed song is the bottom-most card', () => {
  const urs = byName('Ursula - Deceiver of All'); const boss = byName('The Boss is on a Roll');
  const { s, ids } = setup({ play0: [urs], hand0: [boss] });
  const S = ids.hand0[0];
  ok(applyAction(s, 0, { type: 'play', iid: S, mode: 'sing', singers: [ids.play0[0]] }));
  const bottoms = [];
  const sortTop = () => {   // put exactly 1 of the 5 on the bottom, the other 4 stay on top
    assert.ok(s.pending?.valid?.length >= 1, 'look at the top 5');
    const c = s.pending.valid[0]; bottoms.push(c); choose(s, c);
    if (s.pending && !s.pending.confirm && s.pending.optional && s.pending.valid?.length) no(s);
  };
  sortTop();
  assert.ok(s.pending?.confirm, 'What a Deal'); yes(s);
  sortTop(); drain(s, 'no');
  const deck = s.players[0].deck;
  assert.equal(deck.at(-1), S, 'Boss is on a Roll is the bottom card');
  assert.deepEqual(deck.slice(-3, -1), bottoms);
  assert.equal(s.players[0].lore, 2);
});

untestable('6bffd9340a', 'flavor-text correction only (Pacha/Kuzco quote) — no game state');

// Yzma - Scary Beyond All Reason (errata): the shuffle is not optional; that player draws 2
oracle('f7962bd8da', 'Cruel Irony is mandatory: chosen character shuffled in, its owner draws 2', () => {
  const yz = byName('Yzma - Scary Beyond All Reason'); const foe = vanilla((d) => d.cost === 2);
  const { s, ids } = setup({ play1: [foe], hand0: [yz] });
  const h1 = s.players[1].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  assert.ok(s.pending && !s.pending.confirm && s.pending.optional === false, 'no "you may"');
  assert.ok(!s.pending.valid.includes(ids.hand0[0]), '"another" character');
  choose(s, ids.play1[0]); drain(s, 'no');
  assert.equal(s.cards[ids.play1[0]].zone, 'deck');
  assert.equal(s.players[1].hand.length - h1, 2);
});

// Yzma - Unjustly Treated: during your turn, your character banishes another in a challenge → may deal 1 damage
oracle('0e75cd5cab', 'I\'m Warning You! fires on your turn only', () => {
  const yz = byName('Yzma - Unjustly Treated'); const big = vanilla((d) => d.str >= 3 && d.wp >= 4);
  const small = vanilla((d) => d.wp <= 2 && d.str <= 2); const tank = byName('Eudora - Accomplished Seamstress');
  {
    const { s, ids } = setup({ play0: [yz, big], play1: [small, tank] });
    s.cards[ids.play1[0]].exerted = true;
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[1], target: ids.play1[0] }));
    assert.equal(s.cards[ids.play1[0]].zone, 'discard');
    if (s.pending?.confirm) yes(s);
    assert.ok(s.pending?.valid?.includes(ids.play1[1]), 'may deal 1 damage to chosen character');
    choose(s, ids.play1[1]); drain(s, 'no');
    assert.equal(s.cards[ids.play1[1]].damage, 1);
  }
  {
    const { s, ids } = setup({ play0: [yz, big], play1: [small, tank] });
    passTo(s, 1);
    s.cards[ids.play0[1]].exerted = true; dry(s, ids.play1[0]);
    ok(applyAction(s, 1, { type: 'challenge', attacker: ids.play1[0], target: ids.play0[1] }));
    assert.equal(s.cards[ids.play1[0]].zone, 'discard');
    assert.ok(!s.pending, 'not during the opponent\'s turn');
  }
});

// Zero to Hero: 10 characters → the next character costs 10 less; only that one
oracle('89e697ac3d', 'one character free, the next pays full', () => {
  const zth = byName('Zero to Hero'); const f = all.find((d) => d.type === 'character' && d.abilities.length === 0 && d.cost === 1 && d.wp >= 1);
  const five = vanilla((d) => d.cost === 5);
  const { s, ids } = setup({ play0: Array(10).fill(f), hand0: [zth, five, five], ink0: 12 });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
  let r = inkReady(s, 0);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] })); drain(s, 'no');
  assert.equal(r - inkReady(s, 0), 0, 'first 5-cost free');
  r = inkReady(s, 0);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[2] })); drain(s, 'no');
  assert.equal(r - inkReady(s, 0), 5, 'second pays 5');
});
