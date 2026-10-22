#!/usr/bin/env node
// Build step: cards.db + cache/scan/results.jsonl (tools/card-scan) → cache/rulings.db.
//
//   node tools/build-rulings.mjs
//
// One `cards` row per unique card (Name - Title), its `printings`, and one `rulings` row per ability holding
// the DB text, the scanned text and the final text the compiler gets (canonical spelling, see normalize.js).
// `rulings.proc_id` stays NULL here; tools/compile-procs.mjs fills it with a key into cache/proc.db.
// Cards the scan has no verdict for (no ability text, mismatch without a correction) keep the DB text.
// Deterministic: same input → same rows.

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canon, unknownIcons, mergeSplitNames } from '../game/procs/normalize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'cache/cards.db');
const RESULTS = path.join(ROOT, 'cache/scan/results.jsonl');
const OUT = path.join(ROOT, 'cache/rulings.db');

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
    return (JSON.parse(json || '[]') || []).map((x) => ({ name: x.name || x.title || '', text: x.text || x.description || x.effect || '' })).filter((x) => x.text);
  } catch { return []; }
};
// Keyword-only cards ship no ability text, just the `keywords` column — turn it back into printed keyword
// lines ("Shift 3 {ink}", "Challenger +3", "Evasive") so they compile to keyword procs like every other card.
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
    source TEXT NOT NULL,          -- where the rulings text came from: db · db+icons · errata · corrected · reviewed · scan · keywords · none
    scan_status TEXT,              -- results.jsonl status: match · icon-fix · close · mismatch · db-suspect · no-image (NULL = not scanned)
    scanned_id TEXT, verified INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE printings (id TEXT PRIMARY KEY, card_key TEXT NOT NULL REFERENCES cards, set_id TEXT, number TEXT, rarity TEXT);
  CREATE TABLE rulings (
    id INTEGER PRIMARY KEY, card_key TEXT NOT NULL REFERENCES cards, idx INTEGER NOT NULL,
    name TEXT, text TEXT NOT NULL,  -- what the compiler gets
    db_text TEXT, scan_text TEXT,   -- the two sources, as read
    proc_id TEXT,                   -- → proc.db procs.proc_id; NULL until compile-procs runs
    UNIQUE (card_key, idx)
  );
  CREATE INDEX printings_card ON printings(card_key);
  CREATE INDEX rulings_proc ON rulings(proc_id);
`);
const insCard = out.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insPrint = out.prepare('INSERT INTO printings VALUES (?,?,?,?,?)');
const insRuling = out.prepare('INSERT INTO rulings (card_key, idx, name, text, db_text, scan_text) VALUES (?,?,?,?,?,?)');
const n = (x) => (x == null || x === '' ? null : Number(x));

const errors = [];
const stats = { cards: 0, rulings: 0, sources: {} };
out.exec('BEGIN');
for (const [full, printings] of [...byFull].sort((a, b) => a[0].localeCompare(b[0]))) {
  const r = printings[0];
  const scan = results.get(full);
  const rules = scan?.rules;
  const dbAb = abilitiesOf(r.abilities);
  let abilities = rules ? rules.abilities.map((a) => ({ name: a.name || '', text: a.description ?? a.text ?? '' })) : dbAb;
  let source = rules ? rules.source : dbAb.length ? 'db' : 'none';
  if (!abilities.length) { abilities = keywordLines(r); if (abilities.length) source = 'keywords'; }
  abilities = mergeSplitNames(abilities.map((a) => ({ name: canon(a.name || ''), text: canon(a.text) })));
  for (const a of abilities) {
    const bad = unknownIcons(a.text);
    if (bad.length) errors.push(`${full}: unknown icon {${bad.join('}, {')}} in "${a.text}"`);
    if (rules && (!a.text.trim() || /,\s*$|\s,/.test(a.text))) errors.push(`${full}: suspicious text "${a.text}" (empty / dangling comma — missing icon?)`);
  }
  const type = String(r.type || 'character').toLowerCase();
  insCard.run(full, r.name, r.title || null, type, n(r.cost), Number(r.ink) === 1 ? 1 : 0, n(r.lore), n(r.strength), n(r.willpower), n(r.movement),
    r.keywords || null, source, scan?.status ?? null, scan?.id ?? null, rules?.verified ? 1 : 0);
  for (const p of printings) insPrint.run(p.id, full, p.setId ?? null, p.number ?? null, p.rarity ?? null);
  // the scan's own DB version lines up with what it read; else the first printing's DB text
  const dbSide = scan?.db?.length ? abilitiesOf(JSON.stringify(scan.db)) : dbAb;
  const scanSide = (scan?.scanned || []).map((x) => ({ name: x.name || '', text: x.text || '' }));
  abilities.forEach((a, i) => {
    insRuling.run(full, i, a.name || null, a.text, sourceText(a, dbSide), sourceText(a, scanSide));
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
if (errors.length) {
  console.log(`\n⚠ ${errors.length} text problems (fix in tools/card-scan/corrections.json):`);
  for (const e of errors.slice(0, 20)) console.log('  ' + e);
}
