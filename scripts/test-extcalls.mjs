// The external-calls recorder (lib/extcalls) and the Dreamborn client (lib/dreamborn.js) against a local fake remote:
// timing/status/size, network errors, redaction, kept bodies and the 256 KB cut, the 24 h window and the size cap,
// buffered writes, stats and the call query, and the client's politeness (2 in flight), cache hits and sign-in safety.
//   node scripts/test-extcalls.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStore, BODY_MAX } from '../lib/extcalls/store.js';
import { extFetch, recordCall, redactQuery, setExtStore, extStore } from '../lib/extcalls/index.js';
import { dreamborn, configureDreamborn, DreambornError } from '../lib/dreamborn.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-extcalls-'));
const tmpFile = (name) => path.join(TMP, `${name}.db`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok -', name); } catch (e) { console.error('FAIL -', name); throw e; } };

// ---------- the fake remote ----------
const BIG = 'x'.repeat(300 * 1024);
const PASSWORD = 'hunter2-PASSWORD', ID_TOKEN = 'IDTOKEN-abc.def.ghi', COOKIE = '__session=SECRETCOOKIE123';
const deckPayload = (id) => JSON.stringify([
  ['ShallowReactive', 1],
  { name: 2, creator: 3, creatorName: 4, cards: 5, pbCode: 7, colors: 8, size: 10 },
  `Deck ${id}`, 'creator-uid', 'Tester', { 1234: 6 }, 4,
  Buffer.from('Mickey Mouse_Brave Little Tailor$4').toString('base64'), [9], 'amber', 60,
]);
const seen = { decks: 0, deckPages: 0, inflight: 0, maxInflight: 0, starts: [], bodies: [] };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    seen.bodies.push(body);
    const json = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/ok') return json(200, { a: 1, pad: 'y'.repeat(100) });
    if (u.pathname === '/slow') { await sleep(Number(u.searchParams.get('ms')) || 50); return json(200, { slow: true }); }
    if (u.pathname === '/missing') return json(404, { error: 'nope' });
    if (u.pathname === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(BIG); }
    if (u.pathname === '/api/v2/decks') {
      seen.decks++; seen.inflight++; seen.maxInflight = Math.max(seen.maxInflight, seen.inflight); seen.starts.push(Date.now());
      await sleep(120);
      seen.inflight--;
      return json(200, [{ id: `d${u.searchParams.get('page')}`, name: 'A deck', colors: ['amber'] }]);
    }
    const deck = u.pathname.match(/^\/decks\/([\w-]+)$/);
    if (deck) { seen.deckPages++; res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<html><body><div>${'z'.repeat(5000)}</div><script type="application/json">${deckPayload(deck[1])}</script></body></html>`); }
    if (u.pathname === '/api/users/firebase-uid-42/owned-cards') return json(200, { 1234: { normal: 2 } });
    if (u.pathname === '/v1/accounts:signInWithPassword') {
      const b = JSON.parse(body || '{}');
      if (b.password !== PASSWORD) return json(400, { error: { message: 'INVALID_PASSWORD' } });
      return json(200, { idToken: ID_TOKEN, refreshToken: 'REFRESH-xyz', localId: 'firebase-uid-42', expiresIn: '3600' });
    }
    if (u.pathname === '/api/auth/login') return json(200, { success: true, displayName: 'Tester' }, { 'set-cookie': [`${COOKIE}; Path=/; HttpOnly`, 'other=1; Path=/'] });
    if (u.pathname === '/cache/en/cards.db') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      for (let i = 0; i < 8; i++) res.write(Buffer.alloc(64 * 1024, i));
      return res.end();
    }
    json(500, { error: 'unknown route' });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const HOST = `127.0.0.1:${server.address().port}`;
// a port nobody listens on, for network errors
const dead = http.createServer();
await new Promise((r) => dead.listen(0, '127.0.0.1', r));
const DEAD = `http://127.0.0.1:${dead.address().port}`;
await new Promise((r) => dead.close(r));

// the shared store every extFetch writes to
const shared = openStore({ file: tmpFile('shared') });
setExtStore(shared);
const last = () => shared.query({ limit: 1 }).calls[0];

// ---------- extFetch / recordCall ----------
await test('extFetch records one call with method, host, path, status, timing and size', async () => {
  const res = await extFetch(`${BASE}/slow?ms=60`, {}, { source: 'test', kind: 'slow', caller: 'unit', userId: 7, ref: 'run-1' });
  assert.equal(res.status, 200);
  const text = await res.text();
  const row = last();
  assert.equal(row.source, 'test'); assert.equal(row.kind, 'slow'); assert.equal(row.method, 'GET');
  assert.equal(row.host, HOST); assert.equal(row.path, '/slow'); assert.equal(row.query, 'ms=60');
  assert.equal(row.status, 200); assert.equal(row.ok, 1);
  assert.equal(row.bytes, Buffer.byteLength(text));
  assert.ok(row.ms >= 50, `ms ${row.ms}`);
  assert.equal(row.caller, 'unit'); assert.equal(row.user_id, 7); assert.equal(row.ref, 'run-1');
  assert.equal(row.has_body, false);
});

await test('extFetch: a 404 is recorded as not ok, the caller still reads it', async () => {
  const res = await extFetch(`${BASE}/missing`, {}, { source: 'test', kind: 'missing' });
  assert.deepEqual(await res.json(), { error: 'nope' });
  const row = last();
  assert.equal(row.status, 404); assert.equal(row.ok, 0);
});

await test('extFetch: a network error is recorded with status 0 and rethrown', async () => {
  await assert.rejects(extFetch(`${DEAD}/x`, {}, { source: 'test', kind: 'dead' }));
  const row = last();
  assert.equal(row.kind, 'dead'); assert.equal(row.status, 0); assert.equal(row.ok, 0);
  assert.match(row.error, /fetch failed/);
});

await test('redaction: key/token/password/sig params lose their values, user ids are masked', async () => {
  assert.equal(redactQuery(new URLSearchParams('key=S1&token=S2&password=S3&sig=S4&page=2&apiKey=S5&id_token=S6&sort=popular')),
    'key=…&token=…&password=…&sig=…&page=2&apiKey=…&id_token=…&sort=popular');
  assert.equal(redactQuery('?auth=S7&session=S8&q=dog'), 'auth=…&session=…&q=dog');
  const res = await extFetch(`${BASE}/api/users/firebase-uid-42/owned-cards?key=AIzaSECRET&page=1`, {}, { source: 'test', kind: 'owned' });
  await res.json();
  const row = last();
  assert.equal(row.path, '/api/users/:uid/owned-cards');
  assert.equal(row.query, 'key=…&page=1');
  assert.ok(!JSON.stringify(shared.get(row.id)).includes('AIzaSECRET'));
});

await test('keepBody: true keeps the text, cut at 256 KB; a function keeps what it returns; false keeps nothing', async () => {
  let r = await extFetch(`${BASE}/big`, {}, { source: 'test', kind: 'big', keepBody: true });
  assert.equal((await r.text()).length, BIG.length);
  let row = shared.get(last().id);
  assert.equal(row.bytes, BIG.length);
  assert.equal(row.body.length, BODY_MAX); assert.equal(row.body_trunc, 1); assert.equal(row.body_bytes, BIG.length);
  assert.equal(row.body_type, 'text/plain');

  r = await extFetch(`${BASE}/big`, {}, { source: 'test', kind: 'big', keepBody: (text, res) => `len=${text.length} status=${res.status}` });
  await r.arrayBuffer();
  row = shared.get(last().id);
  assert.equal(row.body, `len=${BIG.length} status=200`); assert.equal(row.body_trunc, 0);

  r = await extFetch(`${BASE}/ok`, {}, { source: 'test', kind: 'ok', keepBody: true });
  await r.json();
  row = shared.get(last().id);
  assert.equal(row.json.a, 1, 'JSON bodies come back parsed');

  r = await extFetch(`${BASE}/big`, {}, { source: 'test', kind: 'big', keepBody: false });
  await r.text();
  assert.equal(last().has_body, false);
  assert.equal(shared.get(last().id).body, null);
});

await test('recordCall records a cache hit without the network', () => {
  recordCall({ url: `${BASE}/api/users/u9/x?token=T`, source: 'test', kind: 'hit', status: 200, ok: 1, ms: 0, bytes: 0, cache: 'hit', userId: 3 });
  const row = last();
  assert.equal(row.cache, 'hit'); assert.equal(row.ms, 0); assert.equal(row.path, '/api/users/:uid/x'); assert.equal(row.query, 'token=…');
  assert.equal(row.user_id, 3);
});

// ---------- the store ----------
await test('writes are buffered: nothing on disk until the timer or 200 rows', async () => {
  const file = tmpFile('buffer');
  const s = openStore({ file, flushMs: 150 });
  const peek = new DatabaseSync(file);
  const count = () => Number(peek.prepare('SELECT COUNT(*) AS n FROM calls').get().n);
  s.record({ source: 'test', kind: 'a', status: 200 });
  assert.equal(count(), 0, 'still in memory');
  await sleep(400);
  assert.equal(count(), 1, 'flushed by the timer');
  for (let i = 0; i < 200; i++) s.record({ source: 'test', kind: 'b', status: 200 });
  assert.equal(count(), 201, 'flushed at 200 rows');
  s.record({ source: 'test', kind: 'c', status: 200 });
  s.flush();
  assert.equal(count(), 202, 'flush() writes the rest');
  peek.close();
  s.close();
});

await test('the window: rows older than INK_EXTCALLS_HOURS go on prune', () => {
  const s = openStore({ file: tmpFile('window'), hours: 24 });
  s.record({ at: Date.now() - 25 * 3600e3, source: 'test', kind: 'old', status: 200 });
  s.record({ at: Date.now() - 23 * 3600e3, source: 'test', kind: 'recent', status: 200 });
  s.record({ source: 'test', kind: 'now', status: 200 });
  s.flush();
  assert.equal(s.info().rows, 3);
  s.prune();
  const kinds = s.query({}).calls.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ['now', 'recent']);
  assert.ok(s.info().oldest >= Date.now() - 24 * 3600e3);
  s.close();
});

await test('the size cap: oldest rows go until file + WAL is under the cap, newest kept', () => {
  const file = tmpFile('cap');
  const s = openStore({ file, maxMb: 1 });
  const N = 40;
  for (let i = 0; i < N; i++) s.record({ source: 'test', kind: 'fat', status: 200, ref: `r${i}`, body: randomBytes(75 * 1024).toString('base64') });
  s.flush();
  s.prune();
  const onDisk = fs.statSync(file).size + (fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0);
  assert.ok(onDisk <= 1024 * 1024, `on disk ${onDisk}`);
  const info = s.info();
  assert.ok(info.bytes <= 1024 * 1024, `measured ${info.bytes}`);
  assert.ok(info.rows > 0 && info.rows < N, `rows ${info.rows}`);
  const refs = s.query({ limit: 500 }).calls.map((r) => Number(r.ref.slice(1)));
  assert.equal(Math.max(...refs), N - 1, 'the newest row is kept');
  assert.equal(Math.min(...refs), N - refs.length, 'the rows kept are the newest ones, in a run');
  s.close();
});

await test('stats: buckets stacked by kind, per-kind counts and percentiles, totals and the store', () => {
  const s = openStore({ file: tmpFile('stats') });
  const now = Date.now();
  const at = (minAgo) => now - minAgo * 60e3;
  s.record({ at: at(50), source: 'dreamborn', kind: 'decks', status: 200, ms: 100, bytes: 1000 });
  s.record({ at: at(50), source: 'dreamborn', kind: 'decks', status: 200, ms: 300, bytes: 1000 });
  s.record({ at: at(20), source: 'dreamborn', kind: 'deck', status: 500, ms: 50, bytes: 10, error: 'boom needle' });
  s.record({ at: at(20), source: 'dreamborn', kind: 'deck', status: 200, ms: 0, bytes: 0, cache: 'hit' });
  s.record({ at: at(5), source: 'duels', kind: 'ping', status: 0, ms: 5 });
  const st = s.stats({ since: now - 60 * 60e3, until: now, bucket: '5m' });
  assert.equal(st.bucket, '5m');
  assert.ok(st.buckets.length >= 12 && st.buckets.length <= 14, `${st.buckets.length} buckets`);
  assert.ok(st.buckets.every((b, i) => i === 0 || b.t - st.buckets[i - 1].t === 5 * 60e3));
  assert.deepEqual(st.totals, { n: 5, errors: 2, bytes: 2010 });
  const b50 = st.buckets.find((b) => b.n === 2 && b.byKind.decks === 2);
  assert.ok(b50, 'the two deck lists share a bucket');
  assert.equal(b50.bytes, 2000);
  const decks = st.kinds.find((k) => k.kind === 'decks');
  assert.equal(decks.n, 2); assert.equal(decks.p50, 300); assert.equal(decks.p95, 300); assert.equal(decks.errors, 0);
  const deck = st.kinds.find((k) => k.kind === 'deck');
  assert.equal(deck.n, 2); assert.equal(deck.errors, 1); assert.equal(deck.hits, 1);
  assert.equal(deck.p50, 50, 'cache hits stay out of the percentiles');
  assert.equal(st.store.rows, 5); assert.equal(st.store.hours, 24); assert.equal(st.store.maxBytes, 200 * 1024 * 1024);
  assert.equal(s.stats({ source: 'duels', since: now - 3600e3 }).totals.n, 1);
  assert.equal(s.stats({ bucket: '1h', since: now - 3600e3 }).buckets.length <= 2, true);

  // the query: filters, text search, the cursor
  assert.equal(s.query({ kind: 'deck' }).calls.length, 2);
  assert.equal(s.query({ ok: '0' }).calls.length, 2);
  assert.equal(s.query({ status: '5xx' }).calls.length, 1);
  assert.equal(s.query({ status: 200 }).calls.length, 3);
  assert.equal(s.query({ q: 'needle' }).calls[0].kind, 'deck');
  assert.equal(s.query({ source: 'duels' }).calls.length, 1);
  assert.equal(s.query({ since: at(30), until: at(10) }).calls.length, 2);
  const p1 = s.query({ limit: 2 });
  assert.equal(p1.calls.length, 2); assert.ok(p1.next);
  assert.ok(p1.calls[0].id > p1.calls[1].id, 'newest first');
  const p2 = s.query({ limit: 2, before: p1.next });
  assert.ok(p2.calls.every((r) => r.id < p1.next));
  const p3 = s.query({ limit: 2, before: p2.next });
  assert.equal(p3.calls.length, 1); assert.equal(p3.next, null);
  assert.equal(new Set([...p1.calls, ...p2.calls, ...p3.calls].map((r) => r.id)).size, 5);
  // the export: oldest first, every row
  assert.equal([...s.exportRows({ source: 'dreamborn' })].length, 4);
  s.close();
});

// ---------- the Dreamborn client ----------
configureDreamborn({ base: BASE, firebase: BASE, gapMs: 40 });

await test('dreamborn: at most 2 requests in flight, starts spaced, every call recorded', async () => {
  seen.maxInflight = 0; seen.starts = [];
  const results = await Promise.all([1, 2, 3, 4, 5].map((page) => dreamborn.listDecks({ sort: 'popular', page }, { caller: 'test' })));
  assert.ok(results.every((r) => r.ok && Array.isArray(r.data)));
  assert.equal(seen.maxInflight, 2, `max in flight ${seen.maxInflight}`);
  const gaps = seen.starts.slice(1).map((t, i) => t - seen.starts[i]);
  assert.ok(gaps.every((g) => g >= 30), `gaps ${gaps}`);
  const rows = shared.query({ source: 'dreamborn', kind: 'decks' }).calls;
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.cache === 'miss' && r.has_body && r.caller === 'test'));
});

