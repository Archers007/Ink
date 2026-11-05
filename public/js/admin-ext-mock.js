// Sample data for the External calls tab, used only with ?mock=1 on localhost (see admin.js). It answers the same
// three requests the real API does (lib/extcalls/admin.js), with the same response shapes, from a day of calls
// generated in the browser — so the tab can be looked at without the server or a recorder running.
// Add &mockstate=empty or &mockstate=error to see the empty and error states.

const HOUR = 3600e3;
const BUCKET_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': HOUR };

// a small seeded random, so a reload shows the same day of calls (relative to now)
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const R = rng(20261104);
const pick = (arr) => arr[Math.floor(R() * arr.length)];
const between = (lo, hi) => Math.round(lo + R() * (hi - lo));
const latency = (base) => Math.round(base * Math.exp((R() - 0.4) * 1.4));

const INKS = ['amber', 'amethyst', 'emerald', 'ruby', 'sapphire', 'steel'];
const DECK_IDS = Array.from({ length: 40 }, (_, i) => `d${(0x5a17 * (i + 3)).toString(36)}${i}`);
const LAB_RUNS = ['run-41', 'run-42', 'run-43'];

// kind → how to make one call of it
const KINDS = {
  decks: { source: 'dreamborn', w: 30, make: () => ({ method: 'GET', host: 'dreamborn.ink', path: '/api/v2/decks', query: `currency=USD&sort=${pick(['trending', 'new', 'top'])}&archetype=&format=${pick(['core', 'infinity', ''])}&page=${between(1, 4)}`, ms: latency(380), bytes: between(18e3, 95e3), caller: pick(['route:/api/decks', 'route:/api/decks', 'lab', 'tool:fetch-meta-decks']), hitRate: 0.4, keep: true, errRate: 0.02, errs: [[502, 'Bad gateway'], [429, 'Too many requests']] }) },
  deck: { source: 'dreamborn', w: 30, make: () => { const id = pick(DECK_IDS); const caller = pick(['route:/api/decks/:id', 'lab', 'lab', 'tool:fetch-meta-decks']); return { method: 'GET', host: 'dreamborn.ink', path: `/decks/${id}`, query: '', ms: latency(620), bytes: between(120e3, 340e3), caller, ref: caller === 'lab' ? pick(LAB_RUNS) : null, hitRate: 0.3, keep: true, deckId: id, errRate: 0.03, errs: [[404, 'Not found'], [500, 'Server error']] }; } },
  'firebase-signin': { source: 'dreamborn', w: 0, make: () => ({ method: 'POST', host: 'identitytoolkit.googleapis.com', path: '/v1/accounts:signInWithPassword', query: 'key=…', ms: latency(260), bytes: between(900, 1400), caller: 'route:/api/login', errRate: 0.12, errs: [[400, 'INVALID_LOGIN_CREDENTIALS']] }) },
  login: { source: 'dreamborn', w: 3, make: () => ({ method: 'POST', host: 'dreamborn.ink', path: '/api/auth/login', query: '', ms: latency(310), bytes: between(200, 600), caller: 'route:/api/login', errRate: 0.03, errs: [[401, 'Unauthorized']] }) },
  user: { source: 'dreamborn', w: 3, make: () => ({ method: 'GET', host: 'dreamborn.ink', path: '/api/user', query: '', ms: latency(180), bytes: between(700, 2200), caller: 'route:/api/login', errRate: 0.01, errs: [[401, 'Unauthorized']] }) },
  owned: { source: 'dreamborn', w: 3, make: () => ({ method: 'GET', host: 'dreamborn.ink', path: '/api/users/:uid/owned-cards', query: '', ms: latency(900), bytes: between(40e3, 160e3), caller: pick(['route:/api/login', 'route:/api/collection']), errRate: 0.02, errs: [[503, 'Service unavailable']] }) },
  leaderboard: { source: 'duels', w: 5, recent: 9, make: () => ({ method: 'GET', host: 'duels.ink', path: '/api/leaderboard', query: `format=${pick(['core', 'infinity'])}&limit=50`, ms: latency(450), bytes: between(8e3, 30e3), caller: 'tool:probe-duels', keep: true, errRate: 0.1, errs: [[503, 'Service unavailable'], [429, 'Too many requests']] }) },
  'match-history': { source: 'duels', w: 3, recent: 9, make: () => ({ method: 'GET', host: 'duels.ink', path: '/api/players/:id/matches', query: 'page=1', ms: latency(700), bytes: between(4e3, 22e3), caller: 'tool:probe-duels', errRate: 0.08, errs: [[404, 'Not found']] }) },
};

