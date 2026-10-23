#!/usr/bin/env node
// Build step: cards.db + cache/scan/results.jsonl (tools/card-scan) + cache/lorcanajson.json → cache/rulings.db.
//
//   node tools/build-rulings.mjs
//
// One `cards` row per unique card (Name - Title), its `printings`, and one `rulings` row per ability holding
// the DB text, the scanned text, lorcanajson's text and the final text the compiler gets (canonical spelling).
// `rulings.proc_id` stays NULL here; tools/compile-procs.mjs fills it with a key into cache/proc.db.
//
// Which text wins — a vote between the three sources, per card (see vote() below):
//   scan found icons the DB dropped        → DB words + scanned icons             db+icons
//   DB and lorcanajson agree               → DB                                   db
//   card image and DB agree, lorcanajson   → DB, unless the set release notes     db · errata
//     doesn't                                 print lorcanajson's wording (errata)
//   otherwise (DB disagrees with both)     → lorcanajson                          lorcanajson
// Deterministic: same input → same rows.

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canon, unknownIcons, mergeSplitNames, splitDbAbilities } from '../game/procs/normalize.js';
import { needsOcr } from './card-scan/needs-ocr.mjs';
import { loadLorcanaJson, ljAbilities, rulesKey, officialText, missingKeywordLines } from './card-scan/lorcanajson.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'cache/cards.db');
const RESULTS = path.join(ROOT, 'cache/scan/results.jsonl');
const OUT = path.join(ROOT, 'cache/rulings.db');
const LJ = loadLorcanaJson(path.join(ROOT, 'cache/lorcanajson.json'));
if (!LJ) console.warn('⚠ cache/lorcanajson.json missing — voting with cards.db + scan only (scripts/build-cards.mjs downloads it).');
const isOfficial = officialText(path.join(ROOT, 'docs/rules'));

if (!existsSync(DB)) { console.error('cache/cards.db missing — run the card DB fetch first.'); process.exit(1); }
const results = new Map();
if (existsSync(RESULTS)) {
  for (const line of readFileSync(RESULTS, 'utf8').split('\n')) if (line.trim()) { const r = JSON.parse(line); results.set(r.full, r); }
} else console.warn('⚠ cache/scan/results.jsonl missing — using the raw DB text (run tools/card-scan/scan.py for verified text).');

const db = new DatabaseSync(DB, { readOnly: true });
const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
const rows = db.prepare(`select * from cards${cols.includes('language') ? " where language = 'en'" : ''} order by id`).all();
const fullOf = (r) => (r.title ? `${r.name} - ${r.title}` : r.name);
const byFull = new Map();
for (const r of rows) (byFull.get(fullOf(r)) || byFull.set(fullOf(r), []).get(fullOf(r))).push(r);

const abilitiesOf = (json) => {
  try {
    return (JSON.parse(json || '[]') || []).flatMap((x) => splitDbAbilities(x.name || x.title || '', x.text || x.description || x.effect || '')).filter((x) => x.text);
  } catch { return []; }
};
// Keyword-only cards ship no ability text, just the `keywords` column — turn it back into printed keyword
// lines ("Shift 3 {ink}", "Challenger +3", "Evasive") so they compile to keyword procs like every other card.
const FULL_ART = new Set(['enchanted', 'iconic', 'promo', 'epic']);
const KW_SIGN = new Set(['challenger', 'resist']);
const keywordLines = (r) => {
  let kw;
  try { kw = JSON.parse(r?.keywords || '{}') || {}; } catch { return []; }
  return Object.entries(kw).map(([k, v]) => {
    const label = k.replace(/\b[a-z]/g, (c) => c.toUpperCase());
    if (v === true) return /shift|singer|boost/.test(k) ? null : `${label}${KW_SIGN.has(k) ? ' +1' : ''}`; // Kronk ships `challenger: true` = +1
    if (typeof v === 'string' && !/^\d+$/.test(v)) return `${label}: ${v}`; // non-ink shift cost
    return `${label} ${KW_SIGN.has(k) ? '+' : ''}${v}${/shift|boost/.test(k) ? ' {ink}' : ''}`;
  }).filter(Boolean).map((text) => ({ name: '', text }));
};

