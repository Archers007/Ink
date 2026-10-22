#!/usr/bin/env node
// Build step: verified rules text (cache/scan/rules.json, from tools/card-scan) → cache/procs.json.
//
//   node tools/compile-procs.mjs            compile + coverage summary
//   node tools/compile-procs.mjs --misses   + the top reasons abilities didn't compile (what to build next)
//
// Every card name+title gets { source, abilities:[{name,text}] (canonical text), procs:[…] }.
// Cards missing from rules.json fall back to the DB text (source "db-unscanned").
// Deterministic: same input → byte-identical output.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileCard, KINDS } from '../game/procs/index.js';
import { canon, unknownIcons, mergeSplitNames } from '../game/procs/normalize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES = path.join(ROOT, 'cache/scan/rules.json');
const DB = path.join(ROOT, 'cache/cards.db');
const OUT = path.join(ROOT, 'cache/procs.json');
const showMisses = process.argv.includes('--misses');

if (!existsSync(DB)) { console.error('cache/cards.db missing — run the card DB fetch first.'); process.exit(1); }
const rules = existsSync(RULES) ? JSON.parse(readFileSync(RULES, 'utf8')) : {};
if (!existsSync(RULES)) console.warn('⚠ cache/scan/rules.json missing — compiling the raw DB text (run tools/card-scan/scan.py for verified text).');

// DB: one row per printing; we need type + the DB ability text for unscanned cards
const db = new DatabaseSync(DB, { readOnly: true });
const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
const rows = db.prepare(`select * from cards${cols.includes('language') ? " where language = 'en'" : ''}`).all();
const fullOf = (r) => (r.title ? `${r.name} - ${r.title}` : r.name);
const byFull = new Map();
for (const r of rows) if (!byFull.has(fullOf(r))) byFull.set(fullOf(r), r);
const typeOf = (r) => String(r?.type || '').toLowerCase();
const dbAbilities = (r) => {
  try {
    const a = JSON.parse(r.abilities || '[]');
    return a.map((x) => ({ name: x.name || x.title || '', text: x.text || x.description || x.effect || '' })).filter((x) => x.text);
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
  }).filter(Boolean).map((text) => ({ name: '', text: canon(text) }));
};

const cards = {};
const errors = [];
const stats = { cards: 0, abilities: 0, exec: 0, cardsExec: 0, kinds: {}, sources: {} };
const misses = {};
const names = [...new Set([...Object.keys(rules), ...byFull.keys()])].sort();
for (const full of names) {
  const r = byFull.get(full);
  const v = rules[full];
  const type = typeOf(r) || 'character';
  const source = v ? v.source : 'db-unscanned';
  const abilities = (v ? v.abilities.map((a) => ({ name: a.name || '', text: a.description ?? a.text ?? '' })) : dbAbilities(r))
    .map((a) => ({ name: canon(a.name || ''), text: canon(a.text) }));
  abilities.splice(0, abilities.length, ...mergeSplitNames(abilities));
  if (!abilities.length) abilities.push(...keywordLines(r));
  for (const a of abilities) {
    const bad = unknownIcons(a.text);
    if (bad.length) errors.push(`${full}: unknown icon {${bad.join('}, {')}} in "${a.text}"`);
    if (v && (!a.text.trim() || /,\s*$|\s,/.test(a.text))) errors.push(`${full}: suspicious text "${a.text}" (empty / dangling comma — missing icon?)`);
  }
  const procs = compileCard({ type, abilities });
  const base = KINDS.base.build({ type, cost: r?.cost, inkable: Number(r?.ink) === 1, lore: r?.lore, str: r?.strength, wp: r?.willpower, move: r?.movement });
  cards[full] = { type, source, base, abilities, procs };
  stats.cards++;
  stats.sources[source] = (stats.sources[source] || 0) + 1;
  let all = true;
  for (const p of procs) {
    stats.abilities++;
    stats.kinds[p.kind] = (stats.kinds[p.kind] || 0) + 1;
    if (p.exec) stats.exec++;
    else {
      all = false;
      const key = String(p.why || 'unknown').replace(/"[^"]*"/, (m) => (m.length > 50 ? m.slice(0, 50) + '…"' : m));
      (misses[key] ||= []).push(full);
    }
  }
  if (all) stats.cardsExec++;
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '0.0');
const out = {
  generated: 'tools/compile-procs.mjs',
  input: v0(),
  coverage: {
    abilities: stats.abilities, runnable: stats.exec, pctAbilities: +pct(stats.exec, stats.abilities),
    cards: stats.cards, fullyRunnable: stats.cardsExec, pctCards: +pct(stats.cardsExec, stats.cards),
    kinds: stats.kinds, sources: stats.sources,
  },
  cards,
};
function v0() { return { rules: existsSync(RULES) ? 'cache/scan/rules.json' : null, db: 'cache/cards.db' }; }
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');

console.log(`procs → ${path.relative(ROOT, OUT)}`);
console.log(`  abilities: ${stats.exec}/${stats.abilities} runnable (${pct(stats.exec, stats.abilities)}%)`);
console.log(`  cards:     ${stats.cardsExec}/${stats.cards} fully runnable (${pct(stats.cardsExec, stats.cards)}%)`);
console.log(`  kinds:     ${Object.entries(stats.kinds).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
console.log(`  sources:   ${Object.entries(stats.sources).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
if (errors.length) {
  console.log(`\n⚠ ${errors.length} text problems (fix in tools/card-scan/corrections.json):`);
  for (const e of errors.slice(0, 20)) console.log('  ' + e);
}
if (showMisses) {
  console.log('\ntop misses:');
  for (const [k, list] of Object.entries(misses).sort((a, b) => b[1].length - a[1].length).slice(0, 40)) {
    console.log(`${String(list.length).padStart(5)}  ${k}\n         e.g. ${list.slice(0, 2).join(' | ')}`);
  }
}
