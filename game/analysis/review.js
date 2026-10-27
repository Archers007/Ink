// Game review, chess-engine style: for every decision one player made in a saved game, the engine analyzes the
// position from that player's side only (searchbot.analyze — it re-deals what that player couldn't see), ranks the
// moves, and rates the one they played by how much it gave up against the engine's best:
//   best · good (≤ 0.5 lore, or within the engine's own uncertainty) · inaccuracy (≤ 1.5) · mistake (≤ 4) · blunder
// Accuracy is 100·e^(−loss/3) averaged over the decisions that had a real choice.
import { replayGame } from '../learn/replay.js';
import { analyze, moveKey, describeMove } from '../searchbot.js';

export function classify(loss, noise) {
  if (loss <= 0.05) return 'best';
  if (loss <= Math.max(0.5, noise)) return 'good';
  if (loss <= 1.5) return 'inaccuracy';
  if (loss <= 4) return 'mistake';
  return 'blunder';
}

export function reviewGame(index, rec, seat, { budgetMs = 250, onProgress = null } = {}) {
  const skip = (a) => !a || a.type === 'mulligan' || a.type === 'concede';
  const total = rec.actions.filter(([who, a]) => who === seat && !skip(a)).length;
  const memory = {};
  const moves = [];
  let done = 0;
  replayGame(index, rec, null, {
    onBefore: (s, k, who, a) => {
      if (who !== seat || skip(a) || s.status !== 'playing') return;
      done++;
      const r = analyze(structuredClone(s), seat, memory, { budgetMs, extra: a });
      const key = moveKey(s, a);
      const played = r.moves.find((m) => m.key === key);
      const best = r.moves[0];
      const entry = { k, turn: s.turn, played: describeMove(s, a), choices: r.moves.length, eval: r.eval };
      if (r.moves.length >= 2 && played && best) {
        const loss = Math.max(0, Math.round((best.score - played.score) * 10) / 10);
        Object.assign(entry, { loss, cls: played.key === best.key ? 'best' : classify(loss, played.pm + best.pm), best: best.label, bestScore: best.score, playedScore: played.score, top: r.moves.slice(0, 3).map((m) => ({ label: m.label, score: m.score })) });
      } else entry.cls = 'forced';
      moves.push(entry);
      onProgress?.(done, total);
    },
  });
  const real = moves.filter((m) => m.cls !== 'forced');
  const count = (c) => real.filter((m) => m.cls === c).length;
  return {
    seat, decisions: moves.length, rated: real.length,
    accuracy: real.length ? Math.round(real.reduce((s, m) => s + 100 * Math.exp(-m.loss / 3), 0) / real.length) : null,
    counts: { best: count('best'), good: count('good'), inaccuracy: count('inaccuracy'), mistake: count('mistake'), blunder: count('blunder') },
    moves,
  };
}
