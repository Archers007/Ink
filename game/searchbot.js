// The search bot: determinized Monte Carlo search over the moves it can make right now.
//
// What it may know is what a player at the table knows: both decklists, its own hand, everything in play and in the
// discards, and any card it has seen revealed. It never reads the opponent's hand, either player's deck order, or
// the opponent's facedown inkwell. Each sample re-deals all of that hidden information at random, consistent with
// what it knows: the opponent's unseen cards are exactly their decklist minus every card of theirs it can see, so
// those cards are shuffled across the opponent's hidden slots (hand, deck, inkwell), and its own deck is shuffled.
// Then it plays one candidate move on that guess and plays the game forward with the fast heuristic bot (bot.js)
// for both sides until its own next turn begins, and scores the position. The move with the best average across
// samples wins; samples go to the most promising moves first (UCB1) until the time budget runs out.
//
//   const bot = createSearchBot({ budgetMs: 400 });
//   const action = bot.decide(state, seat, memory);   // memory: {} kept per game and seat (what it has seen)

import { applyAction, D, readyInk } from './engine.js';
import { botDecide, shiftPlan, chooseMulligan } from './bot.js';
import { learnedValue } from './learn/model.js';
import { questBlocker, attackerBlocker, singerBlocker, effLore, effStr, effWp, shiftOptions } from '../public/js/play/rules.js';

const SCRATCH = { scratch: true };
const MAX_ROLLOUT_STEPS = 400;

// The knobs an A/B run flips (scripts/bot-arena.mjs --ab). Each one came out of the 2026-11 audit of the bot:
//   lethal   an exact "20 lore on board" term at the horizon, instead of hoping a rollout stumbles into the win
//   keep     the rollout policy keeps a lone bomb instead of inking it (bot.js chooseInk)
//   ucb      'tuned': the exploration bonus follows each move's measured variance; 'fixed': the old constant 12
//   clock    the first samples of every move respect the budget too, and the search stops once the leader is clear
//   order    near-ties go to the move that comes first in a sound turn: ink → play → quest/challenge → end turn
export const TUNING = { lethal: true, keep: true, ucb: 'tuned', clock: true, order: true };
export const BASELINE = { lethal: false, keep: false, ucb: 'fixed', clock: false, order: false };

// ---------- what this seat has seen ----------
// Opponent cards it has watched in public zones keep their identity if they go back to a hidden zone
// ("return chosen character to their player's hand": that card is known to be in the hand).
export function observe(s, seat, memory) {
  memory.seen ||= new Set();
  for (const p of s.players) {
    if (p.seat === seat) continue;
    for (const iid of [...p.play, ...p.discard]) memory.seen.add(iid);
    for (const iid of p.play) for (const u of s.cards[iid].under) if (!s.cards[u].faceDown) memory.seen.add(u);
  }
  return memory;
}

// ---------- one guess at the hidden information ----------
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function determinize(src, seat, memory) {
  const s = structuredClone(src);
  // the engine's own randomness (shuffles, "at random") must differ between samples, too
  s.rng = (Math.random() * 2 ** 31) | 0;
  const pinned = new Set([...(s.pending?.valid || []), ...(s.pending?.cards || [])]);   // cards a pending choice shows us
  const me = s.players[seat];
  if (!pinned.size) {
    // our own deck order is unknown to us (keep a face-up top card where a rule shows it)
    shuffle(me.deck);
  }
  for (const p of s.players) {
    if (p.seat === seat) continue;
    const hidden = [
      ...p.hand.filter((iid) => !memory.seen?.has(iid)),
      ...p.deck,
      ...p.inkwell,
    ].filter((iid) => !pinned.has(iid));
    const ids = shuffle(hidden.map((iid) => s.cards[iid].cardId));
    hidden.forEach((iid, k) => { s.cards[iid].cardId = ids[k]; });
  }
  return s;
}

// ---------- the moves to consider ----------
const uniqBy = (list, key) => { const seen = new Set(); return list.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };

