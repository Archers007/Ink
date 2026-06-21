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
