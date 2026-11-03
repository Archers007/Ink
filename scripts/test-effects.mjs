// Scenario tests for automated card abilities (compiled procs + engine effect queue).
//   node scripts/test-effects.mjs
import assert from 'node:assert/strict';
import { applyAction, checkInvariants, viewFor, eventsFor } from '../game/engine.js';
import { all, byName, test, done, ok, setup, FILLER } from './lib/game.mjs';
import { effStr, effLore } from '../public/js/play/rules.js';
import { handEvaluate, BASELINE } from '../game/searchbot.js';
import { botDecide } from '../game/bot.js';


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

// #17: one static changes a stat another static's selector reads; the result can't depend on who entered play first
test('statics see each other: Gaston\'s +1 {S} qualifies Li Shang for his own "4 {S} or more get +1 {L}", in either order', () => {
  const li = byName('Li Shang - Valorous General'), gaston = byName('Gaston - Created by the Vine');
  for (const order of [[li, gaston], [gaston, li]]) {
    const { s, ids } = setup({ play0: order });
    ok(applyAction(s, 0, { type: 'endTurn' }));                       // a state check re-applies the board's statics
    const shang = s.cards[ids.play0[order.indexOf(li)]];
    const tag = order.map((d) => d.name).join(' then ');
    assert.equal(effStr(shang, li), li.str + 1, `Gaston gives Li Shang +1 strength (${tag})`);
    assert.equal(effLore(shang, li), li.lore + 1, `Li Shang at ${li.str + 1} strength gets his own +1 lore (${tag})`);
    checkInvariants(s);
  }
  // and it comes off again once Gaston is gone
  const { s, ids } = setup({ play0: [li, gaston] });
  ok(applyAction(s, 0, { type: 'endTurn' }));
  const g = ids.play0[1];
  s.cards[g].zone = 'discard'; s.players[0].play.splice(s.players[0].play.indexOf(g), 1); s.players[0].discard.push(g);
  ok(applyAction(s, 1, { type: 'endTurn' }));
  assert.equal(effStr(s.cards[ids.play0[0]], li), li.str, 'without Gaston: printed strength');
  assert.equal(effLore(s.cards[ids.play0[0]], li), li.lore, 'without Gaston: printed lore');
});

// #19: a hand card the board discounts carries its current cost in the owner's view
test('view: Seeking the Half Crown costs 2 less with two Sorcerers in play, and the hand says so', () => {
  const half = byName('Seeking the Half Crown');
  const sorc = all.find((d) => d.type === 'character' && d.classes?.some((x) => /^sorcerer$/i.test(x)) && d.procs.every((p) => p.kind !== 'static'));
  assert.ok(sorc, 'a Sorcerer without statics of its own');
  const { s, ids } = setup({ hand0: [half, FILLER], play0: [sorc, sorc] });
  const hand = viewFor(s, 0).players[0].hand;
  assert.equal(hand.find((c) => c.iid === ids.hand0[0]).cost, half.cost - 2, 'two Sorcerers: pay 2 less');
  assert.equal(hand.find((c) => c.iid === ids.hand0[1]).cost, undefined, 'an undiscounted card carries no cost field');
  assert.equal(viewFor(s, 1).players[0].hand, null, 'the opponent still sees no hand');
  // the engine agrees when it's played
  const inkBefore = s.players[0].inkwell.filter((iid) => !s.cards[iid].exerted).length;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink' }));
  assert.equal(inkBefore - s.players[0].inkwell.filter((iid) => !s.cards[iid].exerted).length, half.cost - 2, 'paid the discounted price');
});

// a private "look at the top N cards" tells the looker's table which cards (to show them turning over, choosable or
// not) and the other player's table only how many
test('look at the top N: a look event with the cards for the looker, just the count for the opponent', () => {
  const looker = all.find((d) => d.type === 'action' && d.procs.some((p) => p.exec && p.kind === 'action' && JSON.stringify(p).includes('"fn":"look"') && !JSON.stringify(p).includes('"reveal"')));
  assert.ok(looker, 'an action that looks at the top of the deck without revealing');
  const { s, ids } = setup({ hand0: [looker] });
  const r = ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink' }));
  const mine = eventsFor(r.events, 0).find((e) => e.k === 'look');
  const theirs = eventsFor(r.events, 1).find((e) => e.k === 'look');
  assert.ok(mine && mine.n >= 1 && mine.cards?.length === mine.n && mine.cards.every((c) => c.iid && c.cardId), `${looker.full}: the looker gets the cards`);
  assert.ok(theirs && theirs.n === mine.n && theirs.cards === undefined, `${looker.full}: the opponent gets only the count`);
  assert.equal(mine.seat, 0);
});

