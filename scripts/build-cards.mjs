#!/usr/bin/env node
// Card build in rounds: check the DB text → OCR what it flags → compile → OCR what got stuck → compile → …
//
//   node scripts/build-cards.mjs             rounds until no stuck card is left unscanned (max 5)
//   node scripts/build-cards.mjs --all       rescan every card first (the old full run, ~2.5 min on 12 jobs)
//   node scripts/build-cards.mjs --no-scan   build once from the scan results already in cache/scan/results.jsonl
//
// round 1  DB check: needs-ocr.mjs flags cards whose DB text dropped an icon; those and every card in
//          corrections.json (the scan is what applies it) get OCR'd, then build-rulings + compile-procs.
// round 2+ stuck: a card with a manual ruling that was never OCR'd may just have bad DB text — OCR those,
//          build again. Stops when a round has nothing new to OCR. Results accumulate in results.jsonl, so
//          a card is OCR'd once until --all.

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
  if (!names.length) return console.error(`build-cards: ${why}: nothing new to OCR`);
  console.error(`build-cards: ${why}: scanning ${names.length} card${names.length === 1 ? '' : 's'}…`);
  writeFileSync(TODO, names.join('\n') + '\n');
  run('uv', ['run', 'tools/card-scan/scan.py', '--jobs', '12', '--names-file', TODO], true);
};
const build = () => { run('node', ['tools/build-rulings.mjs'], true); run('node', ['tools/compile-procs.mjs'], true); };

if (!existsSync(C('cards.db'))) { console.error('cache/cards.db missing — start the server once to download it'); process.exit(1); }

const STUCK = `SELECT DISTINCT c.card_key FROM rulings r JOIN cards c USING (card_key) JOIN p.procs USING (proc_id)
  WHERE procs.exec = 0 AND c.scan_status IS NULL AND c.source != 'keywords' ORDER BY c.card_key`;   // keyword-only cards have no text to read
const state = () => {
  const db = new DatabaseSync(C('rulings.db'), { readOnly: true });
  db.exec(`ATTACH DATABASE '${C('proc.db')}' AS p`);
  const cards = db.prepare('SELECT count(*) n FROM cards').get().n;
  const blocked = db.prepare('SELECT count(DISTINCT card_key) n FROM rulings JOIN p.procs USING (proc_id) WHERE procs.exec = 0').get().n;
  const stuck = db.prepare(STUCK).all().map((r) => r.card_key);
  db.close();
  return { runnable: cards - blocked, stuck };
};
const rounds = [];
const round = (why, names) => {
  scan(names, `round ${rounds.length + 1} (${why})`);
  build();
  const st = state();
  rounds.push({ why, ocr: names.length, ...st });
  return st;
};

if (all) {
  console.error('build-cards: --all: scanning every card…');
  run('uv', ['run', 'tools/card-scan/scan.py', '--jobs', '12'], true);
  round('full scan', []);
} else if (noScan) {
  round('no scan', []);
} else {
  const done = scanned();
  const flagged = [...await flagCards(C('cards.db'))].filter(([, c]) => c.flags.length).map(([k]) => k);
  // corrections.json is applied by the scan, so a corrected card has to go through it
  const corrected = Object.keys(JSON.parse(readFileSync(path.join(ROOT, 'tools/card-scan/corrections.json'), 'utf8'))).filter((k) => k !== '_doc');
  let st = round(`DB check: ${flagged.length} flagged + ${corrected.length} corrected`, [...new Set([...flagged, ...corrected])].filter((k) => !done.has(k)).sort());
  // a card the scan can't read (not in its pool) stays stuck — try each card once, so the rounds always end
  const tried = new Set();
  for (let next = st.stuck; next.length && rounds.length < 5; next = st.stuck.filter((k) => !tried.has(k))) {
    next.forEach((k) => tried.add(k));
    st = round(`${next.length} stuck, never OCR'd`, next);
  }
}

console.log('round  OCR\'d  runnable  stuck   why');
for (const [i, r] of rounds.entries()) console.log(`${String(i + 1).padStart(5)}  ${String(r.ocr).padStart(5)}  ${String(r.runnable).padStart(8)}  ${String(r.stuck.length).padStart(5)}   ${r.why}`);

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
