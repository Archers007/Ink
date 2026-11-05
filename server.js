// Ink — Lorcana deck builder and online table.
//
// Responsibilities:
//   1. Static-serve the frontend (public/).
//   2. Cache dreamborn.ink's public cards.db (as cache/dreamborn.db) (SQLite), merge Ravensburger's
//      card data onto it (tools/import-cards.mjs → cache/sanitized.db) and serve them to the browser, which queries
//      them in-place via sql.js.
//   3. Proxy dreamborn's auth flow (Firebase identitytoolkit -> dreamborn session
//      cookie -> user collection) so the browser doesn't fight CORS / cookies.
//   4. Keep a small persistent SQLite DB (data/ink.db) that survives restarts: site visits
//      (read-only at /api/stats) plus accounts and their decks (lib/accounts.js).

import express from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { loadCardIndex, resolveDeck } from './game/cards.js';
import * as procLookup from './game/procs/lookup.js';
import { rolesForIndex } from './game/procs/roles.js';
import { attachLobby } from './game/lobby.js';
import { attachAccounts } from './lib/accounts.js';
import { attachSim } from './lib/sim.js';
import { attachLab } from './lib/lab.js';
import { attachReplays } from './lib/replays.js';
import { attachReports } from './lib/reports.js';
import { dreamborn as dreambornClient } from './lib/dreamborn.js';
import { attachExtCallsAdmin } from './lib/extcalls/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const CACHE_DIR = path.join(__dirname, 'cache');
// data/ holds app-owned state we never want wiped (unlike cache/, which is just
// re-downloadable copies of dreamborn's DBs).
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Every call to dreamborn.ink (and to Firebase for Dreamborn sign-in) goes through lib/dreamborn.js, which records it
// in data/extcalls.db for /admin → External calls (lib/extcalls).

await fs.mkdir(CACHE_DIR, { recursive: true });
await fs.mkdir(DATA_DIR, { recursive: true });

// ---------- persistent stats DB (node:sqlite) ----------
// node:sqlite is a built-in (Node 22.5+). We import it lazily and degrade
// gracefully: if it's unavailable, visit tracking is simply a no-op so the rest
// of the app keeps working.
let statsDb = null;
try {
  const { DatabaseSync } = await import('node:sqlite');
  statsDb = new DatabaseSync(path.join(DATA_DIR, 'ink.db'));
  statsDb.exec('PRAGMA journal_mode = WAL');
  statsDb.exec(`
    CREATE TABLE IF NOT EXISTS visits (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,          -- unix epoch (ms)
      day     TEXT    NOT NULL,          -- YYYY-MM-DD (UTC), for fast per-day rollups
      path    TEXT,
      referer TEXT,
      ua      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_visits_day ON visits(day);
  `);
  console.log('[stats] visit DB ready at', path.join(DATA_DIR, 'ink.db'));
} catch (e) {
  console.warn('[stats] visit tracking disabled (node:sqlite unavailable):', e.message);
}

function recordVisit(req) {
  if (!statsDb) return;
  try {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    statsDb
      .prepare('INSERT INTO visits (ts, day, path, referer, ua) VALUES (?, ?, ?, ?, ?)')
      .run(now, day, String(req.path || '').slice(0, 256),
           String(req.get('referer') || '').slice(0, 256),
           String(req.get('user-agent') || '').slice(0, 256));
  } catch (e) {
    // Never let analytics break a page load.
    console.warn('[stats] recordVisit failed:', e.message);
  }
}

function readStats() {
  if (!statsDb) return { ok: false, total: 0, today: 0 };
  try {
    const today = new Date().toISOString().slice(0, 10);
    const total = statsDb.prepare('SELECT COUNT(*) AS n FROM visits').get().n;
    const todayN = statsDb.prepare('SELECT COUNT(*) AS n FROM visits WHERE day = ?').get(today).n;
    return { ok: true, total: Number(total) || 0, today: Number(todayN) || 0 };
  } catch (e) {
    return { ok: false, total: 0, today: 0, error: e.message };
  }
}

// ---------- DB cache ----------
// cache/dreamborn.db: dreamborn's cards.db, downloaded again once it's an hour old
async function ensureCardsDb(maxAgeMs = 60 * 60 * 1000) {
  const target = path.join(CACHE_DIR, 'dreamborn.db');
  try {
    const stat = await fs.stat(target);
    if (Date.now() - stat.mtimeMs < maxAgeMs) return target;
  } catch { /* not cached yet */ }
  console.log('[cache] fetching dreamborn cards.db');
  const { bytes } = await dreambornClient.downloadCardsDb(target, { caller: 'cards' });
  console.log(`[cache] wrote ${target} (${bytes} bytes)`);
  return target;
}

