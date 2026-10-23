#!/usr/bin/env node
// The compiler's learning loop. Compiles every ability in cache/sanitized.db in-process, then:
//
//   1. templates  every miss's fragment with the card-specific words abstracted away — card names → <NAME>,
//                 classifications → <CLASS>, card types → <TYPE>, numbers → N, stats → {STAT} — so
//                 "Your Pirate characters get +2 {strength}" and "Your Hero characters get +1 {lore}" are one
//                 template. The same mechanic in different words / querying different things clusters together.
//   2. ranks      templates by how many cards they'd finish (cards whose every miss is that template)
//   3. hints      for each template, the closest sentence the compiler already reads — the rule to generalise
//   4. diffs      against the last accepted run (cache/learn/baseline.json): abilities gained, lost (regressions),
//                 and runnable procs whose JSON changed (behaviour changes to look at)
//
//   node scripts/learn.mjs                 ranked templates + diff vs baseline
//   node scripts/learn.mjs --show <n>      every ability behind template #n
//   node scripts/learn.mjs --top 40        more templates
//   node scripts/learn.mjs --accept        make this run the baseline (only with no regressions, or --force) + rebuild proc.db
//                                          + sync the review ledger (scripts/verify/ledger.jsonl)
//   node scripts/learn.mjs --features      the engine-feature backlog: every miss sorted into the mechanic it needs
//                                          (game/rulebook/features.js), ranked by cards it would finish, with the
//                                          rulebook section to build it to (--features <id> lists its cards)
//
// The loop: run → pick the top template → generalise the class that owns it (an effects/ / triggers/ /
// conditions/ / classifiers/ rule) → run again → no regressions? → --accept → repeat.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileAbility } from '../game/procs/index.js';
import { FEATURES, featureOf } from '../game/rulebook/features.js';
import { quote } from '../game/rulebook/cr.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'cache/sanitized.db');
const BASE = path.join(ROOT, 'cache/learn/baseline.json');
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const flag = (k) => process.argv.includes(k);

// ---- compile everything ----
const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare('SELECT r.card_key, r.idx, r.name, r.text, c.type FROM rulings r JOIN rules c USING (card_key) ORDER BY r.card_key, r.idx').all();
const cardNames = db.prepare('SELECT DISTINCT name FROM rules').all().map((r) => r.name);
const classes = [...new Set(db.prepare('SELECT classes FROM rules WHERE classes IS NOT NULL').all().flatMap((r) => JSON.parse(r.classes)))];
db.close();

const procs = rows.map((r) => {
  const p = compileAbility({ name: r.name || '', text: r.text }, r.type);
  const { name, text, ...body } = p;
  return { key: `${r.card_key}#${r.idx}`, card: r.card_key, text: r.text, p, hash: createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12) };
});

// ---- templates ----
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME_RX = new RegExp(`\\b(?:${cardNames.filter((n) => n.length > 3).sort((a, b) => b.length - a.length).map(esc).join('|')})\\b`, 'g');
const CLASS_RX = new RegExp(`\\b(?:${classes.sort((a, b) => b.length - a.length).map(esc).join('|')})\\b`, 'gi');
export function template(s) {
  return String(s)
    .replace(NAME_RX, '<NAME>').replace(CLASS_RX, '<CLASS>')
    .replace(/\{(?:strength|willpower|lore)\}/g, '{STAT}')
    .replace(/\b(?:characters?|items?|locations?|actions?|songs?)\b/gi, '<TYPE>')
    .replace(/[+-]?\b\d+\b/g, 'N').replace(/\b(?:a|an|one|two|three|four|five)\b(?= <|\s+\w+ <)/gi, 'N')
    .replace(/(?:<CLASS>(?:,? (?:or|and) |, ))+<CLASS>/g, '<CLASS>')
    .replace(/\s+/g, ' ').trim();
}
const reasonOf = (p) => {
  const w = String(p.why || '');
  const m = w.match(/^([a-z ]+): "([\s\S]*)"$/i);
  return m ? { where: m[1], frag: m[2] } : { where: w.replace(/:.*/, ''), frag: w.replace(/^[^:]*:\s*/, '') };
};
const bad = procs.filter((x) => !x.p.exec);
const groups = new Map();
for (const x of bad) {
  const r = reasonOf(x.p);
  const k = `${r.where} · ${template(r.frag)}`;
  (groups.get(k) || groups.set(k, { k, items: [] }).get(k)).items.push({ ...x, frag: r.frag });
}
const badByCard = new Map();
for (const x of bad) (badByCard.get(x.card) || badByCard.set(x.card, []).get(x.card)).push(x);
for (const g of groups.values()) {
  const cards = new Set(g.items.map((x) => x.card));
  g.cards = cards.size;
  g.finishes = [...cards].filter((c) => badByCard.get(c).every((x) => g.items.includes(x) || groups.get(g.k).items.some((y) => y.key === x.key))).length;
}
const ranked = [...groups.values()].sort((a, b) => b.finishes - a.finishes || b.items.length - a.items.length || a.k.localeCompare(b.k));

