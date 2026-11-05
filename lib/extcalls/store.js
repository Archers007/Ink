// The external-calls store: one row per call Ink makes to another site (Dreamborn, Firebase for Dreamborn sign-in,
// duels.ink), in its own small SQLite file so it never touches ink.db. It keeps the last INK_EXTCALLS_HOURS (24) and
// never more than INK_EXTCALLS_MAX_MB (200) on disk, oldest rows going first. Rows are buffered in memory and written
// in one transaction a second (or every 200 rows); a failed write is logged and dropped, never thrown at a caller.
//
// Never stored: request bodies, request or response headers, cookies, tokens, passwords. Call sites decide whether a
// response body is kept at all (lib/extcalls/index.js `keepBody`); kept bodies are cut at 256 KB and gzip'd.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const BODY_MAX = 256 * 1024;
const FLUSH_MS = 1000;
const FLUSH_ROWS = 200;
const PRUNE_EVERY = 500;
const PRUNE_MS = 10 * 60 * 1000;
const BUCKETS = { '1m': 60e3, '5m': 5 * 60e3, '15m': 15 * 60e3, '1h': 60 * 60e3 };

const COLS = ['at', 'source', 'kind', 'method', 'host', 'path', 'query', 'status', 'ok', 'ms', 'bytes', 'cache', 'caller',
  'user_id', 'ref', 'error', 'body', 'body_type', 'body_bytes', 'body_trunc'];
// every column but the body itself, for lists
const LIST_COLS = `id, ${COLS.filter((c) => c !== 'body').join(', ')}, (body IS NOT NULL) AS has_body`;

