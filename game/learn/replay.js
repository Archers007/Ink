// Replaying a saved game: the engine is deterministic, so the seed, both decklists and the accepted actions
// rebuild every position. onStep(state, k, seat, action, events, handBefore) runs after each action
// (handBefore: that seat's hand just before it, for mulligans).
import { newGame, applyAction } from '../engine.js';
import { resolveDeck } from '../cards.js';

export function replayGame(index, rec, onStep = null, { scratch = false } = {}) {
  const players = rec.seats.map((p) => ({ name: p.name, deck: resolveDeck(index, { cards: p.cards }).defs }));
  const s = newGame({ seed: rec.seed, players });
  if (onStep) onStep(s, -1, null, null, []);
  for (let k = 0; k < rec.actions.length; k++) {
    const [seat, a] = rec.actions[k];
    const handBefore = a?.type === 'mulligan' ? [...s.players[seat].hand] : null;
    const r = applyAction(s, seat, a, scratch ? { scratch: true } : null);
    if (!r.ok) return { s, ok: false, at: k, error: r.error };      // the cards changed since: the rest doesn't replay
    if (onStep) onStep(s, k, seat, a, r.events || [], handBefore);
  }
  return { s, ok: true };
}