function mainMoves(s, seat) {   // (concede is never a candidate)
  const p = s.players[seat];
  const out = [];
  const hand = p.hand.map((iid) => s.cards[iid]);
  const mine = p.play.map((iid) => s.cards[iid]);
  const ink = readyInk(s, seat);
  // ink one card (copies of a card are the same move)
  if (p.inkedThisTurn < 1 + (p.extraInk || 0)) for (const c of uniqBy(hand.filter((c) => D(s, c).inkable), (c) => c.cardId)) out.push({ type: 'ink', iid: c.iid });
  for (const c of uniqBy(hand, (c) => c.cardId)) {
    const d = D(s, c);
    if (d.cost <= ink + 2) out.push({ type: 'play', iid: c.iid, mode: 'ink' });          // cost changes: let the engine judge
    for (const opt of shiftOptions(d)) { const plan = shiftPlan(s, seat, c, d, opt, ink); if (plan) out.push({ type: 'play', iid: c.iid, ...plan }); }
    if (d.type === 'song') {
      for (const x of uniqBy(mine.filter((x) => D(s, x).type === 'character' && !singerBlocker(x, D(s, x), d)), (x) => x.cardId)) out.push({ type: 'play', iid: c.iid, mode: 'sing', singers: [x.iid] });
    }
  }
  for (const c of mine) {
    const d = D(s, c);
    if (d.type === 'character' && !questBlocker(c, d)) out.push({ type: 'quest', iid: c.iid });
    if (d.type === 'character' && !attackerBlocker(c, d)) {
      for (const opp of s.players) if (opp.seat !== seat) for (const t of opp.play) {
        const T = s.cards[t];
        if (T.exerted || D(s, T).type === 'location') out.push({ type: 'challenge', attacker: c.iid, target: t });
      }
    }
    (d.procs || []).forEach((pr, i) => { if (pr.kind === 'activated') out.push({ type: 'useAbility', iid: c.iid, index: i }); });
    if (typeof d.kw?.boost === 'number' && c.boostedTurn !== s.turn) out.push({ type: 'boost', iid: c.iid });
    if (d.type === 'character') for (const L of mine) if (D(s, L).type === 'location' && c.atLocation !== L.iid) out.push({ type: 'move', iid: c.iid, location: L.iid });
  }
  out.push({ type: 'endTurn', force: true });
  return out;
}

function pendingMoves(s, seat) {
  const pend = s.pending;
  if (pend.type === 'support') {
    const others = s.players[seat].play.filter((iid) => iid !== pend.from && D(s, s.cards[iid]).type === 'character');
    return [{ type: 'support' }, ...others.map((iid) => ({ type: 'support', target: iid }))];
  }
  if (pend.choices) return pend.choices.map((_, i) => ({ type: 'choose', option: i }));
  if (pend.confirm) return [{ type: 'choose', confirm: true }, { type: 'choose', skip: true }];
  const out = (pend.valid || []).slice(0, 14).map((iid) => ({ type: 'choose', target: iid }));
  if (pend.optional || !out.length) out.push({ type: 'choose', skip: true });
  return out;
}

// moves the engine accepts in this position (each tried on a copy)
function legalMoves(s, seat) {
  const raw = s.pending ? pendingMoves(s, seat) : mainMoves(s, seat);
  const ok = [];
  for (const a of raw) {
    const t = structuredClone(s);
    if (applyAction(t, seat, a, SCRATCH).ok) ok.push(a);
  }
  return ok;
}

// ---------- playing forward ----------
function rollout(s, seat, stopTurn, tuning = TUNING) {
  const policy = { keep: tuning.keep };
  for (let step = 0; step < MAX_ROLLOUT_STEPS; step++) {
    if (s.status === 'over') return true;
    if (!s.pending && s.turn >= stopTurn) return true;
    const who = s.pending ? s.pending.seat : s.active;
    const a = botDecide(s, who, policy);
    let r = a ? applyAction(s, who, a, SCRATCH) : { ok: false };
    if (r.broken) return false;
    if (!r.ok) {
      // the heuristic bot asked for something the engine refused: fall back the way the lobby does
      const fb = s.pending ? (s.pending.type === 'support' ? { type: 'support' } : { type: 'choose', skip: true }) : { type: 'endTurn', force: true };
      r = applyAction(s, who, fb, SCRATCH);
      if (!r.ok && s.pending?.valid?.length) r = applyAction(s, who, { type: 'choose', target: s.pending.valid[0] }, SCRATCH);
      if (!r.ok) return false;
    }
  }
  return false;
}