// which source line this ability came from: same name, else most words in common (abilities can be merged or
// reordered between sources, so the list index isn't enough)
const words = (t) => new Set(canon(t).toLowerCase().match(/[a-z0-9{}]+/g) || []);
function sourceText(a, list) {
  const named = a.name && list.find((x) => x.name && canon(x.name).toLowerCase() === a.name.toLowerCase());
  if (named) return named.text;
  const A = words(a.text);
  let best = null, score = 0;
  for (const x of list) {
    const B = words(x.text);
    const common = [...A].filter((w) => B.has(w)).length;
    const sc = common / Math.max(1, Math.min(A.size, B.size));
    if (sc > score) { best = x; score = sc; }
  }
  return score >= 0.5 ? best.text : null;
}

rmSync(OUT, { force: true });
const out = new DatabaseSync(OUT);
out.exec(`
  CREATE TABLE cards (
    card_key TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT, type TEXT NOT NULL, cost INTEGER, inkable INTEGER,
    lore INTEGER, strength INTEGER, willpower INTEGER, movement INTEGER, keywords TEXT,
    source TEXT NOT NULL,          -- where the rulings text came from: db · db+icons · errata · lorcanajson · scan · keywords · none
    scan_status TEXT,              -- results.jsonl status: match · icon-fix · close · mismatch · db-suspect · no-image (NULL = not scanned)
    scanned_id TEXT,
    verified INTEGER NOT NULL DEFAULT 0   -- 1 = two sources agree on this text
  );
  CREATE TABLE printings (id TEXT PRIMARY KEY, card_key TEXT NOT NULL REFERENCES cards, set_id TEXT, number TEXT, rarity TEXT);
  CREATE TABLE rulings (
    id INTEGER PRIMARY KEY, card_key TEXT NOT NULL REFERENCES cards, idx INTEGER NOT NULL,
    name TEXT, text TEXT NOT NULL,  -- what the compiler gets
    db_text TEXT, scan_text TEXT, lj_text TEXT,   -- the three sources, as read
    proc_id TEXT,                   -- → proc.db procs.proc_id; NULL until compile-procs runs
    UNIQUE (card_key, idx)
  );
  CREATE INDEX printings_card ON printings(card_key);
  CREATE INDEX rulings_proc ON rulings(proc_id);
`);
const insCard = out.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insPrint = out.prepare('INSERT INTO printings VALUES (?,?,?,?,?)');
const insRuling = out.prepare('INSERT INTO rulings (card_key, idx, name, text, db_text, scan_text, lj_text) VALUES (?,?,?,?,?,?,?)');

// → { abilities, source, verified } for one card
function vote(dbAb, scan, lja) {
  const rules = scan?.rules;
  const fromRules = rules && rules.abilities.map((a) => ({ name: a.name || '', text: a.description ?? a.text ?? '' }));
  if (scan?.status === 'icon-fix' && fromRules) return { abilities: fromRules, source: 'db+icons', verified: true };
  if (lja) {
    const same = rulesKey(dbAb) === rulesKey(lja);
    if (same) return { abilities: dbAb, source: dbAb.length ? 'db' : 'none', verified: true };
    if (lja.length && isOfficial(lja)) return { abilities: lja, source: 'errata', verified: true };
    if (scan?.status === 'match') return { abilities: dbAb, source: 'db', verified: true, ljDiffers: true };
    if (lja.length) return { abilities: lja, source: 'lorcanajson', verified: !!scan };
  }
  if (fromRules) return { abilities: fromRules, source: rules.source, verified: !!rules.verified };
  return { abilities: dbAb, source: dbAb.length ? 'db' : 'none', verified: false };
}
const n = (x) => (x == null || x === '' ? null : Number(x));

