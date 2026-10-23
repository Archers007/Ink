// Batch 2: Hyperia, Whispers in the Well, Wilds Unknown, Winterspell release notes and card FAQs.
import { assert, applyAction, checkInvariants, all, byName, ok, setup, oracle, untestable, vanilla, put, giveInk, drain, choose, yes, no, passTo, settle, eff, kw, viewFor } from './lib.mjs';

const inkReady = (s, seat) => s.players[seat].inkwell.filter((iid) => !s.cards[iid].exerted).length + (s.players[seat].inkDrops || 0);
const handOf = (s, seat) => s.players[seat].hand.length;
// put the whole hand back into the deck (setup() deals 7)
const emptyHand = (s, seat) => { const p = s.players[seat]; for (const iid of [...p.hand]) { p.hand.splice(p.hand.indexOf(iid), 1); s.cards[iid].zone = 'deck'; p.deck.push(iid); } };
// a deck card put facedown under `iid` (as Boost would)
const tuck = (s, iid) => { const c = s.cards[iid]; const p = s.players[c.owner]; const u = p.deck.shift(); Object.assign(s.cards[u], { zone: 'under', parent: iid, faceDown: true }); c.under.push(u); return u; };

// Hyperia: Powerline sings Never Gonna Let You Cry → the song resolves first, then Backup Singers
oracle('edf5f62355', 'song effect resolves before the singer-played trigger', () => {
  const pl = byName('Powerline - Megastar'); const song = byName('Never Gonna Let You Cry'); const isa = byName('Isabela Madrigal - Such a Lovely Voice');
  const c1 = vanilla((d) => d.cost === 1); const c2 = vanilla((d) => d.cost === 2);
  const { s, ids } = setup({ play0: [pl], hand0: [song] });
  const cheap = [put(s, 0, c1, 'discard'), put(s, 0, c2, 'discard')]; const singer = put(s, 0, isa, 'discard');
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'sing', singers: [ids.play0[0]] }));
  assert.ok(s.pending, 'a choice is pending');
  assert.equal(s.pending.src, ids.hand0[0], 'first choice comes from the song');
  assert.ok(!s.pending.valid.includes(singer), 'cost-3 Isabela is not a song target');
  for (const iid of cheap) if (s.pending?.src === ids.hand0[0] && s.pending.valid.includes(iid)) choose(s, iid);
  if (s.pending?.src === ids.hand0[0]) no(s);
  assert.ok(cheap.every((iid) => s.cards[iid].zone === 'hand'), 'both cheap characters returned by the song');
  assert.equal(s.cards[singer].zone, 'discard', 'Powerline not resolved yet / still waiting');
  if (s.pending) { assert.equal(s.pending.src, ids.play0[0], 'then Powerline'); choose(s, singer); }
  assert.equal(s.cards[singer].zone, 'hand', 'Backup Singers returns the Singer card');
  checkInvariants(s);
});

// Hyperia: Flash – Efficient Clerk in play → Donald Duck – Taxi Driver chooses himself, can't gain Rush
oracle('db6c89b98a', "Flash: Donald can't gain Rush, so he can't challenge the turn he's played", () => {
  const donald = byName('Donald Duck - Taxi Driver'); const flash = byName('Flash - Efficient Clerk'); const tgt = vanilla((d) => d.wp >= 5);
  for (const withFlash of [true, false]) {
    const { s, ids } = setup({ hand0: [donald], play1: withFlash ? [tgt, flash] : [tgt] });
    s.cards[ids.play1[0]].exerted = true;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    if (s.pending) choose(s, ids.hand0[0]);
    assert.equal(!!kw(s, ids.hand0[0]).rush, !withFlash, withFlash ? 'no Rush under Flash' : 'Rush without Flash');
    const r = applyAction(s, 0, { type: 'challenge', attacker: ids.hand0[0], target: ids.play1[0] });
    assert.equal(r.ok, !withFlash, withFlash ? 'challenge must be refused' : `challenge allowed: ${r.error}`);
  }
});

// Hyperia: Remember Me, then a "play a character for free" effect → may play it from the discard (enters exerted, name ban)
oracle('fbeb1c26e6', 'Remember Me + Just in Time → free character from the discard, exerted, same-name ban', () => {
  const rm = byName('Remember Me'); const jit = byName('Just in Time'); const ch = vanilla((d) => d.cost === 4);
  const { s, ids } = setup({ hand0: [rm, jit, ch], ink0: 12 });
  const dis = put(s, 0, ch, 'discard');
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] }));
  for (let k = 0; k < 4 && s.pending && s.cards[dis].zone === 'discard'; k++) {
    if (s.pending.confirm) { yes(s); continue; }
    assert.ok(s.pending.valid.includes(dis), 'the discard copy is offered to Just in Time');
    choose(s, dis);
  }
  drain(s, 'no');
  assert.equal(s.cards[dis].zone, 'play', 'played from the discard for free');
  assert.equal(s.cards[dis].exerted, true, 'entered play exerted');
  assert.equal(applyAction(s, 0, { type: 'play', iid: ids.hand0[2] }).ok, false, "can't play another character with that name this turn");
});

