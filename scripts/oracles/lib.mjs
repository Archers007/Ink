// Helpers for oracle tests: an official Q&A (scripts/oracles/qa.json) → a scenario whose result must match the answer.
//   oracle(qaId, what, fn)   a test of that Q&A — fn throws (assert) when the engine disagrees with the ruling
//   untestable(qaId, why)    a Q&A that isn't a game state the engine can show (deckbuilding, multiplayer, wording)
import assert from 'node:assert/strict';
import { applyAction, checkInvariants, viewFor } from '../../game/engine.js';
import { all, byName, ok, setup } from '../lib/game.mjs';

export { assert, applyAction, checkInvariants, viewFor, all, byName, ok, setup };
export const ORACLES = [];
export const UNTESTABLE = new Map();
export const oracle = (id, what, fn) => ORACLES.push({ id, what, fn });
export const untestable = (id, why) => UNTESTABLE.set(id, why);

// a plain character: no abilities, no keywords
export const vanilla = (f = () => true) => all.find((d) => d.type === 'character' && d.abilities.length === 0 && !Object.keys(d.kw || {}).length && f(d));
// a copy of `def` into any zone of any seat (setup() covers hand0/play0/play1/hand1 only)
export function put(s, seat, def, zone) {
  const p = s.players[seat];
  let iid = p.deck.find((id) => s.cards[id].cardId === def.id);
  if (!iid) {
    iid = `x${Object.keys(s.cards).length + 1}`;
    s.cards[iid] = { iid, cardId: def.id, owner: seat, zone: 'deck', exerted: false, damage: 0, drying: false, atLocation: null, mods: [], faceDown: false, boostedTurn: 0, parent: null, under: [], shifted: false, tempShift: null };
    s.defs[def.id] ||= def; p.deck.push(iid);
  }
  p.deck.splice(p.deck.indexOf(iid), 1); s.cards[iid].zone = zone; p[zone].push(iid);
  if (zone === 'play') s.cards[iid].drying = false;
  return iid;
}
export const giveInk = (s, seat, n) => { for (let k = 0; k < n; k++) { const iid = s.players[seat].deck.pop(); Object.assign(s.cards[iid], { zone: 'inkwell', faceDown: true }); s.players[seat].inkwell.push(iid); } };
export const readyAll = (s, ids) => { for (const iid of ids) Object.assign(s.cards[iid], { drying: false, exerted: false }); };
// answer prompts: 'yes' takes the first option / target and accepts every may; 'no' declines what it can
export function drain(s, policy = 'yes') {
  for (let k = 0; k < 30 && s.pending; k++) {
    const p = s.pending;
    if (p.type !== 'choose') { ok(applyAction(s, p.seat, { type: 'support' })); continue; }
    const no = policy === 'no' && (p.confirm || p.optional);
    ok(applyAction(s, p.seat, { type: 'choose', ...(no ? { skip: true } : p.choices ? { option: 0 } : p.confirm ? { confirm: true } : p.valid?.length ? { target: p.valid[0] } : { skip: true }) }));
  }
}
export const choose = (s, target) => ok(applyAction(s, s.pending.seat, { type: 'choose', target }));
export const yes = (s) => ok(applyAction(s, s.pending.seat, { type: 'choose', confirm: true }));
export const no = (s) => ok(applyAction(s, s.pending.seat, { type: 'choose', skip: true }));
export const passTo = (s, seat) => { for (let k = 0; k < 4 && s.active !== seat; k++) { ok(applyAction(s, s.active, { type: 'endTurn', force: true })); drain(s, 'no'); } };
// statics settle on a game state check — an end-turn pair puts seat 0 back in its main phase with everything applied
export const settle = (s) => { ok(applyAction(s, 0, { type: 'endTurn', force: true })); drain(s, 'no'); ok(applyAction(s, 1, { type: 'endTurn', force: true })); drain(s, 'no'); };
export const eff = (s, iid) => viewFor(s, s.cards[iid].owner).players[s.cards[iid].owner].play.find((c) => c.iid === iid)?.eff;
export const kw = (s, iid) => viewFor(s, s.cards[iid].owner).players[s.cards[iid].owner].play.find((c) => c.iid === iid)?.kw || {};