await test('dreamborn: a cached deck list is a recorded hit with no network', async () => {
  const before = seen.decks;
  const r = await dreamborn.listDecks({ sort: 'popular', page: 3 }, { caller: 'test', userId: 5 });
  assert.equal(seen.decks, before, 'no request');
  assert.ok(r.cached); assert.equal(r.data[0].id, 'd3');
  const row = last();
  assert.equal(row.kind, 'decks'); assert.equal(row.cache, 'hit'); assert.equal(row.ms, 0); assert.equal(row.has_body, false);
  assert.equal(row.user_id, 5);
  // a signed-in list is its own cache entry
  await dreamborn.listDecks({ sort: 'popular', page: 3 }, { cookie: COOKIE });
  assert.equal(seen.decks, before + 1);
});

await test('dreamborn: a deck page is parsed, the row keeps the parsed deck (not the HTML), the next one is a hit', async () => {
  const r = await dreamborn.deck('abc123', { caller: 'test', ref: 'lab-9' });
  assert.ok(r.ok); assert.equal(r.deck.name, 'Deck abc123'); assert.equal(r.deck.cards[0].qty, 4);
  const row = shared.get(last().id);
  assert.equal(row.kind, 'deck'); assert.equal(row.path, '/decks/abc123'); assert.equal(row.ref, 'lab-9');
  assert.equal(row.body_type, 'application/json');
  assert.equal(row.json.name, 'Deck abc123');
  assert.ok(!row.body.includes('<html>'));
  assert.ok(row.bytes > 5000, 'bytes is the page size');
  const pages = seen.deckPages;
  const again = await dreamborn.deck('abc123', { caller: 'test' });
  assert.equal(seen.deckPages, pages); assert.ok(again.cached); assert.equal(last().cache, 'hit');
});