// Hyperia: Remember Me's permission during the opponent's turn → still can't play a character from the discard
oracle('51e52385b2', "Remember Me on the opponent's turn doesn't let you play characters then", () => {
  const ch = vanilla((d) => d.cost === 2);
  const { s } = setup({});
  const dis = put(s, 0, ch, 'discard');
  passTo(s, 1);
  (s.players[0].playFrom ||= []).push({ zone: 'discard', filter: { types: ['character'] }, exerted: true, sameNameBan: true, src: null, turn: s.turn });   // "somehow" resolved this turn
  assert.equal(applyAction(s, 0, { type: 'play', iid: dis }).ok, false, 'no playing on the opponent’s turn');
  assert.equal(s.cards[dis].zone, 'discard');
});

// Hyperia: Rapunzel – Outgoing Artist alone in play → can't choose "another" character; with another Rapunzel → match → draw
oracle('8b42aa89ee', 'Picture Perfect needs another character; another Rapunzel in play → reveal Rapunzel → draw', () => {
  const rap = byName('Rapunzel - Outgoing Artist');
  { const { s, ids } = setup({ play0: [rap], hand0: [rap] });
    const h = handOf(s, 0);
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
    assert.ok(!s.pending || !(s.pending.valid || []).includes(ids.play0[0]), 'she can’t choose herself');
    drain(s, 'yes');
    assert.equal(handOf(s, 0), h, 'no draw when she is the only character'); }
  { const { s, ids } = setup({ play0: [rap], hand0: [rap], play1: [rap] });
    const h = handOf(s, 0);
    ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
    for (let k = 0; k < 4 && s.pending; k++) {
      const p = s.pending;
      if (p.confirm) yes(s);
      else if (p.valid.includes(ids.play1[0])) choose(s, ids.play1[0]);
      else if (p.valid.includes(ids.hand0[0])) choose(s, ids.hand0[0]);
      else assert.fail(`unexpected prompt ${p.prompt}`);
    }
    assert.equal(handOf(s, 0), h + 1, 'opposing Rapunzel chosen + Rapunzel revealed → draw'); }
});

// Hyperia: Belle – Exceptional Writer exerts twice → next action costs 4 less
oracle('355bb229dc', 'two exerts → 4 less for the next action', () => {
  const belle = byName('Belle - Exceptional Writer');
  const act = all.find((d) => d.type === 'action' && d.cost >= 5 && d.procs.every((p) => p.exec) && /draw/i.test(d.abilities.map((a) => a.text).join(' ')) && !/chosen|opponent|discard/i.test(d.abilities.map((a) => a.text).join(' ')));
  const { s, ids } = setup({ play0: [belle], hand0: [act] });
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s);
  ok(applyAction(s, 0, { type: 'exert', iid: ids.play0[0], exerted: false }));
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s);
  const before = inkReady(s, 0);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
  assert.equal(before - inkReady(s, 0), act.cost - 4, `${act.full}: cost ${act.cost} − 4`);
});

// Hyperia: Leaning Tower of Cheese-a — 5 copies → no Ward (needs exactly 4)
oracle('d0d9af7b2e', 'exactly 4 copies give Ward; 5 copies do not', () => {
  const tower = byName('Leaning Tower of Cheese-a');
  for (const [n, ward] of [[4, true], [5, false]]) {
    const { s } = setup({});
    const t = Array.from({ length: n }, () => put(s, 0, tower, 'play'));
    settle(s);
    assert.equal(!!kw(s, t[0]).ward, ward, `${n} copies → ${ward ? '' : 'no '}Ward`);
  }
});

// Hyperia: Intense Research paid with an ink drop → look at 5, still one to hand and the rest on the bottom
oracle('b8bfa4da1e', 'ink drop → look at 5; one to hand, other 4 to the bottom', () => {
  const ir = byName('Intense Research');
  const { s, ids } = setup({ hand0: [ir], ink0: 1 });
  s.players[0].inkDrops = 1;
  const top5 = s.players[0].deck.slice(0, 5);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  assert.equal(s.players[0].inkDrops, 0, 'the drop paid for it');
  assert.deepEqual([...s.pending.valid].sort(), [...top5].sort(), 'looked at the top 5');
  choose(s, top5[2]); drain(s, 'yes');
  assert.equal(s.cards[top5[2]].zone, 'hand');
  const rest = top5.filter((x) => x !== top5[2]);
  assert.deepEqual([...s.players[0].deck.slice(-4)].sort(), [...rest].sort(), 'the other 4 on the bottom');
});

const plainItem = () => all.find((d) => d.type === 'item' && d.name !== 'Spyglass Hat' && d.procs.length && d.procs.every((p) => p.kind === 'activated'));
// Hyperia: Spyglass Hat — playing a second Spyglass Hat matches a name in play → no ink; a different item → may ink
oracle('02516bf043', 'second Spyglass Hat → no effect; a differently named item → card to inkwell exerted', () => {
  const hat = byName('Spyglass Hat'); const other = plainItem();
  const { s, ids } = setup({ hand0: [hat, other] });
  put(s, 0, hat, 'play');
  const ink0 = s.players[0].inkwell.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  const asked = !!s.pending; drain(s, 'yes');
  assert.equal(s.players[0].inkwell.length, ink0, `second Spyglass Hat resolved for no effect${asked ? ' (was prompted)' : ''}`);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] }));
  assert.ok(s.pending, `${other.full} has a different name → Hat Couture offers`);
  for (let k = 0; k < 4 && s.pending; k++) { if (s.pending.confirm) yes(s); else choose(s, s.pending.valid[0]); if (s.players[0].inkwell.length > ink0) break; }
  drain(s, 'no');
  assert.ok(s.players[0].inkwell.length > ink0, 'a card went into the inkwell');
  assert.equal(s.cards[s.players[0].inkwell.at(-1)].exerted, true, 'exerted');
});

