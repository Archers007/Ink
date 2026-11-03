// Deck model + decklist parser/exporter + legality checks.
// A deck is a Map<cardId, qty>. Saving and loading: account.js (the account's decks, or this browser's).

import { DB, findByNameTitle, INK_ORDER } from './db.js';
import { DECK, parseDeckRule } from '/rulebook/deck.js';

// CR 1.10.1.1: 4 copies of a full name — unless the card says otherwise (1.10.1.3, game/rulebook/deck.js)
function abilityTexts(card) {
  let a = card.abilities;
  try { a = typeof a === 'string' ? JSON.parse(a) : a; } catch { /* plain text */ }
  const list = Array.isArray(a) ? a.map((x) => (typeof x === 'string' ? x : x?.text || x?.description || x?.effect || '')) : [String(a || '')];   // sanitized.db: [{ name, description }]
  return list.flatMap((t) => String(t).split(/\n|(?<=\.)\s+/));
}
export function maxCopies(card) {
  for (const t of abilityTexts(card)) { const r = parseDeckRule(t); if (r?.copies != null) return r.copies; }
  return DECK.maxCopies.base;
}

export const Deck = {
  id: null,           // saved deck id (account.js), null until first saved
  shared: false,      // listed for other players (Browse decks → Ink players)
  cover: null,        // the card shown on the deck's tile; null = picked automatically
  name: 'Untitled deck',
  cards: new Map(),   // cardId -> qty
};

export function clear() {
  Deck.cards.clear();
}
// The copy limit counts every printing of a full name together (CR 1.10.1.1 — "copies of a full name"): two sets'
// Improvise are the same card, while Mickey Mouse - Brave Little Tailor and Mickey Mouse - Wayward Sorcerer aren't (#31)
const fullKey = (card) => `${card.name || ''} - ${card.title || ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
const cardById = (id) => DB.allCards.find((c) => c.id === id);
// copies of other printings of the same full name already in the deck
function otherPrintings(card, exceptId) {
  const k = fullKey(card);
  let n = 0;
  for (const [id, q] of Deck.cards) if (id !== exceptId) { const c = cardById(id); if (c && fullKey(c) === k) n += q; }
  return n;
}
export function setQty(cardId, qty) {
  qty = Math.max(0, Math.floor(qty));
  const card = cardById(cardId) || {};
  if (qty <= 0) Deck.cards.delete(cardId);
  else Deck.cards.set(cardId, Math.min(qty, Math.max(0, maxCopies(card) - otherPrintings(card, cardId))));
  if (Deck.cards.get(cardId) === 0) Deck.cards.delete(cardId);
}
// how many more copies of this card fit (across its printings) — for "Max 4" feedback
export function roomFor(cardId) {
  const card = cardById(cardId) || {};
  return Math.max(0, maxCopies(card) - otherPrintings(card, null));
}
export function bump(cardId, delta) {
  const q = Deck.cards.get(cardId) || 0;
  setQty(cardId, q + delta);
}

export function totalCount() {
  let t = 0;
  for (const q of Deck.cards.values()) t += q;
  return t;
}

export function entries() {
  const out = [];
  for (const [id, qty] of Deck.cards) {
    const card = DB.allCards.find((c) => c.id === id);
    if (card) out.push({ card, qty });
  }
  return out;
}

export function inksUsed() {
  const set = new Set();
  for (const { card } of entries()) {
    for (const ink of card.inks) set.add(ink);
  }
  return [...set].sort((a, b) => INK_ORDER.indexOf(a) - INK_ORDER.indexOf(b));
}

export function inkable(card) {
  // Inkable when "ink" col is 1 (per db inspection: 1=inkable, 0=uninkable).
  return Number(card.ink) === 1;
}

export function summary() {
  const ents = entries();
  let total = 0, inkableCount = 0, costSum = 0, costable = 0;
  for (const { card, qty } of ents) {
    total += qty;
    if (inkable(card)) inkableCount += qty;
    if (typeof card.cost === 'number') { costSum += card.cost * qty; costable += qty; }
  }
  return {
    total,
    inkable: inkableCount,
    avgCost: costable ? (costSum / costable) : 0,
    inks: inksUsed(),
  };
}

export function legality() {
  const s = summary();
  const errs = [];
  if (s.total !== 60) errs.push(`must be 60 cards (currently ${s.total})`);
  if (s.inks.length > 2) errs.push(`max 2 inks (got ${s.inks.length})`);
  if (s.inkable < 30) errs.push(`need ≥30 inkable (got ${s.inkable})`);
  // per full name, all printings together (#31)
  const perFull = new Map();
  for (const { card, qty } of entries()) { const k = fullKey(card); const e = perFull.get(k) || perFull.set(k, { card, n: 0 }).get(k); e.n += qty; }
  for (const { card, n } of perFull.values()) {
    const max = maxCopies(card);
    if (n > max) errs.push(`>${max} copies of ${card.name}${card.title ? ` - ${card.title}` : ''} (all printings)`);
  }
  return errs;
}

// ---------- import/export ----------
export function toText() {
  const lines = [];
  for (const { card, qty } of entries()) {
    const title = card.title ? ` - ${card.title}` : '';
    lines.push(`${qty} ${card.name}${title}`);
  }
  return lines.join('\n');
}

// Replace the deck with a parsed list (used by Browse decks); returns the skipped lines.
export function fromText(text) {
  const { cards, errs } = parseText(text);
  clear();
  for (const [id, q] of cards) setQty(id, q);
  return errs;
}

// Parse a decklist without touching the deck, so Import can preview it first (#37).
// → { cards: [[id, qty]], errs: [skipped lines], total, capped: [names cut down to their copy limit] }
export function parseText(text) {
  const counts = new Map();
  const errs = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    const m = line.match(/^(\d+)\s*[xX]?\s+(.+?)$/);
    if (!m) { errs.push(`unparsed: ${line}`); continue; }
    const qty = Number(m[1]);
    const rest = m[2].trim();
    // Try "Name - Title" first, fall back to name only.
    let card = null;
    const dash = rest.lastIndexOf(' - ');
    if (dash > 0) {
      const name = rest.slice(0, dash).trim();
      const title = rest.slice(dash + 3).trim();
      const matches = findByNameTitle(name, title);
      if (matches.length) card = matches[0];
    }
    if (!card) {
      // name-only lookup
      const lc = rest.toLowerCase();
      const hit = DB.allCards.find((c) => c.name.toLowerCase() === lc)
              || DB.allCards.find((c) => (c.name + ' - ' + (c.title||'')).toLowerCase() === lc);
      if (hit) card = hit;
    }
    if (!card) { errs.push(`unknown card: ${rest}`); continue; }
    counts.set(card.id, (counts.get(card.id) || 0) + qty);
  }
  const cards = [];
  const capped = [];
  for (const [id, q] of counts) {
    const card = DB.allCards.find((c) => c.id === id) || {};
    const max = maxCopies(card);
    if (q > max) capped.push(`${card.name}${card.title ? ' - ' + card.title : ''} (${q} → ${max})`);
    if (Math.min(q, max) > 0) cards.push([id, Math.min(q, max)]);
  }
  return { cards, errs, capped, total: cards.reduce((n, [, q]) => n + q, 0) };
}

// Grouping for display
export function grouped() {
  const groups = {
    character: [], action: [], song: [], item: [], location: [],
  };
  for (const ent of entries()) {
    (groups[ent.card.type] || (groups[ent.card.type] = [])).push(ent);
  }
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => (a.card.cost - b.card.cost) || a.card.name.localeCompare(b.card.name));
  }
  return groups;
}
