// Auto-fix proposals: turn a deck report's weaknesses into concrete swaps (−2 of a card the deck isn't using well,
// +2 of a card in its inks that covers the weakness). lib/sim.js then plays every proposal on the same games as the
// original list and keeps the ones that win more — the proposals are only guesses; the games decide.
//
//   proposeEdits(index, counts, report, { locks }) → [{ remove: [[id, n]], add: [[id, n]], why, cut, put }]
import { cardRoles } from '../procs/roles.js';
import { isFullyAutomated } from '../cards.js';
import { DECK } from '../rulebook/deck.js';

const CANON = (d) => !['enchanted', 'iconic', 'epic', 'promo'].includes(d.rarity);
const STEP = 2;                                         // copies swapped at a time

// how much a card brings for its cost, roughly: lore and stats for characters, plus what its abilities do
function worth(d, roles) {
  const body = d.type === 'character' ? ((d.lore || 0) * 2 + ((d.str || 0) + (d.wp || 0)) / 2) / Math.max(1, d.cost) : 0.8;
  return body + roles.length * 0.6 + (d.inkable ? 0.4 : 0);
}

export function proposeEdits(index, counts, report, { locks = [], max = 6 } = {}) {
  const defsById = (id) => index.byId.get(String(id));
  const deck = counts.map(([id, n]) => ({ id: String(id), n, d: defsById(id) })).filter((x) => x.d);
  const inks = new Set(deck.flatMap((x) => x.d.inks));
  const locked = new Set(locks.map((s) => s.toLowerCase()));
  const inDeck = new Map(deck.map((x) => [x.d.full, x]));
  const stats = new Map((report.cards || []).map((c) => [c.name, c]));
  const maxCopies = (d) => {
    const r = (d.procs || []).find((p) => p.kind === 'static' && p.effect?.fn === 'deck' && 'copies' in p.effect);
    return r ? (r.effect.copies ?? Infinity) : DECK.maxCopies.base;
  };

  // ---- what to cut: unlocked cards the pilot mostly inks, that do worse when played, or that sit in hand ----
  const cuts = deck.filter((x) => !locked.has(x.d.full.toLowerCase()) && x.n >= STEP).map((x) => {
    const c = stats.get(x.d.full) || {};
    const inkShare = c.inkShare ?? 50;
    const dl = c.playedDelta?.d ?? 0;
    return { ...x, bad: inkShare / 25 - dl / 10 + (c.stuckPerGame || 0) * 3 - (c.playedDelta?.real && dl > 0 ? 5 : 0) };
  }).sort((a, b) => b.bad - a.bad);
  if (!cuts.length) return [];

  // ---- what could come in: legal in these inks, fully run by the engine, standard printings ----
  const pool = [...index.byFull.values()].filter((d) => CANON(d) && d.inks.length && d.inks.every((i) => inks.has(i)) && isFullyAutomated(d));
  const roleOf = new Map(pool.map((d) => [d.full, cardRoles(d).roles]));
  const room = (d) => maxCopies(d) - (inDeck.get(d.full)?.n || 0);
  const pick = (f, n = 3) => pool.filter((d) => room(d) >= STEP && f(d)).sort((a, b) => worth(b, roleOf.get(b.full)) - worth(a, roleOf.get(a.full))).slice(0, n);

  const wants = [];
  for (const w of report.weaknesses || []) {
    if (w.kind === 'draw') wants.push({ why: 'more card draw', cards: pick((d) => roleOf.get(d.full).includes('draw') && d.cost <= 4) });
    if (w.kind === 'removal') wants.push({ why: 'more removal', cards: pick((d) => roleOf.get(d.full).includes('removal') && d.cost <= 5) });
    if (w.kind === 'inkability') wants.push({ why: 'more inkable cards', cards: pick((d) => d.inkable), cutUninkable: true });
    if (w.kind === 'curve') {
      const curve = report.facts?.curve || [];
      const gap = [2, 3, 4, 5].sort((a, b) => (curve[a - 1] || 0) - (curve[b - 1] || 0))[0];
      wants.push({ why: `fill the ${gap}-cost slot`, cards: pick((d) => d.cost === gap && d.type === 'character') });
    }
    if (w.kind === 'matchup' || w.kind === 'removal') wants.push({ why: 'blockers against wide boards', cards: pick((d) => d.type === 'character' && (d.kw?.bodyguard || d.kw?.resist) && d.cost <= 5, 2) });
  }
  if (!wants.length) wants.push({ why: 'a stronger card for the slot', cards: pick(() => true, 4) });

  const out = [];
  const seen = new Set();
  for (const want of wants) {
    for (const add of want.cards) {
      const cut = (want.cutUninkable ? cuts.filter((x) => !x.d.inkable) : cuts).find((x) => x.d.full !== add.full);
      if (!cut) continue;
      const key = `${cut.id}>${add.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ remove: [[cut.id, STEP]], add: [[add.id, STEP]], why: want.why, cut: cut.d.full, put: add.full });
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function applyEdit(counts, edit) {
  const m = new Map(counts.map(([id, n]) => [String(id), n]));
  for (const [id, n] of edit.remove) m.set(String(id), (m.get(String(id)) || 0) - n);
  for (const [id, n] of edit.add) m.set(String(id), (m.get(String(id)) || 0) + n);
  return [...m].filter(([, n]) => n > 0);
}
