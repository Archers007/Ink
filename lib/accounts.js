// Ink accounts — sign in with Discord or Google (OAuth 2.0 authorization-code flow), and keep each
// account's decks in data/ink.db so they follow the player between devices.
//
// Configure with env (either provider alone is fine; an unconfigured one is hidden in the UI):
//   DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET   redirect URI: <PUBLIC_URL>/auth/discord/callback
//   GOOGLE_CLIENT_ID  / GOOGLE_CLIENT_SECRET    redirect URI: <PUBLIC_URL>/auth/google/callback
//   PUBLIC_URL   the site's public origin, e.g. https://ink.example.com (else taken from the request)
//
// Sessions: a random token in an httpOnly cookie; the DB keeps only its SHA-256.

import crypto from 'node:crypto';

const SESSION_COOKIE = 'ink_session';
const STATE_COOKIE = 'ink_oauth';
const SESSION_DAYS = 90;
const MAX_DECKS = 200;
const MAX_DECK_ENTRIES = 200;

const PROVIDERS = {
  discord: {
    label: 'Discord',
    id: () => process.env.DISCORD_CLIENT_ID,
    secret: () => process.env.DISCORD_CLIENT_SECRET,
    authorize: 'https://discord.com/oauth2/authorize',
    token: 'https://discord.com/api/oauth2/token',
    scope: 'identify',
    extra: { prompt: 'none' },
    async profile(accessToken) {
      const u = await getJson('https://discord.com/api/users/@me', accessToken);
      return {
        subject: String(u.id),
        name: u.global_name || u.username || 'Discord player',
        avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : null,
      };
    },
  },
  google: {
    label: 'Google',
    id: () => process.env.GOOGLE_CLIENT_ID,
    secret: () => process.env.GOOGLE_CLIENT_SECRET,
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid profile',
    extra: { prompt: 'select_account' },
    async profile(accessToken) {
      const u = await getJson('https://openidconnect.googleapis.com/v1/userinfo', accessToken);
      return { subject: String(u.sub), name: u.name || u.given_name || 'Google player', avatar: u.picture || null };
    },
  },
};

async function getJson(url, accessToken) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = (n = 32) => crypto.randomBytes(n).toString('base64url');

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) {
  return req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https' || String(process.env.PUBLIC_URL || '').startsWith('https:');
}
function origin(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = isHttps(req) ? 'https' : 'http';
  return `${proto}://${req.get('x-forwarded-host') || req.get('host')}`;
}
// only same-site paths: "/play", never "//evil.com" or "https://…"
function safeNext(s) {
  s = String(s || '/');
  return /^\/(?![/\\])[\w\-./?=&%#]*$/.test(s) ? s : '/';
}

export function configuredProviders() {
  return Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, !!(p.id() && p.secret())]));
}

// Deck payloads match the browser's: { name, cards: [[cardId, qty], …] }
function cleanDeck(body) {
  const name = String(body?.name || '').trim().slice(0, 60);
  if (!name) throw new Error('deck needs a name');
  if (!Array.isArray(body.cards) || body.cards.length > MAX_DECK_ENTRIES) throw new Error('bad card list');
  const cards = [];
  for (const e of body.cards) {
    if (!Array.isArray(e) || e.length !== 2) throw new Error('bad card entry');
    const id = String(e[0]).slice(0, 64), qty = Math.floor(Number(e[1]));
    if (!id || !(qty >= 1 && qty <= 99)) throw new Error('bad card entry');
    cards.push([id, qty]);
  }
  return { name, cards };
}