// ---- hints: the nearest sentence the compiler already reads ----
const toks = (s) => new Set(template(s).toLowerCase().match(/<[a-z]+>|\{[a-z]+\}|[a-z']+/g) || []);
const known = [];
for (const x of procs) if (x.p.exec && x.p.kind !== 'keyword' && x.p.kind !== 'reminder') for (const s of x.text.replace(/\([^)]*\)/g, '').split(/(?<=[.!])\s+/)) known.push({ s, t: toks(s) });
function hint(frag) {
  const A = toks(frag);
  let best = null, score = 0;
  for (const k of known) {
    let common = 0; for (const w of A) if (k.t.has(w)) common++;
    const sc = common / (A.size + k.t.size - common || 1);
    if (sc > score) { best = k.s; score = sc; }
  }
  return best && score >= 0.3 ? `${best}  (${Math.round(score * 100)}%)` : null;
}

// ---- diff vs baseline ----
const now = Object.fromEntries(procs.map((x) => [x.key, { exec: !!x.p.exec, hash: x.hash }]));
const base = existsSync(BASE) ? JSON.parse(readFileSync(BASE, 'utf8')) : null;
const gained = [], lost = [], changed = [];
if (base) {
  for (const [k, v] of Object.entries(now)) {
    const b = base.procs[k];
    if (!b) continue;
    if (v.exec && !b.exec) gained.push(k);
    else if (!v.exec && b.exec) lost.push(k);
    else if (v.exec && b.exec && v.hash !== b.hash) changed.push(k);
  }
}
const cardsAll = new Set(procs.map((x) => x.card));
const cardsOk = [...cardsAll].filter((c) => !badByCard.has(c)).length;

// ---- report ----
const show = arg('--show');
if (show != null) {
  const g = ranked[Number(show) - 1];
  if (!g) { console.error(`no template #${show}`); process.exit(1); }
  console.log(`#${show}  ${g.k}\n  ${g.items.length} abilities · ${g.cards} cards · finishes ${g.finishes}\n`);
  for (const x of g.items) console.log(`  ${x.card}\n    miss: ${x.frag}\n    text: ${x.text}\n`);
  process.exit(0);
}
// ---- the engine-feature backlog ----
if (flag('--features')) {
  const by = new Map(FEATURES.map((f) => [f.id, { f, items: [] }]));
  by.set('other', { f: { id: 'other', cr: '', build: 'no feature matched — a phrasing for the compiler (see the templates)' }, items: [] });
  for (const x of bad) by.get(featureOf(x.text)?.id || 'other').items.push(x);
  for (const g of by.values()) {
    const cards = new Set(g.items.map((x) => x.card));
    g.cards = cards.size;
    g.finishes = [...cards].filter((c) => badByCard.get(c).every((x) => g.items.includes(x))).length;
  }
  const one = arg('--features');
  if (one && by.has(one)) {
    const g = by.get(one);
    console.log(`${g.f.id} · CR ${g.f.cr} — ${g.f.cr ? quote(g.f.cr, 300) : ''}\n  build: ${g.f.build}\n`);
    for (const x of g.items) console.log(`  ${x.card}\n    ${x.text}\n`);
    process.exit(0);
  }
  const list = [...by.values()].filter((g) => g.items.length).sort((a, b) => (a.f.id === 'other') - (b.f.id === 'other') || b.finishes - a.finishes || b.items.length - a.items.length);
  console.log(`engine-feature backlog — ${bad.length} abilities on ${badByCard.size} cards\n\n  finish  abil  feature           CR       build`);
  for (const g of list) console.log(`  ${String(g.finishes).padStart(6)}  ${String(g.items.length).padStart(4)}  ${g.f.id.padEnd(16)}  ${(g.f.cr || '').padEnd(7)}  ${g.f.build.slice(0, 110)}`);
  process.exit(0);
}
const pct = (a, b) => ((100 * a) / b).toFixed(1);
console.log(`abilities ${procs.length - bad.length}/${procs.length} runnable (${pct(procs.length - bad.length, procs.length)}%) · cards ${cardsOk}/${cardsAll.size} fully runnable (${pct(cardsOk, cardsAll.size)}%) · ${groups.size} templates`);
if (base) {
  const d = cardsOk - base.cardsOk;
  console.log(`vs baseline: ${d >= 0 ? '+' : ''}${d} cards · +${gained.length} abilities · −${lost.length} lost · ${changed.length} runnable procs changed`);
  for (const k of lost.slice(0, 20)) console.log(`  ✗ LOST ${k}: ${procs.find((x) => x.key === k).p.why}`);
  if (flag('--changed')) for (const k of changed.slice(0, 40)) console.log(`  ~ ${k}`);
}
const top = Number(arg('--top') || 25);
console.log('\n   #  finish  abil  where · template');
ranked.slice(0, top).forEach((g, i) => {
  console.log(`${String(i + 1).padStart(4)}  ${String(g.finishes).padStart(6)}  ${String(g.items.length).padStart(4)}  ${g.k.slice(0, 120)}`);
  const h = flag('--hints') ? hint(g.items[0].frag) : null;
  if (h) console.log(`              ≈ ${h.slice(0, 120)}`);
});
if (flag('--accept')) {
  if (lost.length && !flag('--force')) { console.error(`\nnot accepted: ${lost.length} regressions (fix them, or --force)`); process.exit(1); }
  mkdirSync(path.dirname(BASE), { recursive: true });
  writeFileSync(BASE, JSON.stringify({ at: new Date().toISOString(), cardsOk, procs: now }));
  console.log(`\naccepted → ${path.relative(ROOT, BASE)}`);
  // the engine and the tests read the compiled proc.db — rebuild it so they see what was accepted
  const r = spawnSync(process.execPath, ['tools/compile-procs.mjs'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  if (r.status !== 0) process.exit(1);
  // the review ledger: new abilities are listed, reviewed ones whose proc changed go back to be reviewed (scripts/verify/)
  spawnSync(process.execPath, ['scripts/verify/ledger.mjs', '--sync'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
}
