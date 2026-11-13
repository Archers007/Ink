#!/usr/bin/env node
// Union Arena card import: the official card list (lib/ua/official.js) -> cache/ua-cards.json.
//
//   node tools/ua/import-cards.mjs              fetch product lists, then details only for card numbers not yet cached
//   node tools/ua/import-cards.mjs --refresh    re-fetch every card's detail page (errata)
//   node tools/ua/import-cards.mjs --only UE02BT,UE01ST   limit to these product codes (testing)
//
// A card is identified by its card number without the product prefix ("HTR-1-001"): that is what the 4-copy rule
// counts (rule manual p.05, docs/rules/ua/rule_manual.md UA-4). The same number can be printed in several products
// and as parallels (UE02BT/HTR-1-001_p1); those are kept as printings of one card. Parallels share the base card's
// text, so their detail pages are not fetched. AP cards (…-AP01) are skipped.
//
// cache/ua-printings.json keeps every parsed detail page so a re-run only fetches what is new.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUnionArena, imageUrl } from '../../lib/ua/official.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = path.join(ROOT, 'cache');
const OUT = path.join(CACHE, 'ua-cards.json');
const DETAILS = path.join(CACHE, 'ua-printings.json');

const args = process.argv.slice(2);
const refresh = args.includes('--refresh');
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? new Set(args[i + 1].split(',')) : null; })();
const quiet = args.includes('--quiet');
const log = (...a) => { if (!quiet) console.log(...a); };

export const cardNumber = (printing) => String(printing).split('/').pop().replace(/_p\d+$/i, '');
export const srcCode = (no) => String(no).split('-')[0];
const isAp = (printing) => /-AP\d+$/i.test(printing);
const isParallel = (printing) => /_p\d+$/i.test(printing);

async function readJson(f, fallback) {
  try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fallback; }
}

async function main() {
  await fs.mkdir(CACHE, { recursive: true });
  const ua = createUnionArena();
  const details = refresh ? {} : await readJson(DETAILS, {});

  let products = await ua.products();
  if (!products.length) throw new Error('no products found on the card list page (layout changed?)');
  if (only) products = products.filter((p) => only.has(p.code));
  log(`[ua] ${products.length} products`);

  // number -> { printings: [{ printing, product }] }
  const byNumber = new Map();
  for (const p of products) {
    const list = await ua.productPrintings(p.id);
    p.count = list.length;
    log(`[ua] ${p.code || p.id} ${p.label}: ${list.length} printings`);
    for (const printing of list) {
      if (isAp(printing)) continue;
      const no = cardNumber(printing);
      if (!byNumber.has(no)) byNumber.set(no, { printings: [] });
      const entry = byNumber.get(no);
      if (!entry.printings.some((x) => x.printing === printing)) entry.printings.push({ printing, product: p.code || p.label });
    }
  }

  // one detail page per card number: the first non-parallel printing
  const todo = [];
  for (const [no, entry] of byNumber) {
    const base = entry.printings.find((x) => !isParallel(x.printing)) || entry.printings[0];
    entry.base = base.printing;
    if (!details[base.printing]) todo.push(base.printing);
  }
  log(`[ua] ${byNumber.size} card numbers, ${todo.length} detail pages to fetch`);
  let done = 0;
  for (const printing of todo) {
    try {
      const d = await ua.printing(printing);
      if (d && d.name) details[printing] = d;
    } catch (e) {
      console.error(`[ua] ${printing}: ${e.message}`);
    }
    if (++done % 50 === 0) {
      log(`[ua] ${done}/${todo.length}`);
      await fs.writeFile(DETAILS, JSON.stringify(details));
    }
  }
  await fs.writeFile(DETAILS, JSON.stringify(details));

  const cards = [];
  for (const [no, entry] of byNumber) {
    const d = details[entry.base];
    if (!d) continue;
    cards.push({
      no,
      src: srcCode(no),
      name: d.name,
      rarity: d.rarity,
      title: d.title,
      type: d.type,
      color: d.color,
      energy: d.energy,
      ap: d.ap,
      bp: d.bp,
      affinities: d.affinities,
      generated: d.generated,
      genPlus: d.genPlus,
      effect: d.effect,
      trigger: d.trigger,
      img: imageUrl(entry.base),
      printings: entry.printings.map((x) => ({ ...x, img: imageUrl(x.printing) })),
    });
  }
  cards.sort((a, b) => a.no.localeCompare(b.no, 'en', { numeric: true }));

  const titles = {};
  for (const c of cards) if (c.title && !titles[c.src]) titles[c.src] = c.title;
  const out = { builtAt: new Date().toISOString(), source: 'unionarena-tcg.com/na', products, titles, cards };
  await fs.writeFile(OUT + '.tmp', JSON.stringify(out));
  await fs.rename(OUT + '.tmp', OUT);
  log(`[ua] wrote ${OUT}: ${cards.length} cards across ${Object.keys(titles).length} titles`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('[ua] import failed:', e); process.exit(1); });
}
