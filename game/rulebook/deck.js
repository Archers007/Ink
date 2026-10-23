// Deck construction (CR 1.10.1): the Constructed limits, and the card abilities that adjust them (1.10.1.3 — they
// "function outside of the game but apply only if that card could be included in the deck in the first place").
//   static text → { fn: 'deck', copies, of: 'name' | 'full', name } · { fn: 'deck', anyInk: classification }
export const DECK = {
  minSize: { cr: '1.10.1.1', base: 60, say: 'cards at least' },
  maxInks: { cr: '1.10.1.1', base: 2, say: 'ink types at most' },
  maxCopies: { cr: '1.10.1.1', base: 4, say: 'copies of a full name at most' },
};
const PHRASES = [
  [/^you may have any number of cards named (.+) in your deck$/i, (m) => ({ copies: Infinity, of: 'name', name: m[1] })],
  [/^you may have up to (\d+) copies of (.+) in your deck$/i, (m) => ({ copies: +m[1], of: 'full', name: m[2] })],
  [/^you may only have (\d+) copies of (.+) in your deck$/i, (m) => ({ copies: +m[1], of: 'full', name: m[2] })],
  [/^you can have other (\S+) characters in your deck regardless of ink type$/i, (m) => ({ anyInk: m[1].toLowerCase() })],
];
export function parseDeckRule(text) {
  const t = String(text).replace(/\.$/, '').trim();
  for (const [rx, f] of PHRASES) { const m = t.match(rx); if (m) return { fn: 'deck', ...f(m) }; }
  return null;
}
export const deckSay = (st) => (st.anyInk ? `deck: other ${st.anyInk} characters ignore ink type` : `deck: ${st.copies === Infinity ? 'any number' : `up to ${st.copies}`} of ${st.name}`) + ' [CR 1.10.1.3]';

const norm = (s) => String(s).toLowerCase().replace(/[—–-]/g, '-').replace(/\s+/g, ' ').trim();
const rulesOf = (d) => (d.procs || []).filter((p) => p.kind === 'static' && p.effect?.fn === 'deck').map((p) => p.effect);

// The legality problems of a deck (defs: one entry per card). full(d) / name(d) / key(d) as in game/cards.js.
export function deckProblems(defs) {
  const problems = [];
  const present = [...new Map(defs.map((d) => [d.id, d])).values()];
  if (defs.length < DECK.minSize.base) problems.push(`needs at least ${DECK.minSize.base} cards (has ${defs.length})`);
  // inks: a card that lets "other X characters" in regardless of ink type exempts them (not itself)
  const anyInk = present.flatMap((d) => rulesOf(d).filter((r) => r.anyInk).map((r) => ({ cls: r.anyInk, src: d.full })));
  const inks = new Set();
  for (const d of present) {
    const exempt = d.type === 'character' && anyInk.some((a) => a.src !== d.full && (d.classes || []).includes(a.cls));
    if (!exempt) (d.inks || []).forEach((i) => inks.add(i));
  }
  if (inks.size > DECK.maxInks.base) problems.push(`max ${DECK.maxInks.base} ink types (has ${inks.size})`);
  // copies: per full name, unless the card says otherwise for its own name / full name
  const perFull = new Map();
  for (const d of defs) { const k = norm(d.full); const e = perFull.get(k) || perFull.set(k, { d, n: 0 }).get(k); e.n++; }
  for (const { d, n } of perFull.values()) {
    const own = rulesOf(d).find((r) => r.copies != null && norm(r.name) === norm(r.of === 'name' ? d.name : d.full));
    const max = own ? own.copies : DECK.maxCopies.base;
    if (n > max) problems.push(`more than ${max} copies of ${d.full}`);
  }
  return problems;
}
