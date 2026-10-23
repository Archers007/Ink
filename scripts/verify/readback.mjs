// The plain-English read-back (game/procs/explain.js) must show everything a proc does, so a reviewer comparing it
// with the card can see a misread. For every field of every runnable proc: change it to another value seen in the
// corpus and re-explain — if the read-back doesn't change, that field is invisible. Also flags junk read-backs.
//   node scripts/verify/readback.mjs [--all]     exit 1 on an invisible field pattern not in readback-allow.json
import { readFileSync } from 'node:fs';
import { explain } from '../../game/procs/index.js';
import { runnable } from './corpus.mjs';

const ALLOW = JSON.parse(readFileSync(new URL('./readback-allow.json', import.meta.url), 'utf8')).patterns;
const SKIP = new Set(['name', 'text', 'exec', 'why', 'at', 'labels']);   // labels: the chooseOne option names, shown as the options
const all = runnable().filter((x) => x.p.kind !== 'keyword' && x.p.kind !== 'reminder');
const say = (p) => { try { return explain(p).join(' | '); } catch (e) { return `THROW ${e.message}`; } };

// every value each field pattern takes across the corpus — the perturbations
const DOM = {};
const dom = (o, pat) => { for (const [k, v] of Object.entries(o)) { if (SKIP.has(k)) continue; const P2 = Array.isArray(o) ? `${pat}[]` : `${pat}.${k}`; if (v && typeof v === 'object') dom(v, P2); else (DOM[P2] ||= new Set()).add(v); } };
for (const x of all) dom(x.p, '');

const byPat = {};
const junk = [];
for (const x of all) {
  const p = structuredClone(x.p);
  const base = say(p);
  if (/undefined|NaN|\[object|  |THROW|: \(while in play\)|card {2}/.test(base)) junk.push({ x, base });
  const rec = (o, pat) => {
    for (const [k, v] of Object.entries(o)) {
      if (SKIP.has(k)) continue;
      const P2 = Array.isArray(o) ? `${pat}[]` : `${pat}.${k}`;
      if (v && typeof v === 'object') { rec(v, P2); continue; }
      const others = [...(DOM[P2] || [])].filter((y) => y !== v && typeof y === typeof v);
      if (typeof v === 'string' && !others.length) continue;
      const alts = typeof v === 'boolean' ? [!v] : typeof v === 'number' ? [v + 1] : typeof v === 'string' ? others.slice(0, 4) : [1];
      let changed = false;
      for (const a of alts) { o[k] = a; if (say(p) !== base) changed = true; }
      o[k] = v;
      if (!changed && v === true && !Array.isArray(o)) { delete o[k]; changed = say(p) !== base; o[k] = v; }
      const pp = P2.replace(/^\./, '');
      const B = (byPat[pp] ||= { n: 0, inv: 0, ex: [] });
      B.n++;
      if (!changed) { B.inv++; if (B.ex.length < 2) B.ex.push(`${x.full}: ${x.text.slice(0, 110)}`); }
    }
  };
  rec(p, '');
}
const inv = Object.entries(byPat).filter(([k, v]) => v.inv && !ALLOW[k]).sort((a, b) => b[1].inv - a[1].inv);
const total = Object.values(byPat).reduce((n, v) => n + v.inv, 0);
console.log(`readback: ${all.length} procs, ${Object.values(byPat).reduce((n, v) => n + v.n, 0)} fields, ${total} invisible (${Object.keys(ALLOW).length} patterns allowed)`);
for (const [k, v] of inv.slice(0, process.argv.includes('--all') ? Infinity : 30)) console.log(`  ${String(v.inv).padStart(4)} / ${String(v.n).padEnd(5)} ${k}\n        ${v.ex[0]}`);
for (const j of junk.slice(0, 20)) console.log(`  junk: ${j.x.full}: ${j.base}`);
const bad = inv.length + junk.length;
console.log(bad ? `readback: ${inv.length} invisible field patterns, ${junk.length} junk read-backs` : 'readback: OK — every field shows in the read-back');
process.exitCode = bad ? 1 : 0;
