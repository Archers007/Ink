// Every official Q&A — the set release notes in docs/rules/ and the per-card FAQ in cache/sanitized.db — with a stable
// id, where it came from, the cards it names and whether they all run. Written to scripts/oracles/qa.json; each
// oracle test (scripts/oracles/*.oracle.mjs) names the Q&A id it checks, and run.mjs reports what's still untested.
//   node scripts/oracles/extract.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadCardIndex, isFullyAutomated, nameKey } from '../../game/cards.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const index = await loadCardIndex(path.join(ROOT, 'cache/sanitized.db'));
const db = new DatabaseSync(path.join(ROOT, 'cache/sanitized.db'), { readOnly: true });
const rules = db.prepare('SELECT card_key, faq FROM rules').all();
db.close();
const norm = (t) => t.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
// cards named in a text: "Name - Title" (or a bare name for cards with no title), longest first
const keys = rules.map((r) => ({ key: r.card_key, pat: norm(r.card_key).toLowerCase() })).filter((k) => k.pat.length >= 5).sort((a, b) => b.pat.length - a.pat.length);
const findCards = (text) => {
  let t = norm(text).toLowerCase(); const out = [];
  for (const k of keys) if (t.includes(k.pat)) { out.push(k.key); t = t.split(k.pat).join(' '); }
  return out;
};
const runnable = (key) => { const d = index.byFull.get(nameKey(key)); return d ? isFullyAutomated(d) : false; };

const qas = [];
const DIR = path.join(ROOT, 'docs/rules');
for (const f of readdirSync(DIR).filter((x) => /notes/i.test(x)).sort()) {
  const lines = readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/).map((l) => l.trim());
  let ctx = []; let cur = null;
  const done = () => { if (cur) qas.push(cur); cur = null; ctx = []; };
  lines.forEach((l, i) => {
    if (/^Q[:.]/.test(l)) { if (cur && cur.mode === 'A') done(); cur = { src: `docs/rules/${f}:${i + 1}`, ctx: ctx.slice(-6).join(' '), q: l.slice(2).trim(), a: '', mode: 'Q' }; return; }
    if (/^A[:.]/.test(l) && cur) { cur.mode = 'A'; cur.a = l.slice(2).trim(); return; }
    if (/^©Disney/.test(l)) return;
    if (cur?.mode === 'Q') { cur.q += ` ${l}`; return; }
    if (cur?.mode === 'A') { if (!l) { cur.blank = (cur.blank || 0) + 1; if (cur.blank >= 2) done(); return; } cur.blank = 0; cur.a += ` ${l}`; return; }
    if (l) ctx.push(l);
  });
  done();
}
for (const r of rules) {
  if (!r.faq) continue;
  let f; try { f = JSON.parse(r.faq); } catch { continue; }
  for (const e of f) for (const part of e.body.split(/\r?\n\s*Q:\s*/)) {
    const [q, a = ''] = part.replace(/^\s*Q:\s*/, '').split(/\r?\n\s*A:\s*/);
    if (q.trim()) qas.push({ src: `faq:${r.card_key}`, ctx: r.card_key, self: r.card_key, q, a });
  }
}
const out = qas.map((x) => {
  const q = norm(x.q); const a = norm(x.a);
  const cards = [...new Set([...(x.self ? [x.self] : []), ...findCards(`${x.ctx} ${q} ${a}`)])];
  return { id: createHash('sha1').update(q).digest('hex').slice(0, 10), src: x.src, cards, runnable: cards.length > 0 && cards.every(runnable), multiplayer: /multiplayer|teammate|3-player|4-player/i.test(q) || undefined, q, a };
});
// the same question can be in a set's notes and in the card's FAQ — one entry, every source
const byId = new Map();
for (const x of out) {
  const y = byId.get(x.id);
  if (!y) { byId.set(x.id, { ...x, src: [x.src] }); continue; }
  y.src.push(x.src); y.cards = [...new Set([...y.cards, ...x.cards])]; y.runnable = y.cards.length > 0 && y.cards.every(runnable);
  if (x.a.length > y.a.length) y.a = x.a;
}
const list = [...byId.values()];
writeFileSync(path.join(ROOT, 'scripts/oracles/qa.json'), `${JSON.stringify(list, null, 1)}\n`);
console.log(`${list.length} Q&As · ${list.filter((x) => x.cards.length).length} name a card · ${list.filter((x) => x.runnable).length} are about cards that all run → scripts/oracles/qa.json`);