// ---------- scoring a position for `seat` ----------
function sideValue(s, p) {
  let v = 0;
  for (const iid of p.play) {
    const c = s.cards[iid];
    const d = D(s, c);
    if (d.type === 'character') {
      const wp = effWp(c, d);
      const alive = Math.max(0, wp - c.damage) / Math.max(1, wp);
      v += 2 + effLore(c, d) * 3 + (effStr(c, d) + wp) * 0.45 * (0.4 + 0.6 * alive);
    } else if (d.type === 'location') v += 1.5 + (d.lore || 0) * 2.5 + Math.max(0, effWp(c, d) - c.damage) * 0.3;
    else v += 1 + d.cost * 0.6;
  }
  v += p.hand.length * 1.4;
  // Ink is worth clearly more than the card it came from while the inkwell is still growing: the horizon ends before
  // the next turn's plays, so this is the only way the search sees that inking now pays off later. At 0.9 an ink was
  // worth less than a hand card (1.4): "End turn" and "Ink …" scored the same, and the bot sat on expensive hands
  // without inking (#21). The margin has to beat the sampling noise of a 450ms search (about a quarter lore), so
  // an ink up to the sixth is worth a lore (4); past the eighth a card in hand is worth more than another ink.
  const ink = p.inkwell.length;
  v += Math.min(ink, 6) * 4 + Math.max(0, Math.min(ink, 8) - 6) * 2 + Math.max(0, ink - 8) * 0.3;
  if (p.deck.length < 4) v -= (4 - p.deck.length) * 3;
  return v;
}
const loreValue = (n) => n * 4 + Math.max(0, n - 14) * 3;
// the score: hand-tuned, plus a share of the learned win-probability model once a head-to-head test showed it
// helps (learn/train.js)
export function evaluate(s, seat, tuning = TUNING) {
  if (s.status === 'over') return s.winner === seat ? 1000 : s.winner == null ? 0 : -1000;
  return handEvaluate(s, seat, tuning) + (learnedValue(s, seat) ?? 0);
}
export function handEvaluate(s, seat, tuning = TUNING) {
  if (s.status === 'over') return s.winner === seat ? 1000 : s.winner == null ? 0 : -1000;
  const me = s.players[seat];
  let score = loreValue(me.lore) + sideValue(s, me);
  for (const p of s.players) if (p.seat !== seat) score -= loreValue(p.lore) + sideValue(s, p);
  if (tuning.lethal) score += lethalValue(s, seat);
  return score;
}
// The race, exactly, at the horizon (the start of the scorer's turn): if the lore its ready characters quest for
// reaches 20 it has won, whatever else is on the board; if the opponent's board quests for 20 on their coming turn,
// the scorer is losing unless this turn answers it. Lore per quester is what the hand score already counts, so
// these are on top of it.
const WIN_SOON = 500, LOSE_SOON = -200;
function lethalValue(s, seat) {
  const me = s.players[seat];
  let mine = 0;
  for (const iid of me.play) { const c = s.cards[iid], d = D(s, c); if (d.type === 'character' && !questBlocker(c, d)) mine += Math.max(0, effLore(c, d)); }
  if (me.lore + mine >= 20) return WIN_SOON;
  let v = 0;
  for (const p of s.players) {
    if (p.seat === seat) continue;
    let theirs = 0;                                            // their turn readies everything and dries the fresh ones
    for (const iid of p.play) { const c = s.cards[iid], d = D(s, c); if (d.type === 'character' && !questBlocker({ ...c, exerted: false, drying: false }, d)) theirs += Math.max(0, effLore(c, d)); }
    if (p.lore + theirs >= 20) v += LOSE_SOON;
  }
  return v;
}

