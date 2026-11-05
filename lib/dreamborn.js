// The Dreamborn client: the one place Ink talks to dreamborn.ink (and to Firebase for Dreamborn sign-in). Every call
// goes through extFetch (lib/extcalls), so it shows up on /admin → External calls. Used by server.js (cards.db,
// /api/login, /api/collection, /api/decks, /api/decks/:id), tools/fetch-meta-decks.mjs and scripts/build-cards.mjs.
//
// Polite by construction: at most 2 requests in flight to dreamborn.ink and 250 ms between starts; deck lists are
// cached 60 s and parsed deck pages 6 h (a cache hit is recorded with cache 'hit', no network).
// Sign-in and the collection carry a password, a Firebase token and a session cookie: their rows keep only
// method/host/masked path/status/timing/size, never a body, header or cookie, and the Firebase key is redacted.
//
// Also here: dreamborn.ink deck pages, the Nuxt 3 SSR payload a deck page embeds, resolved into a plain deck object
// with the decklist (pbCode "Name_Subtitle$qty|…" and the card-id map).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { extFetch, recordCall } from './extcalls/index.js';

export const DREAMBORN_DECKS = 'https://dreamborn.ink/api/v2/decks';
export const DREAMBORN_DECK_PAGE = (id) => `https://dreamborn.ink/decks/${encodeURIComponent(id)}`;

const FIREBASE_KEY = 'AIzaSyBKtYUafFcgqlYmUTz6HTRKuJhJsHHRPsU'; // public anon key, same as their web app
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
export const COMMON_HEADERS = {
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'origin': 'https://dreamborn.ink',
  'referer': 'https://dreamborn.ink/sign-in',
  'user-agent': UA,
  'x-client-version': 'Chrome/JsCore/12.14.0/FirebaseCore-web',
  'x-firebase-gmpid': '1:289000561792:web:5938b5d208e6d79f2d5a65',
};

// base URLs and politeness; tests point these at a local server (configureDreamborn, or the env vars)
const cfg = {
  base: process.env.INK_DREAMBORN_BASE || 'https://dreamborn.ink',
  firebase: process.env.INK_FIREBASE_BASE || 'https://identitytoolkit.googleapis.com',
  maxInFlight: 2,
  gapMs: 250,
  decksTtl: 60 * 1000,
  deckTtl: 6 * 60 * 60 * 1000,
};
export function configureDreamborn(opts = {}) {
  Object.assign(cfg, opts);
  cache.clear();
}

// ----- politeness: a tiny queue in front of dreamborn.ink -----
let active = 0, lastStart = 0, wake = null;
const waiting = [];
function pump() {
  while (waiting.length && active < cfg.maxInFlight) {
    const wait = lastStart + cfg.gapMs - Date.now();
    if (wait > 0) { wake ||= setTimeout(() => { wake = null; pump(); }, wait); return; }
    const job = waiting.shift();
    active++;
    lastStart = Date.now();
    Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active--; pump(); });
  }
}
// runs fn (which fetches and reads the body) once a slot is free
const polite = (fn) => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); pump(); });

// ----- a small in-memory cache -----
const cache = new Map();
const CACHE_MAX = 500;
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (e.exp < Date.now()) { cache.delete(key); return null; }
  return e.value;
}
function cacheSet(key, value, ttl) {
  cache.delete(key);
  cache.set(key, { value, exp: Date.now() + ttl });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}
// a signed-in list is cached apart from the public one, keyed by a hash rather than the cookie itself
const cookieKey = (cookie) => (cookie ? createHash('sha256').update(cookie).digest('hex').slice(0, 16) : '');

const SRC = 'dreamborn';
const ownedMask = (p) => p.replace(/\/api\/users\/[^/]+\/owned-cards/, '/api/users/:uid/owned-cards');

// a sign-in that Firebase or Dreamborn turned down: `step` says which, `status`/`detail` are what they answered
export class DreambornError extends Error {
  constructor(step, status, message, detail) {
    super(message);
    this.step = step;
    this.status = status;
    this.detail = detail;
  }
}

