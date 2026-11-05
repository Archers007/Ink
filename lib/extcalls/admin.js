// /admin's view of the external-calls store (lib/extcalls/store.js). Moderators and admins; the export is admin only.
//   GET /api/admin/ext/stats   ?source=&kind=&since=&until=&bucket=5m|1m|15m|1h
//       { buckets: [{ t, n, errors, byKind, p50, p95, bytes }], kinds: [{ source, kind, n, errors, hits, p50, p95, bytes, last }],
//         totals: { n, errors, bytes }, store: { bytes, maxBytes, rows, oldest, hours } }
//   GET /api/admin/ext/calls   ?source=&kind=&status=&ok=&caller=&q=&since=&until=&before=&limit=
//       { calls: [row without body, has_body], next }   newest first; `next` goes back as `before`
//   GET /api/admin/ext/calls/:id   the row, `body` as text (and `json` when it's JSON)
//   GET /api/admin/ext/export  ?since=&source=   (admin) NDJSON, one row a line, bodies included

import { extStore } from './index.js';

const FILTERS = ['source', 'kind', 'status', 'ok', 'caller', 'q', 'since', 'until', 'before', 'limit', 'bucket'];
const pick = (query) => Object.fromEntries(FILTERS.filter((k) => query[k] != null && query[k] !== '').map((k) => [k, String(query[k])]));

export function attachExtCallsAdmin(app, { accounts, store } = {}) {
  const st = () => store || extStore();
  // the same role check the Lab's admin routes use; without accounts nobody gets in
  function allowed(req, res, min) {
    res.set('Cache-Control', 'no-store');
    if (!accounts?.requireRole) { res.status(503).json({ error: 'Accounts are not available on this server.' }); return false; }
    if (!accounts.requireRole(req, res, min)) return false;
    if (st().unavailable) { res.status(503).json({ error: 'The external-calls log is not available on this server.' }); return false; }
    return true;
  }
  const fail = (res, e) => { console.warn('[extcalls] admin:', e.message); res.status(500).json({ error: 'Could not read the external-calls log.' }); };

  app.get('/api/admin/ext/stats', (req, res) => {
    if (!allowed(req, res, 'moderator')) return;
    try { res.json(st().stats(pick(req.query))); } catch (e) { fail(res, e); }
  });

  app.get('/api/admin/ext/calls', (req, res) => {
    if (!allowed(req, res, 'moderator')) return;
    try { res.json(st().query(pick(req.query))); } catch (e) { fail(res, e); }
  });

  app.get('/api/admin/ext/calls/:id', (req, res) => {
    if (!allowed(req, res, 'moderator')) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad call id' });
    try {
      const row = st().get(id);
      if (!row) return res.status(404).json({ error: 'No such call (it may have aged out of the log).' });
      res.json(row);
    } catch (e) { fail(res, e); }
  });

  app.get('/api/admin/ext/export', async (req, res) => {
    if (!allowed(req, res, 'admin')) return;
    const f = pick(req.query);
    res.status(200).set({
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="ink-extcalls-${new Date().toISOString().slice(0, 10)}.ndjson"`,
    });
    let closed = false;
    res.on('close', () => { closed = true; });
    try {
      for (const row of st().exportRows({ since: f.since, source: f.source })) {
        if (closed) break;
        if (!res.write(`${JSON.stringify(row)}\n`)) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
      }
    } catch (e) {
      console.warn('[extcalls] export:', e.message);
    }
    res.end();
  });
}