// cache/sanitized.db = dreamborn's printings + Ravensburger's card data (tools/import-cards.mjs), procs compiled into
// cache/proc.db. Rebuilt when dreamborn's file is newer, and daily so the official page is re-read.
const OFFICIAL_MAX_AGE = 24 * 60 * 60 * 1000;
let building = null;
async function ensureCards() {
  const dreamborn = await ensureCardsDb();
  const target = path.join(CACHE_DIR, 'sanitized.db');
  const mtime = (f) => fs.stat(f).then((x) => x.mtimeMs).catch(() => 0);
  const built = await mtime(target);
  const stale = Date.now() - (await mtime(path.join(CACHE_DIR, 'official.html'))) > OFFICIAL_MAX_AGE;
  if (built && built >= (await mtime(dreamborn)) && !stale) return target;
  building ||= (async () => {
    const run = promisify(execFile);
    console.log(`[cards] importing${stale ? ' (re-reading the official page)' : ''}…`);
    await run(process.execPath, ['tools/import-cards.mjs', ...(stale ? ['--refresh'] : [])], { cwd: __dirname });
    await run(process.execPath, ['tools/compile-procs.mjs'], { cwd: __dirname });
    console.log('[cards] cache/sanitized.db + proc.db rebuilt');
  })().finally(() => { building = null; });
  try { await building; } catch (e) {
    if (!built) throw e;                                  // nothing to fall back on
    console.error('[cards] import failed, keeping the last sanitized.db:', e.message);
  }
  return target;
}

// Warm both DBs on boot so the first user gets a fast page.
(async () => {
  try {
    await ensureCards();
  } catch (e) {
    console.error('[cache] warmup failed:', e.message);
  }
  await refreshCardIndex();
})();

// ---------- Play mode: card index for the rules engine ----------
// Built from the same imported sanitized.db; rebuilt whenever it or proc.db is rebuilt.
let cardIndex = null;
async function refreshCardIndex() {
  try {
    const file = await ensureCards();
    const built = (f) => fs.stat(path.join(CACHE_DIR, f)).then((x) => x.mtimeMs).catch(() => 0);
    const mtime = (await built('sanitized.db')) + (await built('proc.db'));    // rebuild on a new import or rebuilt procs
    if (cardIndex && cardIndex.mtime === mtime) return;
    const idx = await loadCardIndex(file);
    idx.mtime = mtime;
    cardIndex = idx;
    console.log(`[play] card index ready: ${idx.size} cards, ${idx.demoDecks.length} demo decks`);
  } catch (e) {
    console.error('[play] card index failed:', e.message);
  }
}
setInterval(refreshCardIndex, 60 * 60 * 1000).unref();

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '512kb' }));
app.set('trust proxy', 'loopback, linklocal, uniquelocal');   // cloudflared / a reverse proxy on the LAN sets X-Forwarded-Proto

// Discord / Google sign-in + server-side decks (lib/accounts.js)
const accounts = attachAccounts(app, {
  db: statsDb,
  summarize: (cards) => { if (!cardIndex) return {}; const r = resolveDeck(cardIndex, { cards }); return { size: r.size, inks: r.inks, legal: r.legal }; },
  // a deck's cards by name, for the admin page's look at a player's decks
  describe: (cards) => cards.map(([id, qty]) => { const c = cardIndex?.byId.get(String(id)); return { id: String(id), qty, name: c?.full || `unknown card ${id}`, cost: c?.cost ?? null, inks: c?.inks || [], type: c?.type || '' }; }),
});
// the /admin issue board: reports that become GitHub issues, fixed by Claude on the maintainer's machine (lib/reports.js)
attachReports(app, { db: statsDb, accounts, dataDir: DATA_DIR });
// /admin → External calls: every call Ink makes to Dreamborn (and later duels.ink), from data/extcalls.db (lib/extcalls)
attachExtCallsAdmin(app, { accounts });

// Count one visit per top-level HTML page load (real navigations only — not API
// calls, the .db downloads, or static assets like /css, /js, the favicon).
app.use((req, res, next) => {
  if (req.method === 'GET' &&
      !req.path.startsWith('/api/') &&
      (req.get('accept') || '').includes('text/html') &&
      !/\.[a-z0-9]+$/i.test(req.path)) {
    recordVisit(req);
  }
  next();
});

// Site visit stats, backed by the persistent SQLite DB.
app.get('/api/stats', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(readStats());
});

