// Union Arena card index: cache/ua-cards.json (tools/ua/import-cards.mjs) -> card defs the UA engine and clients use.
//
// A def:
//   { no: 'HTR-1-001', src: 'HTR', name, type: 'character'|'site'|'event', color: 'green', energy: 3, ap: 1,
//     bp: 3000, affinities: ['Phantom Troupe'], gen: ['green'], genPlus, rarity, title, img,
//     kw: { step, snipe, doubleAttack, doubleBlock, impact: 1, damage: 2, nullifyImpact, impactPlus, damagePlus },
//     raid: { kind: 'name'|'affinity', value: 'Gon Freecss' } | null,
//     lines: [ 'raw effect line', … ], trigger: { type: 'draw'|'get'|'raid'|'active'|'special'|'color'|'final', text } | null }
//
// Rules cited as UA-x from docs/rules/ua/rule_manual.md.

import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileDef } from './compile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const UA_CARDS_FILE = path.join(ROOT, 'cache', 'ua-cards.json');

export const DECK_RULES = { size: 50, copies: 4, limitedTriggers: ['special', 'color', 'final'], limitedMax: 4 };   // UA-4
export const COLORS = ['red', 'blue', 'green', 'yellow', 'purple'];

// a keyword standing alone on its line (no timing or condition in front) is the card's own
const KW_TAGS = [
  [/^Step$/i, (kw) => { kw.step = true; }],
  [/^Snipe$/i, (kw) => { kw.snipe = true; }],
  [/^Double Attack$/i, (kw) => { kw.doubleAttack = true; }],
  [/^Double Block$/i, (kw) => { kw.doubleBlock = true; }],
  [/^Nullify Impact$/i, (kw) => { kw.nullifyImpact = true; }],
  [/^Impact\s*\+\s*\(?(\d+)\)?$/i, (kw, m) => { kw.impactPlus = (kw.impactPlus || 0) + Number(m[1]); }],
  [/^Impact(?:\s*\(?(\d+)\)?)?$/i, (kw) => { kw.impact = 1; }],                         // Impact 1 doesn't stack (UA-10)
  [/^Damage\s*\+\s*\(?(\d+)\)?$/i, (kw, m) => { kw.damagePlus = (kw.damagePlus || 0) + Number(m[1]); }],
  [/^Damage\s*\(?(\d+)\)?$/i, (kw, m) => { kw.damage = Math.max(kw.damage || 1, Number(m[1])); }],
];
export function keywordTag(tag) {
  for (const [rx, apply] of KW_TAGS) {
    const m = String(tag).trim().match(rx);
    if (m) return (kw) => apply(kw, m);
  }
  return null;
}

export const TRIGGER_TYPES = { draw: 'draw', get: 'get', raid: 'raid', active: 'active', special: 'special', color: 'color', final: 'final' };
export const triggerKind = (t) => TRIGGER_TYPES[String(t || '').trim().toLowerCase()] || (t ? 'other' : null);

// "[Raid] <Gon Freecss> Switch to active. …" / "[Raid] [Phantom Troupe] …"
export function parseRaid(line) {
  const m = String(line).match(/^\[Raid\]\s*(?:<([^>]+)>|\[([^\]]+)\])/i);
  if (!m) return null;
  return m[1] ? { kind: 'name', value: m[1].trim() } : { kind: 'affinity', value: m[2].trim() };
}

export const nameKey = (s) => String(s || '').toLowerCase().replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

