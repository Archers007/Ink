// Search bot vs the heuristic bot over full games, alternating who goes first and which deck each side plays.
//
//   node scripts/bot-arena.mjs [games=20] [budgetMs=300]
//
// Both bots see only their own seat's legal information (the search bot re-deals what it can't see; see searchbot.js).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCardIndex, resolveDeck } from '../game/cards.js';
import { newGame, applyAction, checkInvariants } from '../game/engine.js';
import { botDecide } from '../game/bot.js';
import { createSearchBot } from '../game/searchbot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAMES = Number(process.argv[2] || 20);
const BUDGET = Number(process.argv[3] || 300);
const index = await loadCardIndex(path.join(__dirname, '..', 'cache', 'sanitized.db'));
const decks = index.demoDecks.map((d) => ({ name: d.name, defs: resolveDeck(index, d).defs }));
const search = createSearchBot({ budgetMs: BUDGET });

const res = { search: 0, heuristic: 0, draw: 0, lore: [], turns: [], decisions: 0, ms: 0, samples: 0 };
for (let g = 0; g < GAMES; g++) {
  const smartSeat = g % 2;                                   // the search bot sits in seat 0, then 1, …
  const pair = Math.floor(g / 2) % decks.length;             // …with each pairing played from both sides
  const da = decks[pair], db = decks[(pair + 1) % decks.length];
  const s = newGame({ seed: 7000 + Math.floor(g / 2), players: [{ name: 'A', deck: (smartSeat === 0 ? da : db).defs }, { name: 'B', deck: (smartSeat === 0 ? db : da).defs }] });
  const memory = {};
  let steps = 0;
  while (s.status !== 'over' && steps++ < 4000) {
    let acted = false;
    for (const seat of [0, 1]) {
      let a;
      if (seat === smartSeat) { a = search.decide(s, seat, memory); if (a && search.decide.last) { res.decisions++; res.ms += search.decide.last.ms; res.samples += search.decide.last.samples; search.decide.last = null; } }
      else a = botDecide(s, seat);
      if (!a) continue;
      let r = applyAction(s, seat, a);
      if (!r.ok) {
        const fb = s.pending?.seat === seat ? (s.pending.type === 'support' ? { type: 'support' } : { type: 'choose', skip: true }) : { type: 'endTurn', force: true };
        r = applyAction(s, seat, fb);
        if (!r.ok && s.pending?.valid?.length) r = applyAction(s, seat, { type: 'choose', target: s.pending.valid[0] });
      }
      checkInvariants(s);
      acted = acted || r.ok;
      break;
    }
    if (!acted && s.status !== 'over') { console.log('stuck', s.turn, s.pending); break; }
  }
  const w = s.winner == null ? 'draw' : s.winner === smartSeat ? 'search' : 'heuristic';
  res[w]++;
  res.turns.push(s.turn);
  res.lore.push(`${s.players[smartSeat].lore}-${s.players[1 - smartSeat].lore}`);
  console.log(`game ${g + 1}: ${w.padEnd(9)} search ${smartSeat === 0 ? 'first-seat' : 'second-seat'} with ${(smartSeat === 0 ? da : db).name} vs ${(smartSeat === 0 ? db : da).name} · turn ${s.turn} · lore ${res.lore.at(-1)} (${s.endReason || ''})`);
}
const n = res.search + res.heuristic + res.draw;
console.log(`\nsearch bot ${res.search}/${n} (${Math.round((res.search / n) * 100)}%) · heuristic ${res.heuristic} · draws ${res.draw}`);
console.log(`decisions ${res.decisions} · avg ${Math.round(res.ms / Math.max(1, res.decisions))} ms · avg ${Math.round(res.samples / Math.max(1, res.decisions))} samples per decision`);
