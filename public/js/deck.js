// Deck model + decklist parser/exporter + legality checks.
// A deck is a Map<cardId, qty>. Storage = localStorage 'ink.deck.<name>'.

import { DB, findByNameTitle, INK_ORDER } from './db.js';

export const Deck = {
  name: 'Untitled Deck',
  cards: new Map(),   // cardId -> qty
};

export function clear() {
  Deck.cards.clear();
}
export function setQty(cardId, qty) {
  qty = Math.max(0, Math.floor(qty));
  if (qty <= 0) Deck.cards.delete(cardId);
  else Deck.cards.set(cardId, Math.min(qty, 4));
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
  for (const { card, qty } of entries()) {
    if (qty > 4) errs.push(`>4 copies of ${card.name} - ${card.title || ''}`);
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

export function fromText(text) {
  clear();
  const errs = [];
  for (const raw of text.split(/\r?\n/)) {
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
    setQty(card.id, (Deck.cards.get(card.id) || 0) + qty);
  }
  return errs;
}

// ---------- localStorage ----------
const KEY_PREFIX = 'ink.deck.';
export function save(name = Deck.name) {
  Deck.name = name;
  const payload = { name, cards: [...Deck.cards.entries()] };
  localStorage.setItem(KEY_PREFIX + name, JSON.stringify(payload));
  return payload;
}
export function load(name) {
  const raw = localStorage.getItem(KEY_PREFIX + name);
  if (!raw) return false;
  const p = JSON.parse(raw);
  Deck.name = p.name;
  Deck.cards = new Map(p.cards);
  return true;
}
export function listSaved() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(KEY_PREFIX)) out.push(k.slice(KEY_PREFIX.length));
  }
  return out.sort();
}
export function deleteSaved(name) {
  localStorage.removeItem(KEY_PREFIX + name);
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
