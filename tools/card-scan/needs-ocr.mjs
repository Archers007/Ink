#!/usr/bin/env node
// Which cards need the image scan? DB-only red flags for an icon dreamborn dropped from the rules text
// ("gets +1 this turn" — the card says +1 {strength}). Tested per ability, reminder text removed.
//
//   node tools/card-scan/needs-ocr.mjs          flagged cards in cache/cards.db, scored against cache/scan/results.jsonl
//   node tools/card-scan/needs-ocr.mjs --list   + every flagged card and the pattern that caught it
//
// Scored against the scan's icon-fix cards: 164/164 caught, 0 false alarms. close / mismatch / db-suspect
// cards are OCR trouble, not DB gaps, so nothing in the DB text predicts them — the full scan still runs.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// [missing icon, what it catches, pattern, only on permanents (not action / song)?]
export const NEEDS_OCR = [
  ['stat',  '+N / -N with no stat',      /(?<!(?:Challenger|Resist|Singer|Boost|Shift)[>}]?)(?:^|\s)[+-] ?\d+(?!\d)(?! ?\{)(?! (?:cost|card|damage|lore|more|less|other))/],
  ['stat',  'with N or more, no stat',   /\bwith (?!cost)\d+(?!\d)(?: or (?:more|less))?(?! ?\{)(?! (?:cost|damage|cards?|lore))/],
  ['stat',  'equal to the ___',          /\bequal to (?:the|her|his|their|its) (?:of\b|[,.])/],
  ['stat',  "characters' ___",           /\bcharacters' (?!\{)/],
  ['ink',   'pay N, no {ink}',           /\bpay \d+(?!\d)(?! ?\{)/],
  ['ink',   'N less / more, no {ink}',   /\b\d+ (?:less|more)\b(?! \{)(?! (?:than|cards?|damage|lore))/],
  ['ink',   'N , (cost)',                /(?:^|\s)\d+ ,/],
  ['exert', 'cost starts with , — ?',    /^\s*(?:[,—-]\s*\S|\? ?—|\d+ ?[—-])/],
  ['exert', 'gain " — (granted ability)', /\bgains? "\s*—/],
  // a character / item / location ability that opens with a bare command lost its whole "{exert} — " cost;
  // one that still has its " — " cost dash is fine
  ['exert', 'command with no cost',      /^(?!.*\s[—-]\s)\s*(?:Draw|Remove|Deal|Banish|Return|Gain|Look|Put|Ready|Exert|Move|Play|Shuffle|Reveal|Search|Choose|Chosen)\b/, true],
];

// dreamborn often runs the ability name into the text: "MAGIC HAIR — Remove…", "YAAA-HOO , Banish…"
const INLINE_NAME = /^(?:[A-Z0-9][A-Z0-9'’!?.&-]* )+(?=[—,-]|\d|\?|\{|[A-Z][a-z])/;
// …and sometimes runs two abilities into one string: "…gains Evasive. GROUNDED 3 — Return this item…"
const MERGED = /\s(?=(?:[A-Z][A-Z'’!?.&-]+ )+(?:\d+ ?)?[—-]\s)/;
const stripName = (t) => { const m = t.match(INLINE_NAME); return m && m[0].trim().length >= 3 ? t.slice(m[0].length) : t; };

// ability texts + card type → [{ icon, why }] (empty = the DB text looks complete)
export function needsOcr(texts, type = '') {
  const spell = /action|song/i.test(type);
  const abs = texts.flatMap((t) => String(t ?? '').replace(/\([^)]*\)/g, '').split(MERGED)).map((t) => stripName(t.trim()));
  return NEEDS_OCR.filter(([, , rx, permOnly]) => !(permOnly && spell) && abs.some((t) => rx.test(t))).map(([icon, why]) => ({ icon, why }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(ROOT, 'cache/cards.db'), { readOnly: true });
  const seen = new Map();
  for (const r of db.prepare("SELECT name, title, type, abilities FROM cards WHERE language = 'en' ORDER BY id").all()) {
    const full = r.title ? `${r.name} - ${r.title}` : r.name;
    let abs = [];
    try { abs = (JSON.parse(r.abilities || '[]') || []).map((a) => a.description ?? a.text ?? ''); } catch {}
    // any printing's text can be the broken one (Beast's Mirror: set 1 lost its whole cost, set 9 only the icons)
    const f = needsOcr(abs, r.type), prev = seen.get(full) || [];
    seen.set(full, [...prev, ...f.filter((x) => !prev.some((p) => p.why === x.why))]);
  }
  const flagged = [...seen].filter(([, f]) => f.length);
  console.log(`needs OCR: ${flagged.length} of ${seen.size} cards`);
  const by = {};
  for (const [, f] of flagged) for (const x of f) by[`${x.icon}: ${x.why}`] = (by[`${x.icon}: ${x.why}`] || 0) + 1;
  for (const [k, n] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

  const RESULTS = path.join(ROOT, 'cache/scan/results.jsonl');
  if (existsSync(RESULTS)) {
    const fix = new Set(readFileSync(RESULTS, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.status === 'icon-fix').map((r) => r.full));
    const hit = flagged.filter(([k]) => fix.has(k)).length;
    console.log(`vs last scan: ${hit}/${fix.size} icon-fix cards caught · ${flagged.length - hit} flagged but scan agreed · ${fix.size - hit} missed`);
    for (const k of fix) if (!seen.get(k)?.length) console.log(`  missed: ${k}`);
  }
  if (process.argv.includes('--list')) for (const [k, f] of flagged) console.log(`${k}  ←  ${f.map((x) => x.why).join(', ')}`);
}