// ---------- moves in words, and as keys (copies of a card are the same move) ----------
const nm = (s, iid) => { const c = s.cards[iid]; return c ? D(s, c).full : '?'; };
const cid = (s, iid) => s.cards[iid]?.cardId ?? iid;
export function moveKey(s, a) {
  if (!a) return '';
  switch (a.type) {
    case 'ink': case 'quest': case 'boost': return `${a.type}:${cid(s, a.iid)}`;
    case 'play': return `play:${cid(s, a.iid)}:${a.mode || 'ink'}:${(a.singers || a.targets || []).map((x) => cid(s, x)).join('+')}`;
    case 'challenge': return `challenge:${cid(s, a.attacker)}>${cid(s, a.target)}`;
    case 'move': return `move:${cid(s, a.iid)}>${cid(s, a.location)}`;
    case 'useAbility': return `ability:${cid(s, a.iid)}:${a.index}`;
    case 'choose': return `choose:${a.target != null ? cid(s, a.target) : a.option != null ? `o${a.option}` : a.confirm ? 'yes' : 'skip'}`;
    case 'support': return `support:${a.target != null ? cid(s, a.target) : '-'}`;
    default: return a.type;
  }
}
export function describeMove(s, a) {
  switch (a?.type) {
    case 'ink': return `Ink ${nm(s, a.iid)}`;
    case 'quest': return `Quest with ${nm(s, a.iid)}`;
    case 'boost': return `Boost ${nm(s, a.iid)}`;
    case 'play':
      if (a.mode === 'sing' || a.mode === 'singTogether') return `Sing ${nm(s, a.iid)} with ${(a.singers || []).map((x) => nm(s, x)).join(' + ')}`;
      if (a.mode === 'shift') return `Shift ${nm(s, a.iid)} onto ${(a.targets || []).map((x) => nm(s, x)).join(' + ')}`;
      return `Play ${nm(s, a.iid)}`;
    case 'challenge': return `Challenge ${nm(s, a.target)} with ${nm(s, a.attacker)}`;
    case 'move': return `Move ${nm(s, a.iid)} to ${nm(s, a.location)}`;
    case 'useAbility': return `Use ${nm(s, a.iid)}'s ability`;
    case 'choose': return a.target != null ? `Choose ${nm(s, a.target)}` : a.option != null ? `Option ${a.option + 1}` : a.confirm ? 'Yes' : 'Skip / no';
    case 'support': return a.target != null ? `Support ${nm(s, a.target)}` : 'No support';
    case 'endTurn': return 'End turn';
    case 'mulligan': return 'Mulligan';
    case 'concede': return 'Concede';
    default: return a?.type || '?';
  }
}

// ---------- the search ----------
// Scores every legal move for `seat`: re-deal the hidden cards, play the move, roll forward to the start of our next
// turn, score; UCB1 spreads samples toward the promising moves until the budget runs out.
// extra: a move to make sure is among the candidates (analysis of a move someone actually played).
export function search(s, seat, memory = {}, { budgetMs = 400, minSamples = 3, maxSamples = 400, evaluator = evaluate, extra = null, tuning = TUNING } = {}) {
  observe(s, seat, memory);
  const moves = legalMoves(s, seat);
  if (extra && !moves.some((m) => moveKey(s, m) === moveKey(s, extra))) {
    const t = structuredClone(s);
    if (applyAction(t, seat, extra, SCRATCH).ok) moves.push(extra);
  }
  const stats = moves.map(() => ({ n: 0, sum: 0, sq: 0 }));
  if (moves.length < 2) return { moves, stats, samples: 0, ms: 0 };
  const stopTurn = s.turn + (s.active === seat ? 2 : 1);   // horizon: through the opponent's next turn
  const t0 = performance.now();
  let total = 0;
  const sample = (k) => {
    const g = determinize(s, seat, memory);
    let v;
    if (!applyAction(g, seat, moves[k], SCRATCH).ok) v = -50;
    else if (!rollout(g, seat, stopTurn, tuning)) return;   // a rollout the heuristics couldn't finish: no data
    else v = evaluator(g, seat, tuning);
    stats[k].n++; stats[k].sum += v; stats[k].sq += v * v; total++;
  };
  const mean = (st) => (st.n ? st.sum / st.n : -Infinity);
  const variance = (st) => (st.n > 1 ? Math.max(0, st.sq / st.n - mean(st) ** 2) : 0);
  // every move gets its first samples; a proc-heavy position where one sample costs 30 ms still gets at least one
  // sample per move, but not three times the budget (tuning.clock)
  for (let r = 0; r < minSamples; r++) for (let k = 0; k < moves.length; k++) { if (tuning.clock && r > 0 && performance.now() - t0 >= budgetMs) break; sample(k); }
  // UCB1-tuned: the bonus scales with the move's own spread (a floor of sd 2 keeps a flat move from being forgotten),
  // so a position where every rollout agrees stops burning samples on it
  const bonus = (st) => (tuning.ucb === 'tuned' ? Math.sqrt((2 * Math.log(total + 1) / st.n) * Math.max(4, variance(st))) : 12 * Math.sqrt(Math.log(total + 1) / st.n));
  while (performance.now() - t0 < budgetMs && total < maxSamples * moves.length) {
    let best = 0, bestU = -Infinity;
    for (let k = 0; k < moves.length; k++) {
      const st = stats[k];
      const u = st.n ? mean(st) + bonus(st) : Infinity;
      if (u > bestU) { bestU = u; best = k; }
    }
    sample(best);
    // the leader is clear of the runner-up by three standard errors: more samples won't change the pick
    if (tuning.clock && total % 16 === 0 && stats.every((st) => st.n >= minSamples)) {
      const order = stats.map((st, k) => k).sort((a, b) => mean(stats[b]) - mean(stats[a]));
      const l = stats[order[0]], r = stats[order[1]];
      if (mean(l) - mean(r) > 3 * (Math.sqrt(variance(l) / l.n) + Math.sqrt(variance(r) / r.n))) break;
    }
  }
  return { moves, stats, samples: total, ms: Math.round(performance.now() - t0) };
}