const inflightDownloads = new Map();

export const dreamborn = {
  // dreamborn's public cards.db, streamed to destFile (written beside it, then renamed in). ifNewerThan (ms): ask
  // with If-Modified-Since and leave the file alone on a 304. → { file, changed, status, bytes }
  downloadCardsDb(destFile, { ifNewerThan, caller = 'cards' } = {}) {
    if (inflightDownloads.has(destFile)) return inflightDownloads.get(destFile);
    const url = `${cfg.base}/cache/en/cards.db`;
    const p = polite(async () => {
      const headers = { 'Referer': 'https://dreamborn.ink/builder', 'User-Agent': UA };
      if (ifNewerThan) headers['If-Modified-Since'] = new Date(ifNewerThan).toUTCString();
      const res = await extFetch(url, { headers }, { source: SRC, kind: 'cardsdb', caller });
      if (res.status === 304) { await res.arrayBuffer().catch(() => {}); return { file: destFile, changed: false, status: 304, bytes: 0 }; }
      if (!res.ok) {
        await res.arrayBuffer().catch(() => {});
        throw new Error(`fetch ${url} -> HTTP ${res.status}`);
      }
      const tmp = `${destFile}.${process.pid}.${Date.now()}.tmp`;
      try {
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
        const bytes = (await fsp.stat(tmp)).size;
        // a reader holding the old file open on Windows can refuse the rename; copy over it then
        await fsp.rename(tmp, destFile).catch(async () => { await fsp.copyFile(tmp, destFile); await fsp.rm(tmp, { force: true }); });
        return { file: destFile, changed: true, status: res.status, bytes };
      } catch (e) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
    }).finally(() => inflightDownloads.delete(destFile));
    inflightDownloads.set(destFile, p);
    return p;
  },

  // email + password → Firebase idToken → Dreamborn __session cookie. Throws DreambornError when either says no.
  // → { uid, cookie, user (Dreamborn's login reply), idToken, refreshToken, expiresIn }
  async signIn(email, password, { caller = 'route:/api/login', userId } = {}) {
    // nothing of either call's body is kept: the request has the password, the replies have tokens
    const fb = await extFetch(`${cfg.firebase}/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`, {
      method: 'POST',
      headers: { ...COMMON_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true, clientType: 'CLIENT_TYPE_WEB' }),
    }, { source: SRC, kind: 'firebase-signin', caller, userId });
    const fbJson = await fb.json();
    if (!fb.ok) throw new DreambornError('firebase', fb.status, fbJson?.error?.message || 'firebase auth failed', fbJson);
    const { idToken, refreshToken, localId, expiresIn } = fbJson;

    const { dr, drJson } = await polite(async () => {
      const r = await extFetch(`${cfg.base}/api/auth/login`, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'origin': 'https://dreamborn.ink',
          'referer': 'https://dreamborn.ink/sign-in',
          'user-agent': UA,
        },
        body: JSON.stringify({ token: idToken }),
      }, { source: SRC, kind: 'login', caller, userId });
      return { dr: r, drJson: await r.json().catch(() => ({})) };
    });
    if (!dr.ok || !drJson.success) throw new DreambornError('login', dr.status, 'dreamborn login failed', drJson);

    // only the __session cookie matters for follow-up calls
    const sessionCookie = (dr.headers.get('set-cookie') || '')
      .split(/,(?=\s*[A-Za-z0-9_-]+=)/)
      .map((c) => c.trim())
      .find((c) => c.startsWith('__session='));
    return { uid: localId, cookie: sessionCookie || '', user: drJson, idToken, refreshToken, expiresIn };
  },

  // the signed-in Dreamborn user. → { status, ok, data }
  user(cookie, { caller, userId } = {}) {
    return polite(async () => {
      const r = await extFetch(`${cfg.base}/api/user`, {
        headers: { 'accept': 'application/json', 'cookie': cookie || '', 'user-agent': UA, 'referer': 'https://dreamborn.ink/' },
      }, { source: SRC, kind: 'user', caller, userId });
      return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) };
    });
  },

  // a user's collection. → { status, ok, data }
  ownedCards(uid, cookie, { caller = 'route:/api/collection', userId } = {}) {
    return polite(async () => {
      const r = await extFetch(`${cfg.base}/api/users/${encodeURIComponent(uid)}/owned-cards`, {
        headers: { 'accept': '*/*', 'cookie': cookie || '', 'user-agent': UA, 'referer': 'https://dreamborn.ink/collection' },
      }, { source: SRC, kind: 'owned', caller, userId, maskPath: ownedMask });
      return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) };
    });
  },

  // the public deck index (/api/v2/decks), a signed-in user's cookie forwarded when given. → { status, ok, data, cached? }
  // `data` may be shared with other callers through the cache: read it, don't change it.
  listDecks(params = {}, { cookie, caller, userId } = {}) {
    const qs = (params instanceof URLSearchParams ? params : new URLSearchParams(params)).toString();
    const url = `${cfg.base}/api/v2/decks?${qs}`;
    const key = `decks?${qs}#${cookieKey(cookie)}`;
    const hit = cacheGet(key);
    if (hit) {
      recordCall({ url, source: SRC, kind: 'decks', method: 'GET', status: hit.status, ok: 1, ms: 0, bytes: 0, cache: 'hit', caller, userId });
      return Promise.resolve({ status: hit.status, ok: true, data: hit.data, cached: true });
    }
    return polite(async () => {
      const r = await extFetch(url, {
        headers: { 'accept': 'application/json', 'user-agent': UA, 'referer': 'https://dreamborn.ink/decks', ...(cookie ? { cookie } : {}) },
      }, { source: SRC, kind: 'decks', caller, userId, cache: 'miss', keepBody: true });
      const data = await r.json().catch(() => ({ error: 'non-json' }));
      if (r.ok) cacheSet(key, { status: r.status, data }, cfg.decksTtl);
      return { status: r.status, ok: r.ok, data };
    });
  },

  // one deck page, parsed (parseDreambornDeckHTML). → { status, ok, deck (null when it wouldn't parse), cached? }
  deck(id, { caller, userId, ref } = {}) {
    const url = `${cfg.base}/decks/${encodeURIComponent(id)}`;
    const key = `deck:${id}`;
    const hit = cacheGet(key);
    if (hit) {
      recordCall({ url, source: SRC, kind: 'deck', method: 'GET', status: 200, ok: 1, ms: 0, bytes: 0, cache: 'hit', caller, userId, ref });
      return Promise.resolve({ status: 200, ok: true, deck: hit.deck, cached: true });
    }
    return polite(async () => {
      // the row keeps the parsed deck, not the page's HTML; parsed once, here, as the body ends
      let parsed;
      const r = await extFetch(url, {
        headers: { 'accept': 'text/html', 'user-agent': UA, 'referer': 'https://dreamborn.ink/decks' },
      }, {
        source: SRC, kind: 'deck', caller, userId, ref, cache: 'miss', bodyType: 'application/json',
        keepBody: (html, res) => {
          if (!res.ok) return null;
          parsed = parseDreambornDeckHTML(html, id);
          return parsed ? JSON.stringify(parsed) : null;
        },
      });
      const html = await r.text();
      if (!r.ok) return { status: r.status, ok: false, deck: null };
      if (parsed === undefined) parsed = parseDreambornDeckHTML(html, id);
      if (parsed) cacheSet(key, { deck: parsed }, cfg.deckTtl);
      return { status: r.status, ok: true, deck: parsed || null };
    });
  },

  clearCache() { cache.clear(); },
};

