#!/usr/bin/env node
// Build step: cache/cards.db `rulings` (tools/import-cards.mjs) → cache/proc.db, and every ruling's proc_id filled in.
//
//   node tools/compile-procs.mjs            compile + coverage summary
//   node tools/compile-procs.mjs --misses   + the top reasons abilities didn't compile (what to build next)
//
// proc.db `procs` holds one row per distinct proc: proc_id = hash of its JSON, so the same text compiles to the
// same proc and cards that share an ability share a row. The ability's name/text stay on the ruling in cards.db.
// Deterministic: same rulings → same proc ids.

import { existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileAbility } from '../game/procs/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARDS = path.join(ROOT, 'cache/cards.db');
const OUT = path.join(ROOT, 'cache/proc.db');
const showMisses = process.argv.includes('--misses');

if (!existsSync(CARDS)) { console.error('cache/cards.db missing — run `node tools/import-cards.mjs` first.'); process.exit(1); }

rmSync(OUT, { force: true });
const out = new DatabaseSync(OUT);
out.exec(`
  CREATE TABLE procs (
    proc_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,         -- keyword · triggered · activated · static · action · reminder · unparsed
    exec INTEGER NOT NULL,      -- 1 = the engine runs it; 0 = manual
    why TEXT,                   -- why it's manual
    fns TEXT,                   -- step functions it uses, space-separated ("draw mod")
    json TEXT NOT NULL          -- the proc, without the ability's name/text
  );
  CREATE INDEX procs_exec ON procs(exec);
`);
const insProc = out.prepare('INSERT OR IGNORE INTO procs VALUES (?,?,?,?,?,?)');

const rulings = new DatabaseSync(CARDS);
const rows = rulings.prepare('SELECT r.id, r.card_key, r.name, r.text, c.type FROM rulings r JOIN rules c USING (card_key) ORDER BY r.card_key, r.idx').all();
const setProc = rulings.prepare('UPDATE rulings SET proc_id = ? WHERE id = ?');

const fnsOf = (p) => {
  const s = new Set();
  const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (typeof x.fn === 'string') s.add(x.fn); Object.values(x).forEach(walk); } };
  walk(p);
  return [...s].sort().join(' ') || null;
};

const stats = { abilities: 0, exec: 0, kinds: {} };
const cardOk = new Map();
const misses = {};
out.exec('BEGIN'); rulings.exec('BEGIN');
for (const r of rows) {
  const { name, text, ...proc } = compileAbility({ name: r.name || '', text: r.text }, r.type);
  const json = JSON.stringify(proc);
  const id = createHash('sha1').update(json).digest('hex').slice(0, 16);
  insProc.run(id, proc.kind, proc.exec ? 1 : 0, proc.why ?? null, fnsOf(proc), json);
  setProc.run(id, r.id);
  stats.abilities++;
  stats.kinds[proc.kind] = (stats.kinds[proc.kind] || 0) + 1;
  if (proc.exec) stats.exec++;
  else {
    const key = String(proc.why || 'unknown').replace(/"[^"]*"/, (m) => (m.length > 50 ? m.slice(0, 50) + '…"' : m));
    (misses[key] ||= []).push(r.card_key);
  }
  cardOk.set(r.card_key, (cardOk.get(r.card_key) ?? true) && !!proc.exec);
}
out.exec('COMMIT'); rulings.exec('COMMIT');

const cards = rulings.prepare('SELECT count(*) n FROM rules').get().n;
const blocked = [...cardOk.values()].filter((v) => !v).length;   // cards without rulings (vanillas) have nothing to run
const distinct = out.prepare('SELECT count(*) n FROM procs').get().n;
out.close(); rulings.close();

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '0.0');
console.log(`procs → ${path.relative(ROOT, OUT)}  (${distinct} distinct procs for ${stats.abilities} rulings)`);
console.log(`  abilities: ${stats.exec}/${stats.abilities} runnable (${pct(stats.exec, stats.abilities)}%)`);
console.log(`  cards:     ${cards - blocked}/${cards} fully runnable (${pct(cards - blocked, cards)}%)`);
console.log(`  kinds:     ${Object.entries(stats.kinds).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
if (showMisses) {
  console.log('\ntop misses:');
  for (const [k, list] of Object.entries(misses).sort((a, b) => b[1].length - a[1].length).slice(0, 40)) {
    console.log(`${String(list.length).padStart(5)}  ${k}\n         e.g. ${list.slice(0, 2).join(' | ')}`);
  }
}
