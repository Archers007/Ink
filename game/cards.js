// Server-side card index for Play mode.
//
// Reads dreamborn's cards.db (the same SQLite file the deck builder downloads)
// with Node's built-in node:sqlite, and normalises each row into a compact
// "card def" the rules engine and the 3D client both understand.
//
// A def looks like:
//   { id, name, title, full, cost, type, inkable, inks, str, wp, lore, move,
//     kw: { evasive:true, challenger:2, shift:5, ... },   // the card's OWN keywords
//     classes: ['storyborn','hero'], abilities: [{ name, text }],
//     rarity, set, num, franchise, img }

const INK_BITS = [[1, 'amber'], [2, 'amethyst'], [4, 'emerald'], [8, 'ruby'], [16, 'sapphire'], [32, 'steel']];
export const INK_ORDER = INK_BITS.map(([, n]) => n);

export const CARD_IMG = (id) => `https://cdn.dreamborn.ink/images/en/cards/${id}`;

// dreamborn keyword key -> our normalised key
const KW_KEYS = {
  support: 'support', ward: 'ward', singer: 'singer', evasive: 'evasive', challenger: 'challenger',
  vanish: 'vanish', boost: 'boost', rush: 'rush', reckless: 'reckless', alert: 'alert', resist: 'resist',
  bodyguard: 'bodyguard', shift: 'shift', 'puppy shift': 'puppyShift', 'universal shift': 'universalShift',
  'sing together': 'singTogether',
};
const NUMERIC_KW = new Set(['singer', 'challenger', 'boost', 'resist', 'shift', 'puppyShift', 'universalShift', 'singTogether']);
// Keywords that are effectively never granted by other cards — always trust the DB.
const ALWAYS_OWN = new Set(['shift', 'puppyShift', 'universalShift', 'boost', 'singTogether']);

const KW_RX = {
  support: /\bsupport\b/i, ward: /\bward\b/i, singer: /\bsinger\b/i, evasive: /\bevasive\b/i,
  challenger: /\bchallenger\b/i, vanish: /\bvanish\b/i, boost: /\bboost\b/i, rush: /\brush\b/i,
  reckless: /\breckless\b/i, alert: /\balert\b/i, resist: /\bresist\b/i, bodyguard: /\bbodyguard\b/i,
};
const KW_NUM_RX = {
  singer: /\bsinger\s*\+?(\d+)/i,
  challenger: /\bchallenger\s*\+\s*(\d+)/i,
  boost: /\bboost\s*(\d+)/i,
  resist: /\bresist\s*\+\s*(\d+)/i,
  shift: /(?<!puppy |universal )\bshift\s*(\d+)/i,
  puppyShift: /\bpuppy shift\s*(\d+)/i,
  universalShift: /\buniversal shift\s*(\d+)/i,
  singTogether: /\bsing together\s*(\d+)/i,
};

