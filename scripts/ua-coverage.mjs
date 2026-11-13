#!/usr/bin/env node
// How much Union Arena card text the compiler (game/ua/compile.js) automates.
//
//   node scripts/ua-coverage.mjs              totals + the most common sentences still resolved by hand
//   node scripts/ua-coverage.mjs --src HTR    one title
//   node scripts/ua-coverage.mjs --card HTR-1-001   what one card compiles to
//   node scripts/ua-coverage.mjs --misses 60  show more unhandled sentences

import { readFileSync, existsSync } from 'node:fs';
import { toDef } from '../game/ua/cards.js';
import { compileDef } from '../game/ua/compile.js';

const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

let cards;
if (existsSync('cache/ua-cards.json')) cards = JSON.parse(readFileSync('cache/ua-cards.json', 'utf8')).cards;
else {
  const det = JSON.parse(readFileSync('cache/ua-printings.json', 'utf8'));
  cards = Object.values(det).map((d) => ({ ...d, no: d.number.split('/').pop(), src: d.number.split('/').pop().split('-')[0] }));
}
const defs = cards.map(toDef).filter((d) => !arg('--src') || d.src === arg('--src'));

if (arg('--card')) {
  const d = defs.find((x) => x.no === arg('--card'));
  if (!d) { console.error('no such card'); process.exit(1); }
  console.log(d.effect, '\n', d.trigger);
  console.log(JSON.stringify(compileDef(d), null, 2));
  process.exit(0);
}

let lines = 0, auto = 0, fully = 0, noText = 0;
const misses = new Map();
for (const d of defs) {
  const c = compileDef(d);
  lines += c.coverage.lines;
  auto += c.coverage.auto;
  if (!c.coverage.lines) noText++;
  else if (!c.coverage.manual.length) fully++;
  for (const s of c.coverage.fails) {
    const key = String(s).replace(/<[^>]+>/g, '<N>').replace(/\[(?!Impact|Damage|Snipe|Step|Double)[^\]]+\]/g, '[A]').replace(/\d+/g, '#');
    misses.set(key, (misses.get(key) || 0) + 1);
  }
}
const withText = defs.length - noText;
console.log(`cards: ${defs.length} (${noText} with no ability text)`);
console.log(`ability lines automated: ${auto}/${lines} (${(100 * auto / Math.max(1, lines)).toFixed(1)}%)`);
console.log(`cards fully automated: ${fully}/${withText} with text (${(100 * fully / Math.max(1, withText)).toFixed(1)}%), ${fully + noText}/${defs.length} overall`);
const n = Number(arg('--misses', 40));
console.log(`\nmost common sentences resolved by hand:`);
for (const [k, v] of [...misses].sort((a, b) => b[1] - a[1]).slice(0, n)) console.log(String(v).padStart(4), ' ', k);
