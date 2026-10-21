// Shared harness for engine scenario tests.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadCardIndex } from '../../game/cards.js';
import { newGame, applyAction, checkInvariants } from '../../game/engine.js';

const DB = process.env.CARDS_DB || 'cache/cards.db';
if (!existsSync(DB)) { console.error(`no ${DB} — start the server once to download it`); process.exit(1); }
export const index = await loadCardIndex(DB);
export const all = [...index.byFull.values()];
export const byName = (full) => { const d = all.find((x) => x.full === full); assert(d, `card not found: ${full}`); return d; };
let passed = 0;
export const test = (name, fn) => { try { fn(); passed++; console.log('ok -', name); } catch (e) { console.error('FAIL -', name); throw e; } };
export const done = () => console.log(`ALL OK (${passed} tests)`);
export const ok = (r) => { assert.ok(r.ok, r.error); return r; };
// Builds a game where seat 0 is active in its main phase, with given cards in hand / play.
export const FILLER = all.find((d) => d.type === 'character' && d.abilities.length === 0 && d.cost === 1 && d.wp >= 1);
export function setup({ hand0 = [], play0 = [], play1 = [], hand1 = [], ink0 = 10 } = {}) {
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
