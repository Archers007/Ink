// Ink — Lorcana deck builder w/ AI, themed like the web in 1996.
//
// Responsibilities:
//   1. Static-serve the frontend (public/).
//   2. Cache dreamborn.ink's public cards.db / prices.db (SQLite) and serve them
//      to the browser, which queries them in-place via sql.js.
//   3. Proxy dreamborn's auth flow (Firebase identitytoolkit -> dreamborn session
//      cookie -> user collection) so the browser doesn't fight CORS / cookies.
//   4. Optionally proxy an AI provider (OpenAI or Anthropic) so users don't have
//      to paste an API key into the browser.

import express from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const CACHE_DIR = path.join(__dirname, 'cache');
const PUBLIC_DIR = path.join(__dirname, 'public');

// dreamborn endpoints
const FIREBASE_KEY = 'AIzaSyBKtYUafFcgqlYmUTz6HTRKuJhJsHHRPsU'; // public anon key, same as their web app
const FIREBASE_SIGNIN = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`;
const DREAMBORN_LOGIN = 'https://dreamborn.ink/api/auth/login';
const DREAMBORN_USER  = 'https://dreamborn.ink/api/user';
const DREAMBORN_OWNED = (uid) => `https://dreamborn.ink/api/users/${encodeURIComponent(uid)}/owned-cards`;
const DREAMBORN_DECKS = 'https://dreamborn.ink/api/v2/decks';
const DREAMBORN_DECK_PAGE = (id) => `https://dreamborn.ink/decks/${encodeURIComponent(id)}`;
const CARDS_DB_URL    = 'https://dreamborn.ink/cache/en/cards.db';
const PRICES_DB_URL   = (currency = 'USD') => `https://dreamborn.ink/cache/prices/${currency}/prices.db`;

const COMMON_HEADERS = {
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'origin': 'https://dreamborn.ink',
  'referer': 'https://dreamborn.ink/sign-in',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'x-client-version': 'Chrome/JsCore/12.14.0/FirebaseCore-web',
  'x-firebase-gmpid': '1:289000561792:web:5938b5d208e6d79f2d5a65',
};

await fs.mkdir(CACHE_DIR, { recursive: true });

// ---------- DB cache ----------
async function ensureCached(filename, url, maxAgeMs = 60 * 60 * 1000) {
  const target = path.join(CACHE_DIR, filename);
  try {
    const stat = await fs.stat(target);
    if (Date.now() - stat.mtimeMs < maxAgeMs) return target;
  } catch { /* not cached yet */ }
  console.log(`[cache] fetching ${url}`);
  const res = await fetch(url, {
    headers: {
      'Referer': 'https://dreamborn.ink/builder',
      'User-Agent': COMMON_HEADERS['user-agent'],
    },
  });
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(target, buf);
  console.log(`[cache] wrote ${target} (${buf.length} bytes)`);
  return target;
}

// Warm both DBs on boot so the first user gets a fast page.
(async () => {
  try {
    await ensureCached('cards.db', CARDS_DB_URL);
    await ensureCached('prices-USD.db', PRICES_DB_URL('USD'));
  } catch (e) {
    console.error('[cache] warmup failed:', e.message);
  }
})();

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '512kb' }));