// Hyperia: Duchess – Upper Crust compares characters only — an opponent's pricier item doesn't count
//   (no cost-8 item exists: my top character costs 6, the opponent's item 7 — vs a cost-7 opposing character)
oracle('a3972cba38', 'highest cost among characters only; items ignored', () => {
  const duch = byName('Duchess - Cosmopolitan Cat'); const six = vanilla((d) => d.cost === 6); const seven = vanilla((d) => d.cost === 7);
  const item7 = byName('Lucky Dime');
  for (const [opp, bonus] of [[item7, 1], [seven, 0]]) {
    const { s, ids } = setup({ play0: [duch, six] });
    put(s, 1, opp, 'play'); settle(s);
    assert.equal(eff(s, ids.play0[0]).lore, duch.lore + bonus, `opponent's ${opp.type} cost ${opp.cost} → +${bonus}`);
  }
});

// Hyperia: Ariel – Collector of Oddities: second Spyglass Hat → no draw; a differently named item → draw
oracle('2504d33ba9', 'One of a Kind: same name as an item in play → no draw', () => {
  const ariel = byName('Ariel - Collector of Oddities'); const hat = byName('Spyglass Hat'); const other = plainItem();
  const { s, ids } = setup({ play0: [ariel], hand0: [hat, other] });
  put(s, 0, hat, 'play');
  let h = handOf(s, 0);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
  assert.equal(handOf(s, 0), h - 1, 'second Spyglass Hat: no draw');
  h = handOf(s, 0);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1] })); drain(s, 'no');
  assert.equal(handOf(s, 0), h - 1 + 1, `${other.full}: draw 1`);
});

// Hyperia: Baymax – Amped Up's Shift removes 2 ink drops — that isn't paying ink
oracle('2109312180', 'Shift by removing 2 ink drops spends no ink', () => {
  const amped = byName('Baymax - Amped Up');
  const base = all.find((d) => d.type === 'character' && d.name === 'Baymax' && d.full !== amped.full);
  const { s, ids } = setup({ hand0: [amped], play0: [base], ink0: 3 });
  s.players[0].inkDrops = 2;
  const ready = s.players[0].inkwell.filter((iid) => !s.cards[iid].exerted).length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'shift', target: ids.play0[0] })); drain(s, 'no');
  assert.equal(s.cards[ids.hand0[0]].zone, 'play');
  assert.equal(s.players[0].inkDrops, 0, 'two drops removed');
  assert.equal(s.players[0].inkwell.filter((iid) => !s.cards[iid].exerted).length, ready, 'no ink paid');
});

// Hyperia: Madam Mim played with an ink drop → Upper Hand draws 2, Bauble Game doesn't trigger (she wasn't in play)
oracle('c0eaf5e7a3', 'ink drop removed before Mim is in play → no Bauble Game draw', () => {
  const mim = byName('Madam Mim - Resourceful Trickster');
  const { s, ids } = setup({ hand0: [mim], ink0: mim.cost - 1 });
  s.players[0].inkDrops = 1;
  const h = handOf(s, 0);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'yes');
  assert.equal(s.players[0].inkDrops, 0);
  assert.equal(handOf(s, 0), h - 1 + 2, 'Upper Hand 2 cards, no Bauble Game card');
});

// Whispers: putting a card under The Black Cauldron isn't playing it → no "whenever you play a character"
oracle('b004e36c91', 'The Cauldron Calls is not playing the card', () => {
  const cauldron = byName('The Black Cauldron'); const minnie = byName('Minnie Mouse - Storyteller'); const ch = vanilla((d) => d.cost === 3);
  const { s, ids } = setup({ play0: [minnie] });
  const cal = put(s, 0, cauldron, 'play'); const dis = put(s, 0, ch, 'discard');
  settle(s);
  const lore = eff(s, ids.play0[0]).lore;
  ok(applyAction(s, 0, { type: 'useAbility', iid: cal, index: 0 }));
  if (s.pending) choose(s, dis);
  drain(s, 'no');
  assert.equal(s.cards[dis].zone, 'under', 'under the Cauldron');
  assert.equal(eff(s, ids.play0[0]).lore, lore, 'Minnie – Gather Around did not trigger');
  assert.ok(!s.players[0].playedThisTurn.includes(dis), 'not counted as played');
});

// Whispers: anyone may look at faceup cards under The Black Cauldron
oracle('c755df374e', 'cards under the Cauldron are visible to every player', () => {
  const cauldron = byName('The Black Cauldron'); const ch = vanilla((d) => d.cost === 3);
  const { s } = setup({});
  const cal = put(s, 0, cauldron, 'play'); const dis = put(s, 0, ch, 'discard');
  ok(applyAction(s, 0, { type: 'useAbility', iid: cal, index: 0 }));
  if (s.pending) choose(s, dis);
  for (const seat of [0, 1]) {
    const under = viewFor(s, seat).players[0].play.find((c) => c.iid === cal).under;
    assert.deepEqual(under, [{ iid: dis, cardId: ch.id }], `seat ${seat} sees the faceup card`);
  }
});

