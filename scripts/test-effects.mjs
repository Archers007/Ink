// Scenario tests for automated card abilities (compiled procs + engine effect queue).
//   node scripts/test-effects.mjs
import assert from 'node:assert/strict';
import { applyAction, checkInvariants, viewFor } from '../game/engine.js';
import { all, byName, test, done, ok, setup, FILLER } from './lib/game.mjs';


const DMG3 = byName('Vincenzo Santorini - The Explosives Expert');        // you may deal 3 damage to chosen character
test('ETB damage: optional prompt, banish on lethal, Ward blocks, Resist reduces', () => {
  const ward = all.find((d) => d.type === 'character' && d.kw.ward && d.abilities.every((a) => /^\s*Ward/i.test(a.text)));
  const resist = all.find((d) => d.type === 'character' && d.kw.resist === 1 && d.wp >= 3 && d.abilities.length === 1);
  const victim = all.find((d) => d.type === 'character' && d.abilities.length === 0 && d.wp === 3);
  const { s, ids } = setup({ hand0: [DMG3], play1: [ward, resist, victim] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink' }));
  assert.equal(s.pending?.type, 'choose');
  assert.ok(!s.pending.valid.includes(ids.play1[0]), 'Ward card must not be choosable');
  assert.ok(s.pending.valid.includes(ids.play1[1]) && s.pending.valid.includes(ids.play1[2]));
  assert.equal(viewFor(s, 1).pending.valid, undefined, 'other seat must not see the valid list');
  assert.equal(applyAction(s, 0, { type: 'endTurn' }).ok, false, 'pending blocks the turn');
  assert.equal(applyAction(s, 0, { type: 'choose', target: ids.play1[0] }).ok, false);
  ok(applyAction(s, 0, { type: 'choose', target: ids.play1[2] }));
  assert.equal(s.cards[ids.play1[2]].zone, 'discard', '3 damage to a 3-willpower character banishes it');
  assert.equal(s.pending, null);
  checkInvariants(s);
  // second copy against Resist +1 → 2 damage
  const { s: s2, ids: i2 } = setup({ hand0: [DMG3], play1: [resist] });
  ok(applyAction(s2, 0, { type: 'play', iid: i2.hand0[0], mode: 'ink' }));
  ok(applyAction(s2, 0, { type: 'choose', target: i2.play1[0] }));
  assert.equal(s2.cards[i2.play1[0]].damage, 2);
});

test('optional "may draw, then discard": declining skips both', () => {
  const bobby = byName('Bobby Zimuruski - Spray Cheese Kid');
  const { s, ids } = setup({ hand0: [bobby, FILLER] });
  const hand = s.players[0].hand.length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink' }));
  assert.equal(s.pending?.confirm, true);
  ok(applyAction(s, 0, { type: 'choose', skip: true }));
  assert.equal(s.pending, null);
  assert.equal(s.players[0].hand.length, hand - 1);
  // accepting: draw, then must discard (not optional)
  const { s: t, ids: j } = setup({ hand0: [bobby, FILLER] });
  ok(applyAction(t, 0, { type: 'play', iid: j.hand0[0], mode: 'ink' }));
  ok(applyAction(t, 0, { type: 'choose', confirm: true }));
  assert.equal(t.pending?.op, 'selfDiscard');
  assert.equal(applyAction(t, 0, { type: 'choose', skip: true }).ok, false);
  const pick = t.pending.valid[0];
  ok(applyAction(t, 0, { type: 'choose', target: pick }));
  assert.equal(t.cards[pick].zone, 'discard');
  checkInvariants(t);
});

test('"each opponent chooses and discards" is chosen by the opponent', () => {
  const d = all.find((x) => x.type === 'character' && x.abilities.length === 1 && /When you play this character, each opponent chooses and discards a card\.$/.test(x.abilities[0].text));
  assert(d, 'no such card');
  const { s, ids } = setup({ hand0: [d], hand1: [FILLER] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink' }));
  assert.equal(s.pending.seat, 1);
  assert.equal(applyAction(s, 0, { type: 'choose', target: s.pending.valid[0] }).ok, false, 'seat 0 cannot choose for the opponent');
  const pick = s.pending.valid[0];
  ok(applyAction(s, 1, { type: 'choose', target: pick }));
  assert.equal(s.cards[pick].zone, 'discard');
  assert.equal(s.cards[pick].owner, 1);
});

test('"until the start of your next turn" lasts through the opponent turn', () => {
  const kida = byName('Kida - Guardian of the Path');         // chosen opposing character gets -2 {S} this turn? (check text)
  const goofy = byName('Goofy - Ghost Hunter');                // chosen opposing character gets -1 {S} until the start of your next turn
  const victim = all.find((d) => d.type === 'character' && d.abilities.length === 0 && d.str >= 2);
  const { s, ids } = setup({ hand0: [goofy], play1: [victim] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink' }));
  ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] }));
  const str = () => viewFor(s, 0).players[1].play.find((c) => c.iid === ids.play1[0]).eff.str;
  assert.equal(str(), victim.str - 1);
  ok(applyAction(s, 0, { type: 'endTurn' }));
  assert.equal(s.active, 1); assert.equal(str(), victim.str - 1, 'still reduced during the opponent turn');
  ok(applyAction(s, 1, { type: 'endTurn' }));
  assert.equal(s.active, 0); assert.equal(str(), victim.str, 'expired at the start of my next turn');
  void kida;
});

test('action: no legal target → skipped, card still goes to discard', () => {
  const act = all.find((d) => d.type === 'action' && d.abilities.length === 1 && /^Banish chosen item\.$/.test(d.abilities[0].text));
  assert(act, 'no banish-item action');
  const { s, ids } = setup({ hand0: [act] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink' }));
  assert.equal(s.pending, null);
  assert.equal(s.cards[ids.hand0[0]].zone, 'discard');
  assert.ok(s.log.some((l) => /no valid/.test(l.text)));
});

test('a rejected choice rolls back atomically', () => {
  const { s, ids } = setup({ hand0: [DMG3], play1: [FILLER] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink' }));
  const before = JSON.stringify(s);
  assert.equal(applyAction(s, 0, { type: 'choose', target: 'c99999' }).ok, false);
  assert.equal(JSON.stringify(s), before);
});

done();