// Simple in-memory session store: sessionId -> { uid, displayName, cookie, idToken, refreshToken, exp }
const sessions = new Map();
function newSessionId() {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ----- DB downloads (browser fetches these and queries via sql.js) -----
app.get('/api/sanitized.db', async (req, res) => {
  try {
    const p = await ensureCards();
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
    // Firebase password sign-in, exchanged for the dreamborn __session cookie (lib/dreamborn.js)
    const { uid: localId, cookie: sessionCookie, user: drJson, idToken, refreshToken, expiresIn } =
      await dreambornClient.signIn(email, password, { caller: 'route:/api/login', userId: accounts.userFromReq?.(req)?.id });

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
    // Firebase or dreamborn said no: pass their answer on, as before
    if (e.step === 'firebase') return res.status(e.status).json({ error: e.message, detail: e.detail });
    if (e.step === 'login') return res.status(e.status || 502).json({ error: 'dreamborn login failed', detail: e.detail });
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
    const { ok, status, data: j } = await dreambornClient.ownedCards(s.uid, s.cookie, { caller: 'route:/api/collection', userId: accounts.userFromReq?.(req)?.id });
    if (!ok) return res.status(status).json({ error: 'collection fetch failed', detail: j });
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

    // If the user is signed in, forward their dreamborn session cookie so
    // paginated / source=following / favorites lookups work.
    const sid = parseSid(req);
    const sess = sid && sessions.get(sid);
    const r = await dreambornClient.listDecks(params, { cookie: sess?.cookie || undefined, caller: 'route:/api/decks', userId: accounts.userFromReq?.(req)?.id });
    const j = r.data;
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
    const r = await dreambornClient.deck(id, { caller: 'route:/api/decks/:id', userId: accounts.userFromReq?.(req)?.id });
    if (!r.ok) return res.status(r.status).json({ error: 'dreamborn deck page failed', status: r.status });
    const parsed = r.deck;
    if (!parsed) return res.status(502).json({ error: 'could not parse deck payload' });
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ ok: true, deck: parsed });
  } catch (e) {
    console.error('[deck-detail]', e);
    res.status(502).json({ error: e.message });
  }
});

// ----- front-end build id (silent updates, public/js/version.js) -----
// A hash of everything the browser loads from this checkout (public/ and the shared rulebook modules), taken at start,
// so it changes on every deploy that changes a front-end file — no git needed inside Docker. INK_BUILD overrides it.
function frontendBuildId() {
  const h = createHash('sha256');
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(dir, e.name), r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) { h.update(r); h.update('\0'); h.update(fsSync.readFileSync(p)); h.update('\0'); }
    }
  };
  walk(PUBLIC_DIR, 'public');
  walk(path.join(__dirname, 'game', 'rulebook'), 'rulebook');
  return h.digest('hex').slice(0, 16);
}
const FRONTEND_BUILD = String(process.env.INK_BUILD || '').trim() || frontendBuildId();
app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ version: FRONTEND_BUILD });
});
// the build the page's own files came with (the SW caches it alongside the rest of the shell, so an old cached shell
// reports its old build and the updater notices)
app.get('/js/build.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('text/javascript').send(`export const BUILD = ${JSON.stringify(FRONTEND_BUILD)};\n`);
});
// the service worker carries the build in its cache name, so every deploy installs a new worker that precaches a
// fresh shell and drops the old one
app.get('/sw.js', async (req, res, next) => {
  try {
    const src = await fs.readFile(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
    res.set('Cache-Control', 'no-cache');
    res.type('text/javascript').send(src.replace(/const VERSION = '([^']*)';/, (m, v) => `const VERSION = '${v}-${FRONTEND_BUILD}';`));
  } catch (e) { next(); }
});

// ----- static -----
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders(res, file) { if (file.endsWith(`${path.sep}sw.js`)) res.set('Cache-Control', 'no-cache'); },   // a new service worker is picked up on the next load
}));

// the rulebook modules the client shares with the engine (deck construction limits)
app.use('/rulebook', express.static(path.join(__dirname, 'game', 'rulebook'), { index: false }));

// three.js for the Play board (served from node_modules, no CDN needed)
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three'), { maxAge: '7d' }));