export function toDef(c) {
  const type = String(c.type || '').toLowerCase();
  const lines = String(c.effect || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const kw = {};
  let raid = null;
  const ability = [];
  for (const line of lines) {
    const r = parseRaid(line);
    if (r) { raid = r; ability.push(line); continue; }
    // a line made only of keyword tags: "[Impact (1)]" / "[Step] [Snipe]"
    const tags = [...line.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
    const rest = line.replace(/\[[^\]]+\]/g, '').replace(/\([^)]*\)/g, '').trim();
    const fns = tags.map(keywordTag);
    if (tags.length && !rest && fns.every(Boolean)) { fns.forEach((f) => f(kw)); continue; }
    ability.push(line);
  }
  return {
    no: c.no,
    src: c.src,
    name: c.name,
    title: c.title || null,
    type: type === 'character' || type === 'site' || type === 'event' ? type : type || 'unknown',
    color: c.color || null,
    energy: c.energy ?? 0,
    ap: c.ap ?? 0,
    bp: c.bp ?? null,
    affinities: c.affinities || [],
    gen: c.generated || [],
    genPlus: !!c.genPlus,
    rarity: c.rarity || null,
    img: c.img,
    printings: c.printings || [],
    kw,
    raid,
    effect: c.effect || null,
    lines: ability,
    trigger: c.trigger ? { type: triggerKind(c.trigger.type), label: c.trigger.type, text: c.trigger.text || '' } : null,
  };
}

let cached = null;
export function loadUaCards(file = UA_CARDS_FILE) {
  if (!existsSync(file)) return null;
  const mtime = statSync(file).mtimeMs;
  if (cached && cached.file === file && cached.mtime === mtime) return cached;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const defs = new Map();
  for (const c of raw.cards || []) defs.set(c.no, toDef(c));
  cached = { file, mtime, builtAt: raw.builtAt, titles: raw.titles || {}, products: raw.products || [], defs, size: defs.size };
  return cached;
}

// "A deck can only contain up to three copies of this card." overrides the 4-copy rule
const limits = new Map();
export function copyLimit(d) {
  if (!limits.has(d.no)) limits.set(d.no, compileDef(d).copyLimit ?? DECK_RULES.copies);
  return limits.get(d.no);
}

// Deck legality (UA-4). list: [[cardNo, qty], …]. Returns [] when legal, else human-readable problems.
export function deckProblems(list, defs) {
  const problems = [];
  let total = 0;
  const srcs = new Set();
  const limited = {};
  for (const [no, qty] of list) {
    const d = defs.get(no);
    if (!d) { problems.push(`Unknown card ${no}.`); continue; }
    total += qty;
    srcs.add(d.src);
    const limit = copyLimit(d);
    if (qty > limit) problems.push(`${d.name} (${no}): ${qty} copies; the limit is ${limit}.`);
    const t = d.trigger?.type;
    if (DECK_RULES.limitedTriggers.includes(t)) limited[t] = (limited[t] || 0) + qty;
  }
  if (total !== DECK_RULES.size) problems.push(`The deck has ${total} cards; it needs exactly ${DECK_RULES.size}.`);
  if (srcs.size > 1) problems.push(`Every card must come from one title; this deck mixes ${[...srcs].join(', ')}.`);
  for (const [t, n] of Object.entries(limited)) {
    if (n > DECK_RULES.limitedMax) problems.push(`${n} cards with a ${t.toUpperCase()} trigger; the limit is ${DECK_RULES.limitedMax}.`);
  }
  return problems;
}

// "4 HTR-1-001" / "4x HTR-1-001" / "HTR-1-001 x4" / "UE02BT/HTR-1-001 4" lines -> [[no, qty]]
export function parseDeckText(text) {
  const out = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const no = line.match(/(?:[A-Z0-9]+\/)?([A-Z0-9]{2,4}-[A-Z0-9]+-[A-Z0-9]+)(?:_p\d+)?/i)?.[1]?.toUpperCase();
    if (!no) continue;
    const rest = line.replace(/(?:[A-Z0-9]+\/)?[A-Z0-9]{2,4}-[A-Z0-9]+-[A-Z0-9]+(?:_p\d+)?/i, ' ');
    const qty = Number(rest.match(/(\d+)\s*x?|x\s*(\d+)/i)?.slice(1).find(Boolean) || 1);
    out.set(no, (out.get(no) || 0) + qty);
  }
  return [...out];
}