function generate() {
  const now = Date.now(), start = now - 24 * HOUR + 4 * 60e3;   // the oldest row is just inside the window
  const rows = [];
  const add = (at, kind, c, extra = {}) => {
    const src = KINDS[kind]?.source || 'dreamborn';
    let status = 200, ok = 1, error = null, cache = c.hitRate != null ? 'miss' : null, ms = c.ms, bytes = c.bytes;
    if (c.hitRate != null && R() < c.hitRate) { cache = 'hit'; ms = 0; }
    else if (R() < 0.005) { status = 0; ok = 0; error = pick(['fetch failed: ECONNRESET', 'fetch failed: ETIMEDOUT', 'getaddrinfo EAI_AGAIN dreamborn.ink']); bytes = 0; ms = between(3000, 10000); }
    else if (R() < c.errRate) { const [s, m] = pick(c.errs); status = s; ok = 0; error = `${s} ${m}`; bytes = between(80, 900); }
    const keep = c.keep && ok && cache !== 'hit';
    rows.push({
      at: Math.round(at), source: src, kind, method: c.method, host: c.host, path: c.path, query: c.query, status, ok, ms, bytes, cache,
      caller: c.caller, user_id: c.caller.startsWith('route:') && R() < 0.7 ? between(1, 60) : null, ref: c.ref || null, error,
      body_type: keep ? 'application/json' : null, body_bytes: keep ? (kind === 'deck' ? between(2e3, 6e3) : bytes) : null, body_trunc: keep && kind !== 'deck' && bytes > 262144 ? 1 : 0,
      _deck: c.deckId, ...extra,
    });
  };
  const total = Object.values(KINDS).reduce((s, k) => s + k.w, 0);
  for (let t = start; t < now;) {
    // busier in the evening, quiet overnight
    const h = new Date(t).getHours();
    const rate = 0.35 + 0.65 * Math.max(0, Math.sin(((h - 6) / 24) * 2 * Math.PI));
    t += -Math.log(1 - R()) * (22e3 / rate);
    if (t >= now) break;
    let r = R() * total, kind = 'decks';
    for (const [k, v] of Object.entries(KINDS)) { r -= v.w; if (r <= 0) { kind = k; break; } }
    const spec = KINDS[kind];
    if (spec.recent && t < now - spec.recent * HOUR) continue;    // the duels.ink scaffold only started a few hours ago
    if (kind === 'login') { add(t - 400, 'firebase-signin', KINDS['firebase-signin'].make()); }
    add(t, kind, spec.make());
  }
  // cards.db: at startup and every 6 hours after, a big download (or a 304 when it hasn't changed)
  for (let t = start + 25 * 60e3; t < now; t += 6 * HOUR) {
    const fresh = R() < 0.5;
    rows.push({ at: Math.round(t), source: 'dreamborn', kind: 'cardsdb', method: 'GET', host: 'dreamborn.ink', path: '/cache/en/cards.db', query: '', status: fresh ? 200 : 304, ok: 1, ms: fresh ? between(2200, 5200) : between(90, 200), bytes: fresh ? between(38e6, 41e6) : 0, cache: null, caller: t === start + 25 * 60e3 ? 'startup' : 'timer:cards-db', user_id: null, ref: null, error: null, body_type: null, body_bytes: null, body_trunc: 0 });
  }
  rows.sort((a, b) => a.at - b.at);
  rows.forEach((r, i) => { r.id = 5000 + i; });
  return rows;
}
// &mockstate=empty or &mockstate=error shows the tab's empty and error states
const MOCK_STATE = typeof location === 'undefined' ? '' : new URLSearchParams(location.search).get('mockstate') || '';
const ROWS = MOCK_STATE === 'empty' ? [] : generate();

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

function filtered(p, { withKind = true } = {}) {
  const since = Number(p.since) || 0, until = Number(p.until) || Infinity;
  const q = (p.q || '').toLowerCase();
  return ROWS.filter((r) => r.at >= since && r.at <= until
    && (!p.source || r.source === p.source)
    && (!withKind || !p.kind || r.kind === p.kind)
    && (p.status == null || p.status === '' || r.status === Number(p.status))
    && (p.ok == null || p.ok === '' || r.ok === Number(p.ok))
    && (!p.caller || r.caller === p.caller)
    && (!q || [r.path, r.query, r.error, r.caller].some((s) => String(s || '').toLowerCase().includes(q))));
}

