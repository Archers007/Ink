// Q&As about the last cards to become runnable (Merlin's Wand, Thomas O'Malley, Minnie - Urban Visionary, Metamorphosis,
// The Family Scattered, Anna - Soothing Sister, Colors of the Wind) and the cards their pages also answer for.
import { oracle, untestable, assert, applyAction, byName, ok, setup, vanilla, put, drain, choose, yes, no, eff } from './lib.mjs';
import { all } from '../lib/game.mjs';

const toTop = (s, seat, iid) => { const p = s.players[seat]; for (const z of ['hand', 'deck', 'play', 'discard']) { const i = p[z].indexOf(iid); if (i >= 0) p[z].splice(i, 1); } s.cards[iid].zone = 'deck'; p.deck.unshift(iid); };
const dry = (s, ids) => { for (const iid of ids) s.cards[iid].drying = false; };

oracle('3eee0f5949', 'Everyone Knows Juanita is not in the discard while it resolves (9 others → draw 2, not 3)', () => {
  const ekj = byName('Everyone Knows Juanita');
  const { s, ids } = setup({ hand0: [ekj] });
  for (let k = 0; k < 9; k++) { const x = s.players[0].deck.pop(); s.cards[x].zone = 'discard'; s.players[0].discard.push(x); }
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
  assert.equal(s.players[0].hand.length, h - 1 + 2, '9 in the discard while it resolves → draw 2');
});

oracle('4b551d0085', "Merlin's Wand: Winnie the Pooh & Piglet + a Piglet share a name, so they pay the cost", () => {
  const wand = byName("Merlin's Wand"); const wp = byName('Winnie the Pooh & Piglet - Hunny Mages');
  const piglet = all.find((d) => d.name === 'Piglet' && d.type === 'character');
  const { s, ids } = setup({ play0: [wand], hand0: [wp, piglet] }); dry(s, ids.play0);
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 }));
  choose(s, ids.hand0[0]);
  assert.ok(s.pending.valid.includes(ids.hand0[1]), 'a Piglet may be the second card');
  choose(s, ids.hand0[1]); drain(s);
  assert.equal(s.players[0].costMods.length, 1, 'the cost was paid → the discount is set');
});

oracle('adbb1f997d', "Thomas O'Malley: both reveal a cost-5 card → both go into their players' hands", () => {
  const tom = byName("Thomas O'Malley - Savvy Vagabond"); const five = vanilla((d) => d.cost === 5);
  const { s, ids } = setup({ play0: [tom], hand0: [five], hand1: [five] }); dry(s, ids.play0);
  toTop(s, 0, ids.hand0[0]); toTop(s, 1, ids.hand1[0]);
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s);
  assert.deepEqual([s.cards[ids.hand0[0]].zone, s.cards[ids.hand1[0]].zone], ['hand', 'hand']);
});

oracle('4710b207c8', 'Minnie - Urban Visionary: decline the look but return one → still exert the inkwell; decline both → no', () => {
  const minnie = byName('Minnie Mouse - Urban Visionary');
  for (const ret of [true, false]) {
    const { s, ids } = setup({ play0: [minnie], ink0: 3 }); s.cards[ids.play0[0]].exerted = true;
    ok(applyAction(s, 0, { type: 'endTurn', force: true }));
    assert.equal(s.pending?.op, 'peekInkwell'); no(s);                  // don't look
    if (ret) choose(s, s.pending.valid[0]); else no(s);                 // return one / don't
    assert.equal(s.players[0].inkwell.length, ret ? 2 : 3);
    assert.equal(s.players[0].inkwell.every((x) => s.cards[x].exerted), ret, ret ? 'one "may" done → exert all' : 'neither → nothing');
  }
});

untestable('b4f89efce3', "a player leaving a 4-player game — the engine plays 2-player games");

oracle('07b3bc9b48', 'Ranger Team-Up uses the modified {W}', () => {
  const rtu = byName('Ranger Team-Up'); const me = vanilla((d) => d.wp === 2 && d.str >= 1);
  const { s, ids } = setup({ hand0: [rtu], play0: [me] });
  s.cards[ids.play0[0]].mods.push({ stat: 'wp', delta: 1, until: 'eot', by: 0, setTurn: s.turn, src: 'test' });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); choose(s, ids.play0[0]); drain(s);
  assert.equal(eff(s, ids.play0[0]).str, me.str + 3, '+3 {S} from a 3 {W}');
});