// Simple in-memory session store: sessionId -> { uid, displayName, cookie, idToken, refreshToken, exp }
const sessions = new Map();
function newSessionId() {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ----- DB downloads (browser fetches these and queries via sql.js) -----
app.get('/api/cards.db', async (req, res) => {
  try {
    const p = await ensureCached('cards.db', CARDS_DB_URL);
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(p);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/prices.db', async (req, res) => {
  try {
    const currency = (req.query.currency || 'USD').toString().toUpperCase().replace(/[^A-Z]/g, '');
    const p = await ensureCached(`prices-${currency}.db`, PRICES_DB_URL(currency));
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(p);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ----- Auth: email/password -> Firebase -> dreamborn session cookie -----
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email + password required' });
  try {
    // 1) Firebase
    const fb = await fetch(FIREBASE_SIGNIN, {
      method: 'POST',
      headers: { ...COMMON_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true, clientType: 'CLIENT_TYPE_WEB' }),
    });
    const fbJson = await fb.json();
    if (!fb.ok) return res.status(fb.status).json({ error: fbJson?.error?.message || 'firebase auth failed', detail: fbJson });

    const { idToken, refreshToken, localId, expiresIn } = fbJson;

    // 2) Exchange for dreamborn session cookie
    const dr = await fetch(DREAMBORN_LOGIN, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'origin': 'https://dreamborn.ink',
        'referer': 'https://dreamborn.ink/sign-in',
        'user-agent': COMMON_HEADERS['user-agent'],
      },
      body: JSON.stringify({ token: idToken }),
    });
    const setCookie = dr.headers.get('set-cookie') || '';
    const drJson = await dr.json().catch(() => ({}));
    if (!dr.ok || !drJson.success) {
      return res.status(dr.status || 502).json({ error: 'dreamborn login failed', detail: drJson });
    }

    // Pull __session cookie (we only need that one for follow-up calls)
    const sessionCookie = setCookie
      .split(/,(?=\s*[A-Za-z0-9_-]+=)/)
      .map((c) => c.trim())
      .find((c) => c.startsWith('__session='));

    const sid = newSessionId();
    sessions.set(sid, {
      uid: localId,
      displayName: drJson.displayName || email,
      settings: drJson.settings || {},
      cookie: sessionCookie || '',
      idToken,
      refreshToken,
      exp: Date.now() + (Number(expiresIn) || 3600) * 1000,
    });

    res.cookie('ink_sid', sid, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 3600 * 1000,
    });
    res.json({
      ok: true,
      uid: localId,
      displayName: drJson.displayName || email,
      settings: drJson.settings || {},
    });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  const sid = parseSid(req);
  if (sid) sessions.delete(sid);
  res.clearCookie('ink_sid');
  res.json({ ok: true });
});

function parseSid(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === 'ink_sid') return v;
  }
  return null;
}
function requireSession(req, res) {
  const sid = parseSid(req);
  const s = sid && sessions.get(sid);
  if (!s) { res.status(401).json({ error: 'not signed in' }); return null; }
  return s;
}

app.get('/api/me', (req, res) => {
  const sid = parseSid(req);
  const s = sid && sessions.get(sid);
  if (!s) return res.json({ ok: false });
  res.json({ ok: true, uid: s.uid, displayName: s.displayName, settings: s.settings });
});