// A sound turn inks first (nothing learned later changes what to ink), develops next, and quests, challenges and ends
// last. The samples can't tell those orders apart, so a tie goes to the earlier move — only a tie, though: a move
// counts as tied with the leader when their means are within the two standard errors of each other. (An additive
// bonus of a point or so was tried first and lost 22-38 in the arena: it overrode real differences 40 times a game.)
const ORDER = { ink: 4, play: 3, move: 2, useAbility: 2, boost: 2, quest: 1, challenge: 1, endTurn: 0 };
function pickMove(moves, stats, tuning) {
  const mean = (st) => (st.n ? st.sum / st.n : -Infinity);
  const se = (st) => (st.n > 1 ? Math.sqrt(Math.max(0, st.sq / st.n - mean(st) ** 2) / st.n) : 0);
  let lead = 0;
  stats.forEach((st, k) => { if (mean(st) > mean(stats[lead])) lead = k; });
  if (!tuning.order) return lead;
  let pick = lead;
  stats.forEach((st, k) => {
    if (k === lead || mean(st) < mean(stats[lead]) - (se(st) + se(stats[lead]))) return;
    if ((ORDER[moves[k]?.type] ?? 0) > (ORDER[moves[pick]?.type] ?? 0)) pick = k;
  });
  return pick;
}

// The engine's view of a position, Stockfish-style: every candidate move ranked, each with its score in lore (the
// expected lore lead at the start of our next turn, counting board, hand and ink as their lore worth; a win or
// loss is ±250) and how sure it is. eval = the best move's score.
export const LORE_UNIT = 4;                          // handEvaluate scores a lore point as 4
export function analyze(s, seat, memory = {}, opts = {}) {
  const r = search(s, seat, memory, opts);
  const ranked = r.moves.map((a, k) => {
    const st = r.stats[k];
    const mean = st.n ? st.sum / st.n : -Infinity;
    const sd = st.n > 1 ? Math.sqrt(Math.max(0, st.sq / st.n - mean * mean)) : 0;
    return { action: a, key: moveKey(s, a), label: describeMove(s, a), score: Math.round((mean / LORE_UNIT) * 10) / 10, pm: Math.round(((1.96 * sd) / Math.sqrt(Math.max(1, st.n)) / LORE_UNIT) * 10) / 10, samples: st.n };
  }).sort((a, b) => b.score - a.score);
  return { eval: ranked[0]?.score ?? 0, moves: ranked, samples: r.samples, ms: r.ms };
}

// ---------- the bot ----------
// evaluator: (state, seat) → score; the default is evaluate() (training compares variants with it)
export function createSearchBot({ budgetMs = 400, minSamples = 3, maxSamples = 400, evaluator = evaluate, tuning = TUNING } = {}) {
  function decide(s, seat, memory = {}) {
    if (s.status === 'over') return null;
    const p = s.players[seat];
    if (s.status === 'mulligan') return p.mulligan.done ? null : { type: 'mulligan', iids: chooseMulligan(s, seat) };
    if (s.pending ? s.pending.seat !== seat : s.active !== seat) return null;
    const r = search(s, seat, memory, { budgetMs, minSamples, maxSamples, evaluator, tuning });
    if (!r.moves.length) return botDecide(s, seat, { keep: tuning.keep });
    if (r.moves.length === 1) return r.moves[0];
    const pick = pickMove(r.moves, r.stats, tuning);
    const pickMean = r.stats[pick].n ? r.stats[pick].sum / r.stats[pick].n : -Infinity;
    decide.last = { moves: r.moves.length, samples: r.samples, ms: r.ms, mean: Math.round(pickMean) };
    return r.moves[pick];
  }
  return { decide };
}
