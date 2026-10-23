// Every word of a card's text has to matter. Delete each sentence part and each content word, recompile: if the proc
// comes out the same, the compiler never read that span — text was dropped (the class of bug where "if …" vanished).
//   node scripts/verify/probe.mjs [--all]     exit 1 on an unread span that isn't in probe-allow.json
import { readFileSync } from 'node:fs';
import { compileAbility } from '../../game/procs/index.js';
import { canon, stripReminders } from '../../game/procs/normalize.js';
import { runnable } from './corpus.mjs';

const ALLOW = JSON.parse(readFileSync(new URL('./probe-allow.json', import.meta.url), 'utf8'));
const WORDS = new Set(ALLOW.words.map((w) => w.toLowerCase()));          // redundant in Lorcana templating, anywhere
const SPANS = new Map(Object.entries(ALLOW.spans));                       // "<key>|<span>" → why it's fine there
// words that carry no rules by themselves
const FUNC = new Set('a an the of to and this that it its is are be your you their they them his her him he she one each any may can with from in on at for as by into has have was were do does then'.split(' '));
const body = (p) => { const { name, text, exec, why, at, ...b } = p; return JSON.stringify(b, (k, v) => (k === 'labels' || k === 'text' ? undefined : v)); };

const found = [];
let segs = 0; let words = 0;
for (const x of runnable()) {
  if (x.p.kind === 'keyword' || x.p.kind === 'reminder') continue;
  const t = stripReminders(canon(x.p.text));
  const b0 = body(x.p);
  const same = (t2) => { const q = compileAbility({ name: x.name, text: t2 }, x.type); return q.exec && body(q) === b0; };
  const flag = (span, kind) => {
    if (kind === 'word' && WORDS.has(span.toLowerCase())) return;
    if (SPANS.has(`${x.key}|${span}`)) return;
    found.push({ key: x.key, full: x.full, kind, span, text: t });
  };
  const cuts = [...t.matchAll(/[^.,!]+[.,!]?/g)].map((m) => [m.index, m.index + m[0].length]).filter(([a, b]) => b - a > 3);
  if (cuts.length > 1) for (const [a, b] of cuts) {
    const t2 = (t.slice(0, a) + t.slice(b)).replace(/\s+/g, ' ').replace(/^[ ,]+/, '').trim();
    if (!t2) continue;
    segs++;
    const span = t.slice(a, b).trim();
    if (/^then,?$/i.test(span)) continue;                                 // "Then, X" reads as X (both are in order)
    if (same(t2.replace(/^\w/, (c) => c.toUpperCase()))) flag(span, 'part');
  }
  for (const m of t.matchAll(/[A-Za-z'{}+\-0-9]+/g)) {
    const w = m[0];
    if (FUNC.has(w.toLowerCase())) continue;
    words++;
    const t2 = (t.slice(0, m.index) + t.slice(m.index + w.length)).replace(/\s+/g, ' ').replace(/ ([.,])/g, '$1').trim();
    if (same(t2)) flag(w, 'word');
  }
}
console.log(`probe: ${segs} parts, ${words} content words checked`);
for (const f of found.slice(0, process.argv.includes('--all') ? Infinity : 40)) console.log(`  ${f.kind.padEnd(4)} "${f.span}"  ${f.full}\n        ${f.text.slice(0, 160)}`);
console.log(found.length ? `probe: ${found.length} unread spans (allow them in scripts/verify/probe-allow.json with a reason, or fix the compiler)` : 'probe: OK — every word is read');
process.exitCode = found.length ? 1 : 0;
