// Run every oracle (scripts/oracles/*.oracle.mjs) and report how many official Q&As are checked.
//   node scripts/oracles/run.mjs [--untested]     exit 1 on a failing oracle or an oracle naming an unknown Q&A
import { readFileSync, readdirSync } from 'node:fs';
import { ORACLES, UNTESTABLE } from './lib.mjs';

const DIR = new URL('.', import.meta.url);
const QA = new Map(JSON.parse(readFileSync(new URL('qa.json', DIR), 'utf8')).map((x) => [x.id, x]));
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.oracle.mjs')).sort()) await import(new URL(f, DIR));

const origErr = console.error; console.error = () => {};
let pass = 0; const fails = [];
for (const o of ORACLES) {
  if (!QA.has(o.id)) { fails.push(`${o.id} — not a Q&A id in qa.json (${o.what})`); continue; }
  try { o.fn(); pass++; } catch (e) { fails.push(`${o.id} — ${o.what}\n      Q: ${QA.get(o.id).q.slice(0, 160)}\n      ✗ ${String(e.message).split('\n')[0]}`); }
}
console.error = origErr;
for (const id of UNTESTABLE.keys()) if (!QA.has(id)) fails.push(`${id} — marked untestable but not in qa.json`);
const tested = new Set(ORACLES.map((o) => o.id));
const open = [...QA.values()].filter((x) => x.runnable && !tested.has(x.id) && !UNTESTABLE.has(x.id));
console.log(`oracles: ${pass}/${ORACLES.length} pass · ${tested.size} of ${QA.size} official Q&As checked, ${UNTESTABLE.size} not testable, ${open.length} about runnable cards still to write`);
for (const f of fails) console.log(`  ✗ ${f}`);
if (process.argv.includes('--untested')) for (const x of open) console.log(`  ○ ${x.id}  ${x.cards.join(', ')}\n      Q: ${x.q}\n      A: ${x.a}`);
console.log(fails.length ? 'oracles: FAIL' : 'oracles: OK — the engine agrees with every ruling tested');
process.exitCode = fails.length ? 1 : 0;