app.get('/api/collection', async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  try {
    const r = await fetch(DREAMBORN_OWNED(s.uid), {
      headers: {
        'accept': '*/*',
        'cookie': s.cookie,
        'user-agent': COMMON_HEADERS['user-agent'],
        'referer': 'https://dreamborn.ink/collection',
      },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: 'collection fetch failed', detail: j });
    res.json({ ok: true, owned: j });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ----- Deck browser: proxy dreamborn's public deck index + scrape individual decks. -----
//
// /api/decks   -> list of decks with filters (sort, format, archetype, color, q, page).
// /api/decks/:id -> single deck with cards + decoded pbCode (Name_Subtitle$qty|...).

app.get('/api/decks', async (req, res) => {
  try {
    const params = new URLSearchParams();
    params.set('currency', (req.query.currency || 'USD').toString());
    params.set('sort',     (req.query.sort     || 'popular').toString());
    params.set('archetype',(req.query.archetype|| '').toString());
    params.set('format',   (req.query.format   || '').toString());
    params.set('page',     (req.query.page     || '1').toString());
    // Note: dreamborn's /api/v2/decks does NOT accept ?q= or ?color= and 400s when
    // they're present.  We filter those client-side on our side after the fetch.

    const url = `${DREAMBORN_DECKS}?${params}`;
    // If the user is signed in, forward their dreamborn session cookie so
    // paginated / source=following / favorites lookups work.
    const sid = parseSid(req);
    const sess = sid && sessions.get(sid);
    const r = await fetch(url, {
      headers: {
        'accept': 'application/json',
        'user-agent': COMMON_HEADERS['user-agent'],
        'referer': 'https://dreamborn.ink/decks',
        ...(sess?.cookie ? { 'cookie': sess.cookie } : {}),
      },
    });
    const j = await r.json().catch(() => ({ error: 'non-json' }));
    if (!r.ok) return res.status(r.status).json({ error: 'dreamborn decks failed', detail: j });

    // dreamborn returns an array. Client-side filter for color/q if asked,
    // since their v2 endpoint may ignore them.
    let decks = Array.isArray(j) ? j : (j.data || j.items || []);
    const colors = (req.query.color || '').toString().toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    const qstr   = (req.query.q || '').toString().toLowerCase().trim();
    if (colors.length) {
      decks = decks.filter((d) => {
        const dc = (d.colors || []).map((x) => x.toLowerCase());
        return colors.every((c) => dc.includes(c));
      });
    }
    if (qstr) {
      decks = decks.filter((d) =>
        (d.name || '').toLowerCase().includes(qstr) ||
        (d.creatorName || '').toLowerCase().includes(qstr) ||
        (d.description || '').toLowerCase().includes(qstr));
    }
    res.set('Cache-Control', 'public, max-age=120');
    res.json({ ok: true, page: Number(params.get('page')), count: decks.length, decks });
  } catch (e) {
    console.error('[decks]', e);
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/decks/:id', async (req, res) => {
  const id = (req.params.id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return res.status(400).json({ error: 'bad deck id' });
  try {
    const r = await fetch(DREAMBORN_DECK_PAGE(id), {
      headers: {
        'accept': 'text/html',
        'user-agent': COMMON_HEADERS['user-agent'],
        'referer': 'https://dreamborn.ink/decks',
      },
    });
    if (!r.ok) return res.status(r.status).json({ error: 'dreamborn deck page failed', status: r.status });
    const html = await r.text();
    const parsed = parseDreambornDeckHTML(html, id);
    if (!parsed) return res.status(502).json({ error: 'could not parse deck payload' });
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ ok: true, deck: parsed });
  } catch (e) {
    console.error('[deck-detail]', e);
    res.status(502).json({ error: e.message });
  }
});

// Pull the Nuxt 3 SSR payload out of dreamborn's HTML and resolve the dedup'd
// references back into a plain deck object. The Nuxt payload is a JSON array
// where compound values reference each other by integer index.
function parseDreambornDeckHTML(html, id) {
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
  const totalPrice  = ref(deckObj.totalPrice);
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
    totalPrice: Number(totalPrice) || 0,
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

// ----- AI proxy (optional). Supports OpenAI & Anthropic. -----
app.get('/api/ai/config', (req, res) => {
  res.json({
    provider: process.env.OPENAI_API_KEY ? 'openai'
            : process.env.ANTHROPIC_API_KEY ? 'anthropic'
            : null,
    model: process.env.OPENAI_API_KEY ? (process.env.OPENAI_MODEL || 'gpt-4o-mini')
         : process.env.ANTHROPIC_API_KEY ? (process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest')
         : null,
  });
});

app.post('/api/ai/chat', async (req, res) => {
  const { messages, system, max_tokens = 1200, temperature = 0.7 } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages[] required' });

  try {
    if (process.env.OPENAI_API_KEY) {
      const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      const oa = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            ...messages,
          ],
        }),
      });
      const j = await oa.json();
      if (!oa.ok) return res.status(oa.status).json({ error: j?.error?.message || 'openai error', detail: j });
      return res.json({ ok: true, text: j.choices?.[0]?.message?.content ?? '', raw: j });
    }
    if (process.env.ANTHROPIC_API_KEY) {
      const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
      const an = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens,
          temperature,
          system,
          messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
        }),
      });
      const j = await an.json();
      if (!an.ok) return res.status(an.status).json({ error: j?.error?.message || 'anthropic error', detail: j });
      const text = (j.content || []).map((b) => b.text || '').join('');
      return res.json({ ok: true, text, raw: j });
    }
    res.status(501).json({ error: 'no AI provider configured on server; set OPENAI_API_KEY or ANTHROPIC_API_KEY' });
  } catch (e) {
    console.error('[ai]', e);
    res.status(500).json({ error: e.message });
  }
});

// ----- static -----
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`\n  Ink ▸ http://localhost:${PORT}\n`);
});