// Whispers: Nana – Canine Caregiver with an empty hand → can't discard, so no character returns
oracle('fc68c630c8', 'no card to discard → the return does not happen', () => {
  const nana = byName('Nana - Canine Caregiver'); const small = vanilla((d) => d.cost === 2);
  for (const [cards, back] of [[0, false], [1, true]]) {
    const { s, ids } = setup({ hand0: [nana], play1: [small] });
    emptyHand(s, 0);
    const p = s.players[0]; p.deck.splice(p.deck.indexOf(ids.hand0[0]), 1); p.hand.push(ids.hand0[0]); s.cards[ids.hand0[0]].zone = 'hand';
    for (let k = 0; k < cards; k++) { const x = p.deck.shift(); s.cards[x].zone = 'hand'; p.hand.push(x); }
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    for (let k = 0; k < 4 && s.pending; k++) { if (s.pending.confirm) yes(s); else if (s.pending.valid.includes(ids.play1[0])) choose(s, ids.play1[0]); else choose(s, s.pending.valid[0]); }
    assert.equal(s.cards[ids.play1[0]].zone, back ? 'hand' : 'play', cards ? 'discarded → returned' : 'empty hand → stays in play');
  }
});

// Whispers: Beast – Aggressive Lord vs Blessed Bagpipes, opponent at 19 → Beast first (18), then Bagpipes (19) — no win
oracle('878875592d', "active player's trigger resolves first: 19 → 18 → 19, opponent doesn't win", () => {
  const beast = byName('Beast - Aggressive Lord'); const pipes = byName('Blessed Bagpipes'); const def = vanilla((d) => d.wp >= 5);
  const { s, ids } = setup({ play0: [beast], play1: [def] });
  put(s, 1, pipes, 'play');
  tuck(s, ids.play0[0]); tuck(s, ids.play1[0]);
  s.cards[ids.play1[0]].exerted = true;
  s.players[1].lore = 19;
  const l0 = s.players[0].lore;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] })); drain(s, 'yes');
  assert.equal(s.status, 'playing', `game must go on (winner ${s.winner})`);
  assert.equal(s.players[1].lore, 19, 'opponent back at 19');
  assert.equal(s.players[0].lore, l0 + 1, 'Beast gained 1');
});

// Wilds Unknown: Pedro Madrigal's Devoted Family heals only himself, not another Pedro in play
oracle('73fbebcfe3', '"him" is this Pedro only', () => {
  const pedro = byName('Pedro Madrigal - Family Patriarch');
  const { s, ids } = setup({ hand0: [pedro] });
  const old = put(s, 0, pedro, 'play'); s.cards[old].damage = 1;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  assert.equal(s.cards[ids.hand0[0]].damage, 1, 'entered with 1 damage');
  for (let k = 0; k < 4 && s.pending; k++) {
    if (s.pending.confirm) { yes(s); continue; }
    assert.ok(!s.pending.valid.includes(old), 'the other Pedro is not a choice');
    choose(s, ids.hand0[0]);
  }
  assert.equal(s.cards[old].damage, 1, 'other copy keeps its damage');
  assert.equal(s.cards[ids.hand0[0]].damage, 0, 'the new Pedro healed (the other Pedro is a Madrigal)');
});

// Wilds Unknown: Chip's Friendly Assist (+1 {W} to Dale) works only in play → 3-{W} Dale in the discard can't be returned
oracle('f05f282a0e', "Dale – Bumbler in the discard keeps 3 {W} → not a There You Are! target", () => {
  const chip = byName('Chip - Retrieval Expert'); const dale = byName('Dale - Bumbler'); const four = vanilla((d) => d.wp === 4);
  const { s, ids } = setup({ hand0: [chip] });
  const dd = put(s, 0, dale, 'discard'); const ok4 = put(s, 0, four, 'discard');
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  for (let k = 0; k < 4 && s.pending; k++) {
    if (s.pending.confirm) { yes(s); continue; }
    assert.ok(!s.pending.valid.includes(dd), 'Dale is not offered');
    assert.ok(s.pending.valid.includes(ok4), 'a 4-{W} character is');
    choose(s, ok4);
  }
  assert.equal(s.cards[dd].zone, 'discard');
  assert.equal(s.cards[ok4].zone, 'hand');
});

// Wilds Unknown: Isabela – Caring Cultivator: removing 2 damage at once → one trigger, 2 lore
oracle('2429ac1a50', 'Do No Wrong triggers once and gains 1 per damage removed', () => {
  const isa = byName('Isabela Madrigal - Caring Cultivator'); const glow = byName('Healing Glow'); const tgt = vanilla((d) => d.wp >= 4);
  const { s, ids } = setup({ play0: [isa, tgt], hand0: [glow] });
  s.cards[ids.play0[1]].damage = 2;
  const l = s.players[0].lore;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  choose(s, ids.play0[1]); drain(s, 'yes');
  assert.equal(s.cards[ids.play0[1]].damage, 0);
  assert.equal(s.players[0].lore - l, 2, '+2 lore (not 1, not 4)');
});

