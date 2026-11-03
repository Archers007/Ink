// Game review, chess.com style: for every decision both players made in a saved game, the engine analyzes the
// position from the mover's side only (searchbot.analyze — it re-deals what that player couldn't see), ranks the
// moves, and rates the one they played by how much it gave up against the engine's best:
//   great (the best move, and every other one gave up 2+ lore) · best · good (≤ 0.5 lore, or within the engine's
//   own uncertainty) · inaccuracy (≤ 1.5) · mistake (≤ 4) · blunder
// Accuracy is 100·e^(−loss/3) averaged over the decisions that had a real choice. The timeline is the engine's
// evaluation before every decision, from seat 0's side, for the graph (public/js/play/review.js).
import { replayGame } from '../learn/replay.js';
import { analyze, moveKey, describeMove } from '../searchbot.js';

export const VERSION = 2;
const GREAT_GAP = 2;                       // lore the second-best move gives up for the best one to count as great
const CLASSES = ['great', 'best', 'good', 'inaccuracy', 'mistake', 'blunder'];

export function classify(loss, noise) {
  if (loss <= 0.05) return 'best';
  if (loss <= Math.max(0.5, noise)) return 'good';
  if (loss <= 1.5) return 'inaccuracy';
  if (loss <= 4) return 'mistake';
  return 'blunder';
}

function summary(moves) {
  const real = moves.filter((m) => m.cls !== 'forced');
  const counts = Object.fromEntries(CLASSES.map((c) => [c, real.filter((m) => m.cls === c).length]));
  return {
    decisions: moves.length, rated: real.length, counts,
    accuracy: real.length ? Math.round((real.reduce((s, m) => s + 100 * Math.exp(-m.loss / 3), 0) / real.length) * 10) / 10 : null,
  };
}

// seats: whose moves to rate (both by default). onProgress(done, total).
export function reviewGame(index, rec, seats = [0, 1], { budgetMs = 250, onProgress = null } = {}) {
  const want = new Set(Array.isArray(seats) ? seats : [seats]);
  const skip = (a) => !a || a.type === 'mulligan' || a.type === 'concede';
  const total = rec.actions.filter(([who, a]) => want.has(who) && !skip(a)).length;
  const memory = [{}, {}];
  const moves = [];
  let done = 0;
  const end = replayGame(index, rec, null, {
    onBefore: (s, k, who, a) => {
      if (!want.has(who) || skip(a) || s.status !== 'playing') return;
      done++;
      const r = analyze(structuredClone(s), who, memory[who], { budgetMs, extra: a });
      // a move the search never sampled scores -Infinity: it can't be rated, and the position's eval is the last one
      r.moves = r.moves.filter((m) => Number.isFinite(m.score));
      const key = moveKey(s, a);
      const played = r.moves.find((m) => m.key === key);
      const best = r.moves[0];
      const entry = { k, who, turn: s.turn, played: describeMove(s, a), choices: r.moves.length, eval: best ? best.score : null };
      if (r.moves.length >= 2 && played && best) {
        const loss = Math.max(0, Math.round((best.score - played.score) * 10) / 10);
        let cls = played.key === best.key ? 'best' : classify(loss, played.pm + best.pm);
        if (cls === 'best' && best.score - r.moves[1].score >= GREAT_GAP) cls = 'great';
        Object.assign(entry, { loss, cls, best: best.label, bestScore: best.score, playedScore: played.score, top: r.moves.slice(0, 3).map((m) => ({ label: m.label, score: m.score })) });
      } else Object.assign(entry, { cls: 'forced', loss: 0 });
      moves.push(entry);
      onProgress?.(done, total);
    },
  });
  const players = {};
  for (const seat of want) players[seat] = summary(moves.filter((m) => m.who === seat));
  return {
    v: VERSION, seats: [...want], players, moves,
    // where the game ended up, so the graph can finish on the result
    winner: end.s?.winner ?? null, finalTurn: end.s?.turn ?? null,
  };
}
