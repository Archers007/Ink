// Bot-vs-bot simulation: plays N full games through the rules engine and checks
// invariants after every action (every card in exactly one zone, no negative
// lore, game always terminates). Also fuzzes random illegal actions to make sure
// they're rejected atomically.
//
//   node scripts/sim-games.mjs [games=50] [seed=1]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCardIndex, resolveDeck } from '../game/cards.js';
import { newGame, applyAction, checkInvariants, viewFor, eventsFor } from '../game/engine.js';
import { botDecide } from '../game/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAMES = Number(process.argv[2] || 50);
const SEED = Number(process.argv[3] || 1);

const index = await loadCardIndex(path.join(__dirname, '..', 'cache', 'cards.db'));
console.log(`cards: ${index.size}, demo decks: ${index.demoDecks.map((d) => d.name).join(' | ')}`);
for (const d of index.demoDecks) {
  const r = resolveDeck(index, d);
  if (!r.legal) throw new Error(`demo deck ${d.name} illegal: ${[...r.problems, ...r.errors].join('; ')}`);
}

const FUZZ = ['ink', 'play', 'quest', 'challenge', 'move', 'boost', 'endTurn', 'damage', 'exert', 'moveCard', 'mod', 'support', 'useAbility'];
let rngState = SEED;
const rnd = () => ((rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const stats = { games: 0, wins: [0, 0], reasons: {}, turns: [], actions: 0, rejected: 0 };
for (let g = 0; g < GAMES; g++) {
  const da = index.demoDecks[g % index.demoDecks.length];
  const db = index.demoDecks[(g + 1) % index.demoDecks.length];
  const s = newGame({
    seed: SEED * 1000 + g,
    players: [
      { name: 'Bot A', deck: resolveDeck(index, da).defs },
      { name: 'Bot B', deck: resolveDeck(index, db).defs },
    ],
  });
  checkInvariants(s);
  let steps = 0;
  while (s.status !== 'over') {
    if (++steps > 5000) throw new Error(`game ${g} did not finish (turn ${s.turn})`);
    // occasionally throw garbage at the engine from a random seat
    if (rnd() < 0.15) {
      const all = Object.keys(s.cards);
      const a = { type: FUZZ[Math.floor(rnd() * FUZZ.length)], iid: all[Math.floor(rnd() * all.length)], target: all[Math.floor(rnd() * all.length)], attacker: all[Math.floor(rnd() * all.length)], location: all[Math.floor(rnd() * all.length)], delta: 1, to: 'hand', stat: 'str', index: 0 };
      const before = JSON.stringify(s);
      const r = applyAction(s, Math.floor(rnd() * 2), a);
      if (!r.ok) {
        stats.rejected++;
        if (JSON.stringify(s) !== before) throw new Error(`rejected action mutated state: ${JSON.stringify(a)} -> ${r.error}`);
      } else if (a.type !== 'endTurn') {
        // a legal manual action — fine, keep going (bots adapt)
      }
      checkInvariants(s);
      if (s.status === 'over') break;
    }
    let acted = false;
    for (const seat of [0, 1]) {
      const a = botDecide(s, seat);
      if (!a) continue;
      const r = applyAction(s, seat, a);
      stats.actions++;
      if (!r.ok) {
        // fall back to ending the turn so the game always progresses
        const r2 = s.active === seat && s.status === 'playing' ? applyAction(s, seat, { type: 'endTurn', force: true }) : { ok: false };
        if (!r2.ok && s.pending?.seat === seat) applyAction(s, seat, { type: 'support' });
        if (!r2.ok && !s.pending) throw new Error(`bot stuck: ${JSON.stringify(a)} -> ${r.error}`);
      }
      // views must never leak the other player's hand
      for (const viewer of [0, 1, -1]) {
        const v = viewFor(s, viewer);
        for (const p of v.players) if (p.seat !== viewer && p.hand) throw new Error('hand leaked');
        for (const e of eventsFor(r.events || [], viewer)) {
          if (e.k === 'move' && e.from?.zone === 'deck' && e.to?.zone === 'hand' && e.from.seat !== viewer && e.cardId) throw new Error('draw leaked');
        }
      }
      checkInvariants(s);
      acted = true;
      break;
    }
    if (!acted && s.status !== 'over') throw new Error(`nobody can act in game ${g}: status=${s.status} pending=${JSON.stringify(s.pending)} active=${s.active}`);
  }
  stats.games++;
  stats.wins[s.winner]++;
  const reason = s.endReason.replace(/^.*?(reached|ended|conceded)/, '$1').replace(/\d+/g, 'N');
  stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
  stats.turns.push(s.turn);
}
const avg = stats.turns.reduce((a, b) => a + b, 0) / stats.turns.length;
console.log(`games: ${stats.games}  wins A/B: ${stats.wins.join('/')}  avg turns: ${avg.toFixed(1)}  min/max: ${Math.min(...stats.turns)}/${Math.max(...stats.turns)}`);
console.log(`bot actions: ${stats.actions}  fuzz rejected (atomic): ${stats.rejected}`);
console.log('end reasons:', stats.reasons);
console.log('OK');