// "pay 2 or less to play a card" counts the ink actually paid after modifiers: Grandmother Willow makes a cost-3 character cost 2
function paidTwoOrLess(name, check) {
  const src = byName(name); const willow = byName('Grandmother Willow - Ancient Advisor'); const three = vanilla((d) => d.cost === 3); const opp = vanilla((d) => d.str >= 3 && d.wp >= 3);
  for (const discount of [true, false]) {
    const { s, ids } = setup({ play0: discount ? [src, willow] : [src], hand0: [three], play1: [opp] });
    const before = inkReady(s, 0);
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    assert.equal(before - inkReady(s, 0), discount ? 2 : 3, 'ink paid');
    const fired = !!s.pending;
    const want = check.target(ids);
    if (fired) { assert.ok(s.pending.valid.includes(want), 'target offered'); choose(s, want); }
    drain(s, 'no');
    assert.equal(fired, discount, discount ? 'paid 2 → triggers' : 'paid 3 → no trigger');
    if (discount) check.after(s, want);
  }
}
// Wilds Unknown: Jessie – Lively Cowgirl
oracle('ea95b1cfc8', 'Yodel-ay-hee-hoo! triggers on a cost-3 card paid down to 2', () => paidTwoOrLess('Jessie - Lively Cowgirl', {
  target: (ids) => ids.play1[0],
  after: (s, t) => assert.equal(eff(s, t).str, s.defs[s.cards[t].cardId].str - 1, '-1 {S}'),
}));
// Wilds Unknown: Babyhead – Leader of Sid's Toys
oracle('0c9c1d058a', 'Tighten the Bolts triggers on a cost-3 card paid down to 2', () => paidTwoOrLess("Babyhead - Leader of Sid's Toys", {
  target: (ids) => ids.play0[0],
  after: (s, t) => assert.equal(eff(s, t).str, s.defs[s.cards[t].cardId].str + 2, '+2 {S}'),
}));

// Wilds Unknown: Dale – Ready for His Shot: challenge damage uses {W}; {S} modifiers don't matter, {W} modifiers do
oracle('deec776f7e', 'Spike Suit: +{S} ignored, +{W} counts', () => {
  const dale = byName('Dale - Ready for His Shot'); const atk = vanilla((d) => d.str !== d.wp && d.wp >= 2 && d.wp <= 4); const def = vanilla((d) => d.wp >= 8);
  for (const [stat, delta, dealt] of [['str', 2, atk.wp], ['wp', 1, atk.wp + 1]]) {
    const { s, ids } = setup({ play0: [dale, atk], play1: [def] });
    ok(applyAction(s, 0, { type: 'mod', iid: ids.play0[1], stat, delta }));
    s.cards[ids.play1[0]].exerted = true;
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[1], target: ids.play1[0] })); drain(s, 'no');
    assert.equal(s.cards[ids.play1[0]].damage, dealt, `+${delta} ${stat} → deals ${dealt}`);
  }
});

// Wilds Unknown: Ranger Team-Up — +{S} equal to the chosen character's {W}
oracle('5ec4bffb0a', 'a 2-{W} character gets +2 {S}', () => {
  const rtu = byName('Ranger Team-Up'); const tgt = vanilla((d) => d.wp === 2);
  const { s, ids } = setup({ play0: [tgt], hand0: [rtu] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); choose(s, ids.play0[0]); drain(s);
  assert.equal(eff(s, ids.play0[0]).str, tgt.str + 2);
});

// Wilds Unknown: Pepa – Calm Before the Storm: moving damage off your character is removing damage → Silver Lining draws
oracle('4e11570d04', 'Luisa moves damage from Pepa → Silver Lining draws', () => {
  const pepa = byName('Pepa Madrigal - Calm Before the Storm'); const luisa = byName('Luisa Madrigal - Confident Climber');
  const { s, ids } = setup({ play0: [pepa, luisa] });
  s.cards[ids.play0[0]].damage = 1;
  const h = handOf(s, 0);
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[1], index: 1 }));
  choose(s, ids.play0[0]); drain(s, 'no');
  assert.deepEqual([s.cards[ids.play0[0]].damage, s.cards[ids.play0[1]].damage], [0, 1], 'damage moved');
  assert.equal(handOf(s, 0), h + 1, 'drew 1');
});

// Wilds Unknown: Luisa at 3 damage moves 1 more onto herself → 4 (= {W}) but moves it all away before the game state check
oracle('da7f924502', 'Luisa survives when there is an opposing character; banished when there is none', () => {
  const luisa = byName('Luisa Madrigal - Confident Climber'); const mine = vanilla((d) => d.wp >= 3); const opp = vanilla((d) => d.wp >= 6);
  for (const withOpp of [false, true]) {
    const { s, ids } = setup({ play0: [luisa, mine], play1: withOpp ? [opp] : [] });
    s.cards[ids.play0[0]].damage = 3; s.cards[ids.play0[1]].damage = 1;
    ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 1 }));
    choose(s, ids.play0[1]);
    if (s.pending && withOpp) choose(s, ids.play1[0]);
    drain(s, 'no');
    if (withOpp) {
      assert.equal(s.cards[ids.play0[0]].zone, 'play', 'Luisa not banished');
      assert.equal(s.cards[ids.play0[0]].damage, 0);
      assert.equal(s.cards[ids.play1[0]].damage, 4, 'all 4 moved to the opposing character');
    } else assert.equal(s.cards[ids.play0[0]].zone, 'discard', 'no opposing character → 4 damage → banished');
  }
});

// Wilds Unknown: DunBroch Family Tapestry — a player with no character cards in the discard doesn't shuffle
oracle('775fc6f976', 'no characters in your discard → your deck is not shuffled', () => {
  const tap = byName('DunBroch Family Tapestry'); const ch = vanilla((d) => d.cost === 2);
  const { s } = setup({});
  const t = put(s, 0, tap, 'play'); s.cards[t].exerted = false;
  const mine = put(s, 0, ch, 'discard');
  const deck1 = [...s.players[1].deck];
  ok(applyAction(s, 0, { type: 'useAbility', iid: t, index: 1 })); drain(s, 'no');
  assert.equal(s.cards[mine].zone, 'deck', 'my character shuffled in');
  assert.deepEqual(s.players[1].deck, deck1, "opponent's deck untouched");
});