// Glued words: a word that's rare across all card text but splits into two common ones lost its space
// ("another characteris banished" → "character is"). Real words that happen to split go in REAL_WORDS.
const REAL_WORDS = new Set(['forget', 'forward', 'inkable']);
const wordCount = new Map();
for (const r of rows) for (const a of abilitiesOf(r.abilities)) for (const w of a.text.toLowerCase().match(/[a-z']+/g) || []) wordCount.set(w, (wordCount.get(w) || 0) + 1);
const common = (w) => (wordCount.get(w) || 0) >= 15;
const gluedFixes = new Map();      // "characteris" → { split: "character is", cards: Set }
function unglue(text, full) {
  return text.replace(/[A-Za-z']{5,}/g, (w) => {
    const lw = w.toLowerCase();
    if (REAL_WORDS.has(lw) || (wordCount.get(lw) || 0) > 3) return w;
    for (let i = 2; i <= w.length - 2; i++) {
      if (common(lw.slice(0, i)) && common(lw.slice(i))) {
        const split = `${w.slice(0, i)} ${w.slice(i)}`;
        (gluedFixes.get(lw) || gluedFixes.set(lw, { split, cards: new Set() }).get(lw)).cards.add(full);
        return split;
      }
    }
    return w;
  });
}

const errors = [];
const stats = { cards: 0, rulings: 0, sources: {}, ljDiffers: [], kwAdded: 0 };
out.exec('BEGIN');
for (const [full, printings] of [...byFull].sort((a, b) => a[0].localeCompare(b[0]))) {
  // the printing to read when there's no scan: one with text, then one needs-ocr finds nothing wrong with
  // (reprints often lost icons the older row still has), standard frame before full art, newest set first
  const flagsOf = (p) => needsOcr(abilitiesOf(p.abilities).map((a) => a.text), p.type).length;
  const r = [...printings].sort((a, b) => (abilitiesOf(b.abilities).length > 0) - (abilitiesOf(a.abilities).length > 0)
    || flagsOf(a) - flagsOf(b) || FULL_ART.has(a.rarity) - FULL_ART.has(b.rarity)
    || String(b.setId).localeCompare(String(a.setId)) || String(b.id).localeCompare(String(a.id)))[0];
  const scan = results.get(full);
  const dbAb = abilitiesOf(r.abilities);
  const lj = LJ?.get(full);
  const lja = lj ? ljAbilities(lj) : null;
  let { abilities, source, verified, ljDiffers } = vote(dbAb, scan, lja);
  if (ljDiffers) stats.ljDiffers.push(full);
  if (lj && source !== 'lorcanajson' && source !== 'errata') {
    const kw = missingKeywordLines(lj, abilities);
    if (kw.length) { abilities = [...kw, ...abilities]; if (source === 'none') source = 'keywords'; stats.kwAdded++; }
  }
  if (!abilities.length) { abilities = keywordLines(r); if (abilities.length) source = 'keywords'; }
  abilities = mergeSplitNames(abilities.map((a) => ({ name: canon(a.name || ''), text: unglue(canon(a.text), full) })));
  for (const a of abilities) {
    const bad = unknownIcons(a.text);
    if (bad.length) errors.push(`${full}: unknown icon {${bad.join('}, {')}} in "${a.text}"`);
    if (verified && (!a.text.trim() || /,\s*$|\s,/.test(a.text))) errors.push(`${full}: suspicious text "${a.text}" (empty / dangling comma — missing icon?)`);
  }
  const type = String(r.type || 'character').toLowerCase();
  insCard.run(full, r.name, r.title || null, type, n(r.cost), Number(r.ink) === 1 ? 1 : 0, n(r.lore), n(r.strength), n(r.willpower), n(r.movement),
    r.keywords || null, source, scan?.status ?? null, scan?.id ?? null, verified ? 1 : 0);
  for (const p of printings) insPrint.run(p.id, full, p.setId ?? null, p.number ?? null, p.rarity ?? null);
  // the scan's own DB version lines up with what it read; else the first printing's DB text
  const dbSide = scan?.db?.length ? abilitiesOf(JSON.stringify(scan.db)) : dbAb;
  const scanSide = (scan?.scanned || []).map((x) => ({ name: x.name || '', text: x.text || '' }));
  const ljSide = lja || [];
  abilities.forEach((a, i) => {
    insRuling.run(full, i, a.name || null, a.text, sourceText(a, dbSide), sourceText(a, scanSide), sourceText(a, ljSide));
  });
  stats.cards++; stats.rulings += abilities.length;
  stats.sources[source] = (stats.sources[source] || 0) + 1;
}
out.exec('COMMIT');
out.close();

console.log(`rulings → ${path.relative(ROOT, OUT)}`);
console.log(`  cards:     ${stats.cards} unique (${rows.length} printings)`);
console.log(`  rulings:   ${stats.rulings}`);
console.log(`  sources:   ${Object.entries(stats.sources).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
if (gluedFixes.size) {
  console.log(`\n  glued words split (add real words to REAL_WORDS in tools/build-rulings.mjs):`);
  for (const [w, g] of gluedFixes) console.log(`    ${w} → ${g.split}   ${[...g.cards].join(' | ')}`);
}
if (stats.kwAdded) console.log(`\n  ${stats.kwAdded} cards got their keyword lines from lorcanajson (the DB keeps them in a separate column)`);
if (stats.ljDiffers.length) console.log(`\n  ${stats.ljDiffers.length} cards where the card image and DB agree but lorcanajson differs (kept the DB text)`);
if (errors.length) {
  console.log(`\n⚠ ${errors.length} text problems:`);
  for (const e of errors.slice(0, 20)) console.log('  ' + e);
}
