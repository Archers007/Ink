// Turns recorded games (playgame.js) into a deck report: matchups, game plan, weaknesses, strengths, combos and
// per-card numbers. Every number carries its sample size, and card- or pair-level claims are only made when the
// sample can support them (Wilson intervals; a delta is "real" only when its interval leaves 0 out).
import { cardRoles, ROLES } from '../procs/roles.js';
import { isFullyAutomated } from '../cards.js';

const pct = (x) => Math.round(x * 100);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const r1 = (x) => Math.round(x * 10) / 10;
// Wilson 95% interval for k of n
export function wilson(k, n) {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const rate = (k, n) => ({ k, n, p: n ? k / n : 0, ci: wilson(k, n).map(pct) });
// difference of two win rates and its rough 95% half-width. `real` asks for ~99% (z 2.58): a report tests dozens of
// cards and pairs at once, and at 95% a few of them would look real by chance alone.
function delta(kA, nA, kB, nB) {
  if (!nA || !nB) return null;
  const a = kA / nA, b = kB / nB;
  const se = Math.sqrt((a * (1 - a)) / nA + (b * (1 - b)) / nB) || 0.5 / Math.sqrt(Math.min(nA, nB));
  return { d: pct(a - b), pm: Math.max(1, pct(1.96 * se)), nWith: nA, nWithout: nB, real: Math.min(nA, nB) >= 8 && Math.abs(a - b) > 2.58 * se };
}

// static facts about the list itself
export function deckFacts(defs) {
  const byFull = new Map();
  for (const d of defs) { const e = byFull.get(d.full) || { def: d, copies: 0 }; e.copies++; byFull.set(d.full, e); }
  const n = defs.length;
  const inkable = defs.filter((d) => d.inkable).length;
  const curve = new Array(8).fill(0);
  for (const d of defs) curve[Math.min(7, Math.max(1, d.cost || 0))]++;
  const roles = Object.fromEntries(Object.keys(ROLES).map((k) => [k, 0]));
  const roleCards = Object.fromEntries(Object.keys(ROLES).map((k) => [k, []]));
  const cares = {};
  for (const { def, copies } of byFull.values()) {
    const r = cardRoles(def);
    for (const k of r.roles) { roles[k] += copies; roleCards[k].push(def.full); }
    for (const c of r.cares) (cares[c] ||= []).push(def.full);
  }
  const classes = {};
  for (const d of defs) if (d.type === 'character') for (const c of d.classes || []) classes[c] = (classes[c] || 0) + 1;
  const manual = [...byFull.values()].filter(({ def }) => !isFullyAutomated(def)).map(({ def, copies }) => ({ name: def.full, copies }));
  return {
    size: n, inkable, inkablePct: pct(inkable / Math.max(1, n)), curve: curve.slice(1), avgCost: r1(mean(defs.map((d) => d.cost || 0))),
    types: defs.reduce((o, d) => ((o[d.type] = (o[d.type] || 0) + 1), o), {}),
    roles, roleCards, cares, classes, manual, unique: byFull.size,
  };
}

export function buildReport({ records, defs, opponents, settings }) {
  const facts = deckFacts(defs);
  const recs = records.filter((r) => r && r.reason !== 'unfinished');
  const N = recs.length;
  const wins = recs.filter((r) => r.win).length;
  const out = { games: N, unfinished: records.length - N, settings, facts, overall: rate(wins, N) };

  // ---- matchups ----
  out.matchups = opponents.map((o) => {
    const rs = recs.filter((r) => r.opp === o.key);
    const w = rs.filter((r) => r.win);
    const first = rs.filter((r) => r.first), second = rs.filter((r) => !r.first);
    return {
      key: o.key, name: o.name, games: rs.length, win: rate(w.length, rs.length),
      onPlay: rate(first.filter((r) => r.win).length, first.length), onDraw: rate(second.filter((r) => r.win).length, second.length),
      winTurn: r1(mean(w.map((r) => r.endTurn))), lossTurn: r1(mean(rs.filter((r) => !r.win).map((r) => r.endTurn))),
    };
  });

  // ---- game plan ----
  // a turn's average only while most games are still going (later turns are just the slow games)
  const turnStat = (k, f) => { const v = recs.map((r) => r.turns[k]).filter(Boolean); return v.length >= Math.max(3, N * 0.5) ? f(v) : null; };
  const maxT = 10;
  out.plan = {
    loreByTurn: Array.from({ length: maxT }, (_, k) => turnStat(k, (v) => r1(mean(v.map((t) => t.loreEnd))))),
    oppLoreByTurn: Array.from({ length: maxT }, (_, k) => turnStat(k, (v) => r1(mean(v.map((t) => t.oppLore))))),
    inkByTurn: Array.from({ length: maxT }, (_, k) => turnStat(k, (v) => r1(mean(v.map((t) => t.ink + t.inked.length))))),
    winTurn: r1(mean(recs.filter((r) => r.win).map((r) => r.endTurn))),
    questsPerGame: r1(mean(recs.map((r) => r.turns.reduce((s, t) => s + t.quests, 0)))),
    challengesPerGame: r1(mean(recs.map((r) => r.turns.reduce((s, t) => s + t.challenges, 0)))),
    playsPerTurn: r1(mean(recs.flatMap((r) => r.turns.map((t) => t.played.length)))),
  };

  // ---- per card ----
  const cards = new Map();
  const C = (n) => { let c = cards.get(n); if (!c) { c = { name: n, copies: 0, played: 0, inked: 0, playTurns: [], openWith: [0, 0], openWithout: [0, 0], playedWin: [0, 0], notPlayedWin: [0, 0], endHand: 0, shipped: 0, opened: 0 }; cards.set(n, c); } return c; };
  for (const d of defs) C(d.full).copies++;
  for (const r of recs) {
    const open = new Set(r.opening);
    const playedSet = new Set();
    for (const t of r.turns) {
      for (const n of t.played) { const c = C(n); c.played++; c.playTurns.push(t.n); playedSet.add(n); }
      for (const n of t.inked) C(n).inked++;
    }
    for (const n of r.shipped) C(n).shipped++;
    for (const n of r.endHand) C(n).endHand++;
    for (const c of cards.values()) {
      const w = r.win ? 1 : 0;
      if (open.has(c.name)) { c.opened++; c.openWith[0] += w; c.openWith[1]++; } else { c.openWithout[0] += w; c.openWithout[1]++; }
      if (playedSet.has(c.name)) { c.playedWin[0] += w; c.playedWin[1]++; } else { c.notPlayedWin[0] += w; c.notPlayedWin[1]++; }
    }
  }
  out.cards = [...cards.values()].map((c) => ({
    name: c.name, copies: c.copies,
    playedPerGame: r1(c.played / Math.max(1, N)), inkedPerGame: r1(c.inked / Math.max(1, N)),
    avgTurnPlayed: c.playTurns.length ? r1(mean(c.playTurns)) : null,
    inkShare: c.played + c.inked ? pct(c.inked / (c.played + c.inked)) : null,
    shippedPerGame: r1(c.shipped / Math.max(1, N)), stuckPerGame: r1(c.endHand / Math.max(1, N)),
    openingDelta: delta(c.openWith[0], c.openWith[1], c.openWithout[0], c.openWithout[1]),
    playedDelta: delta(c.playedWin[0], c.playedWin[1], c.notPlayedWin[0], c.notPlayedWin[1]),
  })).sort((a, b) => b.playedPerGame - a.playedPerGame);

  // ---- combos: cards on the board together at the end of one of our turns ----
  const pairs = new Map();
  for (const r of recs) {
    const seen = new Set();
    for (const t of r.turns) {
      const b = [...t.board].sort();
      for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) seen.add(`${b[i]}\u0000${b[j]}`);
    }
    for (const k of seen) { const p = pairs.get(k) || [0, 0]; p[0] += r.win ? 1 : 0; p[1]++; pairs.set(k, p); }
  }
  const minPair = Math.max(6, Math.round(N * 0.08));
  out.combos = [...pairs].filter(([, [, n]]) => n >= minPair && n < N).map(([k, [w, n]]) => {
    const [a, b] = k.split('\u0000');
    const dl = delta(w, n, wins - w, N - n);
    return { cards: [a, b], games: n, win: rate(w, n), delta: dl };
  }).filter((c) => c.delta && c.delta.d > 0).sort((x, y) => (y.delta.real - x.delta.real) || (y.delta.d - x.delta.d)).slice(0, 8);
  // class payoffs the list contains, with how many of that class it runs
  out.synergies = Object.entries(facts.cares).map(([cls, payoffs]) => ({ cls, payoffs, members: facts.classes[cls] || 0 }))
    .filter((x) => x.members >= 4).sort((a, b) => b.members - a.members).slice(0, 5);

  // ---- weaknesses and strengths ----
  const W = [], S = [];
  const early = recs.flatMap((r) => r.turns.filter((t) => t.n <= 5));
  const missedInk = early.filter((t) => !t.inked.length && t.ink < t.n).length;
  const noInkable = early.filter((t) => !t.hadInkable).length;
  if (facts.inkablePct < 70) W.push({ kind: 'inkability', severity: facts.inkablePct < 60 ? 'high' : 'medium', title: 'Not enough inkable cards',
    detail: `${facts.inkable} of ${facts.size} cards (${facts.inkablePct}%) are inkable.`, fix: 'Swap a few uninkable cards for inkable ones; most lists run 45 or more.' });
  if (early.length && missedInk / early.length > 0.12) W.push({ kind: 'inkability', severity: missedInk / early.length > 0.25 ? 'high' : 'medium', title: 'Misses ink drops early',
    detail: `In ${pct(missedInk / early.length)}% of turns 1–5 the deck put no card into its inkwell (${pct(noInkable / early.length)}% of those turns had no inkable card in hand).`, fix: 'More inkable cards, or cheaper cards so the hand isn’t all keepers.' });
  const late = recs.flatMap((r) => r.turns.filter((t) => t.n >= 5));
  const empty = late.filter((t) => t.hand <= 1).length;
  if (facts.roles.draw < 4) W.push({ kind: 'draw', severity: facts.roles.draw < 2 ? 'high' : 'medium', title: 'Little card draw or tutoring',
    detail: `${facts.roles.draw} cards draw, look at or search for cards${facts.roleCards.draw.length ? ` (${facts.roleCards.draw.slice(0, 3).join(', ')})` : ''}.`, fix: 'Add a few draw or search effects (Card draw chip in the pool).', role: 'draw' });
  if (late.length && empty / late.length > 0.25) W.push({ kind: 'draw', severity: empty / late.length > 0.4 ? 'high' : 'medium', title: 'Runs out of cards',
    detail: `${pct(empty / late.length)}% of its turns from turn 5 on started with one card or none in hand.`, fix: 'More card draw, or fewer cheap cards that empty the hand.', role: 'draw' });
  const mid = recs.flatMap((r) => r.turns.filter((t) => t.n >= 3 && t.n <= 7));
  const unused = mean(mid.map((t) => t.unusedInk));
  if (mid.length && unused >= 1.8) W.push({ kind: 'curve', severity: unused >= 3 ? 'high' : 'medium', title: 'Can’t spend its ink',
    detail: `On turns 3–7 it ends the turn with ${r1(unused)} ready ink on average.`, fix: 'Fill gaps in the curve, or add ink sinks (activated abilities, Boost, locations).' });
  const stuck = out.cards.filter((c) => c.stuckPerGame >= 0.6 * Math.min(1, c.copies / 2)).sort((a, b) => b.stuckPerGame - a.stuckPerGame).slice(0, 3);
  if (stuck.length && N >= 10) W.push({ kind: 'dead', severity: 'medium', title: 'Cards that sit in hand',
    detail: stuck.map((c) => `${c.name} (still in hand at the end of ${pct(Math.min(1, c.stuckPerGame))}% of games)`).join('; ') + '.', fix: 'Check these can actually be cast in this deck, or cut copies.' });
  if (facts.roles.removal < 4) W.push({ kind: 'removal', severity: facts.roles.removal < 2 ? 'high' : 'medium', title: 'Light on removal',
    detail: `${facts.roles.removal} cards remove or bounce an opposing card.`, fix: 'Add removal in your inks (Removal chip in the pool).', role: 'removal' });
  const losses = recs.filter((r) => !r.win);
  const wideLoss = losses.length ? mean(losses.map((r) => r.turns.at(-1)?.oppBoard || 0)) : 0;
  if (losses.length >= 5 && wideLoss >= 4) W.push({ kind: 'removal', severity: 'medium', title: 'Loses to wide boards',
    detail: `In its losses the opponent had ${r1(wideLoss)} characters in play at the end.`, fix: 'Removal that hits several characters, or Bodyguard / Resist blockers.', role: 'removal' });
  for (const m of out.matchups) if (m.games >= 10 && m.win.ci[1] < 50) W.push({ kind: 'matchup', severity: m.win.ci[1] < 35 ? 'high' : 'medium', title: `Struggles against ${m.name}`,
    detail: `${pct(m.win.p)}% wins in ${m.games} games (95% range ${m.win.ci[0]}–${m.win.ci[1]}%).`, fix: m.lossTurn ? `Those losses end around its turn ${m.lossTurn}.` : '' });
  if (facts.manual.length) W.push({ kind: 'engine', severity: 'info', title: 'Some cards aren’t fully automated',
    detail: `${facts.manual.reduce((s, c) => s + c.copies, 0)} cards (${facts.manual.slice(0, 3).map((c) => c.name).join(', ')}) have text the engine leaves to the players, so the bots play them without it.`, fix: 'Results undervalue these cards.' });

  for (const m of out.matchups) if (m.games >= 10 && m.win.ci[0] > 55) S.push({ title: `Strong against ${m.name}`, detail: `${pct(m.win.p)}% wins in ${m.games} games (95% range ${m.win.ci[0]}–${m.win.ci[1]}%).` });
  if (out.plan.winTurn && out.plan.winTurn <= 8 && wins >= 10) S.push({ title: 'Fast', detail: `Wins arrive on its turn ${out.plan.winTurn} on average.` });
  for (const [k, label] of [['draw', 'card draw'], ['removal', 'removal'], ['ramp', 'ramp']]) if (facts.roles[k] >= 8 && !W.some((w) => w.kind === k)) S.push({ title: `Plenty of ${label}`, detail: `${facts.roles[k]} cards (${facts.roleCards[k].slice(0, 3).join(', ')}…).` });
  if (facts.inkablePct >= 80) S.push({ title: 'Reliable ink', detail: `${facts.inkablePct}% of the deck is inkable.` });
  const key = out.cards.filter((c) => c.playedDelta?.real && c.playedDelta.d > 0).sort((a, b) => b.playedDelta.d - a.playedDelta.d).slice(0, 4);
  if (key.length) S.push({ title: 'Cards that win games', detail: key.map((c) => `${c.name} (+${c.playedDelta.d}±${c.playedDelta.pm} points when played)`).join('; ') + '.' });
  for (const sy of out.synergies) S.push({ title: `${sy.cls[0].toUpperCase() + sy.cls.slice(1)} synergy`, detail: `${sy.members} ${sy.cls} characters with ${sy.payoffs.length} card${sy.payoffs.length === 1 ? '' : 's'} that pay them off (${sy.payoffs.slice(0, 3).join(', ')}).` });

  const order = { high: 0, medium: 1, info: 2 };
  out.weaknesses = W.sort((a, b) => order[a.severity] - order[b.severity]);
  out.strengths = S;

  // ---- mulligan: cards the pilot sends back most, and opening-hand effects that are real ----
  out.mulligan = {
    shipped: out.cards.filter((c) => c.shippedPerGame >= 0.15).sort((a, b) => b.shippedPerGame - a.shippedPerGame).slice(0, 6).map((c) => ({ name: c.name, perGame: c.shippedPerGame })),
    keep: out.cards.filter((c) => c.openingDelta?.real && c.openingDelta.d > 0).map((c) => ({ name: c.name, ...c.openingDelta })),
    avoid: out.cards.filter((c) => c.openingDelta?.real && c.openingDelta.d < 0).map((c) => ({ name: c.name, ...c.openingDelta })),
  };
  return out;
}