// Wilds Unknown: RC – Remote-Controlled Car with Reckless isn't forced to pay 1 {I} to challenge
oracle('4e2d9bd493', "Reckless RC: may end the turn without paying to challenge", () => {
  const rc = byName('RC - Remote-Controlled Car'); const opp = vanilla((d) => d.wp >= 4);
  const { s, ids } = setup({ play0: [rc], play1: [opp] });
  ok(applyAction(s, 0, { type: 'mod', iid: ids.play0[0], stat: 'kw', kw: 'reckless', delta: 1 }));
  s.cards[ids.play1[0]].exerted = true;
  assert.ok(kw(s, ids.play0[0]).reckless, 'has Reckless');
  const r = applyAction(s, 0, { type: 'endTurn' });
  assert.ok(r.ok, `turn can end: ${r.error}`);
});

// Wilds Unknown: Alien – True Believer returns only cards named Alien, not Alien-classified Stitch
oracle('2a4d389df3', 'He Has Been Chosen: Stitch – Carefree Snowboarder is not "named Alien"', () => {
  const alien = byName('Alien - True Believer'); const stitch = byName('Stitch - Carefree Snowboarder'); const killer = vanilla((d) => d.str >= 2 && d.wp >= 3);
  for (const withAlien of [false, true]) {
    const { s, ids } = setup({ play0: [alien], play1: [killer] });
    const st = put(s, 0, stitch, 'discard'); const a2 = withAlien ? put(s, 0, alien, 'discard') : null;
    s.cards[ids.play1[0]].exerted = true;
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }));
    for (let k = 0; k < 4 && s.pending; k++) { assert.ok(!s.pending.valid.includes(st), 'Stitch not offered'); if (a2 && s.pending.valid.includes(a2)) choose(s, a2); else drain(s, 'yes'); }
    assert.equal(s.cards[ids.play0[0]].zone, 'discard', 'Alien banished');
    assert.equal(s.cards[st].zone, 'discard', 'Stitch stays');
    if (a2) assert.equal(s.cards[a2].zone, 'hand', 'the other Alien returns');
  }
});

// Wilds Unknown: Buzz's Arm can't be played on the opponent's turn even after Buzz Lightyear was banished
oracle('b35bf33485', "Missing Piece doesn't change timing: only on your own turn", () => {
  const buzz = byName('Buzz Lightyear - Space Ranger'); const arm = byName("Buzz's Arm"); const big = vanilla((d) => d.str >= 4);
  const { s, ids } = setup({ play0: [buzz], hand0: [arm], play1: [big] });
  passTo(s, 1);
  s.cards[ids.play1[0]].drying = false; s.cards[ids.play0[0]].exerted = true;
  ok(applyAction(s, 1, { type: 'challenge', attacker: ids.play1[0], target: ids.play0[0] })); drain(s, 'no');
  assert.equal(s.cards[ids.play0[0]].zone, 'discard', 'Buzz banished on their turn');
  assert.equal(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'free' }).ok, false, 'free mode refused');
  assert.equal(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }).ok, false, 'not on their turn');
  assert.equal(s.cards[ids.hand0[0]].zone, 'hand');
});

// Wilds Unknown: Hercules – Young Rescuer as the only card in hand → discard the (empty) hand, then return a card
oracle('4473889d65', 'Heroic Sacrifice works with nothing else in hand', () => {
  const herc = byName('Hercules - Young Rescuer'); const ch = vanilla((d) => d.cost === 3);
  const { s, ids } = setup({ hand0: [herc] });
  emptyHand(s, 0);
  const p = s.players[0]; p.deck.splice(p.deck.indexOf(ids.hand0[0]), 1); p.hand.push(ids.hand0[0]); s.cards[ids.hand0[0]].zone = 'hand';
  const dis = put(s, 0, ch, 'discard');
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  for (let k = 0; k < 4 && s.pending; k++) { if (s.pending.confirm) yes(s); else choose(s, dis); }
  assert.equal(s.cards[dis].zone, 'hand', 'returned from the discard');
});

// Wilds Unknown: The Leviathan – It's A Machine! totals current {S} (modifiers count; below 0 counts as 0)
oracle('061d9fda41', 'total {S} 10 or less uses current {S}, negatives as 0', () => {
  const lev = byName('The Leviathan - Guardian of Atlantis');
  const p3 = vanilla((d) => d.str === 3); const q7 = vanilla((d) => d.str === 7); const t10 = vanilla((d) => d.str === 10); const s2 = vanilla((d) => d.str === 2);
  const start = (opp, mods) => {
    const { s, ids } = setup({ hand0: [lev], play1: opp });
    for (const [k, delta] of mods) ok(applyAction(s, 0, { type: 'mod', iid: ids.play1[k], stat: 'str', delta }));
    for (const x of s.players[0].hand.filter((x) => x !== ids.hand0[0]).slice(0, 2)) ok(applyAction(s, 0, { type: 'moveCard', iid: x, to: 'discard' }));
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    if (s.pending?.confirm) yes(s);
    assert.ok(s.pending?.valid, 'Leviathan asks for targets');
    return { s, ids };
  };
  { const { s, ids } = start([p3, q7], []);                     // 3 + 7 = 10
    choose(s, ids.play1[0]); assert.ok(s.pending?.valid.includes(ids.play1[1]), '3 + 7 fits'); }
  { const { s, ids } = start([p3, q7], [[0, 1]]);               // (3+1) + 7 = 11
    choose(s, ids.play1[0]); assert.ok(!s.pending?.valid?.includes(ids.play1[1]), '4 + 7 is over 10'); }
  { const { s, ids } = start([p3, t10, s2], [[0, -5]]);         // −2 counts as 0: 0 + 10 leaves no room for 2
    choose(s, ids.play1[0]); assert.ok(s.pending?.valid.includes(ids.play1[1]), '0 + 10 fits');
    choose(s, ids.play1[1]); assert.ok(!s.pending?.valid?.includes(ids.play1[2]), 'a −2 {S} character adds 0, not −2'); }
});

