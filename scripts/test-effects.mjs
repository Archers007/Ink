// Scenario tests for automated card abilities (game/effects.js + engine effect queue).
//   node scripts/test-effects.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadCardIndex } from '../game/cards.js';
import { newGame, applyAction, checkInvariants, viewFor } from '../game/engine.js';
import { parseEffect, parseAbility } from '../game/effects.js';

const DB = process.env.CARDS_DB || 'cache/cards.db';
if (!existsSync(DB)) { console.error(`no ${DB} — start the server once to download it`); process.exit(1); }
const index = await loadCardIndex(DB);
const all = [...index.byFull.values()];
const byName = (full) => { const d = all.find((x) => x.full === full); assert(d, `card not found: ${full}`); return d; };
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('ok -', name); } catch (e) { console.error('FAIL -', name); throw e; } };

// ---------- parser ----------
test('parser: unknown sentence → whole ability manual', () => {
  assert.equal(parseEffect('Draw a card. Then, choose up to 3 cards from chosen opponent\'s discard and shuffle them into their deck.'), null);
});
test('parser: targets, filters, durations', () => {
  const [st] = parseEffect('Banish chosen opposing character with 2 strength or less.');
  assert.equal(st.op, 'banish'); assert.equal(st.target.side, 'opp'); assert.equal(st.target.max, 2);
  const [m] = parseEffect('Chosen character gets -2 strength until the start of your next turn.');
  assert.deepEqual([m.op, m.n, m.stat, m.until], ['mod', -2, 'str', 'sot']);
  const g = parseEffect('Chosen character gains Rush and Challenger +2 this turn.')[0];
  assert.deepEqual(g.kws, [['rush', 1], ['challenger', 2]]);
});
test('parser: "you may X, then Y" is one optional unit', () => {
  const st = parseEffect('you may draw a card, then choose and discard a card.');
  assert.equal(st[0].optional, true); assert.equal(st[1].linked, true);
});
test('parser: name baked into text', () => {
  assert.equal(parseAbility({ text: "I'M A FAST LEARNER When you play this character, remove up to 1 damage from chosen character." }, 'character').trigger, 'play');
});

// ---------- engine scenarios ----------
// Builds a game where seat 0 is active in its main phase, with given cards in hand / play.
const FILLER = all.find((d) => d.type === 'character' && d.abilities.length === 0 && d.cost === 1 && d.wp >= 1);
function setup({ hand0 = [], play0 = [], play1 = [], hand1 = [], ink0 = 10 } = {}) {
  const deck = (extra) => [...extra, ...Array(60 - extra.length).fill(FILLER)];
  const s = newGame({ seed: 1, starting: 0, players: [
    { name: 'P0', deck: deck([...hand0, ...play0]) },
    { name: 'P1', deck: deck([...hand1, ...play1]) },
  ] });
  for (const seat of [0, 1]) assert.ok(applyAction(s, seat, { type: 'mulligan', iids: [] }).ok);
  const grab = (seat, def, zone) => {
    const p = s.players[seat];
    const iid = [...p.deck, ...p.hand].find((id) => s.cards[id].cardId === def.id && s.cards[id].zone !== zone);
    for (const z of ['deck', 'hand']) { const i = p[z].indexOf(iid); if (i >= 0) p[z].splice(i, 1); }
    s.cards[iid].zone = zone;
    p[zone].push(iid);
    return iid;
  };
  const ids = { hand0: hand0.map((d) => grab(0, d, 'hand')), play0: play0.map((d) => grab(0, d, 'play')),
    play1: play1.map((d) => grab(1, d, 'play')), hand1: hand1.map((d) => grab(1, d, 'hand')) };
  for (let k = 0; k < ink0; k++) { const iid = s.players[0].deck.pop(); s.cards[iid].zone = 'inkwell'; s.cards[iid].faceDown = true; s.players[0].inkwell.push(iid); }
  checkInvariants(s);
  return { s, ids };
}
const ok = (r) => { assert.ok(r.ok, r.error); return r; };

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

console.log(`ALL OK (${passed} tests)`);
