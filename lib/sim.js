// Deck simulations: the engine plays a deck against other decks in a pool of worker threads and the results become
// a report (game/analysis/report.js) — matchups, game plan, weaknesses, strengths, combos, per-card numbers.
//
//   POST /api/sim            { deck: {name, cards}, opponents: [{kind:'demo'|'mine'|'shared', id}], games, pilot, preview }
//   GET  /api/sim/:id        status, progress, the report so far, and the live preview frame
//   POST /api/sim/:id/cancel
//   GET  /api/sim            this player's recent runs (finished reports are kept in data/ink.db)
//   POST /api/sim/:id/autofix  { locks: [card names] } → { job } · GET /api/sim/autofix/:job
//        swaps proposed from the report's weaknesses (game/analysis/autofix.js), each played on the same games
//        (same seeds, seats and opponents) as the list it would change; the best one that wins more is kept,
//        then the next round starts from the new list
//
// One run at a time per player (or per IP for someone without any account); runs queue for the shared pool.
import os from 'node:os';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { resolveDeck } from '../game/cards.js';
import { buildReport } from '../game/analysis/report.js';
import { proposeEdits, applyEdit } from '../game/analysis/autofix.js';

const POOL = Math.max(1, Math.min(4, (os.availableParallelism?.() || os.cpus().length) - 1));
const LIMITS = { quick: { per: 300, total: 1200, budget: 0 }, smart: { per: 30, total: 120, budget: 120 } };
const PREVIEW_PACE_MS = 350;