// Wilds Unknown: Mr. Incredible – Super Strong challenging himself → Let's Do This! draws (he's a Super)
oracle('bfa96fd685', 'his own challenge counts', () => {
  const mr = byName('Mr. Incredible - Super Strong'); const def = vanilla((d) => d.wp >= 8);
  const { s, ids } = setup({ play0: [mr], play1: [def] });
  s.cards[ids.play1[0]].exerted = true;
  const h = handOf(s, 0);
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] })); drain(s, 'yes');
  assert.equal(handOf(s, 0), h + 1);
});

// Wilds Unknown: Julieta's Arepas – That Did the Trick after moving damage (moving = removing)
oracle('7cd39ff865', 'moved damage this turn → gain 1 lore', () => {
  const arepas = byName("Julieta's Arepas"); const luisa = byName('Luisa Madrigal - Confident Climber'); const mine = vanilla((d) => d.wp >= 3);
  for (const moved of [false, true]) {
    const { s, ids } = setup({ play0: [luisa, mine] });
    const ar = put(s, 0, arepas, 'play');
    s.cards[ids.play0[1]].damage = 1;
    if (moved) { ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 1 })); choose(s, ids.play0[1]); drain(s, 'no'); assert.equal(s.cards[ids.play0[0]].damage, 1, 'moved'); }
    const l = s.players[0].lore;
    ok(applyAction(s, 0, { type: 'useAbility', iid: ar, index: 1 })); drain(s, 'no');
    assert.equal(s.players[0].lore - l, moved ? 1 : 0, moved ? 'moved damage counts' : 'nothing removed → no lore');
  }
});

// Wilds Unknown: Syndrome – Got Me Monologuing!: a Robot without Shift can be returned and played, not shifted
oracle('6581dd79ba', 'Robot without Shift: returned, then played (not shifted)', () => {
  const syn = byName('Syndrome - Out for Revenge'); const robot = byName('Omnidroid - V.8');
  const { s, ids } = setup({ play0: [syn] });
  const r = put(s, 0, robot, 'discard');
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
  for (let k = 0; k < 4 && s.pending && s.cards[r].zone === 'discard'; k++) choose(s, r);
  assert.notEqual(s.cards[r].zone, 'discard', 'the Robot card left the discard (returned to hand)');
  for (let k = 0; k < 4 && s.pending; k++) { if (s.pending.confirm) yes(s); else if (s.pending.choices) ok(applyAction(s, 0, { type: 'choose', option: 0 })); else choose(s, r); }
  assert.equal(s.cards[r].zone, 'play', 'played for free');
  assert.equal(!!s.cards[r].shifted, false, 'not shifted — it has no Shift');
});

// Wilds Unknown: Merida – Steady Aim — moving damage isn't dealing damage
oracle('c688a864b2', "Can't Hold It Back Anymore moves damage → no extra 2", () => {
  const merida = byName('Merida - Formidable Archer'); const song = byName("Can't Hold It Back Anymore"); const arrows = byName('Three Arrows');
  const mine = vanilla((d) => d.wp >= 4); const opp = vanilla((d) => d.wp >= 7);
  { const { s, ids } = setup({ play0: [merida, mine], play1: [opp], hand0: [song] });
    s.cards[ids.play0[1]].damage = 2;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); choose(s, ids.play1[0]); drain(s, 'no');
    assert.equal(s.cards[ids.play1[0]].damage, 2, 'only the 2 moved damage'); }
  { const { s, ids } = setup({ play0: [merida], play1: [opp], hand0: [arrows] });           // control: an action dealing damage
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); choose(s, ids.play1[0]); drain(s, 'no');
    assert.equal(s.cards[ids.play1[0]].damage, 4, 'dealt 2 + Steady Aim 2'); }
});

// Winterspell: Grandmother Willow – Smooth the Way has no "may": it applies to the very next character
oracle('20a2785dbf', 'the discount goes on the next character played, no choice', () => {
  const willow = byName('Grandmother Willow - Ancient Advisor'); const one = vanilla((d) => d.cost === 1); const three = vanilla((d) => d.cost === 3);
  { const { s, ids } = setup({ hand0: [willow, three, three] });          // played this turn → next character
    const pay = (iid) => { const b = inkReady(s, 0); ok(applyAction(s, 0, { type: 'play', iid })); drain(s, 'no'); return b - inkReady(s, 0); };
    assert.equal(pay(ids.hand0[0]), willow.cost);
    assert.equal(pay(ids.hand0[1]), 2, 'next character: 1 less');
    assert.equal(pay(ids.hand0[2]), 3, 'only once'); }
  { const { s, ids } = setup({ play0: [willow], hand0: [one, three] });   // already in play → first character, even a cheap one
    const pay = (iid) => { const b = inkReady(s, 0); ok(applyAction(s, 0, { type: 'play', iid })); drain(s, 'no'); return b - inkReady(s, 0); };
    assert.equal(pay(ids.hand0[0]), 0, 'cost-1 character takes the discount');
    assert.equal(pay(ids.hand0[1]), 3, "can't save it for the bigger one"); }
});

