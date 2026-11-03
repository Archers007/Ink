// The top decks on dreamborn.ink, as the decks the bots play in simulations, the arena and training
// (game/decks/meta.json → index.simDecks). Run it now and then to follow the meta; commit the result.
//
//   node tools/fetch-meta-decks.mjs [--pages 3] [--keep 12] [--allow-manual]
//
// Takes the most popular decks, resolves each through our card index, and keeps the legal 60-card ones whose every
// card the engine runs by itself (a bot can't use an ability it has to resolve by hand, so such a deck would play
// below its strength). --allow-manual keeps decks with up to 4 such cards. One deck per ink pair and creator, so the
// set is varied.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCardIndex, resolveDeck, isFullyAutomated } from '../game/cards.js';
import { DREAMBORN_DECKS, DREAMBORN_DECK_PAGE, parseDreambornDeckHTML } from '../lib/dreamborn.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, def) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : def; };
const PAGES = Number(arg('--pages', 3)), KEEP = Number(arg('--keep', 12)), MANUAL_OK = process.argv.includes('--allow-manual') ? 4 : 0;
const OUT = path.join(root, 'game', 'decks', 'meta.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const index = await loadCardIndex(path.join(root, 'cache', 'sanitized.db'));
// dreamborn serves page 1 of each sort without a login (later pages answer 401); popular first, then trending
const list = [], ids = new Set();
for (const sort of ['popular', 'trending']) {
  for (let page = 1; page <= PAGES; page++) {
    const r = await fetch(`${DREAMBORN_DECKS}?currency=USD&sort=${sort}&archetype=&format=&page=${page}`, { headers: { accept: 'application/json', 'user-agent': UA, referer: 'https://dreamborn.ink/decks' } });
    if (!r.ok) { if (page === 1) console.warn(`  ${sort} decks: ${r.status}`); break; }
    const j = await r.json();
    for (const d of (Array.isArray(j) ? j : j.data || j.items || [])) if (!ids.has(d.id)) { ids.add(d.id); list.push(d); }
  }
}
console.log(`${list.length} decks listed`);

const kept = [], seen = new Set();
const skipped = { size: 0, illegal: 0, manual: 0, dup: 0, unknown: 0 };
for (const d of list) {
  if (kept.length >= KEEP) break;
  if (Number(d.size) !== 60) { skipped.size++; continue; }
  const r = await fetch(DREAMBORN_DECK_PAGE(d.id), { headers: { accept: 'text/html', 'user-agent': UA, referer: 'https://dreamborn.ink/decks' } });
  if (!r.ok) { console.warn(`  ${d.name}: page ${r.status}`); continue; }
  const deck = parseDreambornDeckHTML(await r.text(), d.id);
  if (!deck) { console.warn(`  ${d.name}: could not parse`); continue; }
  const cards = deck.cardIds.filter((c) => index.byId.has(c.id)).map((c) => [c.id, c.qty]);
  if (cards.length !== deck.cardIds.length) { skipped.unknown++; console.warn(`  ${d.name}: ${deck.cardIds.length - cards.length} unknown cards`); continue; }
  const res = resolveDeck(index, { name: deck.name, cards });
  if (!res.legal) { skipped.illegal++; console.warn(`  ${d.name}: ${[...res.errors, ...res.problems].join('; ')}`); continue; }
  const manual = [...new Set(res.defs.filter((x) => !isFullyAutomated(x)).map((x) => x.full))];
  if (manual.length > MANUAL_OK) { skipped.manual++; console.warn(`  ${d.name}: ${manual.length} cards the engine can't run alone (${manual.slice(0, 3).join(', ')}${manual.length > 3 ? '…' : ''})`); continue; }
  const key = `${res.inks.join('/')}|${deck.creatorName}`;
  if (seen.has(key)) { skipped.dup++; continue; }
  seen.add(key);
  kept.push({ id: `meta:${d.id}`, name: `Meta: ${deck.name.trim().slice(0, 48)}`, inks: res.inks, creator: deck.creatorName, likes: deck.likeCount, source: deck.sourceUrl, fetched: new Date().toISOString().slice(0, 10), manual, cards });
  console.log(`  ✓ ${deck.name} (${res.inks.join('/')}, ${deck.likeCount} likes${manual.length ? `, ${manual.length} manual` : ''})`);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ fetched: new Date().toISOString(), source: 'dreamborn.ink popular', decks: kept }, null, 1));
console.log(`\nkept ${kept.length} → ${path.relative(root, OUT)} · skipped: ${Object.entries(skipped).map(([k, v]) => `${k} ${v}`).join(', ')}`);
