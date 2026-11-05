// What call sites use to talk to another site: extFetch() is fetch() that also records the call (method, host, masked
// path, redacted query, status, time, size, and the response body only when the call site asks) in the external-calls
// store (lib/extcalls/store.js, data/extcalls.db). recordCall() records a call served from a cache. The admin page
// reads the store through lib/extcalls/admin.js.
//
// Never recorded: request bodies, request or response headers, cookies, tokens, passwords. Query params that look like
// secrets (key, token, auth, session, password, sig…) are kept by name only; user ids in paths are masked.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, BODY_MAX } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// a body still unread this long after the headers is recorded as it stands, so a call never goes missing
const UNREAD_MS = 5 * 60 * 1000;

let shared = null;
// stands in when the store can't be opened: calls still work, nothing is recorded
const UNAVAILABLE = {
  unavailable: true,
  record() {}, flush() {}, prune() { return { deleted: 0 }; }, close() {},
  query: () => ({ calls: [], next: null }), get: () => null, *exportRows() {},
  info: () => ({ bytes: 0, maxBytes: 0, rows: 0, oldest: null, hours: 0 }),
  stats() { return { buckets: [], kinds: [], totals: { n: 0, errors: 0, bytes: 0 }, store: this.info() }; },
};

// the shared store, opened on first use from INK_EXTCALLS_DB / INK_EXTCALLS_HOURS / INK_EXTCALLS_MAX_MB
export function extStore() {
  if (shared) return shared;
  try {
    shared = openStore({
      file: process.env.INK_EXTCALLS_DB || path.join(ROOT, 'data', 'extcalls.db'),
      hours: Number(process.env.INK_EXTCALLS_HOURS) || 24,
      maxMb: Number(process.env.INK_EXTCALLS_MAX_MB) || 200,
    });
  } catch (e) {
    console.warn('[extcalls] store unavailable, calls will not be recorded:', e.message);
    shared = UNAVAILABLE;
  }
  return shared;
}
// tests swap in a store of their own (or null to reopen from env)
export function setExtStore(store) { shared = store; }

// query params whose names look like secrets: the name stays, the value goes
const SECRET_WORDS = new Set(['key', 'apikey', 'token', 'auth', 'authorization', 'session', 'sessionid', 'sid', 'password',
  'pass', 'passwd', 'pwd', 'sig', 'signature', 'secret']);
function secretName(k) {
  const lower = String(k).toLowerCase();
  if (SECRET_WORDS.has(lower) || /(key|token|secret|password|session)$/.test(lower)) return true;
  return String(k).split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).some((w) => SECRET_WORDS.has(w.toLowerCase()));
}
export function redactQuery(searchParams) {
  const p = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(String(searchParams || '').replace(/^\?/, ''));
  const out = [];
  for (const [k, v] of p) out.push(`${k}=${secretName(k) ? '…' : v}`);
  return out.join('&');
}

// user ids (and anything that looks like an email) out of a path: /api/users/abc123/owned-cards → /api/users/:uid/owned-cards
export function maskPath(p) {
  return String(p || '/')
    .replace(/\/(users?|uid|profiles?|members?)\/([^/]+)/gi, (m, seg) => `/${seg}/:uid`)
    .replace(/\/[^/]*@[^/]*/g, '/:email');
}

const errText = (e) => {
  const cause = e?.cause?.code || e?.cause?.message;
  return `${e?.name === 'AbortError' || e?.name === 'TimeoutError' ? `${e.name}: ${e.message}` : e?.message || String(e)}${cause ? ` (${cause})` : ''}`;
};

// the parts of a URL a row keeps
function urlParts(url, mask = maskPath) {
  const u = url instanceof URL ? url : new URL(String(url));
  return { host: u.host, path: mask(u.pathname), query: redactQuery(u.searchParams) || null };
}

// Record a call that didn't go to the network (a cache hit): row fields as in the store, plus `url` for host/path/query.
export function recordCall(row = {}) {
  try {
    const { url, maskPath: mask, userId, ...rest } = row;
    const parts = url ? urlParts(url, mask) : {};
    extStore().record({ at: Date.now(), ...parts, ...rest, user_id: rest.user_id ?? userId ?? null });
  } catch { /* recording never breaks a caller */ }
}

// fetch() plus one row in the store. meta: { source, kind, caller?, userId?, ref?, cache?, bodyType?,
//   keepBody?: false | true | (text, res) => string|object|null  (what to keep of the response text),
//   maskPath?: (path) => string }
// The response comes back readable as usual; its body is counted as the caller reads it (no second copy, so a big
// download streams straight through), and the row is written when the body ends. A network error is recorded with
// status 0 and rethrown.
export async function extFetch(url, init = {}, meta = {}) {
  const m = meta || {};
  const u = new URL(String(url));
  const base = {
    source: m.source || 'other', kind: m.kind || null, method: (init?.method || 'GET').toUpperCase(),
    ...urlParts(u, m.maskPath || maskPath),
    caller: m.caller || null, user_id: m.userId ?? null, ref: m.ref ?? null, cache: m.cache || null,
  };
  const at = Date.now();
  const t0 = performance.now();
  const rec = (row) => { try { (m.store || extStore()).record({ ...base, at, ms: performance.now() - t0, ...row }); } catch { /* never breaks a caller */ } };

  let res;
  try {
    res = await fetch(u, init);
  } catch (e) {
    rec({ status: 0, ok: 0, bytes: 0, error: errText(e) });
    throw e;
  }
  if (!res.body) { rec({ status: res.status, ok: res.ok, bytes: 0 }); return res; }

  const keep = m.keepBody;
  const keepAll = typeof keep === 'function';
  const chunks = [];
  let kept = 0, bytes = 0, done = false;
  const finish = (extra = {}) => {
    if (done) return;
    done = true;
    clearTimeout(unread);
    let body = null;
    if (keep && !extra.error) {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        body = keepAll ? keep(text, res) : text;
        if (body != null && typeof body !== 'string') body = JSON.stringify(body);
      } catch { body = null; }
    }
    chunks.length = 0;
    rec({ status: res.status, ok: res.ok, bytes, body: body || null, body_type: m.bodyType || res.headers.get('content-type') || null, ...extra });
  };
  const unread = setTimeout(() => finish({ error: 'body still unread after 5 min' }), UNREAD_MS);
  unread.unref?.();

  const reader = res.body.getReader();
  const counted = new ReadableStream({
    async pull(ctrl) {
      try {
        const { done: end, value } = await reader.read();
        if (end) { finish(); ctrl.close(); return; }
        bytes += value.byteLength;
        if (keep && (keepAll || kept <= BODY_MAX)) { chunks.push(value); kept += value.byteLength; }
        ctrl.enqueue(value);
      } catch (e) {
        finish({ error: errText(e) });
        ctrl.error(e);
      }
    },
    cancel(reason) {
      finish({ error: 'body cancelled by the caller' });
      return reader.cancel(reason);
    },
  });
  const out = new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
  Object.defineProperty(out, 'url', { value: res.url });
  Object.defineProperty(out, 'redirected', { value: res.redirected });
  return out;
}