// secrets that might ride along in an error message (a URL with ?key=…)
const SECRET_IN_TEXT = /((?:^|[?&;\s])[a-z_-]*?(?:key|token|auth|session|password|pass|sig)[a-z_-]*=)[^&\s;"']+/gi;
export const scrubText = (s) => (s == null ? null : String(s).replace(SECRET_IN_TEXT, '$1…').slice(0, 500));

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
// ms since epoch from a number or a date string
export function parseTime(v) {
  if (v == null || v === '') return null;
  if (Number.isFinite(Number(v))) return Number(v);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

export function openStore({ file, hours = 24, maxMb = 200, flushMs = FLUSH_MS, flushRows = FLUSH_ROWS } = {}) {
  if (!file) throw new Error('openStore: file required');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // auto_vacuum has to be set before the first table exists, so deletes hand pages back to the file system
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA journal_size_limit = 8388608');
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, source TEXT, kind TEXT, method TEXT, host TEXT, path TEXT,
      query TEXT, status INTEGER, ok INTEGER, ms INTEGER, bytes INTEGER, cache TEXT, caller TEXT, user_id INTEGER,
      ref TEXT, error TEXT, body BLOB, body_type TEXT, body_bytes INTEGER, body_trunc INTEGER
    );
    CREATE INDEX IF NOT EXISTS calls_at ON calls(at);
    CREATE INDEX IF NOT EXISTS calls_kind ON calls(source, kind, at);
  `);
  // a file made before auto_vacuum was set: VACUUM once to switch it on
  if (Number(db.prepare('PRAGMA auto_vacuum').get().auto_vacuum) !== 2) db.exec('VACUUM');

  const windowMs = Math.max(0, Number(hours) || 24) * 3600e3;
  const maxBytes = Math.max(0.01, Number(maxMb) || 200) * 1024 * 1024;
  const insert = db.prepare(`INSERT INTO calls (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`);
  const one = db.prepare('SELECT * FROM calls WHERE id = ?');

  let queue = [];
  let timer = null;
  let sincePrune = 0, bytesSincePrune = 0;
  let closed = false;
  let warned = 0;
  const warn = (what, e) => { if (warned++ < 5) console.warn(`[extcalls] ${what} failed:`, e?.message || e); };

  // a caller's row → the column values, body cut and gzip'd later at flush
  function normalize(r) {
    let body = null, bodyBytes = null, trunc = null;
    if (r.body != null && r.body !== '') {
      const buf = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body), 'utf8');
      bodyBytes = buf.length;
      trunc = buf.length > BODY_MAX ? 1 : 0;
      body = trunc ? buf.subarray(0, BODY_MAX) : buf;
    }
    return {
      at: num(r.at) ?? Date.now(),
      source: r.source ? String(r.source) : null,
      kind: r.kind ? String(r.kind) : null,
      method: r.method ? String(r.method).toUpperCase() : 'GET',
      host: r.host ? String(r.host) : null,
      path: r.path != null ? String(r.path).slice(0, 500) : null,
      query: r.query ? String(r.query).slice(0, 1000) : null,
      status: num(r.status) ?? 0,
      ok: r.ok == null ? (num(r.status) >= 200 && num(r.status) < 400 ? 1 : 0) : (r.ok ? 1 : 0),
      ms: num(r.ms) != null ? Math.round(num(r.ms)) : null,
      bytes: num(r.bytes),
      cache: r.cache ? String(r.cache) : null,
      caller: r.caller ? String(r.caller).slice(0, 200) : null,
      user_id: num(r.user_id ?? r.userId),
      ref: r.ref != null ? String(r.ref).slice(0, 200) : null,
      error: scrubText(r.error),
      body,
      body_type: body ? (r.body_type || r.bodyType || 'text/plain') : null,
      body_bytes: body ? bodyBytes : null,
      body_trunc: body ? trunc : null,
    };
  }

  function record(row) {
    if (closed || !row) return;
    try { queue.push(normalize(row)); } catch (e) { warn('record', e); return; }
    if (queue.length >= flushRows) flush();
    else if (!timer) { timer = setTimeout(flush, flushMs); timer.unref?.(); }
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length || closed) return;
    const rows = queue;
    queue = [];
    try {
      db.exec('BEGIN');
      for (const r of rows) {
        if (r.body) { bytesSincePrune += r.body.length; r.body = zlib.gzipSync(r.body); }
        insert.run(...COLS.map((c) => r[c]));
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
      warn('write', e);
      return;
    }
    sincePrune += rows.length;
    if (sincePrune >= PRUNE_EVERY || bytesSincePrune > maxBytes * 0.05) prune();
  }

  // file + WAL, the way it sits on disk
  function sizeBytes() {
    const pages = Number(db.prepare('PRAGMA page_count').get().page_count);
    const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
    let wal = 0;
    try { wal = fs.statSync(`${file}-wal`).size; } catch { /* no WAL yet */ }
    return pages * pageSize + wal;
  }
  const compact = () => { db.exec('PRAGMA incremental_vacuum'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); };

  function prune() {
    if (closed) return { deleted: 0 };
    sincePrune = 0;
    bytesSincePrune = 0;
    let deleted = 0;
    try {
      deleted += Number(db.prepare('DELETE FROM calls WHERE at < ?').run(Date.now() - windowMs).changes);
      if (deleted) compact();
      let size = sizeBytes();
      if (size > maxBytes) {
        const target = maxBytes * 0.9;
        const del = db.prepare('DELETE FROM calls WHERE id IN (SELECT id FROM calls ORDER BY at, id LIMIT ?)');
        for (let i = 0; i < 200 && size > target; i++) {
          const rows = Number(db.prepare('SELECT COUNT(*) AS n FROM calls').get().n);
          if (!rows) break;
          // roughly the share of rows that's over the target, at least a small batch
          const n = Math.min(rows, Math.max(20, Math.ceil((rows * (size - target)) / size)));
          deleted += Number(del.run(n).changes);
          compact();
          size = sizeBytes();
        }
      } else if (!deleted) {
        db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      }
    } catch (e) { warn('prune', e); }
    return { deleted };
  }

  // WHERE clause for the list and stats filters
  function where(f = {}, { cursor = true } = {}) {
    const w = [], p = [];
    const since = parseTime(f.since), until = parseTime(f.until);
    if (since != null) { w.push('at >= ?'); p.push(since); }
    if (until != null) { w.push('at <= ?'); p.push(until); }
    if (f.source) { w.push('source = ?'); p.push(String(f.source)); }
    if (f.kind) { w.push('kind = ?'); p.push(String(f.kind)); }
    if (f.caller) { w.push('caller = ?'); p.push(String(f.caller)); }
    if (f.status != null && f.status !== '') {
      const s = String(f.status).toLowerCase();
      if (/^[1-5]xx$/.test(s)) { w.push('status >= ? AND status < ?'); p.push(Number(s[0]) * 100, Number(s[0]) * 100 + 100); }
      else if (num(s) != null) { w.push('status = ?'); p.push(num(s)); }
    }
    if (f.ok != null && f.ok !== '') {
      const ok = f.ok === true || f.ok === 1 || /^(1|true|yes|ok)$/i.test(String(f.ok));
      w.push('ok = ?'); p.push(ok ? 1 : 0);
    }
    if (f.q) {
      const like = `%${String(f.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      w.push("(path LIKE ? ESCAPE '\\' OR query LIKE ? ESCAPE '\\' OR error LIKE ? ESCAPE '\\' OR caller LIKE ? ESCAPE '\\')");
      p.push(like, like, like, like);
    }
    if (cursor && num(f.before) != null) { w.push('id < ?'); p.push(num(f.before)); }
    return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
  }

  // newest first; `next` is the id to pass as `before` for the next page
  function query(f = {}) {
    flush();
    const limit = Math.min(500, Math.max(1, Math.floor(num(f.limit) ?? 100)));
    const { sql, params } = where(f);
    const calls = db.prepare(`SELECT ${LIST_COLS} FROM calls ${sql} ORDER BY id DESC LIMIT ?`).all(...params, limit + 1)
      .map((r) => ({ ...r, has_body: !!r.has_body }));
    const more = calls.length > limit;
    if (more) calls.pop();
    return { calls, next: more ? calls[calls.length - 1].id : null };
  }

  const decode = (r) => {
    if (!r) return null;
    const out = { ...r, has_body: r.body != null };
    if (r.body != null) {
      try {
        out.body = zlib.gunzipSync(Buffer.from(r.body)).toString('utf8');
        if (/json/i.test(r.body_type || '')) { try { out.json = JSON.parse(out.body); } catch { /* cut or not JSON */ } }
      } catch (e) { out.body = null; out.error = out.error || `body unreadable: ${e.message}`; }
    }
    return out;
  };

  function get(id) {
    flush();
    return decode(one.get(Number(id)));
  }

  // rows oldest first with bodies decoded, a page at a time (for the NDJSON export)
  function* exportRows(f = {}) {
    flush();
    const { sql, params } = where({ ...f, before: null }, { cursor: false });
    const stmt = db.prepare(`SELECT * FROM calls ${sql ? `${sql} AND` : 'WHERE'} id > ? ORDER BY id LIMIT 500`);
    let after = 0;
    for (;;) {
      const rows = stmt.all(...params, after);
      if (!rows.length) return;
      for (const r of rows) yield decode(r);
      after = rows[rows.length - 1].id;
    }
  }

  function info() {
    flush();
    const r = db.prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM calls').get();
    return { bytes: sizeBytes(), maxBytes, rows: Number(r.n), oldest: r.oldest == null ? null : Number(r.oldest), hours: windowMs / 3600e3 };
  }

  const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
  const isErr = (r) => !r.ok || !r.status;

  // calls per time bucket (stacked by kind) and per source/kind; percentiles over network calls, not cache hits
  function stats(f = {}) {
    flush();
    const bucketMs = BUCKETS[f.bucket] || BUCKETS['5m'];
    const now = Date.now();
    const until = parseTime(f.until) ?? now;
    const since = parseTime(f.since) ?? until - windowMs;
    const { sql, params } = where({ ...f, since, until, before: null, q: null, status: null, ok: null, caller: null }, { cursor: false });
    const start = Math.floor(since / bucketMs) * bucketMs;
    const nb = Math.min(5000, Math.floor((until - start) / bucketMs) + 1);
    const b = Array.from({ length: nb }, (_, i) => ({ t: start + i * bucketMs, n: 0, errors: 0, byKind: {}, bytes: 0, _ms: [] }));
    const kinds = new Map();
    const totals = { n: 0, errors: 0, bytes: 0 };
    const stmt = db.prepare(`SELECT at, source, kind, status, ok, ms, bytes, cache FROM calls ${sql}`);
    for (const r of stmt.iterate(...params)) {
      const i = Math.floor((r.at - start) / bucketMs);
      const err = isErr(r);
      const bytes = Number(r.bytes) || 0;
      const timed = r.cache !== 'hit' && r.ms != null;
      totals.n++; totals.bytes += bytes; if (err) totals.errors++;
      const x = b[i];
      if (x) {
        x.n++; x.bytes += bytes; if (err) x.errors++;
        x.byKind[r.kind || '?'] = (x.byKind[r.kind || '?'] || 0) + 1;
        if (timed) x._ms.push(Number(r.ms));
      }
      const key = `${r.source}\u0000${r.kind}`;
      let k = kinds.get(key);
      if (!k) kinds.set(key, (k = { source: r.source, kind: r.kind, n: 0, errors: 0, hits: 0, bytes: 0, last: 0, _ms: [] }));
      k.n++; k.bytes += bytes; if (err) k.errors++; if (r.cache === 'hit') k.hits++;
      if (r.at > k.last) k.last = r.at;
      if (timed) k._ms.push(Number(r.ms));
    }
    const fin = (o) => {
      const ms = o._ms.sort((x, y) => x - y);
      delete o._ms;
      return { ...o, p50: pct(ms, 50), p95: pct(ms, 95) };
    };
    return {
      buckets: b.map(fin),
      kinds: [...kinds.values()].map(fin).sort((x, y) => y.n - x.n),
      totals,
      store: info(),
      since, until, bucket: Object.keys(BUCKETS).find((k) => BUCKETS[k] === bucketMs),
    };
  }

  function close() {
    if (closed) return;
    flush();
    closed = true;
    if (timer) clearTimeout(timer);
    clearInterval(pruneTimer);
    process.off('exit', onExit);
    process.off('beforeExit', onExit);
    for (const s of SIGNALS) process.off(s, onSignal);
    try { db.close(); } catch { /* already closed */ }
  }

  // regular pruning, and a last flush on the way out that never holds shutdown up
  const pruneTimer = setInterval(prune, PRUNE_MS);
  pruneTimer.unref?.();
  const onExit = () => { try { flush(); } catch { /* exiting anyway */ } };
  const SIGNALS = ['SIGTERM', 'SIGINT'];
  function onSignal(sig) {
    onExit();
    process.off(sig, onSignal);
    // we were the only listener: carry on with the default (exit) as if we'd never been here
    if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
  }
  process.on('exit', onExit);
  process.on('beforeExit', onExit);
  for (const s of SIGNALS) process.on(s, onSignal);

  prune();
  return { record, query, get, stats, info, prune, flush, close, exportRows, sizeBytes, file };
}
