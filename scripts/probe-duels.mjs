// Probe duels.ink once through lib/duels.js: every wired endpoint is called once and its status and response shape
// printed. Calls go through lib/extcalls, so on this PC they land in the host's data/extcalls.db (set INK_EXTCALLS_DB
// to put them elsewhere). robots.txt is honoured: endpoints under /api/ are reported as blocked without a request.
// Run it sparingly, a couple of times at most; it is a check, not a scraper.
//
//   node scripts/probe-duels.mjs
//   INK_DUELS_BASE=http://127.0.0.1:3999 node scripts/probe-duels.mjs   (against a stub)

import { createDuels } from '../lib/duels.js';
import { extStore } from '../lib/extcalls/index.js';

const duels = createDuels();
const caller = 'tool:probe-duels';

// A one-line picture of a value: keys of objects, length and first item of arrays.
function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.length}]${v.length && depth < 2 ? ' of ' + shape(v[0], depth + 1) : ''}`;
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (depth >= 2) return `{${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}}`;
    return `{ ${keys.slice(0, 10).map((k) => `${k}: ${shape(v[k], depth + 1)}`).join(', ')}${keys.length > 10 ? `, … +${keys.length - 10}` : ''} }`;
  }
  if (typeof v === 'string') return v.length > 40 ? `'${v.slice(0, 37)}…'` : `'${v}'`;
  return String(v);
}

const probes = [
  ['robots', () => duels.robots({ caller }), (r) => `${r.groups.length} groups, ${r.text.length} chars`],
  ['sitemap', () => duels.sitemap({ caller }), (r) => `${r.urls.length} urls, e.g. ${r.urls.slice(0, 3).join(' ')}`],
  ['version', () => duels.version({ caller })],
  ['loginProviders', () => duels.loginProviders({ caller })],
  ['leaderboard', () => duels.leaderboard({}, { caller })],
  ['cards', () => duels.cards({ limit: 5 }, { caller })],
  ['communityDecks', () => duels.communityDecks({ limit: 3 }, { caller })],
  ['prices', () => duels.prices({ caller })],
];

console.log(`duels.ink probe → ${duels.base}`);
for (const [name, run, describe = shape] of probes) {
  const t0 = Date.now();
  try {
    const out = await run();
    console.log(`  ok      ${name.padEnd(15)} ${String(Date.now() - t0).padStart(5)} ms  ${describe(out)}`);
  } catch (e) {
    const tag = e.code === 'DUELS_ROBOTS' ? 'robots' : e.status ? `HTTP ${e.status}` : 'error';
    console.log(`  ${tag.padEnd(7)} ${name.padEnd(15)} ${String(Date.now() - t0).padStart(5)} ms  ${e.message}`);
  }
}
for (const path of ['/', '/cards', '/decks/community', '/api/cards', '/api/leaderboard']) {
  console.log(`  robots.txt ${(await duels.isAllowed(path, { caller })) ? 'allows  ' : 'disallows'} ${path}`);
}
extStore().flush();
