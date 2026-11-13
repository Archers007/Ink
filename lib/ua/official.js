// Union Arena's official card list (https://www.unionarena-tcg.com/na/cardlist/), English (U.S./Canada).
//
// The site has no API and no robots.txt (404, 2026-11-13). The card list is server-rendered HTML:
//   /na/cardlist/                                   product <select> (option value = series id, label "... [UE01BT]")
//   /na/cardlist/?search=true&series=<id>           every printing in that product (no paging), as
//                                                   detail_iframe.php?card_no=UE01BT/BLC-1-004[_p1] links
//   /na/cardlist/detail_iframe.php?card_no=<no>     one printing: name, number, rarity, energy, AP, type, BP, affinity,
//                                                   generated energy, effect, trigger, products
// Icons carry meaning through their alt text (energy colour + count, "When Played", "Raid", trigger type), so the
// parser turns <img alt="X"> into [X] before stripping tags.
//
// Every request goes through lib/extcalls (source 'unionarena') and is spaced out: one at a time by default, with a
// pause between requests, because this is someone else's small Apache server.

import { extFetch } from '../extcalls/index.js';

export const ORIGIN = 'https://www.unionarena-tcg.com';
export const LIST_URL = `${ORIGIN}/na/cardlist/`;
export const imageUrl = (printing) => `${ORIGIN}/na/images/cardlist/card/${String(printing).replace('/', '_')}.png?v3`;

const SRC = 'unionarena';
const UA_HEADERS = { 'user-agent': 'Mozilla/5.0 (compatible; InkDeckBuilder/1.0)', accept: 'text/html' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decode(s) {
  return String(s ?? '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// HTML fragment -> text, icons as [alt], <br> as newline
export function fragText(html) {
  return decode(String(html ?? '')
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, (_, alt) => ` [${alt.trim()}] `)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
    .replace(/\[([^\]]+)\] (?=[,.)])/g, '[$1]');
}

export function createUnionArena({ delayMs = 350, retries = 3, fetchImpl = null } = {}) {
  let last = 0;
  async function get(url, kind, caller) {
    for (let attempt = 0; ; attempt++) {
      const wait = last + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      try {
        const res = fetchImpl
          ? await fetchImpl(url)
          : await extFetch(url, { headers: UA_HEADERS, redirect: 'follow' }, { source: SRC, kind, caller });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return await res.text();
      } catch (e) {
        if (attempt + 1 >= retries) throw e;
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  return {
    // [{ id: '591101', label: 'BLEACH: Thousand-Year Blood War', code: 'UE01BT' }]
    async products(caller = 'ua-import') {
      const html = await get(`${LIST_URL}?search=true`, 'products', caller);
      return parseProducts(html || '');
    },
    // ['UE01BT/BLC-1-001', 'UE01BT/BLC-1-004_p1', ...]
    async productPrintings(seriesId, caller = 'ua-import') {
      const html = await get(`${LIST_URL}?search=true&series=${encodeURIComponent(seriesId)}`, 'product', caller);
      return parsePrintingList(html || '');
    },
    async printing(cardNo, caller = 'ua-import') {
      const html = await get(`${LIST_URL}detail_iframe.php?card_no=${encodeURIComponent(cardNo).replace(/%2F/g, '/')}`, 'card', caller);
      return html ? parseDetail(html, cardNo) : null;
    },
  };
}

export function parseProducts(html) {
  const sel = html.match(/<select[^>]*name="series"[^>]*>([\s\S]*?)<\/select>/i)?.[1] ?? html;
  const out = [];
  for (const m of sel.matchAll(/<option value="(\d+)"[^>]*>([^<]*)/g)) {
    const raw = decode(m[2]).trim();
    const code = raw.match(/\[([^\]]+)\]\s*$/)?.[1]?.trim() || null;
    out.push({ id: m[1], label: raw.replace(/\s*\[[^\]]+\]\s*$/, '').trim(), code });
  }
  return out;
}

export function parsePrintingList(html) {
  const seen = new Set();
  for (const m of html.matchAll(/detail_iframe\.php\?card_no=([^"&]+)/g)) seen.add(decode(decodeURIComponent(m[1])));
  return [...seen];
}

const dd = (html, cls) => {
  const m = html.match(new RegExp(`<dl class="cardDataCol ${cls}"[^>]*>[\\s\\S]*?<dd class="cardDataContents"[^>]*>([\\s\\S]*?)</dd>`, 'i'));
  return m ? m[1] : null;
};
const dash = (s) => (s == null || s === '-' || s === '' ? null : s);

// Purple5 / Purple- / Green3 -> { color, n }
export function parseEnergyAlt(alt) {
  const m = String(alt || '').match(/^([A-Za-z]+)\s*(\d+|-)?$/);
  if (!m) return null;
  return { color: m[1].toLowerCase(), n: m[2] && m[2] !== '-' ? Number(m[2]) : 0 };
}

export function parseDetail(html, cardNo) {
  const name = decode(html.match(/<h2 class="cardNameCol">([\s\S]*?)<\/h2>/)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const number = decode(html.match(/<span class="cardNumData">([^<]*)<\/span>/)?.[1] ?? cardNo).trim();
  const rarity = decode(html.match(/<span class="rareData">([^<]*)<\/span>/)?.[1] ?? '').trim() || null;
  const title = decode(html.match(/cardDataTitleCol[^>]*>\s*<img[^>]*alt="([^"]*)"/)?.[1] ?? '').trim() || null;

  const needHtml = dd(html, 'needEnergyData') || '';
  const needAlt = needHtml.match(/alt="([^"]*)"/)?.[1];
  const need = parseEnergyAlt(needAlt) || { color: null, n: 0 };

  const genHtml = dd(html, 'generatedEnergyData') || '';
  const generated = [...genHtml.matchAll(/ico_resource_energy_([a-z]+)(\d*)\.png[^>]*alt="([^"]*)"/g)]
    .map((m) => m[1].toLowerCase());
  const genPlus = /ico_resource_(?:energy_)?plus|alt="\+"/.test(genHtml);

  const apRaw = dash(fragText(dd(html, 'apData')));
  const bpRaw = dash(fragText(dd(html, 'bpData')));
  const affRaw = dash(fragText(dd(html, 'attributeData')));
  const effectHtml = dd(html, 'effectData');
  const triggerHtml = dd(html, 'triggerData');
  const triggerType = triggerHtml?.match(/alt="([^"]*)"/)?.[1]?.trim() || null;
  const triggerText = dash(fragText((triggerHtml || '').replace(/<img[^>]*>/i, '')));
  const products = [...html.matchAll(/<p class="cardDataProductsTxt">([^<]*)<\/p>/g)].map((m) => decode(m[1]).trim());

  return {
    printing: cardNo,
    number,
    name,
    rarity,
    title,
    type: dash(fragText(dd(html, 'categoryData'))),
    color: need.color,
    energy: need.n,
    ap: apRaw == null ? null : Number(apRaw),
    bp: bpRaw == null ? null : Number(String(bpRaw).replace(/[^\d-]/g, '')),
    affinities: affRaw ? affRaw.split(/\s*\/\s*|\s*,\s*|\n/).map((s) => s.trim()).filter(Boolean) : [],
    generated,
    genPlus,
    effect: dash(fragText(effectHtml)),
    trigger: triggerType ? { type: triggerType, text: triggerText } : null,
    products,
  };
}
