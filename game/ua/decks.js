// Union Arena deck helpers: auto-built starter decks for a title (the bot, demo decks, the soak test).
//
// autoDeck(defs, src, seed) → [[no, qty]] (50 cards, legal by game/ua/cards.js deckProblems) or null.
// A deck plays one colour mostly (required energy is per colour): the title's colour with the most cards, plus enough
// low-cost generators of that colour, then the best of the rest by a simple curve.

import { DECK_RULES, deckProblems, copyLimit } from './cards.js';

export function autoDeck(defs, src, seed = 1) {
  let rng = seed | 0 || 1;
  const r = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const pool = [...defs.values()].filter((d) => d.src === src && ['character', 'site', 'event'].includes(d.type));
  if (pool.length < 13) return null;
  const byColor = {};
  for (const d of pool) if (d.color) byColor[d.color] = (byColor[d.color] || 0) + 1;
  const colors = Object.entries(byColor).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const main = colors[Math.floor(r() * Math.min(2, colors.length))] || colors[0];
  const counts = new Map();
  let total = 0;
  const limited = {};
  const add = (d, want) => {
    const lim = copyLimit(d);
    const have = counts.get(d.no) || 0;
    let n = Math.min(want, lim - have, DECK_RULES.size - total);
    const t = d.trigger?.type;
    if (DECK_RULES.limitedTriggers.includes(t)) n = Math.min(n, DECK_RULES.limitedMax - (limited[t] || 0));
    if (n <= 0) return;
    counts.set(d.no, have + n);
    total += n;
    if (DECK_RULES.limitedTriggers.includes(t)) limited[t] = (limited[t] || 0) + n;
  };
  const score = (d) => r() * 2 + (d.type === 'character' ? 1.5 : 0.5) + ((d.bp || 0) / 1000) * 0.3 - Math.abs((d.energy || 0) - 3) * 0.3;
  const mine = pool.filter((d) => d.color === main);
  // generators of the main colour, cheapest first
  const gens = mine.filter((d) => d.type !== 'event' && (d.gen || []).includes(main) && (d.energy || 0) <= 2).sort((a, b) => (a.energy || 0) - (b.energy || 0) || score(b) - score(a));
  for (const d of gens.slice(0, 5)) add(d, 4);
  for (const d of mine.sort((a, b) => score(b) - score(a))) { if (total >= DECK_RULES.size) break; add(d, 4); }
  for (const d of pool.filter((x) => x.color !== main && (x.energy || 0) <= 1).sort((a, b) => score(b) - score(a))) { if (total >= DECK_RULES.size) break; add(d, 4); }
  for (const d of pool.sort((a, b) => score(b) - score(a))) { if (total >= DECK_RULES.size) break; add(d, 4); }
  const list = [...counts];
  return deckProblems(list, defs).length ? null : list;
}