// #27: CR 8.10.5 — a shifted character "does keep any effects that apply to that character", lingering ones too
const MIM = byName('Madam Mim - Rival of Merlin');
const mimAbility = MIM.procs.findIndex((p) => p.kind === 'activated');
test('Shift keeps a lingering effect: shifting onto a character Madam Mim played still banishes it at end of turn', () => {
  const base = byName('Madam Mim - Bauble Chaser');
  const { s, ids } = setup({ play0: [MIM], hand0: [base, MIM] });
  s.cards[ids.play0[0]].drying = false;
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: mimAbility }));
  if (s.pending) ok(applyAction(s, 0, { type: 'choose', target: ids.hand0[0] }));
  assert.equal(s.cards[ids.hand0[0]].zone, 'play', 'Mim played the 4-or-less character');
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[1], mode: 'shift', target: ids.hand0[0] }));
  ok(applyAction(s, 0, { type: 'endTurn' }));
  while (s.pending) ok(applyAction(s, s.pending.seat, { type: 'choose', skip: true }));
  assert.equal(s.cards[ids.hand0[1]].zone, 'discard', 'the shifted character is banished at the end of the turn');
  assert.equal(s.cards[ids.play0[0]].zone, 'play', 'the Mim that used the ability is untouched');
  checkInvariants(s);
});

// #29: Bodyguard's "may enter play exerted" works however the character is played (CR 8.3.2)
test('Bodyguard played by an effect: the player is asked whether it enters exerted, and the answer sticks', () => {
  const bg = all.find((d) => d.type === 'character' && d.kw?.bodyguard && d.cost <= 4 && d.abilities.length === 1);
  assert.ok(bg, 'a vanilla Bodyguard character costing 4 or less');
  for (const yes of [true, false]) {
    const { s, ids } = setup({ play0: [MIM], hand0: [bg] });
    s.cards[ids.play0[0]].drying = false;
    ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: mimAbility }));
    if (s.pending?.valid?.includes(ids.hand0[0])) ok(applyAction(s, 0, { type: 'choose', target: ids.hand0[0] }));
    assert.equal(s.pending?.confirm, true, `${bg.full}: asked whether it enters exerted`);
    assert.equal(viewFor(s, 1).pending?.seat, 0, 'the opponent sees who is choosing');
    ok(applyAction(s, 0, yes ? { type: 'choose', confirm: true } : { type: 'choose', skip: true }));
    assert.equal(s.cards[ids.hand0[0]].exerted, yes, yes ? 'yes: exerted' : 'no: ready');
    assert.equal(s.pending, null);
    checkInvariants(s);
  }
  // played from the hand the normal way, the client asks up front and there is no second prompt
  const { s, ids } = setup({ hand0: [bg] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0], mode: 'ink', enterExerted: true }));
  assert.equal(s.cards[ids.hand0[0]].exerted, true);
  assert.equal(s.pending, null, 'no prompt for a normal play');
});

// ---------- the search bot's score and rollout policy (searchbot.js, bot.js; the 2026-11 audit) ----------
const quester = (lore) => all.find((d) => d.type === 'character' && d.abilities.length === 0 && d.lore === lore && d.cost <= 5);
test('bot score: lethal on board at the horizon outweighs everything; the opponent about to quest for 20 is a big minus', () => {
  const q4 = quester(4) || quester(3), q2 = quester(2);
  // my turn is starting with 16 lore and a ready, dry 4-lore quester: that is a won game, whatever they have
  const { s, ids } = setup({ play0: [q4], play1: [q2, q2, q2, q2] });
  for (const id of ids.play0) s.cards[id].drying = false;
  s.players[0].lore = 20 - effLore(s.cards[ids.play0[0]], q4);
  assert.ok(handEvaluate(s, 0) > 400, `lethal next quest scores high: ${handEvaluate(s, 0)}`);
  assert.ok(handEvaluate(s, 0, BASELINE) < 100, 'the baseline score has no idea');
  // the mirror: they have 18 lore and a board that quests for 2 next turn — I am losing unless this turn answers it
  const { s: t, ids: ti } = setup({ play0: [q2, q2], play1: [q2] });
  t.players[1].lore = 18;
  assert.ok(handEvaluate(t, 0) < handEvaluate(t, 0, BASELINE) - 150, 'their lethal next turn costs about 200 points');
  // an exerted quester of theirs still counts: their turn readies it
  t.cards[ti.play1[0]].exerted = true;
  assert.ok(handEvaluate(t, 0) < handEvaluate(t, 0, BASELINE) - 150, 'exerted now, ready on their turn');
});
test('rollout policy: a lone bomb is kept, not inked, once the inkwell is deep', () => {
  const bomb = all.find((d) => d.type === 'character' && d.cost === 7 && d.inkable && d.abilities.length === 0) || all.find((d) => d.type === 'character' && d.cost >= 7 && d.inkable);
  const { s, ids } = setup({ hand0: [bomb], ink0: 6 });
  s.players[0].hand = s.players[0].hand.filter((id) => id === ids.hand0[0]);          // the bomb alone in hand
  for (const id of Object.keys(s.cards)) if (s.cards[id].owner === 0 && s.cards[id].zone === 'hand' && id !== ids.hand0[0]) { s.cards[id].zone = 'deck'; s.players[0].deck.push(id); }
  const a = botDecide(s, 0, { keep: true });
  assert.notEqual(a?.type === 'ink' && a.iid === ids.hand0[0], true, `keeps the bomb: ${JSON.stringify(a)}`);
  const b = botDecide(s, 0, { keep: false });
  assert.equal(b?.type, 'ink', 'the old policy inked it');
  checkInvariants(s);
});

done();
