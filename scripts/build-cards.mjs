#!/usr/bin/env node
// Card build: scan only what needs it → rulings.db → proc.db.
//
//   node scripts/build-cards.mjs           scan flagged cards not scanned yet, build, then scan + rebuild stuck ones
//   node scripts/build-cards.mjs --all     rescan every card first (the old full run, ~2.5 min on 12 jobs)
//   node scripts/build-cards.mjs --no-scan build from the scan results already in cache/scan/results.jsonl
//
// 1. needs-ocr.mjs flags cards whose DB text dropped an icon; those and every card in corrections.json
//    (the scan is what applies it) get scanned if they have no scan result yet.
// 2. build-rulings.mjs + compile-procs.mjs.
// 3. A ruling that compiled to a manual proc on a card that was never scanned may just be bad DB text:
//    scan those cards too, then build once more. Results accumulate in results.jsonl, so each card is
//    scanned once until --all.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagCards } from '../tools/card-scan/needs-ocr.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = (f) => path.join(ROOT, 'cache', f);
const RESULTS = C('scan/results.jsonl');
const TODO = C('scan/todo.txt');
const all = process.argv.includes('--all'), noScan = process.argv.includes('--no-scan');

const run = (cmd, args, quiet = false) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', quiet ? 'ignore' : 'inherit', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  if (r.status !== 0) { console.error(`build-cards: \`${cmd} ${args.join(' ')}\` failed`); process.exit(1); }
};
const scanned = () => new Set(existsSync(RESULTS) ? readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).full) : []);
const scan = (names, why) => {
  if (!names.length) return console.error(`build-cards: ${why}: nothing to scan`);
  console.error(`build-cards: ${why}: scanning ${names.length} card${names.length === 1 ? '' : 's'}…`);
  writeFileSync(TODO, names.join('\n') + '\n');
  run('uv', ['run', 'tools/card-scan/scan.py', '--jobs', '12', '--names-file', TODO], true);
};
const build = () => { run('node', ['tools/build-rulings.mjs'], true); run('node', ['tools/compile-procs.mjs'], true); };

if (!existsSync(C('cards.db'))) { console.error('cache/cards.db missing — start the server once to download it'); process.exit(1); }

if (all) {
  console.error('build-cards: --all: scanning every card…');
  run('uv', ['run', 'tools/card-scan/scan.py', '--jobs', '12'], true);
} else if (!noScan) {
  const done = scanned();
  const flagged = [...await flagCards(C('cards.db'))].filter(([, c]) => c.flags.length).map(([k]) => k);
  // corrections.json is applied by the scan, so a corrected card has to go through it
  const corrected = Object.keys(JSON.parse(readFileSync(path.join(ROOT, 'tools/card-scan/corrections.json'), 'utf8'))).filter((k) => k !== '_doc');
  const want = [...new Set([...flagged, ...corrected])].filter((k) => !done.has(k)).sort();
  scan(want, `${flagged.length} cards flagged by needs-ocr + ${corrected.length} with corrections`);
}
build();

if (!noScan) {
  // manual rulings on cards the scan never looked at (keyword-only cards have no text on the card to read)
  const db = new DatabaseSync(C('rulings.db'), { readOnly: true });
  db.exec(`ATTACH DATABASE '${C('proc.db')}' AS p`);
  const stuck = db.prepare(`SELECT DISTINCT c.card_key FROM rulings r JOIN cards c USING (card_key) JOIN p.procs USING (proc_id)
    WHERE procs.exec = 0 AND c.scan_status IS NULL AND c.source != 'keywords' ORDER BY c.card_key`).all().map((r) => r.card_key);
  db.close();
  if (stuck.length) {
    scan(stuck, `${stuck.length} unscanned cards stuck in compiling`);
    build();
  }
}

const db = new DatabaseSync(C('rulings.db'), { readOnly: true });
db.exec(`ATTACH DATABASE '${C('proc.db')}' AS p`);
const q = (sql) => db.prepare(sql).get();
const cards = q('SELECT count(*) n, sum(scan_status IS NOT NULL) scanned FROM cards');
const ab = q('SELECT count(*) n, sum(procs.exec) ok FROM rulings JOIN p.procs USING (proc_id)');
const blocked = q('SELECT count(DISTINCT card_key) n FROM rulings JOIN p.procs USING (proc_id) WHERE procs.exec = 0').n;
const stillStuck = q(`SELECT count(DISTINCT c.card_key) n FROM rulings r JOIN cards c USING (card_key) JOIN p.procs USING (proc_id)
  WHERE procs.exec = 0 AND c.scan_status IS NULL AND c.source != 'keywords'`).n;
db.close();
const pct = (a, b) => ((100 * a) / b).toFixed(1);
console.log(`cards:     ${cards.n} (${cards.scanned} scanned)`);
console.log(`abilities: ${ab.ok}/${ab.n} runnable (${pct(ab.ok, ab.n)}%)`);
console.log(`cards:     ${cards.n - blocked}/${cards.n} fully runnable (${pct(cards.n - blocked, cards.n)}%)`);
if (stillStuck) console.log(`⚠ ${stillStuck} manual cards have no scan result (no card image?)`);
