// Training the bot from saved games (people's and bots'): replay each game, take the position at the start of
// every turn from the active player's side, label it with whether that player went on to win, and fit a
// logistic regression (people's games weigh 3×). Predicting winners is not the same as picking good moves (a
// model fitted to games where everyone inks every turn decides that a big hand wins, and stops inking), so the
// model is only switched on after the search bot using it beats the search bot without it head to head.
// Also tallies what people do with each card (ink or play it, keep or ship it), which the quick bot follows.
import fs from 'node:fs';
import { replayGame } from './replay.js';
import { features, FEATURES } from './features.js';
import { handEvaluate as handScore, createSearchBot } from '../searchbot.js';
import { sigmoid, MODEL_FILE, BLEND, valueWith } from './model.js';
import { D, newGame, applyAction } from '../engine.js';
import { resolveDeck } from '../cards.js';

const HUMAN_WEIGHT = 3;
const MIN_POSITIONS = 2000;
const GATE_GAMES = 24, GATE_BUDGET_MS = 40, GATE_WIN = 0.55;

// the search bot with the candidate model (seat-alternating) against the search bot without it, on the starter decks
function headToHead(index, value, games = GATE_GAMES) {
  const withModel = createSearchBot({ budgetMs: GATE_BUDGET_MS, evaluator: (s, seat) => (s.status === 'over' ? (s.winner === seat ? 1000 : -1000) : handScore(s, seat) + BLEND * valueWith(value, s, seat)) });
  const without = createSearchBot({ budgetMs: GATE_BUDGET_MS, evaluator: handScore });
  const decks = index.demoDecks.map((d) => resolveDeck(index, d).defs);
  let wins = 0, played = 0;
  for (let g = 0; g < games; g++) {
    const mine = g % 2, pair = Math.floor(g / 2) % decks.length;
    const s = newGame({ seed: 90000 + Math.floor(g / 2), players: [{ name: 'A', deck: decks[pair] }, { name: 'B', deck: decks[(pair + 1) % decks.length] }] });
    const mem = [{}, {}];
    for (let step = 0; step < 3000 && s.status !== 'over'; step++) {
      let done = false;
      for (const seat of [0, 1]) {
        const a = (seat === mine ? withModel : without).decide(s, seat, mem[seat]);
        if (!a) continue;
        let r = applyAction(s, seat, a);
        if (!r.ok) r = applyAction(s, seat, s.pending?.seat === seat ? (s.pending.type === 'support' ? { type: 'support' } : { type: 'choose', skip: true }) : { type: 'endTurn', force: true });
        done = r.ok;
        break;
      }
      if (!done) break;
    }
    if (s.status === 'over') { played++; if (s.winner === mine) wins++; }
  }
  return { games: played, wins, rate: played ? wins / played : 0 };
}

function fit(X, y, w8, { epochs = 400, lr = 0.3, l2 = 1e-3 } = {}) {
  const n = X.length, d = X[0].length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (const x of X) for (let i = 0; i < d; i++) mean[i] += x[i] / n;
  for (const x of X) for (let i = 0; i < d; i++) std[i] += (x[i] - mean[i]) ** 2 / n;
  for (let i = 0; i < d; i++) std[i] = Math.sqrt(std[i]) || 1;
  const Z = X.map((x) => x.map((v, i) => (v - mean[i]) / std[i]));
  const W = new Array(d).fill(0);
  let b = 0;
  const wsum = w8.reduce((s, x) => s + x, 0);
  for (let e = 0; e < epochs; e++) {
    const g = new Array(d).fill(0);
    let gb = 0;
    for (let k = 0; k < n; k++) {
      let z = b;
      for (let i = 0; i < d; i++) z += W[i] * Z[k][i];
      const err = (sigmoid(z) - y[k]) * w8[k];
      for (let i = 0; i < d; i++) g[i] += err * Z[k][i];
      gb += err;
    }
    for (let i = 0; i < d; i++) W[i] -= lr * (g[i] / wsum + l2 * W[i]);
    b -= lr * (gb / wsum);
  }
  return { weights: W, bias: b, mean, std };
}

export function train(index, games, { log = () => {}, gate = true } = {}) {
  const pos = [];                         // { x, y, w, game, hand }
  const habits = {};
  const H = (full) => (habits[full] ||= { ink: 0, play: 0, shipped: 0, kept: 0 });
  let replayed = 0, broken = 0, humanGames = 0;
  games.forEach((g, gi) => {
    if (g.winner == null) return;
    const human = g.seats.map((p) => !p.bot);
    if (human.some(Boolean)) humanGames++;
    let lastTurn = -1;
    const r = replayGame(index, g, (s, k, seat, a, ev, handBefore) => {
      if (a && human[seat]) {
        const c = a.iid && s.cards[a.iid];
        if (a.type === 'ink' && c) H(D(s, c).full).ink++;
        if (a.type === 'play' && c) H(D(s, c).full).play++;
        if (a.type === 'mulligan') {
          const ship = new Set(a.iids || []);
          for (const iid of handBefore || []) { const cc = s.cards[iid]; if (cc) H(D(s, cc).full)[ship.has(iid) ? 'shipped' : 'kept']++; }
        }
      }
      if (s.status === 'playing' && !s.pending && s.turn !== lastTurn) {
        lastTurn = s.turn;
        pos.push({ x: features(s, s.active), y: g.winner === s.active ? 1 : 0, w: human.some(Boolean) ? HUMAN_WEIGHT : 1, game: gi, hand: handScore(s, s.active) });
      }
    }, { scratch: true });
    if (r.ok) replayed++; else broken++;
  });
  log(`replayed ${replayed} games (${broken} no longer replay), ${pos.length} positions`);
  const out = { trainedAt: Date.now(), games: replayed, humanGames, positions: pos.length, features: FEATURES, habits, value: null };
  if (pos.length >= 200) {
    // hold out every 5th game
    const tr = pos.filter((p) => p.game % 5 !== 0), te = pos.filter((p) => p.game % 5 === 0);
    const m = fit(tr.map((p) => p.x), tr.map((p) => p.y), tr.map((p) => p.w));
    const z = (x) => m.bias + x.reduce((s, v, i) => s + m.weights[i] * ((v - m.mean[i]) / m.std[i]), 0);
    const acc = (f) => te.length ? te.filter((p) => (f(p) > 0) === (p.y === 1)).length / te.length : 0;
    const modelAcc = acc((p) => z(p.x)), handAcc = acc((p) => p.hand);
    const predicts = pos.length >= MIN_POSITIONS && te.length >= 300 && modelAcc >= handAcc + 0.01;
    out.value = { ...m, use: false, holdout: { positions: te.length, modelAcc: Math.round(modelAcc * 1000) / 10, handAcc: Math.round(handAcc * 1000) / 10 } };
    log(`held-out accuracy: model ${out.value.holdout.modelAcc}% · hand-tuned ${out.value.holdout.handAcc}%`);
    if (predicts && gate) {
      const h = headToHead(index, out.value);
      out.value.gate = { ...h, rate: Math.round(h.rate * 100) };
      out.value.use = h.games >= GATE_GAMES * 0.8 && h.rate >= GATE_WIN;
      log(`head to head: with the model ${h.wins} of ${h.games} → ${out.value.use ? 'using it' : 'keeping the hand-tuned score'}`);
    } else log('keeping the hand-tuned score');
  }
  return out;
}

export function saveModel(model, file = MODEL_FILE) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(model));
  fs.renameSync(tmp, file);
}