export function attachSim(app, { db, getIndex, accounts }) {
  if (db) db.exec(`
    CREATE TABLE IF NOT EXISTS sim_runs (
      id        TEXT PRIMARY KEY,
      user_id   INTEGER,
      deck_name TEXT NOT NULL,
      deck_hash TEXT NOT NULL,
      settings  TEXT NOT NULL,
      created   INTEGER NOT NULL,
      finished  INTEGER,
      report    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sim_user ON sim_runs(user_id, created);
  `);
  const runs = new Map();           // id → live run
  const queue = [];                 // runs waiting for the pool
  let active = null;
  const workers = [];

  function worker(k) {
    if (workers[k]) return workers[k];
    const w = new Worker(new URL('../game/analysis/simworker.js', import.meta.url));
    w.busy = null;
    w.on('message', (m) => onMessage(w, m));
    w.on('error', (e) => { console.error('[sim] worker crashed:', e.message); const job = w.busy; workers[k] = null; if (job) { job.run.failed++; job.run.inflight--; pump(); } });
    w.unref();
    workers[k] = w;
    return w;
  }

  function onMessage(w, m) {
    const job = w.busy;
    if (!job || job.id !== m.id) return;
    const run = job.run;
    if (m.frame) { run.preview = { ...m.frame, game: job.n + 1, oppName: job.oppName }; return; }
    w.busy = null;
    run.inflight--;
    if (m.error) run.failed++;
    else { m.rec.opp = job.oppKey; run.records.push(m.rec); }
    if (run.records.length % 10 === 0 || run.inflight === 0) run.report = null;     // rebuilt on the next read
    pump();
  }

  function report(run) {
    if (!run.report) run.report = buildReport({ records: run.records, defs: run.defs, opponents: run.opponents, settings: run.settings });
    return run.report;
  }

  function pump() {
    if (!active || active.cancelled || (active.next >= active.games.length && active.inflight === 0)) {
      if (active) finish(active);
      active = queue.shift() || null;
      if (active) active.startedAt = Date.now();
      if (!active) return;
    }
    for (let k = 0; k < POOL; k++) {
      if (active.next >= active.games.length || active.cancelled) break;
      const w = worker(k);
      if (w.busy) continue;
      const n = active.next++;
      const g = active.games[n];
      const preview = active.settings.preview && k === 0;
      const id = `${active.id}:${n}`;
      w.busy = { id, run: active, n, oppKey: g.oppKey, oppName: g.oppName };
      active.inflight++;
      w.postMessage({ id, game: { deck: active.defs, oppDeck: g.oppDefs, me: g.me, seed: g.seed, pilot: active.settings.pilot, budgetMs: LIMITS[active.settings.pilot].budget, preview, paceMs: PREVIEW_PACE_MS } });
    }
  }

  function finish(run) {
    if (run.done) return;
    run.done = true;
    run.finishedAt = Date.now();
    run.preview = null;
    run.report = null;
    const rep = report(run);
    if (db && !run.internal) {
      try { db.prepare('UPDATE sim_runs SET finished = ?, report = ? WHERE id = ?').run(run.finishedAt, JSON.stringify(rep), run.id); }
      catch (e) { console.warn('[sim] save failed:', e.message); }
    }
    run.onDone?.(rep);
    setTimeout(() => runs.delete(run.id), 30 * 60 * 1000).unref();
  }

  const ownerKey = (req) => { const u = accounts.userFromReq(req); return u ? `u:${u.id}` : `ip:${req.ip}`; };
  function resolveOpp(o, u, index) {
    if (o?.kind === 'demo') { const d = index.demoDecks.find((x) => x.id === o.id); return d && { key: `demo:${d.id}`, name: d.name.replace(/^Demo:\s*/, ''), cards: d.cards }; }
    if (o?.kind === 'mine') { const d = accounts.myDeck(u, o.id); return d && { key: `mine:${d.id}`, name: d.name, cards: d.cards }; }
    if (o?.kind === 'shared') { const d = accounts.sharedDeck(o.id); return d && { key: `shared:${d.id}`, name: `${d.name} (${d.author})`, cards: d.cards }; }
    return null;
  }

  app.post('/api/sim', (req, res) => {
    const index = getIndex();
    if (!index) return res.status(503).json({ error: 'The card database is still loading. Try again in a moment.' });
    const owner = ownerKey(req);
    if ([...runs.values()].some((r) => r.owner === owner && !r.done && !r.internal)) return res.status(409).json({ error: 'You already have a test running. Cancel it or wait for it to finish.' });
    const u = accounts.userFromReq(req);
    const body = req.body || {};
    const pilot = body.pilot === 'smart' ? 'smart' : 'quick';
    const lim = LIMITS[pilot];
    const deck = resolveDeck(index, { name: body.deck?.name, cards: Array.isArray(body.deck?.cards) ? body.deck.cards : [] });
    if (deck.size < 40) return res.status(400).json({ error: `The deck needs at least 40 cards to test (it has ${deck.size}).` });
    const opps = (Array.isArray(body.opponents) ? body.opponents : []).slice(0, 8).map((o) => resolveOpp(o, u, index)).filter(Boolean);
    if (!opps.length) return res.status(400).json({ error: 'Pick at least one opponent deck.' });
    const resolved = opps.map((o) => ({ ...o, deck: resolveDeck(index, { name: o.name, cards: o.cards }) })).filter((o) => o.deck.size >= 40);
    if (!resolved.length) return res.status(400).json({ error: 'None of those opponent decks has 40 or more cards.' });
    const per = Math.max(2, Math.min(lim.per, Math.floor(Number(body.games) || 40), Math.floor(lim.total / resolved.length)));
    const id = crypto.randomBytes(8).toString('base64url');
    const games = [];
    // matchups interleaved, so a partial report already covers all of them; seats alternate
    for (let g = 0; g < per; g++) for (const o of resolved) games.push({ oppKey: o.key, oppName: o.name, oppDefs: o.deck.defs, me: g % 2, seed: crypto.randomInt(2 ** 30) });
    const settings = { pilot, gamesPer: per, preview: !!body.preview, deckName: deck.name, legal: deck.legal, problems: [...deck.errors, ...deck.problems].slice(0, 6) };
    const run = {
      id, owner, defs: deck.defs, counts: deck.counts, resolved, per, opponents: resolved.map(({ key, name }) => ({ key, name })), games, settings,
      next: 0, inflight: 0, failed: 0, records: [], report: null, preview: null, done: false, cancelled: false, createdAt: Date.now(),
    };
    runs.set(id, run);
    if (db) {
      const hash = crypto.createHash('sha256').update(JSON.stringify(deck.counts.slice().sort())).digest('hex').slice(0, 16);
      try { db.prepare('INSERT INTO sim_runs (id, user_id, deck_name, deck_hash, settings, created) VALUES (?, ?, ?, ?, ?, ?)').run(id, u?.id ?? null, deck.name, hash, JSON.stringify({ ...settings, opponents: run.opponents }), run.createdAt); }
      catch (e) { console.warn('[sim] record failed:', e.message); }
    }
    queue.push(run);
    pump();
    res.json({ id, total: games.length, queued: queue.indexOf(run) + 1 });
  });

  app.get('/api/sim/:id', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const run = runs.get(String(req.params.id));
    if (run) {
      return res.json({
        id: run.id, done: run.done, cancelled: run.cancelled, total: run.games.length, finished: run.records.length, failed: run.failed,
        queued: run === active || run.done ? 0 : queue.indexOf(run) + 1,
        elapsedMs: (run.finishedAt || Date.now()) - (run.startedAt || run.createdAt),
        preview: run.preview, report: run.records.length ? report(run) : null,
      });
    }
    const row = db?.prepare('SELECT id, settings, created, finished, report FROM sim_runs WHERE id = ?').get(String(req.params.id));
    if (!row?.report) return res.status(404).json({ error: 'No such test (or it ended before finishing).' });
    const rep = JSON.parse(row.report);
    res.json({ id: row.id, done: true, total: rep.games, finished: rep.games, failed: 0, queued: 0, elapsedMs: row.finished - row.created, preview: null, report: rep });
  });

  app.post('/api/sim/:id/cancel', (req, res) => {
    const run = runs.get(String(req.params.id));
    if (!run || run.owner !== ownerKey(req)) return res.status(404).json({ error: 'No such test.' });
    run.cancelled = true;
    const qi = queue.indexOf(run);
    if (qi >= 0) { queue.splice(qi, 1); finish(run); }
    pump();
    res.json({ ok: true });
  });

  // ---- auto-fix ----
  const AUTOFIX = { rounds: 2, candidates: 5, maxPer: 50, minGain: 0.03 };
  const fixes = new Map();
  // play a list on fixed games (seeds × opponents × seats) as an internal run; resolves with its report
  function playOn(counts, base, seeds) {
    const index = getIndex();
    const deck = resolveDeck(index, { name: base.settings.deckName, cards: counts });
    const games = [];
    seeds.forEach((seed, g) => { for (const o of base.resolved) games.push({ oppKey: o.key, oppName: o.name, oppDefs: o.deck.defs, me: g % 2, seed }); });
    return new Promise((resolve) => {
      const run = {
        id: crypto.randomBytes(8).toString('base64url'), owner: base.owner, internal: true, defs: deck.defs, counts: deck.counts, resolved: base.resolved,
        opponents: base.opponents, games, settings: { ...base.settings, pilot: 'quick', preview: false, legal: deck.legal, problems: [...deck.errors, ...deck.problems] },
        next: 0, inflight: 0, failed: 0, records: [], report: null, preview: null, done: false, cancelled: false, createdAt: Date.now(), onDone: resolve,
      };
      runs.set(run.id, run);
      queue.push(run);
      pump();
    });
  }
  async function autofix(job, base) {
    const index = getIndex();
    const seeds = Array.from({ length: Math.min(base.per, AUTOFIX.maxPer) }, () => crypto.randomInt(2 ** 30));
    let counts = base.counts;
    job.total = 1 + AUTOFIX.rounds * AUTOFIX.candidates;
    let current = await playOn(counts, base, seeds);
    job.before = { win: current.overall, games: current.games };
    job.done++;
    for (let r = 0; r < AUTOFIX.rounds && !job.cancelled; r++) {
      const edits = proposeEdits(index, counts, current, { locks: job.locks, max: AUTOFIX.candidates });
      const round = { base: current.overall, tried: [] };
      job.rounds.push(round);
      if (!edits.length) { round.note = 'No swaps to try (everything is locked, or nothing in these inks fits).'; break; }
      let best = null;
      for (const e of edits) {
        if (job.cancelled) break;
        const next = applyEdit(counts, e);
        const rep2 = await playOn(next, base, seeds);
        job.done++;
        const tried = { why: e.why, cut: e.cut, put: e.put, n: e.add[0][1], win: rep2.overall, gain: Math.round((rep2.overall.p - current.overall.p) * 100) };
        round.tried.push(tried);
        if (!best || rep2.overall.p > best.rep.overall.p) best = { e, tried, rep: rep2, next };
      }
      if (!best || best.rep.overall.p - current.overall.p < AUTOFIX.minGain) { round.note = 'None of these swaps won clearly more, so the list stays as it was.'; break; }
      best.tried.kept = true;
      job.changes.push({ cut: best.e.cut, put: best.e.put, n: best.e.add[0][1], why: best.e.why, gain: best.tried.gain });
      counts = best.next;
      current = best.rep;
    }
    job.after = { win: current.overall, games: current.games };
    job.cards = counts;
    job.state = job.cancelled ? 'cancelled' : 'done';
  }
  app.post('/api/sim/:id/autofix', (req, res) => {
    const base = runs.get(String(req.params.id));
    if (!base || base.internal) return res.status(404).json({ error: 'That test has expired. Run the test again, then auto-fix.' });
    if (base.owner !== ownerKey(req)) return res.status(403).json({ error: 'Only the person who ran the test can auto-fix it.' });
    if (!base.done) return res.status(409).json({ error: 'Let the test finish first.' });
    if ([...fixes.values()].some((j) => j.owner === base.owner && j.state === 'running')) return res.status(409).json({ error: 'An auto-fix is already running.' });
    const locks = (Array.isArray(req.body?.locks) ? req.body.locks : []).map(String).slice(0, 60);
    const job = { id: crypto.randomBytes(8).toString('base64url'), owner: base.owner, state: 'running', locks, done: 0, total: 1, rounds: [], changes: [], before: null, after: null, cards: null, pilot: 'quick', gamesPer: Math.min(base.per, AUTOFIX.maxPer) };
    fixes.set(job.id, job);
    autofix(job, base).catch((e) => { job.state = 'failed'; job.error = e.message; console.warn('[sim] auto-fix failed:', e.message); });
    setTimeout(() => fixes.delete(job.id), 60 * 60 * 1000).unref();
    res.json({ job: job.id });
  });
  app.get('/api/sim/autofix/:job', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const job = fixes.get(String(req.params.job));
    if (!job || job.owner !== ownerKey(req)) return res.status(404).json({ error: 'No such auto-fix.' });
    const { owner, ...out } = job;
    res.json(out);
  });
  app.post('/api/sim/autofix/:job/cancel', (req, res) => {
    const job = fixes.get(String(req.params.job));
    if (!job || job.owner !== ownerKey(req)) return res.status(404).json({ error: 'No such auto-fix.' });
    job.cancelled = true;
    res.json({ ok: true });
  });

  app.get('/api/sim', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const u = accounts.userFromReq(req);
    if (!u || !db) return res.json({ runs: [] });
    const rows = db.prepare('SELECT id, deck_name, settings, created, finished FROM sim_runs WHERE user_id = ? AND report IS NOT NULL ORDER BY created DESC LIMIT 20').all(u.id);
    res.json({ runs: rows.map((r) => ({ id: r.id, deck: r.deck_name, created: r.created, finished: r.finished, settings: JSON.parse(r.settings) })) });
  });

  console.log(`[sim] deck simulations ready · ${POOL} worker${POOL === 1 ? '' : 's'}`);
}
