#!/usr/bin/env node
// Card build: dreamborn's printings + Ravensburger's card data → cache/sanitized.db → compiled procs in cache/proc.db.
//
//   node scripts/build-cards.mjs             import + compile (downloads what's missing)
//   node scripts/build-cards.mjs --refresh   re-read cards.disneylorcana.com first
//
// 1. cache/dreamborn.db   dreamborn.ink's cards.db (printing ids, sets, rarity — decks / collections / prices key on it)
// 2. tools/import-cards.mjs   merges Ravensburger's catalog onto it: sanitized.db `cards` (dreamborn's shape, official
//    values), `rules` (one row per card: flavour, FAQ), `rulings` (one per ability), `diffs` (what it corrected)
// 3. tools/compile-procs.mjs  rulings → proc.db, proc_id filled in
// Deterministic: same inputs → same rows. tools/card-scan/scan.py can still check the result against card images.

import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = (f) => path.join(ROOT, 'cache', f);
const DREAMBORN_DB_URL = 'https://dreamborn.ink/cache/en/cards.db';

const run = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  if (r.status !== 0) { console.error(`build-cards: \`node ${args.join(' ')}\` failed`); process.exit(1); }
};

if (!existsSync(C('dreamborn.db'))) {
  console.error(`build-cards: downloading ${DREAMBORN_DB_URL}…`);
  const res = await fetch(DREAMBORN_DB_URL, { headers: { referer: 'https://dreamborn.ink/builder' } }).catch((e) => ({ ok: false, statusText: e.message }));
  if (!res.ok) { console.error(`build-cards: dreamborn download failed (${res.statusText})`); process.exit(1); }
  writeFileSync(C('dreamborn.db'), Buffer.from(await res.arrayBuffer()));
}
run(['tools/import-cards.mjs', ...(process.argv.includes('--refresh') ? ['--refresh'] : [])]);
run(['tools/compile-procs.mjs']);

const db = new DatabaseSync(C('sanitized.db'), { readOnly: true });
db.exec(`ATTACH DATABASE '${C('proc.db')}' AS p`);
const q = (sql) => db.prepare(sql).get();
const cards = q('SELECT count(*) n FROM rules').n;
const blocked = q('SELECT count(DISTINCT card_key) n FROM rulings JOIN p.procs USING (proc_id) WHERE procs.exec = 0').n;
const sources = db.prepare('SELECT source, count(*) n FROM rules GROUP BY source').all();
db.close();
console.log(`\nsanitized.db:  ${cards} cards (${sources.map((s) => `${s.n} ${s.source}`).join(' · ')}), ${cards - blocked} fully runnable (${((100 * (cards - blocked)) / cards).toFixed(1)}%)`);
