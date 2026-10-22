#!/usr/bin/env node
// Which cards need the image scan? DB-only red flags for an icon dreamborn dropped from the rules text
// ("gets +1 this turn" — the card says +1 {strength}). Tested per ability, reminder text removed.
//
//   node tools/card-scan/needs-ocr.mjs                  flagged cards, per pattern, scored against the last scan
//   node tools/card-scan/needs-ocr.mjs --check          only check every pattern against its own examples
//   node tools/card-scan/needs-ocr.mjs --pattern <id>   every card one pattern flags, with the words it matched
//   node tools/card-scan/needs-ocr.mjs --missed         icon-fix cards no pattern catches: DB text + where the icon went
//   node tools/card-scan/needs-ocr.mjs --list           every flagged card and the patterns that caught it
//
// Adding a pattern: copy an entry in PATTERNS, give it an id, the icon it detects, a regex, and real card text
// in `flags` (must match) and `passes` (must not). `--check` (part of pnpm test) fails if an example breaks.
// Then `--missed` should shrink and `--pattern <id>` should show only real gaps.
//
// Last full scan: 164/164 icon-fix cards caught. close / mismatch / db-suspect cards are OCR trouble, not DB
// gaps, so nothing in the DB text predicts them — the full scan still runs.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// permanentsOnly: skip actions and songs (their text is all commands, no costs)
export const PATTERNS = [
  {
    id: 'stat-mod', icon: 'stat', why: '+N / -N with no stat',
    rx: /(?<!(?:Challenger|Resist|Singer|Boost|Shift)[>}]?)(?:^|\s)[+-] ?\d+(?!\d)(?! ?\{)(?! (?:cost|card|damage|lore|more|less|other))/,
    flags: ['When you play this character, chosen character gets +1 this turn.', 'Chosen character gets - 2 this turn.'],
    passes: ['Chosen character gains Challenger +3 this turn.', 'Your Floodborn characters gain <Challenger> +1.', 'Your other characters gain {Resist} +1.', 'gets +1 {strength} this turn'],
  },
  {
    id: 'stat-with', icon: 'stat', why: 'with N or more, no stat',
    rx: /\bwith (?!cost)\d+(?!\d)(?: or (?:more|less))?(?! ?\{)(?! (?:cost|damage|cards?|lore))/,
    flags: ['Banish chosen opposing character with 2 or less.'],
    passes: ['Chosen character with 10 {S} or more gets +3 {L} this turn.', 'a character with cost 2 or less', 'with 5 {strength} or more'],
  },
  {
    id: 'stat-equal', icon: 'stat', why: 'equal to the ___',
    rx: /\bequal to (?:the|her|his|their|its) (?:of\b|[,.])/,
    flags: ['gain lore equal to the of a character card in your discard', 'gain lore equal to her , to a maximum of 6 lore.'],
    passes: ['gain lore equal to her {strength}.', 'equal to the number of cards in your hand'],
  },
  {
    id: 'stat-possessive', icon: 'stat', why: "characters' ___",
    rx: /\bcharacters' (?!\{)/,
    flags: ["Your characters' can't be reduced below their printed value."],
    passes: ["Your characters' {strength} can't be reduced"],
  },
  {
    id: 'ink-pay', icon: 'ink', why: 'pay N, no {ink}',
    rx: /\bpay \d+(?!\d)(?! ?\{)/,
    flags: ['you may pay 2 to draw a card.'],
    passes: ['you may pay 2 {ink} to draw a card.', 'you may pay 12 {ink}'],
  },
  {
    id: 'ink-less', icon: 'ink', why: 'N less / more, no {ink}',
    rx: /\b\d+ (?:less|more)\b(?! \{)(?! (?:than|cards?|damage|lore))/,
    flags: ['You pay 1 less for the next character you play this turn.'],
    passes: ['You pay 1 {ink} less', 'if you have 2 more cards than', '2 more damage'],
  },
  {
    id: 'ink-cost', icon: 'ink', why: 'N , (cost)',
    rx: /(?:^|\s)\d+ ,/,
    flags: ['2 , Banish this item — Chosen character gains Rush this turn.'],
    passes: ['{exert}, 2 {ink} — Draw a card.'],
  },
  {
    id: 'exert-cost', icon: 'exert', why: 'cost starts with , — ?',
    rx: /^\s*(?:[,—-]\s*\S|\? ?—|\d+ ?[—-])/,
    flags: ['— Draw a card.', '? — Draw a card.', ', 3 — If you have no cards in your hand, draw a card.', '3 — Return this item to your hand.'],
    passes: [',', '{exert} — Draw a card.', 'Whenever you play a song, draw a card.'],
  },
  {
    id: 'exert-granted', icon: 'exert', why: 'gain " — (granted ability)',
    rx: /\bgains? "\s*—/,
    flags: ['Characters gain " — Draw a card" while here.'],
    passes: ['Characters gain "{exert} — Draw a card" while here.'],
  },
  {
    // a character / item / location ability that opens with a bare command lost its whole "{exert} — " cost;
    // one that still has its " — " cost dash is fine
    id: 'exert-command', icon: 'exert', why: 'command with no cost', permanentsOnly: true,
    rx: /^(?!.*\s[—-]\s)\s*(?:Draw|Remove|Deal|Banish|Return|Gain|Look|Put|Ready|Exert|Move|Play|Shuffle|Reveal|Search|Choose|Chosen)\b/,
    flags: ['Remove up to 1 damage from each of your characters.'],
    passes: ['Banish this item — Chosen character gains Rush this turn.', 'Banish this item - Remove up to 3 damage from chosen character.', 'Whenever this character quests, draw a card.'],
  },
];

// dreamborn often runs the ability name into the text: "MAGIC HAIR — Remove…", "YAAA-HOO , Banish…"
const INLINE_NAME = /^(?:[A-Z0-9][A-Z0-9'’!?.&-]* )+(?=[—,-]|\d|\?|\{|[A-Z][a-z])/;
// …and sometimes runs two abilities into one string: "…gains Evasive. GROUNDED 3 — Return this item…"
const MERGED = /\s(?=(?:[A-Z][A-Z'’!?.&-]+ )+(?:\d+ ?)?[—-]\s)/;
const stripName = (t) => { const m = t.match(INLINE_NAME); return m && m[0].trim().length >= 3 ? t.slice(m[0].length) : t; };
export const abilityParts = (texts) => texts.flatMap((t) => String(t ?? '').replace(/\([^)]*\)/g, '').split(MERGED)).map((t) => stripName(t.trim()));

// ability texts + card type → [{ id, icon, why, match }] (empty = the DB text looks complete)
export function needsOcr(texts, type = '') {
  const spell = /action|song/i.test(type);
  const parts = abilityParts(texts);
  const out = [];
  for (const p of PATTERNS) {
    if (p.permanentsOnly && spell) continue;
    const hit = parts.map((t) => t.match(p.rx) && t).find(Boolean);
    if (hit) out.push({ id: p.id, icon: p.icon, why: p.why, match: hit });
  }
  return out;
}

// every pattern against its own examples → list of failures
export function checkPatterns() {
  const bad = [];
  const ids = new Set();
  for (const p of PATTERNS) {
    if (ids.has(p.id)) bad.push(`${p.id}: duplicate id`);
    ids.add(p.id);
    if (!p.flags?.length) bad.push(`${p.id}: needs at least one \`flags\` example`);
    for (const t of p.flags || []) if (!abilityParts([t]).some((x) => p.rx.test(x))) bad.push(`${p.id}: should flag  "${t}"`);
    for (const t of p.passes || []) if (abilityParts([t]).some((x) => p.rx.test(x))) bad.push(`${p.id}: should pass  "${t}"`);
  }
  return bad;
}

// every unique card in cards.db → { flags: [{ id, icon, why, match }], texts: [each printing's DB text] }
export async function flagCards(dbFile) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const cards = new Map();
  for (const r of db.prepare("SELECT name, title, type, abilities FROM cards WHERE language = 'en' ORDER BY id").all()) {
    const full = r.title ? `${r.name} - ${r.title}` : r.name;
    let abs = [];
    try { abs = (JSON.parse(r.abilities || '[]') || []).map((a) => a.description ?? a.text ?? ''); } catch {}
    const c = cards.get(full) || cards.set(full, { flags: [], texts: [] }).get(full);
    c.texts.push(abs.join(' / '));
    // any printing's text can be the broken one (Beast's Mirror: set 1 lost its whole cost, set 9 only the icons)
    for (const f of needsOcr(abs, r.type)) if (!c.flags.some((x) => x.id === f.id)) c.flags.push(f);
  }
  db.close();
  return cards;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1] ?? ''; };
  const bad = checkPatterns();
  if (bad.length) { console.error(`✗ ${bad.length} pattern example(s) broken:\n  ${bad.join('\n  ')}`); process.exit(1); }
  if (process.argv.includes('--check')) { console.log(`✓ ${PATTERNS.length} patterns match their examples`); process.exit(0); }

  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const all = await flagCards(path.join(ROOT, 'cache/cards.db'));
  const seen = new Map([...all].map(([k, c]) => [k, c.flags]));      // card → [{ id, icon, why, match }]
  const texts = new Map([...all].map(([k, c]) => [k, c.texts]));     // card → every printing's DB text
  const RESULTS = path.join(ROOT, 'cache/scan/results.jsonl');
  const scan = existsSync(RESULTS) ? new Map(readFileSync(RESULTS, 'utf8').trim().split('\n').map(JSON.parse).map((r) => [r.full, r])) : null;
  const isFix = (k) => scan?.get(k)?.status === 'icon-fix';
  const flagged = [...seen].filter(([, f]) => f.length);

  const one = arg('--pattern');
  if (one != null) {
    const p = PATTERNS.find((x) => x.id === one);
    if (!p) { console.error(`no pattern "${one}" — ids: ${PATTERNS.map((x) => x.id).join(', ')}`); process.exit(1); }
    const rows = flagged.filter(([, f]) => f.some((x) => x.id === one));
    console.log(`${one} (${p.why}): ${rows.length} cards${scan ? `, ${rows.filter(([k]) => isFix(k)).length} confirmed by the scan` : ''}`);
    for (const [k, f] of rows) {
      const m = f.find((x) => x.id === one).match;
      console.log(`  ${scan ? (isFix(k) ? '✓' : '·') : ' '} ${k.padEnd(44)} ${m.replace(p.rx, (s) => `[${s}]`).slice(0, 110)}`);
    }
    if (scan) console.log('  ✓ = the scan found a missing icon · = scan read a clean printing (or another problem)');
    process.exit(0);
  }

  console.log(`needs OCR: ${flagged.length} of ${seen.size} cards\n`);
  console.log(`  ${'pattern'.padEnd(18)}${'icon'.padEnd(7)}${'cards'.padStart(6)}${scan ? `${'scan ✓'.padStart(8)}` : ''}  what`);
  for (const p of PATTERNS) {
    const rows = flagged.filter(([, f]) => f.some((x) => x.id === p.id));
    console.log(`  ${p.id.padEnd(18)}${p.icon.padEnd(7)}${String(rows.length).padStart(6)}${scan ? String(rows.filter(([k]) => isFix(k)).length).padStart(8) : ''}  ${p.why}`);
  }
  if (scan) {
    const fixes = [...scan.values()].filter((r) => r.status === 'icon-fix');
    const missed = fixes.filter((r) => !seen.get(r.full)?.length);
    console.log(`\nvs last scan: ${fixes.length - missed.length}/${fixes.length} icon-fix cards caught · ${flagged.filter(([k]) => !isFix(k)).length} flagged where the scan read a clean printing · ${missed.length} missed`);
    if (process.argv.includes('--missed')) {
      for (const r of missed) {
        console.log(`\n  ${r.full} (${r.type})`);
        for (const t of texts.get(r.full) || []) console.log(`    DB:   ${t.slice(0, 140)}`);
        for (const f of r.fixes) console.log(`    icon: ${f.icons.join(' ')} after "${f.after}"${f.opensAbility ? ' (opens the ability)' : ''}`);
      }
    } else if (missed.length) console.log(`  run with --missed to see them`);
  }
  if (process.argv.includes('--list')) for (const [k, f] of flagged) console.log(`${k}  ←  ${f.map((x) => x.id).join(', ')}`);
}