oracle('bbc3397cc3', 'Metamorphosis: only a character with Shift, and only with something to shift onto', () => {
  const meta = byName('Metamorphosis'); const tod = byName('Tod - Knows All the Tricks'); const plain = vanilla((d) => d.cost >= 3);
  const base = all.find((d) => d.name === 'Tod' && d.full !== tod.full && d.type === 'character');
  { // a plain character in the discard (no Shift) and no Tod in play: nothing to do
    const { s, ids } = setup({ hand0: [meta, plain, tod] });
    for (const x of ids.hand0.slice(1)) { const p = s.players[0]; p.hand.splice(p.hand.indexOf(x), 1); s.cards[x].zone = 'discard'; p.discard.push(x); }
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.deepEqual(ids.hand0.slice(1).map((x) => s.cards[x].zone), ['discard', 'discard'], 'Tod has nothing to go on top of');
  }
  { const { s, ids } = setup({ hand0: [meta, plain, tod], play0: [base] });
    for (const x of ids.hand0.slice(1)) { const p = s.players[0]; p.hand.splice(p.hand.indexOf(x), 1); s.cards[x].zone = 'discard'; p.discard.push(x); }
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
    if (s.pending?.valid) assert.ok(!s.pending.valid.includes(ids.hand0[1]), 'the card without Shift is not offered');
    drain(s);
    assert.equal(s.cards[ids.hand0[2]].zone, 'play', 'Tod shifted from the discard'); }
});

oracle('a5ebeec222', "Buzz Lightyear - On the Way: paying 2 or less after a payment modifier still triggers", () => {
  const buzz = byName('Buzz Lightyear - On the Way'); const three = all.find((d) => d.type === 'item' && d.cost === 3 && d.procs.every((p) => p.kind === 'activated'));
  const { s, ids } = setup({ play0: [buzz], hand0: [three] });
  s.players[0].costMods.push({ n: 1, filter: { types: ['item'] }, next: true, turn: s.turn, src: 'test' });
  const h = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
  assert.equal(s.players[0].hand.length, h - 1, 'draw 1, then discard 1 → the trigger happened');
  assert.equal(s.players[0].discard.length, 1);
});

oracle('b5822180a3', 'The Family Scattered on an opponent with 2 characters: one to hand, then one to the deck bottom', () => {
  const fs = byName('The Family Scattered'); const foe = vanilla((d) => d.wp >= 2);
  const { s, ids } = setup({ hand0: [fs], play1: [foe, foe] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
  const [a, b] = ids.play1;
  const where = [a, b].map((x) => (s.cards[x].zone === 'hand' ? 'hand' : s.players[1].deck.at(-1) === x ? 'bottom' : s.cards[x].zone));
  assert.deepEqual(where.sort(), ['bottom', 'hand']);
});

oracle('a5b3762396', "Shepherd's Journal: not looking → nothing moves", () => {
  const sj = byName("Shepherd's Journal");
  const { s, ids } = setup({ hand0: [sj] });
  const top = s.players[0].deck[0];
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'no');
  assert.equal(s.players[0].deck[0], top); assert.equal(s.players[0].discard.length, 0);
});

oracle('920a1a8c9e', "Anna - Soothing Sister + Flynn Rider in the discard: Flynn's full 4 {L} (his ability only works in play)", () => {
  const anna = byName('Anna - Soothing Sister'); const flynn = byName('Flynn Rider - His Own Biggest Fan');
  const { s, ids } = setup({ play0: [anna], hand0: [flynn] }); dry(s, ids.play0);
  const p = s.players[0]; p.hand.splice(p.hand.indexOf(ids.hand0[0]), 1); s.cards[ids.hand0[0]].zone = 'discard'; p.discard.push(ids.hand0[0]);
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
  for (let k = 0; k < 4 && s.pending; k++) { if (s.pending.confirm) yes(s); else choose(s, s.pending.valid.includes(ids.hand0[0]) ? ids.hand0[0] : s.pending.valid[0]); }
  assert.equal(p.lore, anna.lore + 4);
});

oracle('2851c9fcdb', 'Colors of the Wind counts ink types: Amethyst + Amethyst → 1; Amethyst + Amethyst/Steel → 2', () => {
  const cotw = byName('Colors of the Wind'); const ame = byName('Tinker Bell - Curious Fairy');
  const dual = all.find((d) => d.type === 'character' && JSON.stringify([...(d.inks || [])].sort()) === '["amethyst","steel"]');
  for (const [theirs, n] of [[ame, 1], [dual, 2]]) {
    const { s, ids } = setup({ hand0: [cotw, ame], hand1: [theirs] });
    toTop(s, 0, ids.hand0[1]); toTop(s, 1, ids.hand1[0]);
    const h = s.players[0].hand.length;
    ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
    assert.equal(s.players[0].hand.length, h - 1 + n);
  }
});
