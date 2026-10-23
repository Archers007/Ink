// The review ledger: for every runnable ability, has someone checked that its proc means what the card says?
// One line per ability in scripts/verify/ledger.jsonl (tracked in git), keyed by card#index:
//   { key, text (hash of the canonical text), proc (hash of the compiled proc), status, note?, by?, at? }
//   status: unreviewed · ok (the read-back matches the card) · approx (runs, with a known shortcut — note says which)
//           · wrong (a misread to fix) · stale (it was reviewed, then its text or proc changed — review again)
//
//   node scripts/verify/ledger.mjs                 check: every ability is listed, nothing stale or wrong; counts
//   node scripts/verify/ledger.mjs --sync          add new abilities, mark changed reviewed ones stale
//   node scripts/verify/ledger.mjs --next 20       the next unreviewed (riskiest first), with text and read-back
//   node scripts/verify/ledger.mjs --mark <key> ok|approx|wrong [note] [--by name]
//   node scripts/verify/ledger.mjs --import <file.jsonl>   apply {key, status, note, by} lines from a review pass
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { explain } from '../../game/procs/index.js';
import { canon, stripReminders } from '../../game/procs/normalize.js';
import { runnable } from './corpus.mjs';

const FILE = new URL('./ledger.jsonl', import.meta.url);
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const h = (x) => createHash('sha1').update(x).digest('hex').slice(0, 12);
const body = (p) => { const { name, text, exec, why, at, ...b } = p; return JSON.stringify(b); };
const STATUSES = new Set(['unreviewed', 'ok', 'approx', 'wrong', 'stale']);

const load = () => (existsSync(FILE) ? readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const save = (rows) => writeFileSync(FILE, `${rows.sort((a, b) => (a.key < b.key ? -1 : 1)).map((r) => JSON.stringify(r)).join('\n')}\n`);
const current = new Map(runnable().filter((x) => x.p.kind !== 'reminder').map((x) => [x.key, { x, text: h(stripReminders(canon(x.text))), proc: h(body(x.p)) }]));

// how much could go wrong in an ability — review the riskiest first
const risk = (p) => { const j = JSON.stringify(p); return (j.match(/"(?:ifDid|linked|otherwise|cond|instead|repeat|ref|nOf|whileCond|of|trig)"/g) || []).length * 2 + (p.do?.length || 0) + (p.kind === 'keyword' ? -10 : 0); };

function sync(rows) {
  const by = new Map(rows.map((r) => [r.key, r]));
  let added = 0; let staled = 0; let dropped = 0;
  for (const [key, c] of current) {
    const r = by.get(key);
    if (!r) { by.set(key, { key, text: c.text, proc: c.proc, status: c.x.p.kind === 'keyword' ? 'ok' : 'unreviewed', ...(c.x.p.kind === 'keyword' ? { by: 'keyword line', note: 'keywords are read from the keyword table, not phrased text' } : {}) }); added++; continue; }
    if (r.text !== c.text || r.proc !== c.proc) {
      if (r.status !== 'unreviewed' && r.by !== 'keyword line') { r.prev = r.status; r.status = 'stale'; staled++; }
      r.text = c.text; r.proc = c.proc;
    }
  }
  for (const key of by.keys()) if (!current.has(key)) { by.delete(key); dropped++; }
  save([...by.values()]);
  console.log(`ledger: +${added} new, ${staled} now stale (reviewed, then changed), ${dropped} gone`);
}

const rows = load();
if (process.argv.includes('--sync')) { sync(rows); process.exit(0); }
if (process.argv.includes('--mark') || process.argv.includes('--import')) {
  const by = new Map(rows.map((r) => [r.key, r]));
  const marks = process.argv.includes('--import')
    ? readFileSync(arg('--import'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [{ key: arg('--mark'), status: process.argv[process.argv.indexOf('--mark') + 2], note: process.argv[process.argv.indexOf('--mark') + 3], by: arg('--by') || 'reviewer' }];
  let n = 0;
  for (const m of marks) {
    const r = by.get(m.key);
    if (!r) { console.log(`  no ability ${m.key}`); continue; }
    if (!STATUSES.has(m.status) || m.status === 'stale' || m.status === 'unreviewed') { console.log(`  ${m.key}: status must be ok, approx or wrong`); continue; }
    if (m.proc && m.proc !== r.proc) { console.log(`  ${m.key}: reviewed an older proc — skipped`); continue; }
    Object.assign(r, { status: m.status, by: m.by || 'reviewer', at: new Date().toISOString().slice(0, 10) });
    delete r.prev;
    if (m.note) r.note = m.note; else delete r.note;
    n++;
  }
  save([...by.values()]);
  console.log(`ledger: ${n} marked`);
  process.exit(0);
}
if (arg('--next')) {
  const n = +arg('--next');
  const todo = rows.filter((r) => r.status === 'unreviewed' || r.status === 'stale').map((r) => ({ r, c: current.get(r.key) })).filter((y) => y.c)
    .sort((a, b) => risk(b.c.x.p) - risk(a.c.x.p) || (a.r.key < b.r.key ? -1 : 1)).slice(0, n);
  for (const { r, c } of todo) console.log(JSON.stringify({ key: r.key, proc: r.proc, status: r.status, text: c.x.text, readback: explain(c.x.p) }));
  process.exit(0);
}
// check
const by = new Map(rows.map((r) => [r.key, r]));
const missing = [...current.keys()].filter((k) => !by.has(k));
const changed = [...current].filter(([k, c]) => by.has(k) && (by.get(k).text !== c.text || by.get(k).proc !== c.proc)).map(([k]) => k);
const count = {}; for (const r of rows) count[r.status] = (count[r.status] || 0) + 1;
console.log(`ledger: ${rows.length} abilities · ${Object.entries(count).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
const bad = [...missing.map((k) => `${k}: not in the ledger (run --sync)`), ...changed.map((k) => `${k}: text or proc changed since the ledger (run --sync)`),
  ...rows.filter((r) => r.status === 'stale').map((r) => `${r.key}: changed after it was reviewed ${r.prev} — review again`),
  ...rows.filter((r) => r.status === 'wrong').map((r) => `${r.key}: reviewed wrong — ${r.note || ''}`)];
for (const b of bad.slice(0, 30)) console.log(`  ✗ ${b}`);
console.log(bad.length ? `ledger: ${bad.length} to deal with` : 'ledger: OK — nothing stale, nothing marked wrong');
process.exitCode = bad.length ? 1 : 0;