// Same card name regardless of curly/straight quotes, dashes and case.
export const nameKey = (s) => String(s || '').toLowerCase()
  .replace(/[\u2018\u2019\u02bc`´]/g, "'").replace(/[\u201c\u201d]/g, '"')
  .replace(/\s+[–—-]\s+/g, ' - ').replace(/\s+/g, ' ').trim();

function parseJSON(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export function inksOf(mask) {
  return INK_BITS.filter(([bit]) => mask & bit).map(([, name]) => name);
}

// dreamborn stores abilities as [{ name?, description }]. Newer sets pack several
// abilities into one description separated by blank lines, with story names
// wrapped in backslashes (\Run Away!\ ...). Split those into separate entries.
export function splitAbilities(raw) {
  const out = [];
  for (const a of raw || []) {
    const desc = String(a.description || '').trim();
    if (a.name) { out.push({ name: String(a.name).trim(), text: desc }); continue; }
    for (const seg of desc.split(/\n\s*\n/)) {
      const s = seg.trim();
      if (!s) continue;
      const m = s.match(/^\\([^\\]+)\\\s*([\s\S]*)$/);
      if (m) out.push({ name: m[1].trim(), text: m[2].trim() });
      else out.push({ name: '', text: s.replace(/[<>]/g, '') });
    }
  }
  return out;
}

function normaliseKwValue(key, val, text, cost) {
  if (!NUMERIC_KW.has(key)) return true;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    if (/^\d+$/.test(val)) return Number(val);
    if (key === 'shift') return val;          // non-ink shift cost, e.g. "Discard an action card"
  }
  const m = text.match(KW_NUM_RX[key]);
  if (m) return Number(m[1]);
  if (key === 'singTogether') return cost;
  return 1; // e.g. Kronk – Unlicensed Investigator ships `challenger: true`; printed as +1
}

// The DB's `keywords` column lists every keyword *mentioned* on the card —
// including ones the card grants to others ("Your other characters gain
// Challenger +1") or only has conditionally ("During your turn, this character
// gains Evasive"). Only keywords that appear as their own keyword line (or are
// never mentioned in a named ability) are treated as the card's own; the rest
// are left for players to apply by hand.
function ownKeywords(type, rawKw, abilities, cost) {
  const kw = {};
  if (!rawKw || typeof rawKw !== 'object') return kw;
  const unnamedText = abilities.filter((a) => !a.name).map((a) => a.text).join(' \n ');
  if (type === 'action' || type === 'song') {
    if (rawKw['sing together'] != null) kw.singTogether = normaliseKwValue('singTogether', rawKw['sing together'], unnamedText, cost);
    return kw;
  }
  const named = abilities.filter((a) => a.name).map((a) => a.text);
  for (const [rawKey, val] of Object.entries(rawKw)) {
    const key = KW_KEYS[rawKey];
    if (!key) continue;
    if (!ALWAYS_OWN.has(key)) {
      const rx = KW_RX[key];
      const inUnnamed = rx ? rx.test(unnamedText) : true;
      const inNamed = rx ? named.some((t) => rx.test(t)) : false;
      if (!inUnnamed && inNamed) continue; // granted to others / conditional → manual
    }
    kw[key] = normaliseKwValue(key, val, unnamedText, cost);
  }
  return kw;
}

export function rowToDef(r) {
  const abilities = splitAbilities(parseJSON(r.abilities, []));
  const classes = parseJSON(r.characteristics, []);
  const kw = ownKeywords(r.type, parseJSON(r.keywords, {}), abilities, r.cost);
  return {
    id: r.id,
    name: r.name,
    title: r.title || '',
    full: r.title ? `${r.name} - ${r.title}` : r.name,
    cost: Number(r.cost) || 0,
    type: r.type,
    inkable: Number(r.ink) === 1,
    inks: inksOf(Number(r.colorMask) || 0),
    str: r.strength == null ? null : Number(r.strength),
    wp: r.willpower == null ? null : Number(r.willpower),
    lore: r.lore == null ? null : Number(r.lore),
    move: r.movement == null ? null : Number(r.movement),
    kw,
    classes,
    abilities,
    rarity: r.rarity || '',
    set: r.setId,
    num: r.number,
    franchise: r.franchise || '',
    img: CARD_IMG(r.id),
  };
}

// Is every rule on this card handled by the engine? (vanilla or keyword-only)
export function isFullyAutomated(def) {
  if (def.type === 'action' || def.type === 'song') return false;
  return def.abilities.every((a) => !a.name);
}

// ---------- index ----------

export async function loadCardIndex(dbFile) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let rows;
  try {
    rows = db.prepare(`SELECT id,name,title,cost,type,number,colorMask,keywords,lore,strength,willpower,movement,
                              ink,characteristics,abilities,rarity,setId,franchise,formats FROM cards`).all();
  } finally {
    db.close();
  }
  const byId = new Map();
  const byFull = new Map();   // lower(full name) -> canonical def
  const byName = new Map();   // lower(name) -> canonical def (first printing)
  const score = (d) => Number(d.set) * 1000 + (Number(d.num) || 999) + (d.rarity === 'promo' ? 100000 : 0)
    + (['enchanted', 'iconic', 'epic'].includes(d.rarity) ? 50000 : 0);
  for (const r of rows) {
    const def = rowToDef(r);
    def.formats = parseJSON(r.formats, []);
    byId.set(def.id, def);
    const fk = nameKey(def.full);
    if (!byFull.has(fk) || score(def) < score(byFull.get(fk))) byFull.set(fk, def);
    const nk = nameKey(def.name);
    if (!byName.has(nk) || score(def) < score(byName.get(nk))) byName.set(nk, def);
  }
  const index = { byId, byFull, byName, size: byId.size, loadedAt: Date.now() };
  index.demoDecks = buildDemoDecks(index);
  return index;
}

// ---------- decks ----------

export const DECK_RULES = { minSize: 60, maxInks: 2, maxCopies: 4 };

// Parse "4 Mickey Mouse - Brave Little Tailor" style lists (same grammar as the builder).
export function parseDeckText(index, text) {
  const counts = new Map();
  const errors = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    const m = line.match(/^(\d+)\s*[xX]?\s+(.+?)$/);
    if (!m) { errors.push(`unparsed: ${line}`); continue; }
    const qty = Number(m[1]);
    const rest = m[2].trim().replace(/\s+[–—]\s+/g, ' - ');
    const lc = nameKey(rest);
    let def = index.byFull.get(lc) || index.byName.get(lc);
    if (!def) { errors.push(`unknown card: ${rest}`); continue; }
    counts.set(def.id, (counts.get(def.id) || 0) + qty);
  }
  return { cards: [...counts.entries()], errors };
}

// Accepts { name, cards: [[id, qty], ...] } or { name, text }. Returns the deck as
// a flat list of defs plus legality problems (Constructed rules, CR 1.10.1.1).
export function resolveDeck(index, input) {
  const name = String(input?.name || 'Deck').slice(0, 80);
  let pairs = [];
  const errors = [];
  if (Array.isArray(input?.cards)) {
    pairs = input.cards.filter((p) => Array.isArray(p) && p.length >= 2);
  } else if (typeof input?.text === 'string') {
    const parsed = parseDeckText(index, input.text);
    pairs = parsed.cards;
    errors.push(...parsed.errors);
  }
  const defs = [];
  const counts = [];
  const perFull = new Map();
  const inks = new Set();
  for (const [id, qtyRaw] of pairs) {
    const def = index.byId.get(String(id));
    const qty = Math.max(0, Math.min(60, Math.floor(Number(qtyRaw) || 0)));
    if (!def) { errors.push(`unknown card id: ${id}`); continue; }
    if (!qty) continue;
    counts.push([def.id, qty]);
    for (let i = 0; i < qty; i++) defs.push(def);
    perFull.set(nameKey(def.full), (perFull.get(nameKey(def.full)) || 0) + qty);
    def.inks.forEach((i) => inks.add(i));
  }
  const problems = [];
  if (defs.length < DECK_RULES.minSize) problems.push(`needs at least ${DECK_RULES.minSize} cards (has ${defs.length})`);
  if (defs.length > 200) problems.push('way too many cards');
  if (inks.size > DECK_RULES.maxInks) problems.push(`max ${DECK_RULES.maxInks} ink types (has ${inks.size})`);
  for (const [key, n] of perFull) if (n > DECK_RULES.maxCopies) problems.push(`more than ${DECK_RULES.maxCopies} copies of ${index.byFull.get(key)?.full || key}`);
  return {
    name,
    defs,
    counts,
    size: defs.length,
    inks: INK_ORDER.filter((i) => inks.has(i)),
    inkable: defs.filter((d) => d.inkable).length,
    errors,      // parse problems (unknown cards)
    problems,    // legality problems
    legal: problems.length === 0 && errors.length === 0,
  };
}

// ---------- demo decks ----------
//
// Ready-to-play 60-card lists generated from the live card DB so a brand new
// player can jump straight into a game. They lean on vanilla / keyword-only
// characters because the engine automates those completely, plus a couple of
// songs and an action so singing and manual effects get exercised too.

const DEMO_PAIRS = [
  { inks: ['amber', 'steel'], name: 'Demo: Amber/Steel Shield Wall' },
  { inks: ['ruby', 'amethyst'], name: 'Demo: Ruby/Amethyst Ambush' },
  { inks: ['emerald', 'sapphire'], name: 'Demo: Emerald/Sapphire Quest Rush' },
  { inks: ['ruby', 'steel'], name: 'Demo: Ruby/Steel Brawlers' },
];

function buildDemoDecks(index) {
  const canon = [...index.byFull.values()].filter((d) =>
    !['enchanted', 'iconic', 'epic', 'promo'].includes(d.rarity) && d.inks.length >= 1);
  const decks = [];
  for (const pair of DEMO_PAIRS) {
    const fits = (d) => d.inks.every((i) => pair.inks.includes(i));
    const used = new Set();
    const pick = (pool, n) => {
      const out = [];
      for (const d of pool) {
        if (out.length >= n) break;
        if (used.has(nameKey(d.full))) continue;
        used.add(nameKey(d.full));
        out.push(d);
      }
      return out;
    };
    const kwScore = (d) => Object.keys(d.kw).length * 1.5
      + (d.kw.rush ? 1 : 0) + (d.kw.evasive ? 1 : 0) + (d.kw.bodyguard ? 0.5 : 0) + (d.kw.support ? 0.5 : 0);
    const statScore = (d) => ((d.str || 0) + (d.wp || 0) + (d.lore || 0) * 2) / Math.max(1, d.cost);
    const charScore = (d) => kwScore(d) + statScore(d) * 2 + (d.inkable ? 2 : 0) - (d.kw.reckless ? 1 : 0);
    const chars = canon.filter((d) => d.type === 'character' && fits(d) && isFullyAutomated(d) && !d.kw.shift)
      .sort((a, b) => charScore(b) - charScore(a) || a.full.localeCompare(b.full));
    const curve = [[1, 2], [2, 2], [3, 2], [4, 2], [5, 1], [6, 1], [7, 1]];
    const picked = [];
    for (const [cost, n] of curve) {
      const pool = chars.filter((d) => (cost === 7 ? d.cost >= 7 : d.cost === cost));
      picked.push(...pick(pool, n));
    }
    // top up to 11 character names if a cost bucket was thin
    picked.push(...pick(chars, 11 - picked.length));

    const simple = (d) => d.abilities.map((a) => a.text).join(' ').length;
    const songs = pick(canon.filter((d) => d.type === 'song' && fits(d) && d.cost <= 5 && d.inkable)
      .sort((a, b) => simple(a) - simple(b) || a.cost - b.cost), 2);
    const actions = pick(canon.filter((d) => d.type === 'action' && fits(d) && d.cost <= 4 && d.inkable)
      .sort((a, b) => simple(a) - simple(b) || a.cost - b.cost), 1);
    const locations = pick(canon.filter((d) => d.type === 'location' && fits(d) && isFullyAutomated(d))
      .sort((a, b) => (b.lore || 0) - (a.lore || 0) || a.cost - b.cost), 1);

    const names = [...picked, ...songs, ...actions, ...locations];
    // pad with more characters until we have 15 names (60 cards)
    names.push(...pick(chars, 15 - names.length));
    const cards = names.slice(0, 15).map((d) => [d.id, 4]);
    const total = cards.reduce((a, [, q]) => a + q, 0);
    if (total < 60) continue; // not enough cards in this ink pair (shouldn't happen)
    decks.push({ id: pair.inks.join('-'), name: pair.name, inks: pair.inks, cards });
  }
  return decks;
}
