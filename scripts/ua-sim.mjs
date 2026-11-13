#!/usr/bin/env node
// Union Arena engine soak test: games between auto-built decks, every action checked against the engine's invariants.
//
//   node scripts/ua-sim.mjs [games=40] [seed=1] [--chaos] [--bot] [--src HTR] [--verbose]
//
// Players pick among legalActions() (a greedy-ish policy by default; --chaos picks uniformly at random, including
// odd choices like declining every trigger). A game that throws, breaks an invariant or doesn't end in 400 actions
// fails the run.

import { loadUaCards } from '../game/ua/cards.js';
import { newGame, applyAction, legalActions, checkInvariants, viewFor } from '../game/ua/engine.js';
import { autoDeck } from '../game/ua/decks.js';
import { botDecide } from '../game/ua/bot.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const pos = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--src'));
const GAMES = Number(pos[0] || 40), SEED = Number(pos[1] || 1);
const srcArg = args.includes('--src') ? args[args.indexOf('--src') + 1] : null;
const chaos = flags.has('--chaos'), verbose = flags.has('--verbose'), botMode = flags.has('--bot');

const idx = loadUaCards();
if (!idx) { console.error('no cache/ua-cards.json: run node tools/ua/import-cards.mjs first'); process.exit(1); }
const srcs = [...new Set([...idx.defs.values()].map((d) => d.src))].filter((s) => !srcArg || s === srcArg);

let rng = SEED;
const r = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const pick = (a) => a[Math.floor(r() * a.length)];

function policy(s, seat, acts) {
  if (chaos) return pick(acts);
  if (botMode && (seat === 0 || r() < 0.9)) return botDecide(s, seat);
  const by = (t) => acts.filter((a) => a.type === t);
  if (by('mulligan').length) return { type: 'mulligan', redraw: r() < 0.2 };
  if (by('trigger').length) return pick(by('trigger').filter((a) => a.use)) || acts[0];
  const plays = by('play'), atks = by('attack'), moves = by('move'), activ = by('activate');
  if (plays.length && r() < 0.85) return pick(plays);
  if (activ.length && r() < 0.5) return pick(activ);
  if (moves.length && r() < 0.8) return pick(moves);
  if (atks.length && r() < 0.9) return pick(atks);
  if (by('extraDraw').length && r() < 0.3) return by('extraDraw')[0];
  const nonNext = acts.filter((a) => a.type !== 'next');
  if (by('next').length && (!nonNext.length || r() < 0.7)) return by('next')[0];
  return pick(acts);
}

let fails = 0, done = 0, turns = 0, actions = 0;
const wins = [0, 0];
for (let g = 0; g < GAMES; g++) {
  const src = srcs[g % srcs.length];
  const seed = SEED * 1000 + g;
  const decks = [autoDeck(idx.defs, src, seed), autoDeck(idx.defs, srcs[(g * 7 + 3) % srcs.length], seed + 1)];
  if (!decks[0] || !decks[1]) continue;
  let s;
  try {
    s = newGame({ players: decks.map((cards, i) => ({ name: `P${i + 1}`, cards })), defs: idx.defs, seed });
    let n = 0;
    while (s.winner == null && n < (chaos ? 1500 : 600)) {
      const seat = s.pending?.seat;
      if (seat == null) throw new Error('no pending decision and no winner');
      const acts = legalActions(s, seat);
      if (!acts.length) throw new Error(`no legal actions for pending ${s.pending.type}`);
      const a = policy(s, seat, acts);
      try { applyAction(s, seat, a); }
      catch (e) {
        if (e.name === 'RuleError' || e.constructor?.name === 'RuleError') {
          // a legal-looking action the engine refused: legalActions and the rules disagree
          throw new Error(`legal action refused: ${JSON.stringify(a)} → ${e.message}`);
        }
        throw e;
      }
      checkInvariants(s);
      viewFor(s, 0); viewFor(s, 1);
      n++;
    }
    actions += n;
    turns += s.turnNo;
    if (s.winner == null) throw new Error(`no winner after ${n} actions (turn ${s.turnNo})`);
    wins[s.winner]++;
    done++;
    if (verbose) console.log(`game ${g} ${decks.map((d) => d[0][0].split('-')[0]).join(' vs ')}: P${s.winner + 1} wins on turn ${s.turnNo} (${s.log.at(-1)?.text})`);
  } catch (e) {
    fails++;
    console.error(`game ${g} (seed ${seed}) FAILED: ${e.stack || e.message}`);
    if (s) console.error(s.log.slice(-12).map((l) => '   ' + l.text).join('\n'));
    if (fails > 5) break;
  }
}
console.log(`${done}/${GAMES} games finished${chaos ? ' (chaos)' : ''}; avg ${(turns / Math.max(1, done)).toFixed(1)} turns, ${(actions / Math.max(1, done)).toFixed(0)} actions; wins P1 ${wins[0]} / P2 ${wins[1]}; ${fails} failed`);
process.exit(fails ? 1 : 0);