await test('dreamborn: sign-in and the collection record no password, token, cookie or Firebase key', async () => {
  await assert.rejects(dreamborn.signIn('a@b.c', 'wrong'), (e) => e instanceof DreambornError && e.step === 'firebase' && e.status === 400 && e.message === 'INVALID_PASSWORD');
  const s = await dreamborn.signIn('a@b.c', PASSWORD, { caller: 'route:/api/login' });
  assert.equal(s.uid, 'firebase-uid-42'); assert.ok(s.cookie.startsWith(COOKIE), 'the __session cookie, as dreamborn set it'); assert.equal(s.user.displayName, 'Tester'); assert.equal(s.idToken, ID_TOKEN);
  assert.ok(seen.bodies.some((b) => b.includes(ID_TOKEN)), 'the token went to dreamborn');
  const owned = await dreamborn.ownedCards(s.uid, s.cookie);
  assert.ok(owned.ok); assert.deepEqual(owned.data, { 1234: { normal: 2 } });

  const rows = shared.query({ limit: 6 }).calls;
  const fb = rows.filter((r) => r.kind === 'firebase-signin');
  assert.equal(fb.length, 2);
  assert.ok(fb.every((r) => r.method === 'POST' && r.path === '/v1/accounts:signInWithPassword' && r.query === 'key=…' && !r.has_body));
  const login = rows.find((r) => r.kind === 'login');
  assert.ok(login && login.status === 200 && !login.has_body);
  const own = rows.find((r) => r.kind === 'owned');
  assert.equal(own.path, '/api/users/:uid/owned-cards'); assert.equal(own.has_body, false);

  // nothing secret anywhere: not in any row, not in the file's bytes
  const all = JSON.stringify([...shared.exportRows({})]);
  shared.flush();
  const raw = Buffer.concat([fs.readFileSync(shared.file), fs.existsSync(`${shared.file}-wal`) ? fs.readFileSync(`${shared.file}-wal`) : Buffer.alloc(0)]).toString('latin1');
  for (const secret of [PASSWORD, ID_TOKEN, 'SECRETCOOKIE', 'REFRESH-xyz', 'AIzaSy', 'a@b.c', 'firebase-uid-42']) {
    assert.ok(!all.includes(secret), `rows mention ${secret}`);
    assert.ok(!raw.includes(secret), `file has ${secret}`);
  }
});

await test('dreamborn: cards.db streams to the file, the row has its size', async () => {
  const dest = path.join(TMP, 'dreamborn.db');
  const [a, b] = await Promise.all([dreamborn.downloadCardsDb(dest, { caller: 'startup' }), dreamborn.downloadCardsDb(dest)]);
  assert.equal(a, b, 'one download for two callers');
  assert.equal(a.bytes, 8 * 64 * 1024); assert.equal(fs.statSync(dest).size, 8 * 64 * 1024);
  assert.deepEqual(fs.readdirSync(TMP).filter((f) => f.endsWith('.tmp')), []);
  const row = last();
  assert.equal(row.kind, 'cardsdb'); assert.equal(row.bytes, 8 * 64 * 1024); assert.equal(row.caller, 'startup'); assert.equal(row.has_body, false);
});

assert.equal(extStore(), shared);
shared.close();
server.close();
setExtStore(null);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed`);