// Pull the Nuxt 3 SSR payload out of dreamborn's HTML and resolve the dedup'd
// references back into a plain deck object. The Nuxt payload is a JSON array
// where compound values reference each other by integer index.
export function parseDreambornDeckHTML(html, id) {
  const arr = extractNuxtPayloadArray(html);
  if (!arr) return null;
  const deckObj = findDeckObject(arr, id);
  if (!deckObj) return null;

  // Nuxt 3 SSR payload stores every value at an integer index; an integer
  // field value means "look up arr[idx]".  Resolve exactly one step.
  const ref = (v) => {
    if (typeof v !== 'number' || v < 0 || v >= arr.length) return v;
    return arr[v];
  };
  // Resolve array of refs (e.g. colors list).
  const refArr = (idx) => {
    const a = ref(idx);
    if (!Array.isArray(a)) return [];
    return a.map((x) => ref(x));
  };
  // Resolve key/value object whose values are refs.
  const refObj = (idx) => {
    const o = ref(idx);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = ref(v);
    return out;
  };

  const name        = ref(deckObj.name);
  const creator     = ref(deckObj.creator);
  const creatorName = ref(deckObj.creatorName);
  const colors      = refArr(deckObj.colors);
  const size        = ref(deckObj.size);
  const lastUpdated = ref(deckObj.lastUpdated);
  const likeCount   = ref(deckObj.likeCount);
  const views       = ref(deckObj.views);
  const description = ref(deckObj.description);
  const formats     = refArr(deckObj.formats);
  const pbCode      = ref(deckObj.pbCode);
  const tags        = refObj(deckObj.tags);
  const cardsMap    = refObj(deckObj.cards);  // { dreambornCardId: qty }

  // Decode the deck list from pbCode (Name_Subtitle$Qty|...).
  const cards = [];
  if (typeof pbCode === 'string') {
    try {
      const decoded = Buffer.from(pbCode, 'base64').toString('utf8');
      for (const entry of decoded.split('|')) {
        if (!entry) continue;
        const m = entry.match(/^(.+?)\$(\d+)$/);
        if (!m) continue;
        const left = m[1];
        const qty  = Number(m[2]);
        const us   = left.indexOf('_');
        const cardName  = us >= 0 ? left.slice(0, us) : left;
        const cardTitle = us >= 0 ? left.slice(us + 1) : '';
        cards.push({ name: cardName, title: cardTitle, qty });
      }
    } catch (e) {
      console.warn('[deck] pbCode decode failed:', e.message);
    }
  }

  return {
    id,
    name: typeof name === 'string' ? name : null,
    creator: typeof creator === 'string' ? creator : null,
    creatorName: typeof creatorName === 'string' ? creatorName : null,
    description: typeof description === 'string' ? description : '',
    colors: colors.filter((c) => typeof c === 'string'),
    size: Number(size) || cards.reduce((a, c) => a + c.qty, 0),
    lastUpdated: typeof lastUpdated === 'string' ? lastUpdated : null,
    likeCount: Number(likeCount) || 0,
    views:     Number(views)     || 0,
    formats: formats.filter((f) => typeof f === 'number' || typeof f === 'string'),
    cardIds: Object.entries(cardsMap).map(([cid, qty]) => ({ id: cid, qty: Number(qty) || 0 })),
    cards,
    pbCode: typeof pbCode === 'string' ? pbCode : null,
    sourceUrl: `https://dreamborn.ink/decks/${id}`,
  };
}

function extractNuxtPayloadArray(html) {
  // The Nuxt 3 serialized payload is embedded in a <script>[...]</script> block.
  // We look for one that starts with `[["ShallowReactive"` which is the marker
  // for the reactive store payload.
  const re = /<script[^>]*>(\[\s*\[\s*"ShallowReactive"[\s\S]*?\])<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const arr = JSON.parse(m[1]);
      if (Array.isArray(arr)) return arr;
    } catch { /* skip */ }
  }
  return null;
}

function findDeckObject(arr, expectedId) {
  // The deck record is an object whose keys include name, creator, cards, pbCode.
  for (const v of arr) {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'pbCode' in v && 'cards' in v && 'creator' in v) {
      return v;
    }
  }
  // Fallback: find by id reference
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === expectedId) {
      // walk for an object that references this index as `id`
      for (const v of arr) {
        if (v && typeof v === 'object' && !Array.isArray(v) && v.id === i) return v;
      }
    }
  }
  return null;
}