// Demo decks for Play mode (also sent over the socket; handy for curl/debugging)
// The card rules page (/rules, public/procs.html). Everyone sees each card's text, keywords, official FAQ and which
// abilities Ink runs for you; how the engine compiles them (procs, read-backs, coverage) is for admins only.
const isAdmin = (req) => { const u = accounts.userFromReq(req); return !!u && !u.guest && u.role === 'admin'; };
app.get('/rules', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'procs.html')));
let rulesDb = null;
function officialRules(full) {
  try {
    rulesDb ||= new statsDb.constructor(path.join(CACHE_DIR, 'sanitized.db'), { readOnly: true });   // node:sqlite's DatabaseSync, loaded above
    const r = rulesDb.prepare('SELECT faq, printed FROM rules WHERE card_key = ?').get(full);
    const faq = (JSON.parse(r?.faq || '[]') || []).map((f) => String(f.body || '')).join('\n\n');
    // Ravensburger's FAQ is one text blob of "Q: … A: …" pairs
    const qa = [...faq.replace(/\r/g, '').matchAll(/Q:\s*([\s\S]*?)\n\s*A:\s*([\s\S]*?)(?=\n\s*Q:|$)/g)].map((m) => ({ q: m[1].trim(), a: m[2].trim() }));
    return { faq: qa.length || !faq.trim() ? qa : [{ q: '', a: faq.trim() }], printed: r?.printed || null };
  } catch { return { faq: [], printed: null }; }
}
app.get('/api/procs/search', (req, res) => {
  if (!cardIndex) return res.status(503).json({ error: 'card index loading' });
  const engine = isAdmin(req) && req.query.engine === '1';
  res.set('Cache-Control', 'private, no-store');
  res.json(procLookup.search(cardIndex, String(req.query.q || '').slice(0, 200), Math.min(400, Number(req.query.limit) || 40), { engine }));
});
app.get('/api/procs/card', (req, res) => {
  if (!cardIndex) return res.status(503).json({ error: 'card index loading' });
  const full = String(req.query.full || '');
  const pub = procLookup.publicCard(cardIndex, full);
  if (!pub) return res.status(404).json({ error: 'no such card' });
  res.set('Cache-Control', 'private, no-store');
  res.json({ ...pub, ...officialRules(pub.full), ...(isAdmin(req) ? { engine: procLookup.card(cardIndex, pub.full) } : {}) });
});
// Deck-builder role tags (removal, card draw, ramp…) and class payoffs, read off each card's compiled procs
let rolesCache = null;
app.get('/api/cards/roles', (req, res) => {
  if (!cardIndex) return res.status(503).json({ error: 'card index loading' });
  if (rolesCache?.at !== cardIndex.loadedAt) rolesCache = { at: cardIndex.loadedAt, body: rolesForIndex(cardIndex) };
  res.set('Cache-Control', 'public, max-age=600');
  res.json(rolesCache.body);
});
app.get('/api/procs/stats', (req, res) => {
  if (!accounts.requireRole(req, res, 'admin')) return;
  if (!cardIndex) return res.status(503).json({ error: 'card index loading' });
  res.json(procLookup.stats(cardIndex));
});

// Size / inks / legality / cover card for the lobby's deck tiles: { decks: [{ id, cards }] } → { [id]: summary }
app.post('/api/play/deck-check', (req, res) => {
  if (!cardIndex) return res.status(503).json({ error: 'card index loading' });
  const out = {};
  for (const d of (Array.isArray(req.body?.decks) ? req.body.decks : []).slice(0, 300)) {
    const r = resolveDeck(cardIndex, { name: d?.name, cards: Array.isArray(d?.cards) ? d.cards : [] });
    // the tile's card: the one the player chose (#26), else the character with the most copies, then the costliest
    const chosen = d?.cover != null && [...r.counts].some(([id]) => String(id) === String(d.cover)) ? cardIndex.byId.get(String(d.cover)) : null;
    const cover = chosen ? { def: chosen } : [...r.counts].map(([id, q]) => ({ id, q, def: cardIndex.byId.get(String(id)) }))
      .sort((a, b) => (b.def?.type === 'character') - (a.def?.type === 'character') || b.q - a.q || (b.def?.cost || 0) - (a.def?.cost || 0))[0];
    out[String(d?.id)] = { size: r.size, inks: r.inks, legal: r.legal, problems: [...r.errors, ...r.problems].slice(0, 6), cover: cover?.def?.id ?? null };
  }
  res.json(out);
});

app.get('/api/play/demo-decks', (req, res) => {
  if (!cardIndex) return res.status(503).json({ error: 'card index loading' });
  res.json(cardIndex.demoDecks);
});

// saved games, replays and bot training (lib/replays.js)
const replays = attachReplays(app, { db: statsDb, dbFile: path.join(DATA_DIR, 'ink.db'), cardsDb: path.join(CACHE_DIR, 'sanitized.db'), getIndex: () => cardIndex, accounts });

// deck simulations (lib/sim.js)
attachSim(app, { db: statsDb, getIndex: () => cardIndex, accounts });

// the Deck Lab: a live AI deck builder (lib/lab.js)
attachLab(app, { db: statsDb, getIndex: () => cardIndex, accounts, dbFile: path.join(CACHE_DIR, 'sanitized.db') });

const server = app.listen(PORT, () => {
  console.log(`\n  Ink ▸ http://localhost:${PORT}\n`);
});
attachLobby(server, {
  getIndex: () => cardIndex,
  userFromReq: accounts.userFromReq,
  onGameOver: (rec) => replays.save(rec),
});
