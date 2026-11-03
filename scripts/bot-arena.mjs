// Bot arena over full games on the sim decks (the top dreamborn decks, game/decks/meta.json), alternating who goes
// first and which deck each side plays. Both bots see only their own seat's legal information.
//
//   node scripts/bot-arena.mjs [games=20] [budgetMs=300]            search bot vs the heuristic bot
//   node scripts/bot-arena.mjs --ab [games=40] [budgetMs=150]       search bot with the current tuning vs the baseline
//   node scripts/bot-arena.mjs --ab ... --flip lethal,order           …vs the current tuning with those knobs flipped off
//
// --ab is how a change to the search or its weights gets proved before it ships (searchbot.js TUNING / BASELINE):
// the same seeds and deck pairings from both seats, and a win rate with its 95% interval.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCardIndex, resolveDeck } from '../game/cards.js';
import { newGame, applyAction, checkInvariants } from '../game/engine.js';
import { botDecide } from '../game/bot.js';
import { createSearchBot, TUNING, BASELINE } from '../game/searchbot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const AB = args.includes('--ab');
const flipAt = args.indexOf('--flip');
const FLIP = flipAt > 0 ? args[flipAt + 1].split(',') : [];
const nums = args.filter((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--flip').map(Number);
const GAMES = nums[0] || (AB ? 40 : 20);
const BUDGET = nums[1] || (AB ? 150 : 300);
const index = await loadCardIndex(path.join(__dirname, '..', 'cache', 'sanitized.db'));
const decks = index.simDecks.map((d) => ({ name: d.name, defs: resolveDeck(index, d).defs }));

// A: the current tuning; B: the baseline, or the current tuning with --flip knobs turned off
const tuningB = FLIP.length ? { ...TUNING, ...Object.fromEntries(FLIP.map((k) => [k, k === 'ucb' ? 'fixed' : false])) } : BASELINE;
const botA = createSearchBot({ budgetMs: BUDGET, tuning: TUNING });
const botB = AB ? createSearchBot({ budgetMs: BUDGET, tuning: tuningB }) : null;
const nameA = AB ? 'A (current)' : 'search', nameB = AB ? (FLIP.length ? `B (without ${FLIP.join(', ')})` : 'B (baseline)') : 'heuristic';
if (AB) console.log(`A ${JSON.stringify(TUNING)}\nB ${JSON.stringify(tuningB)}\n${GAMES} games · ${BUDGET} ms · ${decks.length} decks`);

const res = { a: 0, b: 0, draw: 0, turns: [], decisions: 0, ms: 0, samples: 0 };
for (let g = 0; g < GAMES; g++) {
  const seatA = g % 2;                                       // bot A sits in seat 0, then 1, …
  const pair = Math.floor(g / 2) % decks.length;             // …with each pairing played from both sides
  const da = decks[pair], db = decks[(pair + 1) % decks.length];
  const s = newGame({ seed: 7000 + Math.floor(g / 2), players: [{ name: 'A', deck: (seatA === 0 ? da : db).defs }, { name: 'B', deck: (seatA === 0 ? db : da).defs }] });
  const memory = [{}, {}];
  let steps = 0;
  while (s.status !== 'over' && steps++ < 4000) {
    let acted = false;
    for (const seat of [0, 1]) {
      let a;
      if (seat === seatA) { a = botA.decide(s, seat, memory[seat]); if (a && botA.decide.last) { res.decisions++; res.ms += botA.decide.last.ms; res.samples += botA.decide.last.samples; botA.decide.last = null; } }
      else a = AB ? botB.decide(s, seat, memory[seat]) : botDecide(s, seat);
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
  const w = s.winner == null ? 'draw' : s.winner === seatA ? 'a' : 'b';
  res[w]++;
  res.turns.push(s.turn);
  console.log(`game ${g + 1}: ${(w === 'a' ? nameA : w === 'b' ? nameB : 'draw').padEnd(14)} ${nameA} ${seatA === 0 ? 'first' : 'second'} with ${(seatA === 0 ? da : db).name} vs ${(seatA === 0 ? db : da).name} · turn ${s.turn} · lore ${s.players[seatA].lore}-${s.players[1 - seatA].lore} (${s.endReason || ''})`);
}
const n = res.a + res.b + res.draw;
const rate = res.a / Math.max(1, n), ci = 1.96 * Math.sqrt((rate * (1 - rate)) / Math.max(1, n));
console.log(`\n${nameA} ${res.a}/${n} (${Math.round(rate * 100)}% ± ${Math.round(ci * 100)}) · ${nameB} ${res.b} · draws ${res.draw} · avg ${Math.round(res.turns.reduce((x, y) => x + y, 0) / Math.max(1, n))} turns`);
console.log(`decisions ${res.decisions} · avg ${Math.round(res.ms / Math.max(1, res.decisions))} ms · avg ${Math.round(res.samples / Math.max(1, res.decisions))} samples per decision`);
