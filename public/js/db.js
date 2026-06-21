// Loads cards.db + prices.db via sql.js and exposes query helpers.

const SQL_WASM_URL = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm';

// Color bitmasks from dreamborn cards.db. Confirmed by inspection.
export const INK_BY_BIT = {
  1:  'amber',
  2:  'amethyst',
  4:  'emerald',
  8:  'ruby',
  16: 'sapphire',
  32: 'steel',
};
export const INK_ORDER = ['amber','amethyst','emerald','ruby','sapphire','steel'];

export function inksOf(colorMask) {
  const inks = [];
  for (const bitStr of Object.keys(INK_BY_BIT)) {
    const bit = Number(bitStr);
    if (colorMask & bit) inks.push(INK_BY_BIT[bit]);
  }
  return inks;
}

export const DB = {
  cards: null,    // sql.js Database
  prices: null,
  ready: false,
  cardsByKey: new Map(),   // name|title -> [card row]
};

export async function loadDB(onProgress = () => {}) {
  onProgress('init', 'Loading SQLite engine…');
  const SQL = await initSqlJs({ locateFile: () => SQL_WASM_URL });

  onProgress('fetch', 'Downloading cards.db…');
  const cardsBuf = await fetch('/api/cards.db').then((r) => {
    if (!r.ok) throw new Error('cards.db HTTP ' + r.status);
    return r.arrayBuffer();
  });
  DB.cards = new SQL.Database(new Uint8Array(cardsBuf));

  onProgress('fetch', 'Downloading prices.db…');
  try {
    const pricesBuf = await fetch('/api/prices.db').then((r) => r.ok ? r.arrayBuffer() : null);
    if (pricesBuf) DB.prices = new SQL.Database(new Uint8Array(pricesBuf));
  } catch (e) {
    console.warn('prices.db unavailable:', e);
  }

  // Build lookup index: by lowercase "name|title"
  const all = rows('SELECT id,name,title,setId,number,cost,type,colorMask,ink,strength,willpower,lore,movement,rarity,characteristics,keywords,abilities,variants,formats,franchise FROM cards');
  for (const c of all) {
    c.inks = inksOf(c.colorMask);
    c.image = `https://cdn.dreamborn.ink/images/en/cards/${c.id}`;
    const key = (c.name + '|' + (c.title || '')).toLowerCase();
    if (!DB.cardsByKey.has(key)) DB.cardsByKey.set(key, []);
    DB.cardsByKey.get(key).push(c);
  }
  DB.allCards = all;
  DB.ready = true;
  return all;
}

export function rows(sql, params = []) {
  if (!DB.cards) return [];
  const stmt = DB.cards.prepare(sql);
  stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

export function findByNameTitle(name, title) {
  const key = (name + '|' + (title || '')).toLowerCase();
  return DB.cardsByKey.get(key) || [];
}

// Pick one canonical printing per (name, title) — preferring lowest set/number, non-promo.
export function canonicalPrintings(allCards) {
  const seen = new Map();
  for (const c of allCards) {
    const key = (c.name + '|' + (c.title || '')).toLowerCase();
    const prev = seen.get(key);
    if (!prev) { seen.set(key, c); continue; }
    // Prefer earliest set, then lowest number, then non-promo.
    const score = (x) => Number(x.setId) * 1000 + Number(x.number || 9999) + (x.rarity === 'promo' ? 100000 : 0);
    if (score(c) < score(prev)) seen.set(key, c);
  }
  return [...seen.values()];
}

export function inkSymbol(ink) {
  return `<span class="ink ink-${ink}" title="${ink}"></span>`;
}