function stats(p) {
  const rows = filtered(p);
  const size = BUCKET_MS[p.bucket] || BUCKET_MS['5m'];
  const byT = new Map(), byKind = new Map();
  for (const r of rows) {
    const t = Math.floor(r.at / size) * size;
    if (!byT.has(t)) byT.set(t, { t, n: 0, errors: 0, byKind: {}, ms: [], bytes: 0 });
    const b = byT.get(t);
    b.n++; b.errors += r.ok ? 0 : 1; b.byKind[r.kind] = (b.byKind[r.kind] || 0) + 1; b.bytes += r.bytes; if (r.cache !== 'hit') b.ms.push(r.ms);
    const key = `${r.source}|${r.kind}`;
    if (!byKind.has(key)) byKind.set(key, { source: r.source, kind: r.kind, n: 0, errors: 0, ms: [], bytes: 0, last: 0 });
    const k = byKind.get(key);
    k.n++; k.errors += r.ok ? 0 : 1; k.bytes += r.bytes; k.last = Math.max(k.last, r.at); if (r.cache !== 'hit') k.ms.push(r.ms);
  }
  const fin = ({ ms, ...o }) => { ms.sort((a, b) => a - b); return { ...o, p50: quantile(ms, 0.5), p95: quantile(ms, 0.95) }; };
  // buckets come back sparse (only the ones with calls), as a GROUP BY would give them
  const buckets = [...byT.values()].sort((a, b) => a.t - b.t).map(fin);
  const kinds = [...byKind.values()].sort((a, b) => b.n - a.n).map(fin);
  const totals = { n: rows.length, errors: rows.filter((r) => !r.ok).length, bytes: rows.reduce((s, r) => s + r.bytes, 0) };
  const storeBytes = 4096 * Math.ceil((ROWS.length * 420 + ROWS.filter((r) => r.body_bytes).reduce((s, r) => s + r.body_bytes * 0.18, 0)) / 4096);
  const store = { bytes: storeBytes, maxBytes: 200 * 1024 * 1024, rows: ROWS.length, oldest: ROWS[0]?.at ?? null, hours: 24 };
  return { buckets, kinds, totals, store };
}

const publicRow = ({ _deck, ...r }) => ({ ...r, has_body: r.body_bytes != null });

function calls(p) {
  const limit = Math.min(500, Number(p.limit) || 100);
  const before = Number(p.before) || Infinity;
  const rows = filtered(p).filter((r) => r.id < before).reverse();
  const page = rows.slice(0, limit);
  return { calls: page.map(publicRow), next: rows.length > limit ? page[page.length - 1].id : null };
}

function deckJson(r) {
  const cards = ['Elsa - Spirit of Winter', 'Tipo - Growing Son', 'Hades - Infernal Schemer', 'Mickey Mouse - Brave Little Tailor', 'Maui - Hero to All', 'Lilo - Making a Wish', 'Stitch - Rock Star', 'Be Prepared', 'Dragon Fire', 'Let It Go', 'Ursula - Deceiver of All', 'Belle - Strange but Special'];
  const inks = [pick(INKS), pick(INKS)];
  return { id: r._deck, name: `${inks.map((s) => s[0].toUpperCase() + s.slice(1)).join('/')} ${pick(['Tempo', 'Control', 'Aggro', 'Songs', 'Ramp'])}`, author: pick(['marlowe', 'inkwell', 'tidepool', 'Lumi']), inks, format: 'core', updated: new Date(r.at - between(1, 90) * 86400e3).toISOString(), cards: cards.slice(0, between(8, 12)).map((name) => ({ name, qty: pick([1, 2, 3, 4, 4, 4]) })), sourceUrl: `https://dreamborn.ink/decks/${r._deck}` };
}
function decksJson(r) {
  return { page: Number(/page=(\d+)/.exec(r.query)?.[1] || 1), total: 1842, decks: Array.from({ length: 6 }, (_, i) => ({ id: DECK_IDS[(r.id + i) % DECK_IDS.length], name: `${pick(INKS)} ${pick(['Tempo', 'Control', 'Aggro', 'Songs'])}`, price: { USD: between(40, 400) }, likes: between(0, 300), updated: new Date(r.at - i * 3600e3).toISOString() })) };
}
function leaderboardJson(r) {
  return { format: /format=(\w+)/.exec(r.query)?.[1] || 'core', players: Array.from({ length: 5 }, (_, i) => ({ rank: i + 1, name: pick(['ashen', 'brightfeather', 'cog', 'dewdrop', 'emberly']), rating: 2100 - i * between(10, 40) })) };
}

function one(id) {
  const r = ROWS.find((x) => x.id === Number(id));
  if (!r) throw new Error('Not found (404)');
  const row = publicRow(r);
  delete row.has_body;
  if (r.body_bytes == null) return { ...row, body: null };
  const json = r.kind === 'deck' ? deckJson(r) : r.kind === 'leaderboard' ? leaderboardJson(r) : decksJson(r);
  return { ...row, body: JSON.stringify(json), json };
}

// the same paths and query parameters admin-ext.js sends to the server
export async function mockGet(path, params = {}) {
  await new Promise((res) => setTimeout(res, 120 + Math.random() * 180));
  if (MOCK_STATE === 'error') throw new Error(`${path} failed (500)`);
  if (path === '/api/admin/ext/stats') return stats(params);
  if (path === '/api/admin/ext/calls') return calls(params);
  const m = /^\/api\/admin\/ext\/calls\/(\d+)$/.exec(path);
  if (m) return one(m[1]);
  throw new Error(`${path} failed (404)`);
}

// what /api/admin/ext/export would send: one row per line, bodies included
export function mockExport(params = {}) {
  return filtered(params, { withKind: false }).map((r) => JSON.stringify(r.body_bytes != null ? one(r.id) : publicRow(r))).join('\n') + '\n';
}