export function attachAccounts(app, { db }) {
  if (!db) {
    console.warn('[accounts] disabled: no database');
    app.get('/api/account', (req, res) => res.json({ user: null, providers: {}, enabled: false }));
    return { userFromReq: () => null };
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT NOT NULL,
      avatar   TEXT,
      created  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identities (
      provider TEXT NOT NULL,
      subject  TEXT NOT NULL,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (provider, subject)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash     TEXT PRIMARY KEY,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decks (
      id       TEXT PRIMARY KEY,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name     TEXT NOT NULL,
      cards    TEXT NOT NULL,          -- JSON [[cardId, qty], …]
      updated  INTEGER NOT NULL,
      UNIQUE (user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_decks_user ON decks(user_id);
  `);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());

  const q = {
    identity: db.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?'),
    addUser: db.prepare('INSERT INTO users (name, avatar, created) VALUES (?, ?, ?)'),
    touchUser: db.prepare('UPDATE users SET name = ?, avatar = ? WHERE id = ?'),
    addIdentity: db.prepare('INSERT OR IGNORE INTO identities (provider, subject, user_id) VALUES (?, ?, ?)'),
    user: db.prepare('SELECT id, name, avatar FROM users WHERE id = ?'),
    userProviders: db.prepare('SELECT provider FROM identities WHERE user_id = ?'),
    addSession: db.prepare('INSERT INTO sessions (hash, user_id, expires) VALUES (?, ?, ?)'),
    session: db.prepare('SELECT user_id, expires FROM sessions WHERE hash = ?'),
    dropSession: db.prepare('DELETE FROM sessions WHERE hash = ?'),
    decks: db.prepare('SELECT id, name, cards, updated FROM decks WHERE user_id = ? ORDER BY updated DESC'),
    deckCount: db.prepare('SELECT COUNT(*) AS n FROM decks WHERE user_id = ?'),
    deckById: db.prepare('SELECT id, name, cards, updated FROM decks WHERE id = ? AND user_id = ?'),
    deckByName: db.prepare('SELECT id, name, cards, updated FROM decks WHERE user_id = ? AND name = ?'),
    insertDeck: db.prepare('INSERT INTO decks (id, user_id, name, cards, updated) VALUES (?, ?, ?, ?, ?)'),
    updateDeck: db.prepare('UPDATE decks SET name = ?, cards = ?, updated = ? WHERE id = ? AND user_id = ?'),
    deleteDeck: db.prepare('DELETE FROM decks WHERE id = ? AND user_id = ?'),
  };

  function userFromReq(req) {
    const raw = cookies(req)[SESSION_COOKIE];
    if (!raw) return null;
    const s = q.session.get(sha256(raw));
    if (!s || s.expires < Date.now()) return null;
    return q.user.get(s.user_id) || null;
  }
  function publicUser(u) {
    return u && { id: u.id, name: u.name, avatar: u.avatar, providers: q.userProviders.all(u.id).map((r) => r.provider) };
  }
  function startSession(req, res, userId) {
    const raw = token();
    q.addSession.run(sha256(raw), userId, Date.now() + SESSION_DAYS * 864e5);
    res.cookie(SESSION_COOKIE, raw, { httpOnly: true, sameSite: 'lax', secure: isHttps(req), maxAge: SESSION_DAYS * 864e5, path: '/' });
  }
  // find-or-create the account for a provider identity; when already signed in, link it to that account instead
  function signIn(provider, prof, current) {
    const known = q.identity.get(provider, prof.subject);
    if (known) { q.touchUser.run(prof.name, prof.avatar, known.user_id); return known.user_id; }
    const userId = current ? current.id : Number(q.addUser.run(prof.name, prof.avatar, Date.now()).lastInsertRowid);
    q.addIdentity.run(provider, prof.subject, userId);
    return userId;
  }
  const deckOut = (d) => ({ id: d.id, name: d.name, cards: JSON.parse(d.cards), updated: d.updated });
  function requireUser(req, res) {
    const u = userFromReq(req);
    if (!u) res.status(401).json({ error: 'not signed in' });
    return u;
  }
  function saveDeck(u, body) {
    const d = cleanDeck(body);
    const now = Date.now();
    const json = JSON.stringify(d.cards);
    const byName = q.deckByName.get(u.id, d.name);
    const byId = body.id && q.deckById.get(String(body.id), u.id);
    if (byId) {
      if (byName && byName.id !== byId.id) q.deleteDeck.run(byName.id, u.id);   // renamed onto another deck's name: that one is replaced
      q.updateDeck.run(d.name, json, now, byId.id, u.id);
      return byId.id;
    }
    if (byName) { q.updateDeck.run(d.name, json, now, byName.id, u.id); return byName.id; }
    if (q.deckCount.get(u.id).n >= MAX_DECKS) throw new Error(`deck limit reached (${MAX_DECKS})`);
    const id = token(9);
    q.insertDeck.run(id, u.id, d.name, json, now);
    return id;
  }

  // ----- OAuth -----
  app.get('/auth/:provider', (req, res, next) => {
    const p = PROVIDERS[req.params.provider];
    if (!p) return next();
    if (!p.id() || !p.secret()) return res.status(503).send(`${p.label} sign-in is not configured on this server.`);
    const state = token(18);
    res.cookie(STATE_COOKIE, JSON.stringify({ state, provider: req.params.provider, next: safeNext(req.query.next) }),
      { httpOnly: true, sameSite: 'lax', secure: isHttps(req), maxAge: 10 * 60 * 1000, path: '/auth' });
    const u = new URL(p.authorize);
    u.search = new URLSearchParams({
      client_id: p.id(), redirect_uri: `${origin(req)}/auth/${req.params.provider}/callback`,
      response_type: 'code', scope: p.scope, state, ...p.extra,
    });
    res.redirect(u.toString());
  });

  app.get('/auth/:provider/callback', async (req, res, next) => {
    const name = req.params.provider;
    const p = PROVIDERS[name];
    if (!p) return next();
    let st = null;
    try { st = JSON.parse(cookies(req)[STATE_COOKIE] || 'null'); } catch { /* bad cookie */ }
    res.clearCookie(STATE_COOKIE, { path: '/auth' });
    const back = (err) => res.redirect(`${st?.next || '/'}${(st?.next || '/').includes('?') ? '&' : '?'}signin=${err ? 'failed' : 'ok'}`);
    if (!st || st.provider !== name || !req.query.state || req.query.state !== st.state) return back(true);
    if (req.query.error || !req.query.code) return back(true);
    try {
      const tr = await fetch(p.token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          client_id: p.id(), client_secret: p.secret(), grant_type: 'authorization_code',
          code: String(req.query.code), redirect_uri: `${origin(req)}/auth/${name}/callback`,
        }),
      });
      const tj = await tr.json().catch(() => ({}));
      if (!tr.ok || !tj.access_token) throw new Error(`token exchange failed (${tr.status})`);
      const prof = await p.profile(tj.access_token);
      const userId = signIn(name, prof, userFromReq(req));
      startSession(req, res, userId);
      back(false);
    } catch (e) {
      console.warn(`[accounts] ${name} sign-in failed:`, e.message);
      back(true);
    }
  });

  // Local testing only: INK_DEV_LOGIN=1 outside production adds /auth/dev?name=… (no provider round-trip).
  if (process.env.INK_DEV_LOGIN === '1' && process.env.NODE_ENV !== 'production') {
    console.warn('[accounts] INK_DEV_LOGIN is on: /auth/dev signs anyone in. Never enable this on a public server.');
    app.get('/auth/dev', (req, res) => {
      const nm = String(req.query.name || 'Dev player').slice(0, 40);
      const userId = signIn('dev', { subject: nm.toLowerCase(), name: nm, avatar: null }, userFromReq(req));
      startSession(req, res, userId);
      res.redirect(safeNext(req.query.next));
    });
  }

  // ----- account API -----
  app.get('/api/account', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ user: publicUser(userFromReq(req)), providers: configuredProviders(), enabled: true });
  });
  app.post('/api/account/logout', (req, res) => {
    const raw = cookies(req)[SESSION_COOKIE];
    if (raw) q.dropSession.run(sha256(raw));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/my/decks', (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    res.set('Cache-Control', 'no-store');
    res.json({ decks: q.decks.all(u.id).map(deckOut) });
  });
  app.post('/api/my/decks', (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try { res.json({ deck: deckOut(q.deckById.get(saveDeck(u, req.body), u.id)) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete('/api/my/decks/:id', (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    q.deleteDeck.run(String(req.params.id), u.id);
    res.json({ ok: true });
  });
  // guest decks from this browser move into the account on first sign-in; a name clash with a different list keeps both
  app.post('/api/my/decks/import', (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const list = Array.isArray(req.body?.decks) ? req.body.decks.slice(0, MAX_DECKS) : [];
    let added = 0;
    const skipped = [];
    for (const raw of list) {
      try {
        const d = cleanDeck(raw);
        const same = q.deckByName.get(u.id, d.name);
        if (same && same.cards === JSON.stringify(d.cards)) continue;
        if (same) d.name = `${d.name.slice(0, 50)} (guest)`;
        saveDeck(u, d);
        added++;
      } catch (e) { skipped.push(`${raw?.name || '?'}: ${e.message}`); }
    }
    res.json({ added, skipped, decks: q.decks.all(u.id).map(deckOut) });
  });

  const on = Object.entries(configuredProviders()).filter(([, v]) => v).map(([k]) => k);
  console.log(`[accounts] ready · sign-in: ${on.length ? on.join(', ') : 'no provider configured (set DISCORD_/GOOGLE_CLIENT_ID + _SECRET)'}`);
  return { userFromReq };
}