// Winterspell: Lilo – Bundled Up prevents only the first damage each opponent's turn
oracle('aaae0f57df', 'second damage in the same opponent turn goes through', () => {
  const lilo = byName('Lilo - Bundled Up'); const pin = vanilla((d) => d.str === 1 && d.wp >= 3);
  const { s, ids } = setup({ play0: [lilo], play1: [pin, pin] });
  passTo(s, 1);
  for (const a of ids.play1) s.cards[a].drying = false;
  s.cards[ids.play0[0]].exerted = true;
  ok(applyAction(s, 1, { type: 'challenge', attacker: ids.play1[0], target: ids.play0[0] })); drain(s, 'no');
  assert.equal(s.cards[ids.play0[0]].damage, 0, 'first: prevented');
  ok(applyAction(s, 1, { type: 'challenge', attacker: ids.play1[1], target: ids.play0[0] })); drain(s, 'no');
  assert.equal(s.cards[ids.play0[0]].damage, 1, 'second: taken');
});

// FAQ: A Whole New World with every deck under 7 cards → the active player resolves first and loses
oracle('751184fef6', 'active player loses', () => {
  const awnw = byName('A Whole New World');
  const { s, ids } = setup({ hand0: [awnw] });
  for (const p of s.players) for (const iid of p.deck.splice(3)) { s.cards[iid].zone = 'discard'; p.discard.push(iid); }
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
  assert.notEqual(s.status, 'playing', 'the game is over');
  assert.equal(s.winner, 1, 'seat 0 (active) lost');
});

// FAQ: Anna – Heir to Arendelle: the chosen character exerted later that turn still doesn't ready
oracle('8b4736ed90', 'chosen while ready, exerted later → stays exerted at their next turn start', () => {
  const anna = byName('Anna - Heir to Arendelle'); const elsa = byName('Elsa - Snow Queen'); const opp = vanilla((d) => d.wp >= 3);
  const { s, ids } = setup({ hand0: [anna], play0: [elsa], play1: [opp, opp] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  choose(s, ids.play1[0]); drain(s, 'no');
  assert.equal(s.cards[ids.play1[0]].exerted, false, 'was ready when chosen');
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 })); choose(s, ids.play1[0]); drain(s, 'no');
  s.cards[ids.play1[1]].exerted = true;                                   // control
  passTo(s, 1);
  assert.equal(s.cards[ids.play1[0]].exerted, true, 'Loving Heart keeps it exerted');
  assert.equal(s.cards[ids.play1[1]].exerted, false, 'the other one readied');
});

// FAQ: Beast – Selfless Protector + The Prince – Never Gives Up (Resist +1): Teeth and Ambitions on the Prince
oracle('799bc16b76', '1 damage on Beast, 2 on Flounder', () => {
  const beast = byName('Beast - Selfless Protector'); const prince = byName('The Prince - Never Gives Up');
  const flounder = byName('Flounder - Voice of Reason'); const teeth = byName('Teeth and Ambitions');
  const { s, ids } = setup({ play0: [beast, prince], play1: [flounder], hand0: [teeth] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  choose(s, ids.play0[1]);
  if (s.pending) choose(s, ids.play1[0]);
  drain(s, 'no');
  assert.equal(s.cards[ids.play0[1]].damage, 0, 'Prince took none');
  assert.equal(s.cards[ids.play0[0]].damage, 1, 'Beast took 1 (Resist reduced it first)');
  assert.equal(s.cards[ids.play1[0]].zone, 'discard', 'Flounder took 2 and was banished');
});

// FAQ errata: Befuddle returns a *chosen* character or item → Ward stops it
oracle('c52dd7118a', 'Befuddle chooses: a Ward character is not a target', () => {
  const bef = byName('Befuddle'); const patch = byName('Patch - Playful Pup'); const two = vanilla((d) => d.cost === 2);
  const { s, ids } = setup({ hand0: [bef], play1: [patch, two] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  assert.ok(s.pending && !s.pending.valid.includes(ids.play1[0]), 'Ward character not choosable');
  choose(s, ids.play1[1]); drain(s, 'no');
  assert.equal(s.cards[ids.play1[1]].zone, 'hand');
  assert.equal(s.cards[ids.play1[0]].zone, 'play');
});

// FAQ: Belle – Strange but Special's extra ink still needs the inkwell symbol
oracle('2c4d8a0bf2', 'the additional card must be inkable', () => {
  const belle = byName('Belle - Strange but Special');
  const inky = vanilla((d) => d.inkable && d.cost === 2); const dry = vanilla((d) => !d.inkable);
  const { s, ids } = setup({ play0: [belle], hand0: [inky, inky, dry] });
  ok(applyAction(s, 0, { type: 'ink', iid: ids.hand0[0] }));
  assert.equal(applyAction(s, 0, { type: 'ink', iid: ids.hand0[2] }).ok, false, 'uninkable refused');
  ok(applyAction(s, 0, { type: 'ink', iid: ids.hand0[1] }));
  assert.equal(applyAction(s, 0, { type: 'ink', iid: s.players[0].hand.find((x) => s.defs[s.cards[x].cardId].inkable) }).ok, false, 'only one extra');
});
