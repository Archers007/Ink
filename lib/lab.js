// Deck Lab: a live AI deck builder. A player gives it a starting idea (1–6 seed cards, or one of their decks, and
// optionally the inks); it reads the idea, finds enablers and payoffs, builds a list, plays it against the meta field
// and keeps improving it, narrating as it goes. The page (public/lab.html) watches it over Server-Sent Events.
//
//   POST /api/lab                 { seed: { cards?, deckId?, inks? }, rounds?: 1..6, games?: 12..60, options? } → { id, options }
//   POST /api/lab/:id/continue    { from?: label, rounds?, games?, options? } → { id, options }: a new run from that version
//   GET  /api/lab                 my runs, newest 30
//   GET  /api/lab/:id/events      SSE: every event so far, then live ones (`id:` lines, so a reconnect resumes)
//   GET  /api/lab/:id             { id, status, events, frame, options, parent }
//   POST /api/lab/:id/cancel
//   POST /api/lab/:id/save        { name? } → { deckId }: the best list so far into the owner's decks
//   GET  /api/admin/lab/runs      ?limit=&user=   (moderator+) runs with their players' names
//   GET  /api/admin/lab/export    ?since=         (admin) { runs, tests } for analysis
//
//   options: { pivot = true, freeRein = false, target (0..1, moderator+), untilTarget (moderator+) }
//
// Seed: unless the player fixed the inks, a list is built for each of the best colour pairs (brain.inkOptions) and
// they're quick-simmed on the same games; the best becomes v1.
// One round: sim (the list on fresh games, quick pilot, plus one smart-pilot game streamed move by move) → impact
// (which cards do nothing) → try (each proposed swap, and with pivot/freeRein up to 2 whole-list pivots, on the same
// games as the list they change; kept if they win more) → confirm (the better of {the kept swaps together, the best
// pivot} against the list without it, smart pilot on fresh games). A round that keeps nothing makes the next one try
// more pivots and fewer swaps. With a target, every round ends by checking the best list's smart-pilot rate against it.
// The brain (game/lab/brain.js) and every game run in worker threads (game/lab/labworker.js). Live sessions are in
// memory for an hour after they finish; runs, events (not frames) and tests are also written to the stats DB, so a
// finished run can be read after a restart and a run cut off by one shows as 'interrupted'.
import os from 'node:os';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { resolveDeck, INK_ORDER } from '../game/cards.js';
import { wilson } from '../game/analysis/report.js';

const POOL = Math.max(1, Math.min(4, (os.availableParallelism?.() || os.cpus().length) - 2));
const MAX_RUNNING = 2;                  // sessions building at once, site-wide
const MAX_OPPS = 6;                     // meta decks in the field
const PACE_MS = 350;                    // the streamed game, between actions
const SMART_BUDGET_MS = 130;
const MAX_SWAPS = 4;                    // swaps tried per round
const STUCK_SWAPS = 2;                  // … after a round that kept nothing (when pivots are on)
const MAX_PIVOTS = 2;                   // whole-list candidates per round
const STUCK_PIVOTS = 3;
const MAX_INK_TRIALS = 4;               // colour pairs tried at the seed
const TARGET_ROUNDS = 500;              // safety cap for "keep going until it wins X%"
const DEFAULT_TARGET = 0.55;
const MY_RUNS = 30;
const SESSION_TTL = 60 * 60 * 1000;     // a finished session stays in memory this long (then the DB serves it)
const MAX_RUN_MS = 45 * 60 * 1000;      // a session still running after this is stopped (not untilTarget runs)
const HEARTBEAT_MS = 20 * 1000;
const WORKER_URL = new URL('../game/lab/labworker.js', import.meta.url);

class Cancelled extends Error {}
const pct = (x) => Math.round((x || 0) * 100);
const inkName = (inks) => (inks || []).map((i) => String(i).charAt(0).toUpperCase() + String(i).slice(1)).join('/');
const sameInks = (a, b) => [...(a || [])].sort().join('/') === [...(b || [])].sort().join('/');
const parse = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };

// ---------- the stats DB: lab_runs, lab_events (no frames), lab_tests ----------
function openStore(db) {
  const nop = () => null;
  if (!db) return { on: false, runStart: nop, runUpdate: nop, runFinish: nop, event: nop, test: nop, verdict: nop, run: nop, events: () => [], testCards: nop, mine: () => [], admin: () => [], exportSince: () => ({ runs: [], tests: [] }) };
  db.exec(`
    CREATE TABLE IF NOT EXISTS lab_runs (
      id TEXT PRIMARY KEY, user_id INTEGER, parent_id TEXT, created INTEGER, finished INTEGER, status TEXT,
      seed TEXT, options TEXT, rounds INTEGER, games INTEGER, best TEXT,
      start_rate REAL, best_rate REAL, best_inks TEXT, name TEXT
    );
    CREATE INDEX IF NOT EXISTS lab_runs_user ON lab_runs (user_id, created);
    CREATE INDEX IF NOT EXISTS lab_runs_created ON lab_runs (created);
    CREATE TABLE IF NOT EXISTS lab_events (
      run_id TEXT, seq INTEGER, at INTEGER, t TEXT, data TEXT, PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS lab_tests (
      run_id TEXT, label TEXT, round INTEGER, kind TEXT, inks TEXT, cards TEXT, wins INTEGER, games INTEGER,
      rate REAL, lo REAL, hi REAL, pilot TEXT, kept INTEGER, why TEXT, at INTEGER, PRIMARY KEY (run_id, label)
    );
  `);
  // a run that was going when the server stopped can't resume: say so
  const cut = db.prepare("UPDATE lab_runs SET status = 'interrupted', finished = ? WHERE status = 'running'").run(Date.now()).changes;
  if (cut) console.log(`[lab] ${cut} run${cut === 1 ? '' : 's'} cut off by the last restart marked interrupted`);
  const q = {
    runStart: db.prepare(`INSERT OR REPLACE INTO lab_runs (id, user_id, parent_id, created, finished, status, seed, options, rounds, games, best, start_rate, best_rate, best_inks, name)
      VALUES (?, ?, ?, ?, NULL, 'running', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`),
    runUpdate: db.prepare('UPDATE lab_runs SET seed = ?, best = ?, start_rate = ?, best_rate = ?, best_inks = ?, name = ? WHERE id = ?'),
    runFinish: db.prepare('UPDATE lab_runs SET status = ?, finished = ?, best = ?, start_rate = ?, best_rate = ?, best_inks = ?, name = ? WHERE id = ?'),
    event: db.prepare('INSERT OR REPLACE INTO lab_events (run_id, seq, at, t, data) VALUES (?, ?, ?, ?, ?)'),
    test: db.prepare(`INSERT OR REPLACE INTO lab_tests (run_id, label, round, kind, inks, cards, wins, games, rate, lo, hi, pilot, kept, why, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`),
    verdict: db.prepare('UPDATE lab_tests SET kept = ?, why = ? WHERE run_id = ? AND label = ?'),
    run: db.prepare('SELECT * FROM lab_runs WHERE id = ?'),
    events: db.prepare('SELECT seq, data FROM lab_events WHERE run_id = ? ORDER BY seq'),
    testCards: db.prepare('SELECT cards, rate FROM lab_tests WHERE run_id = ? AND label = ?'),
    mine: db.prepare('SELECT id, name, created, status, start_rate, best_rate, best_inks, parent_id FROM lab_runs WHERE user_id = ? ORDER BY created DESC LIMIT ?'),
  };
  const safe = (fn) => (...a) => { try { return fn(...a); } catch (e) { console.warn('[lab] db:', e.message); return null; } };
  const bestCols = (s) => [JSON.stringify(s.best || null), s.startRate ?? null, s.best?.rate ?? null, s.best?.inks ? JSON.stringify(s.best.inks) : null, s.best?.name || null];
  const seedJson = (s) => JSON.stringify({ cards: s.seed.cards, deck: s.seed.deck, inks: s.seed.inks, format: s.format ?? s.seed.format ?? null, ...(s.base ? { base: s.base, from: s.from } : {}) });
  const runCols = ['id', 'user_id', 'user_name', 'parent_id', 'created', 'finished', 'status', 'rounds', 'games', 'start_rate', 'best_rate', 'best_inks', 'name', 'options'];
  const rowOut = (r, cols) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, ['best_inks', 'options', 'seed', 'best', 'cards', 'inks'].includes(c) ? parse(r[c]) : r[c]]));
  return {
    on: true,
    runStart: safe((s) => q.runStart.run(s.id, s.userId, s.parentId || null, s.createdAt, seedJson(s), JSON.stringify(s.options), s.rounds, s.games)),
    runUpdate: safe((s) => q.runUpdate.run(seedJson(s), ...bestCols(s), s.id)),
    runFinish: safe((s) => q.runFinish.run(s.status, s.finishedAt, ...bestCols(s), s.id)),
    event: safe((id, seq, e) => q.event.run(id, seq, e.at, e.t, JSON.stringify(e))),
    test: safe((id, x) => q.test.run(id, x.label, x.round ?? null, x.kind, JSON.stringify(x.inks || []), JSON.stringify(x.cards), x.wins, x.games, x.rate, x.lo, x.hi, x.pilot, x.why ?? null, x.at)),
    verdict: safe((id, label, kept, why) => q.verdict.run(kept ? 1 : 0, why ?? null, id, label)),
    run: safe((id) => q.run.get(id) || null),
    events: (id) => safe(() => q.events.all(id))() || [],
    testCards: safe((id, label) => { const r = q.testCards.get(id, label); return r ? { cards: parse(r.cards, []), rate: r.rate } : null; }),
    mine: (uid, n) => (safe(() => q.mine.all(uid, n))() || []).map((r) => ({ ...r, best_inks: parse(r.best_inks) })),
    admin: (limit, user) => {
      const where = user == null || user === '' ? '' : /^\d+$/.test(String(user)) ? 'WHERE r.user_id = ?' : 'WHERE u.name LIKE ?';
      const args = where ? [/^\d+$/.test(String(user)) ? Number(user) : `%${user}%`] : [];
      const rows = safe(() => db.prepare(`SELECT r.*, u.name AS user_name FROM lab_runs r LEFT JOIN users u ON u.id = r.user_id ${where} ORDER BY r.created DESC LIMIT ?`).all(...args, limit))() || [];
      return rows.map((r) => rowOut(r, runCols));
    },
    exportSince: (since) => {
      const runs = safe(() => db.prepare('SELECT r.*, u.name AS user_name FROM lab_runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.created >= ? ORDER BY r.created').all(since))() || [];
      const tests = safe(() => db.prepare('SELECT t.* FROM lab_tests t JOIN lab_runs r ON r.id = t.run_id WHERE r.created >= ? ORDER BY t.run_id, t.at').all(since))() || [];
      return { runs: runs.map((r) => rowOut(r, [...runCols, 'seed', 'best'])), tests: tests.map((t) => rowOut(t, Object.keys(t))) };
    },
  };
}

export function attachLab(app, { db = null, getIndex, accounts, dbFile, brainUrl = null, paceMs = PACE_MS, smartBudgetMs = SMART_BUDGET_MS }) {
  const sessions = new Map();
  const store = openStore(db);

  // ---------- the brain (one worker, its own card index) ----------
  let brainWorker = null;
  const brainCalls = new Map();
  function brainW() {
    if (brainWorker) return brainWorker;
    const w = new Worker(WORKER_URL, { workerData: { mode: 'brain', dbFile, brainUrl } });
    const fail = (msg) => { for (const [, c] of brainCalls) c.reject(new Error(msg)); brainCalls.clear(); if (brainWorker === w) brainWorker = null; };
    w.on('message', (m) => { const c = brainCalls.get(m.id); if (!c) return; brainCalls.delete(m.id); m.error ? c.reject(new Error(m.error)) : c.resolve(m.result); });
    w.on('error', (e) => { console.error('[lab] brain worker crashed:', e.message); fail(`the deck brain crashed: ${e.message}`); });
    w.on('exit', () => fail('the deck brain stopped'));
    w.unref();
    return (brainWorker = w);
  }
  function brain(s, fn, args) {
    check(s);
    const id = crypto.randomBytes(6).toString('base64url');
    return new Promise((resolve, reject) => {
      brainCalls.set(id, { resolve, reject });
      brainW().postMessage({ id, fn, args, mtime: getIndex()?.mtime ?? null });
    }).then((r) => { check(s); return r; });
  }
  // a brain call the run can do without (a missing or failing helper): null instead of an error
  async function brainSoft(s, fn, args) {
    try { return await brain(s, fn, args); }
    catch (e) { if (e instanceof Cancelled) throw e; console.warn(`[lab] ${fn}:`, e.message); return null; }
  }

  // ---------- the game pool (shared by every session, fair between them) ----------
  const workers = [];
  const pending = [];                   // jobs waiting: { s, game, resolve, onDone }
  function poolWorker(k) {
    if (workers[k]) return workers[k];
    const w = new Worker(WORKER_URL, { workerData: { mode: 'game' } });
    w.job = null;
    w.on('message', (m) => {
      const job = w.job;
      if (!job || job.id !== m.id || m.frame) return;
      w.job = null;
      job.s.inflight--;
      job.resolve(m.error ? null : m.rec);
      pump();
    });
    w.on('error', (e) => { console.error('[lab] game worker crashed:', e.message); });
    w.on('exit', () => {
      if (workers[k] === w) workers[k] = null;
      const job = w.job;
      w.job = null;
      if (job) { job.s.inflight--; job.resolve(null); }
      pump();
    });
    w.unref();
    return (workers[k] = w);
  }
  function pump() {
    for (let k = 0; k < POOL && pending.length; k++) {
      const w = poolWorker(k);
      if (w.job) continue;
      // the session with the fewest games running goes next
      let bi = 0;
      for (let i = 1; i < pending.length; i++) if (pending[i].s.inflight < pending[bi].s.inflight) bi = i;
      const job = pending.splice(bi, 1)[0];
      job.id = crypto.randomBytes(6).toString('base64url');
      job.s.inflight++;
      w.job = job;
      w.postMessage({ id: job.id, game: job.game });
    }
  }
  const playOne = (s, game) => new Promise((resolve) => { pending.push({ s, game, resolve }); pump(); });

  // the session's streamed game gets a worker of its own (it mostly waits between moves)
  function streamWorker(s) {
    if (s.streamW) return s.streamW;
    const w = new Worker(WORKER_URL, { workerData: { mode: 'game' } });
    w.on('error', (e) => console.error('[lab] stream worker crashed:', e.message));
    w.on('exit', () => { if (s.streamW === w) s.streamW = null; const j = w.job; w.job = null; j?.resolve(null); });
    w.on('message', (m) => {
      const j = w.job;
      if (!j || j.id !== m.id) return;
      if (m.frame) return j.onFrame(m.frame);
      w.job = null;
      j.resolve(m.error ? null : m.rec);
    });
    w.unref();
    return (s.streamW = w);
  }

  // ---------- events ----------
  function emit(s, ev) {
    const e = { ...ev, at: Date.now() - s.createdAt };
    const seq = ++s.seq;
    const line = `id: ${seq}\ndata: ${JSON.stringify(e)}\n\n`;
    if (e.t === 'frame') s.liveFrame = { seq, e, line };          // only the latest frame is kept for late joiners
    else {
      s.events.push({ seq, e, line });
      if (e.t === 'gameEnd') s.liveFrame = null;
      store.event(s.id, seq, e);
    }
    for (const res of s.clients) res.write(line);
  }
  const say = (s, text, cards) => emit(s, { t: 'think', text, ...(cards?.length ? { cards } : {}) });
  const phase = (s, ph, round, label) => { s.phase = ph; emit(s, { t: 'phase', phase: ph, round, label }); };
  function verdict(s, ev) {
    emit(s, { t: 'verdict', ...ev });
    store.verdict(s.id, ev.label, ev.kept, ev.why);
  }
  function check(s) { if (s.cancelled) throw new Cancelled(); }

  // ---------- helpers ----------
  const full = (id) => getIndex()?.byId.get(String(id))?.full || String(id);
  function applySwap(cards, sw) {
    const m = new Map(cards.map(([id, n]) => [String(id), n]));
    for (const [id, n] of sw.out || []) { const left = (m.get(String(id)) || 0) - n; left > 0 ? m.set(String(id), left) : m.delete(String(id)); }
    for (const [id, n] of sw.in || []) m.set(String(id), (m.get(String(id)) || 0) + n);
    return [...m.entries()];
  }
  function diff(before, after) {
    const a = new Map(before), b = new Map(after), out = [], inn = [];
    for (const [id, n] of a) { const d = n - (b.get(id) || 0); if (d > 0) out.push([id, d]); }
    for (const [id, n] of b) { const d = n - (a.get(id) || 0); if (d > 0) inn.push([id, d]); }
    return { out, in: inn };
  }
  const swapIds = (sw) => [...(sw.out || []), ...(sw.in || [])].map(([id]) => String(id));
  function deckEvent(s, label, name, cards, changes) {
    const d = resolveDeck(getIndex(), { name, cards });
    emit(s, { t: 'deck', label, name: d.name, cards: d.counts, inks: d.inks, size: d.size, legal: d.legal, ...(changes ? { changes } : {}) });
    return d;
  }
  function setBest(s, label, name, cards, r) {
    s.best = { label, name, cards, inks: resolveDeck(getIndex(), { cards }).inks, rate: r?.rate ?? null, lo: r?.lo ?? null, hi: r?.hi ?? null };
    store.runUpdate(s);
  }
  // games against the field: matchups interleaved, seats alternating per matchup
  function makeGames(s, n) {
    const k = s.opps.length;
    return Array.from({ length: n }, (_, g) => ({ opp: s.opps[g % k], me: Math.floor(g / k) % 2, seed: crypto.randomInt(2 ** 30) }));
  }
  function summarize(label, records, opps) {
    const recs = records.filter(Boolean);
    const wins = recs.filter((r) => r.win).length, games = recs.length;
    const [lo, hi] = wilson(wins, games);
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const byOpp = opps.map((o) => { const rs = recs.filter((r) => r.opp === o.key); return { name: o.name, wins: rs.filter((r) => r.win).length, games: rs.length }; });
    return { label, wins, games, rate: games ? r3(wins / games) : 0, lo: r3(lo), hi: r3(hi), byOpp };
  }

  // one test: the list on `games`, the background ones in the pool, plus (stream) one streamed smart game.
  // meta { kind, round, why } goes to lab_tests; a label tested again in a later round is stored as "label@r<round>".
  async function test(s, label, cards, games, pilot, stream = false, meta = {}) {
    check(s);
    const d = resolveDeck(getIndex(), { cards });
    const budgetMs = pilot === 'smart' ? smartBudgetMs : 0;
    let done = 0, wins = 0, lastProgress = 0;
    const records = [];
    const bg = Promise.all(games.map((g) => playOne(s, { deck: d.defs, oppDeck: g.opp.defs, me: g.me, seed: g.seed, pilot, budgetMs, preview: false }).then((rec) => {
      if (rec) { rec.opp = g.opp.key; records.push(rec); if (rec.win) wins++; }
      done++;
      const now = Date.now();
      if (!s.cancelled && (done === games.length || now - lastProgress > 400)) { lastProgress = now; emit(s, { t: 'progress', label, done, total: games.length, wins }); }
    })));
    const shown = stream ? streamGame(s, label, d.defs) : null;
    await Promise.all([bg, shown]);
    check(s);
    const res = summarize(label, records, s.opps);
    emit(s, { t: 'result', ...res });
    const dbLabel = s.testLabels.has(label) ? `${label}@r${meta.round ?? s.round ?? 0}` : label;
    s.testLabels.add(label);
    s.lists.set(label, { cards: d.counts, rate: res.rate });
    store.test(s.id, { label: dbLabel, round: meta.round ?? s.round ?? 0, kind: meta.kind || 'version', inks: d.inks, cards: d.counts, wins: res.wins, games: res.games, rate: res.rate, lo: res.lo, hi: res.hi, pilot, why: meta.why, at: Date.now() - s.createdAt });
    return { ...res, records };
  }
  function streamGame(s, label, defs) {
    const opp = s.opps[crypto.randomInt(s.opps.length)];
    const me = crypto.randomInt(2), seed = crypto.randomInt(2 ** 30);
    emit(s, { t: 'gameStart', label, opp: opp.name, oppInks: opp.inks, me, seed });
    const w = streamWorker(s);
    return new Promise((resolve) => {
      const id = crypto.randomBytes(6).toString('base64url');
      w.job = { id, resolve, onFrame: (view) => { if (!s.cancelled) emit(s, { t: 'frame', label, view }); } };
      w.postMessage({ id, game: { deck: defs, oppDeck: opp.defs, me, seed, pilot: 'smart', budgetMs: smartBudgetMs, preview: true, paceMs } });
    }).then((rec) => {
      if (s.cancelled) return;
      emit(s, rec ? { t: 'gameEnd', label, win: !!rec.win, turns: rec.endTurn, reason: rec.reason, lore: rec.lore } : { t: 'gameEnd', label, win: false, turns: 0, reason: 'the game crashed', lore: [0, 0] });
    });
  }

  // ---------- the seed: read the idea, try the colour pairs, build v1 ----------
  async function startFresh(s) {
    const index = getIndex();
    phase(s, 'seed', 0, 'Reading the idea');
    const seed = await brain(s, 'readSeed', { cards: s.seed.cards, deck: s.seed.deck, inks: s.seed.inks });
    // the colour trials below decide which seed cards stay, so readSeed's own first guess at dropping one isn't said
    const trials = !s.seed.inks.length && !seed.base;
    if (seed.idea && !seed.thoughts?.length) say(s, seed.idea, seed.core);
    const held = [];
    for (const th of seed.thoughts || []) {
      if (trials && /^A deck can only use/.test(th.text)) held.push(th);
      else say(s, th.text, th.cards);
    }
    let core = (seed.core || []).filter((id) => index.byId.has(String(id)));
    if (!core.length && !trials) throw new Error('None of those cards can start a deck here.');
    let inks = seed.inks?.length ? seed.inks : s.seed.inks;
    const format = seed.format || null;
    s.format = format;
    store.runUpdate(s);
    if (format === 'infinity') say(s, "Some of these cards have rotated out of Core, so I'm building for Infinity. The meta decks I test against are Core lists, so treat the win rates as a rough guide.");
    else if (format) say(s, `Building for ${format === 'core' ? 'Core' : format}, the same format as the meta decks I test against.`);

    const pick = trials ? await inkTrials(s, s.seed.cards.filter((id) => index.byId.has(id)), format) : null;
    if (pick) { core = pick.core; inks = pick.inks; }
    else for (const th of held) say(s, th.text, th.cards);
    if (!core.length) throw new Error('None of those cards can start a deck here.');

    phase(s, 'synergy', 0, 'Looking for enablers and payoffs');
    const synergies = pick?.synergies || await brain(s, 'findSynergies', { core, opts: { inks, format } });
    emit(s, { t: 'synergy', cards: synergies.slice(0, 20).map((c) => ({ id: c.id, full: full(c.id), role: c.role, score: c.score, reasons: c.reasons || [] })) });

    phase(s, 'build', 0, 'Putting a list together');
    const built = pick?.built || await brain(s, 'assemble', { core, inks, synergies, locks: [], base: seed.base || null, format });
    for (const th of built.thoughts || []) say(s, th.text, th.cards);
    return { core, locks: core, format, synergies, cur: { label: 'v1', name: built.name || 'Lab deck', cards: built.cards }, trialRate: pick?.rate ?? null, trialLists: pick?.lists || [] };
  }

  // one list per colour pair, quick-simmed on the same games; the one that wins most goes on
  async function inkTrials(s, ids, format) {
    const index = getIndex();
    let opts = await brainSoft(s, 'inkOptions', { core: ids, opts: { format, inks: null, pivot: s.options.pivot !== false, max: MAX_INK_TRIALS } });
    opts = (Array.isArray(opts) ? opts : []).filter((o) => o?.inks?.length).slice(0, MAX_INK_TRIALS);
    if (!opts.length) return null;
    const coreOf = (o) => { const drop = new Set((o.dropped || []).map(String)); return ids.filter((id) => !drop.has(String(id))); };
    const dropSay = (o, why) => {
      const out = (o.dropped || []).map(String).filter((id) => index.byId.has(id));
      if (out.length) say(s, `${why}${inkName(o.inks)}, so I'm leaving out ${out.map(full).join(', ').replace(/, ([^,]*)$/, ' and $1')}: ${out.length === 1 ? "it doesn't" : "they don't"} fit those colours.`, out);
    };
    if (opts.length === 1) {
      dropSay(opts[0], 'Going ');
      return { inks: opts[0].inks, core: coreOf(opts[0]) };
    }
    say(s, `Before settling on colours, I'll build a list for each of the ${opts.length} most promising ink pairs and play them all on the same games.`);
    const games = makeGames(s, Math.max(12, Math.round(s.games / 2)));
    const tried = [];
    for (let i = 0; i < opts.length; i++) {
      const o = opts[i], label = `s${i + 1}`, core = coreOf(o);
      if (!core.length) continue;
      const synergies = await brain(s, 'findSynergies', { core, opts: { inks: o.inks, format } });
      const built = await brain(s, 'assemble', { core, inks: o.inks, synergies, locks: [], format });
      const d = resolveDeck(index, { name: built.name, cards: built.cards });
      emit(s, { t: 'inkTrial', label, inks: o.inks, why: o.why || '', dropped: (o.dropped || []).map(String), cards: d.counts, size: d.size, legal: d.legal });
      if (d.size < 40) { verdict(s, { label, kept: false, rate: null, base: null, why: `I couldn't build a full ${inkName(o.inks)} list (only ${d.size} cards fit).` }); continue; }
      const r = await test(s, label, d.counts, games, 'quick', false, { kind: 'ink', round: 0, why: o.why });
      tried.push({ o, label, core, synergies, built: { ...built, cards: d.counts }, r, legal: d.legal });
    }
    if (!tried.length) return null;
    // most wins; a tie goes to the pair the brain rated higher (earlier), and a legal list beats an illegal one
    const best = tried.reduce((a, b) => ((b.legal && !a.legal) || (b.legal === a.legal && b.r.wins > a.r.wins) ? b : a));
    for (const x of tried) {
      const won = x === best;
      verdict(s, { label: x.label, kept: won, rate: x.r.rate, base: best.r.rate,
        why: won ? `${inkName(x.o.inks)} won ${x.r.wins} of ${x.r.games}, the most of the ${tried.length} pairs.` : `${inkName(x.o.inks)} won ${x.r.wins} of ${x.r.games}, against ${best.r.wins} for ${inkName(best.o.inks)}.` });
    }
    say(s, `${inkName(best.o.inks)} won the most (${pct(best.r.rate)}%), so that's the pair I'm building on.`);
    dropSay(best.o, 'Going ');
    return { inks: best.o.inks, core: best.core, synergies: best.synergies, built: best.built, rate: best.r.rate, lists: tried.map((x) => x.built.cards) };
  }

  // a continued run: the parent's version is v1, the original seed cards are a soft core (not locks)
  async function startFrom(s) {
    const index = getIndex();
    phase(s, 'seed', 0, 'Picking up where it stopped');
    const p = s.from;
    say(s, `Continuing from ${p.name} ${p.label}${p.rate != null ? ` (won ${pct(p.rate)}%)` : ''}. I'll keep improving it from here.`);
    const d = resolveDeck(index, { cards: s.base });
    const inList = new Set(d.defs.map((x) => x.full));
    let core = s.seed.cards.filter((id) => index.byId.has(id) && inList.has(index.byId.get(id).full));
    if (!core.length) core = d.counts.filter(([, n]) => n >= 4).map(([id]) => String(id)).slice(0, 6);
    const format = s.seed.format || null;
    s.format = format;
    phase(s, 'synergy', 0, 'Looking for enablers and payoffs');
    const synergies = await brain(s, 'findSynergies', { core, opts: { inks: d.inks, format } });
    emit(s, { t: 'synergy', cards: synergies.slice(0, 20).map((c) => ({ id: c.id, full: full(c.id), role: c.role, score: c.score, reasons: c.reasons || [] })) });
    phase(s, 'build', 0, 'Putting a list together');
    say(s, `The list as it stands: ${d.size} cards in ${inkName(d.inks)}. I'll test it again first.`);
    return { core, locks: [], format, synergies, cur: { label: 'v1', name: p.name || 'Lab deck', cards: d.counts }, trialRate: null };
  }

  // ---------- the runner ----------
  async function run(s) {
    const index = getIndex();
    const opt = s.options;
    let { core, locks, format, synergies, cur, trialRate, trialLists = [] } = s.base ? await startFrom(s) : await startFresh(s);
    let version = 1;
    const d1 = deckEvent(s, cur.label, cur.name, cur.cards);
    cur.cards = d1.counts;
    if (d1.size < 40) throw new Error(`Couldn't build a full list from that idea (only ${d1.size} cards fit).`);
    if (!d1.legal) say(s, `This list isn't fully legal yet: ${[...d1.errors, ...d1.problems].slice(0, 2).join('; ')}.`);
    let inks = d1.inks;
    s.startRate = trialRate;
    setBest(s, cur.label, cur.name, cur.cards, trialRate != null ? { rate: trialRate } : null);
    const tried = [];                                    // swaps already tried
    const triedLists = [cur.cards, ...trialLists];      // whole lists already tested (pivots never repeat one)
    const pivotOn = opt.pivot !== false || opt.freeRein;
    const mode = opt.freeRein ? 'free' : 'pivot';
    const fixedInks = s.seed.inks.length > 0;           // the player chose the colours: pivots keep them
    const maxRounds = opt.untilTarget ? TARGET_ROUNDS : s.rounds;
    let stuck = 0;                                      // rounds in a row that kept nothing
    s.confirmed = null;                                 // { label, rate, lo, hi }: the current list's smart-pilot rate

    for (let round = 1; round <= maxRounds; round++) {
      s.round = round;
      phase(s, 'sim', round, `Testing ${cur.label} against the field`);
      const seeds = makeGames(s, s.games);                 // the tries below replay these exact games
      const base = await test(s, cur.label, cur.cards, seeds, 'quick', true, { kind: 'version', round });
      if (round === 1) s.startRate = base.rate;         // v1's rate, for "from 25% to 41%"
      Object.assign(s.best, { rate: base.rate, lo: base.lo, hi: base.hi });
      store.runUpdate(s);

      phase(s, 'impact', round, 'Finding the cards that do nothing');
      const impact = await brain(s, 'cardImpact', { records: base.records, cards: cur.cards });
      emit(s, { t: 'impact', label: cur.label, cards: impact.slice(0, 10).map((c) => ({ id: c.id, full: c.full || full(c.id), drawn: c.drawn, played: c.played, dead: c.dead, note: c.note })) });
      if (impact[0] && impact[0].dead > 0.3) say(s, `Number 1 cut: ${impact[0].full || full(impact[0].id)}. ${impact[0].note || ''}`.trim(), [impact[0].id]);

      phase(s, 'try', round, 'Trying new combos');
      const nSwaps = pivotOn && stuck ? STUCK_SWAPS : MAX_SWAPS;
      const nPivots = pivotOn ? (stuck ? STUCK_PIVOTS : MAX_PIVOTS) : 0;
      const opponents = s.opps.map(({ key, name }) => ({ key, name }));
      const swaps = (await brain(s, 'proposeSwaps', {
        cards: cur.cards, impact, records: base.records, opponents, synergies, inks, locks, tried, max: nSwaps, format,
      })) || [];
      let pivots = [];
      if (nPivots) {
        // pivots keep only the card the player started from; the other seed cards are a soft core (kept if their ink stays)
        pivots = (await brainSoft(s, 'proposePivots', {
          cards: cur.cards, impact, records: base.records, opponents, synergies, inks, locks: locks.slice(0, 1), tried: triedLists, format, mode, core, max: nPivots + (opt.freeRein ? 2 : 0), rate: base.rate, stuck,
        })) || [];
        if (fixedInks) pivots = pivots.filter((pv) => sameInks(pv.inks || resolveDeck(index, { cards: pv.cards }).inks, inks));
        pivots = pivots.filter((pv) => Array.isArray(pv?.cards) && pv.cards.length);
        // free rein: at least one of them changes the plan, not only the colours (those did best in the brain's checks)
        const plan = opt.freeRein ? pivots.find((pv) => pv.kind && pv.kind !== 'pivot-ink') : null;
        pivots = plan && !pivots.slice(0, nPivots).includes(plan) ? [...pivots.slice(0, nPivots - 1), plan] : pivots.slice(0, nPivots);
      }
      if (!swaps.length && !pivots.length) { say(s, 'Nothing new worth trying, so the list is as good as I can make it.'); break; }
      if (stuck && pivots.length) say(s, `Nothing has stuck for ${stuck === 1 ? 'a round' : `${stuck} rounds`}, so I'm trying ${pivots.length === 1 ? 'a bigger change' : `${pivots.length} bigger changes`} this time${swaps.length ? ' and fewer small swaps' : ''}.`);

      // small swaps, each on the same games as the list
      const kept = [];
      for (let i = 0; i < swaps.length; i++) {
        const sw = swaps[i];
        const label = `t${round}.${i + 1}`;
        tried.push(sw);
        emit(s, { t: 'try', label, swap: { out: sw.out, in: sw.in, why: sw.why, kind: sw.kind } });
        const next = resolveDeck(index, { cards: applySwap(cur.cards, sw) });
        const h = { label, swap: { out: sw.out, in: sw.in, why: sw.why, kind: sw.kind }, rate: null, kept: false };
        s.history.push(h);
        if (!next.legal) { verdict(s, { label, kept: false, rate: null, base: base.rate, why: "That swap would make the list illegal, so I didn't test it." }); continue; }
        const tr = await test(s, label, next.counts, seeds, 'quick', false, { kind: 'swap', round, why: sw.why });
        h.rate = tr.rate;
        const won = tr.wins > base.wins;
        verdict(s, { label, kept: won, rate: tr.rate, base: base.rate,
          why: won ? `It won ${tr.wins - base.wins} more of the same ${tr.games} games.` : tr.wins === base.wins ? 'It won exactly as often, so it is not worth the change.' : `It won ${base.wins - tr.wins} fewer of the same games.` });
        if (won) kept.push({ sw, gain: tr.wins - base.wins, h, label });
      }

      // whole-list pivots (another ink, another plan, a rebuild), on the same games
      const passed = [];
      for (let i = 0; i < pivots.length; i++) {
        const pv = pivots[i];
        const label = `p${round}.${i + 1}`;
        const next = resolveDeck(index, { cards: pv.cards });
        const changes = diff(cur.cards, next.counts);
        const changed = pv.changed ?? changes.in.reduce((n, [, k]) => n + k, 0);
        triedLists.push(next.counts);
        emit(s, { t: 'pivot', label, round, inks: next.inks, kind: pv.kind || 'pivot-ink', why: pv.why || '', cards: next.counts, changed, changes, ...(pv.name ? { name: pv.name } : {}) });
        const h = { label, swap: { out: changes.out, in: changes.in, why: pv.why || '', kind: pv.kind || 'pivot-ink' }, pivot: { inks: next.inks, changed }, rate: null, kept: false };
        s.history.push(h);
        if (!next.legal) { verdict(s, { label, kept: false, rate: null, base: base.rate, why: "That list wouldn't be legal, so I didn't test it." }); continue; }
        const tr = await test(s, label, next.counts, seeds, 'quick', false, { kind: 'pivot', round, why: pv.why });
        h.rate = tr.rate;
        const won = tr.wins > base.wins;
        verdict(s, { label, kept: won, rate: tr.rate, base: base.rate,
          why: won ? `${inkName(next.inks)} won ${tr.wins - base.wins} more of the same ${tr.games} games.` : tr.wins === base.wins ? 'It won exactly as often, so it is not worth changing that much.' : `It won ${base.wins - tr.wins} fewer of the same games.` });
        if (won) passed.push({ pv, cards: next.counts, inks: next.inks, wins: tr.wins, gain: tr.wins - base.wins, h, label });
      }

      // the candidate: the kept swaps together (best first, skipping any that touch the same cards), or the best pivot
      let swapsCand = null;
      if (kept.length) {
        kept.sort((a, b) => b.gain - a.gain);
        let cards = cur.cards;
        const used = new Set(), stacked = [];
        for (const k of kept) {
          const ids = swapIds(k.sw);
          if (ids.some((id) => used.has(id))) continue;
          const next = resolveDeck(index, { cards: applySwap(cards, k.sw) });
          if (!next.legal) continue;
          cards = next.counts;
          ids.forEach((id) => used.add(id));
          stacked.push(k);
        }
        // what the swaps together should win on these games: exact for one, an optimistic sum for several
        if (stacked.length) swapsCand = { cards, stacked, est: base.wins + stacked.reduce((n, k) => n + k.gain, 0) };
      }
      passed.sort((a, b) => b.wins - a.wins);
      const pivotCand = passed[0] || null;
      const usePivot = pivotCand && (!swapsCand || pivotCand.wins > swapsCand.est);
      if (swapsCand && pivotCand) {
        say(s, usePivot
          ? `${pivotCand.label} (${inkName(pivotCand.inks)}) won ${pivotCand.wins} of the same games, more than the kept swaps together look like they would, so that's the one to check.`
          : `The kept swaps together look at least as good as ${pivotCand.label}, and they change less, so I'm checking those.`);
      }

      if (!swapsCand && !pivotCand) {
        stuck++;
        say(s, `None of these won more than ${cur.label}, so the list stays as it is for now.`);
      } else {
        const candLabel = `c${round}`;
        const cand = usePivot ? pivotCand.cards : swapsCand.cards;
        phase(s, 'confirm', round, 'Checking with the smart pilot');
        say(s, usePivot
          ? `The quick pilot liked the ${inkName(pivotCand.inks)} list from ${pivotCand.label}. The smart pilot plays combos better, so it gets the final say on new games.`
          : `The quick pilot liked ${swapsCand.stacked.length === 1 ? 'that swap' : `${swapsCand.stacked.length} swaps`}. The smart pilot plays combos better, so it gets the final say on new games.`);
        const fresh = makeGames(s, s.confirmGames);
        const [b2, c2] = await Promise.all([
          test(s, `${cur.label} smart`, cur.cards, fresh, 'smart', false, { kind: 'confirm', round }),
          test(s, candLabel, cand, fresh, 'smart', true, { kind: usePivot ? 'pivot' : 'combined', round, why: usePivot ? pivotCand.pv.why : swapsCand.stacked.map((k) => k.label).join(' + ') }),
        ]);
        const ok = c2.wins >= b2.wins;
        const adopts = usePivot ? [pivotCand.label] : swapsCand.stacked.map((k) => k.label);
        verdict(s, { label: candLabel, kept: ok, rate: c2.rate, base: b2.rate, adopts,
          why: ok ? `With the smart pilot it won ${c2.wins} of ${c2.games} against ${b2.wins} for ${cur.label}.` : `With the smart pilot it won only ${c2.wins} of ${c2.games} against ${b2.wins} for ${cur.label}, so I'm keeping ${cur.label}.` });
        if (ok) {
          version++;
          const label = `v${version}`;
          const changes = diff(cur.cards, cand);
          if (usePivot) pivotCand.h.kept = true; else swapsCand.stacked.forEach((k) => { k.h.kept = true; });
          cur = { label, name: (usePivot && pivotCand.pv.name) || cur.name, cards: cand };
          const d = deckEvent(s, label, cur.name, cur.cards, changes);
          setBest(s, label, cur.name, cur.cards, c2);
          s.confirmed = { label, rate: c2.rate, lo: c2.lo, hi: c2.hi };
          triedLists.push(cur.cards);
          stuck = 0;
          if (!sameInks(d.inks, inks)) {
            say(s, `From here on the deck is ${inkName(d.inks)} instead of ${inkName(inks)}.`);
            inks = d.inks;
            // the swaps after this look for cards in the new colours; seed cards that left stop being locks
            const names = new Set(d.defs.map((x) => x.full));
            locks = locks.filter((id) => names.has(full(id)));
            const soft = core.filter((id) => names.has(full(id)));
            const around = soft.length ? soft : d.counts.filter(([, n]) => n >= 4).map(([id]) => String(id)).slice(0, 6);
            synergies = (await brainSoft(s, 'findSynergies', { core: around, opts: { inks, format } })) || synergies;
          }
        } else {
          s.confirmed = { label: cur.label, rate: b2.rate, lo: b2.lo, hi: b2.hi };
          stuck++;
        }
      }

      // a target: the best list's smart-pilot rate against it, every round
      if (opt.target != null) {
        if (s.confirmed?.label !== cur.label) {
          phase(s, 'confirm', round, `Checking ${cur.label} against the target`);
          const r = await test(s, `${cur.label} smart`, cur.cards, makeGames(s, s.confirmGames), 'smart', true, { kind: 'confirm', round });
          s.confirmed = { label: cur.label, rate: r.rate, lo: r.lo, hi: r.hi };
        }
        const reached = s.confirmed.rate >= opt.target;
        emit(s, { t: 'target', target: opt.target, best: { ...s.confirmed }, reached });
        if (reached) {
          s.reached = true;
          say(s, `${s.confirmed.label} wins ${pct(s.confirmed.rate)}% with the smart pilot, which reaches the ${pct(opt.target)}% target, so I'm stopping here.`);
          break;
        }
      }
    }
  }

  function doneEvent(s, extra = {}) {
    return {
      t: 'done', best: s.best, history: s.history, start: { label: 'v1', rate: s.startRate ?? null },
      ...(s.options.target != null ? { target: { target: s.options.target, reached: !!s.reached, best: s.confirmed || null } } : {}),
      ...extra,
    };
  }
  function finish(s, status) {
    if (s.status !== 'running') return;
    s.status = status;
    s.finishedAt = Date.now();
    clearTimeout(s.timer);
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].s === s) pending.splice(i, 1)[0].resolve(null);
    // stop this session's games now: a smart game can take ten seconds or more
    for (const w of workers) if (w?.job?.s === s) w.terminate();
    s.streamW?.terminate();
    store.runFinish(s);
    setTimeout(() => drop(s), SESSION_TTL).unref();
    pump();
  }
  function drop(s) {
    for (const res of s.clients) res.end();
    s.clients.clear();
    sessions.delete(s.id);
  }
  function start(s) {
    if (!s.options.untilTarget) {
      s.timer = setTimeout(() => { s.timedOut = true; cancel(s); }, MAX_RUN_MS);
      s.timer.unref();
    }
    store.runStart(s);
    run(s).then(() => {
      phase(s, 'done', s.round || s.rounds, 'Done');
      emit(s, doneEvent(s));
      finish(s, 'done');
    }, (e) => {
      if (e instanceof Cancelled) {
        if (s.best) emit(s, doneEvent(s, { cancelled: true }));
        else emit(s, { t: 'error', msg: s.timedOut ? 'The Lab ran out of time.' : 'Cancelled.' });
        finish(s, 'cancelled');
        return;
      }
      console.warn('[lab] session failed:', e.message);
      emit(s, { t: 'error', msg: e.message });
      finish(s, 'error');
    });
  }
  function cancel(s) {
    if (s.status !== 'running' || s.cancelled) return;
    s.cancelled = true;
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].s === s) pending.splice(i, 1)[0].resolve(null);
    for (const w of workers) if (w?.job?.s === s) w.terminate();
    s.streamW?.terminate();
  }

  // ---------- runs from the DB (finished, or cut off by a restart) ----------
  // the attempts, rebuilt from the stored events (for a run that never got to send its done event)
  function historyFrom(events) {
    const hs = [], by = new Map();
    for (const { e } of events) {
      if (e.t === 'try') { const h = { label: e.label, swap: e.swap, rate: null, kept: false }; hs.push(h); by.set(e.label, h); }
      else if (e.t === 'pivot') {
        const h = { label: e.label, swap: { out: e.changes?.out || [], in: e.changes?.in || [], why: e.why, kind: e.kind }, pivot: { inks: e.inks, changed: e.changed }, rate: null, kept: false };
        hs.push(h); by.set(e.label, h);
      } else if (e.t === 'verdict') {
        const h = by.get(e.label);
        if (h) h.rate = e.rate;
        if (e.kept && e.adopts) for (const l of e.adopts) if (by.get(l)) by.get(l).kept = true;
      }
    }
    return hs;
  }
  function fromDb(row) {
    const events = store.events(row.id).map((r) => ({ seq: r.seq, e: parse(r.data, {}), line: `id: ${r.seq}\ndata: ${r.data}\n\n` }));
    const status = row.status === 'running' ? 'interrupted' : row.status;
    const best = parse(row.best);
    const last = events.at(-1);
    if (status === 'interrupted' && !['done', 'error'].includes(last?.e.t)) {
      const at = last?.e.at ?? 0, seq = (last?.seq || 0) + 1;
      const e = best?.cards?.length
        ? { t: 'done', best, history: historyFrom(events), start: { label: 'v1', rate: row.start_rate ?? null }, interrupted: true, at }
        : { t: 'error', msg: 'The server restarted while this run was going, before it had a list.', interrupted: true, at };
      events.push({ seq, e, line: `id: ${seq}\ndata: ${JSON.stringify(e)}\n\n` });
    }
    return {
      id: row.id, userId: row.user_id, parentId: row.parent_id || null, status, events, liveFrame: null, best, name: row.name,
      seed: parse(row.seed, {}), options: parse(row.options, {}), createdAt: row.created, fromDb: true, clients: new Set(),
    };
  }
  const lookup = (id) => sessions.get(id) || (() => { const row = store.run(id); return row ? fromDb(row) : null; })();

  // a version's list in a run: its deck event, else a tested candidate (inkTrial / pivot / any test label)
  function listOf(s, label) {
    for (let i = s.events.length - 1; i >= 0; i--) {
      const e = s.events[i].e;
      if ((e.t === 'deck' || e.t === 'pivot' || e.t === 'inkTrial') && e.label === label && e.cards?.length) {
        const rate = label === s.best?.label ? s.best.rate : s.lists?.get(`${label} smart`)?.rate ?? s.lists?.get(label)?.rate ?? lastRate(s, label);
        return { label, cards: e.cards, rate: rate ?? null };
      }
    }
    const t = s.lists?.get(label) || store.testCards(s.id, label);
    return t?.cards?.length ? { label, cards: t.cards, rate: t.rate ?? null } : null;
  }
  function lastRate(s, label) {
    for (let i = s.events.length - 1; i >= 0; i--) {
      const e = s.events[i].e;
      if (e.t === 'result' && (e.label === `${label} smart` || e.label === label)) return e.rate;
    }
    return null;
  }

  // ---------- routes ----------
  const isAdmin = (u) => !!accounts.hasRole?.(u, 'admin');
  const isMod = (u) => !!accounts.hasRole?.(u, 'moderator');
  function signedIn(req, res) {
    const u = accounts.userFromReq(req);
    if (!u || u.guest) { res.status(401).json({ error: 'Sign in with an account to use the Deck Lab.' }); return null; }
    return u;
  }
  // owner, or moderator+ (moderators see every run on /admin)
  function readable(req, res) {
    const u = signedIn(req, res);
    if (!u) return null;
    const s = lookup(String(req.params.id));
    if (!s) { res.status(404).json({ error: store.on ? 'No such Lab run.' : 'No such Lab session (they expire an hour after finishing).' }); return null; }
    if (s.userId !== u.id && !isMod(u)) { res.status(403).json({ error: 'That Lab session belongs to another player.' }); return null; }
    return { u, s };
  }
  const clamp = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  // pivot/freeRein for everyone; target/untilTarget only for moderators and admins (ignored for others)
  function parseOptions(u, o) {
    o = o && typeof o === 'object' ? o : {};
    const out = { pivot: o.pivot === undefined ? true : !!o.pivot, freeRein: !!o.freeRein, target: null, untilTarget: false };
    if (isMod(u)) {
      let t = Number(o.target);
      if (Number.isFinite(t) && t > 0) { if (t > 1) t /= 100; out.target = Math.round(Math.min(1, t) * 1000) / 1000; }
      out.untilTarget = !!o.untilTarget;
      if (out.untilTarget && out.target == null) out.target = DEFAULT_TARGET;
    }
    return out;
  }
  // concurrency: one running session per player (admins exempt), at most MAX_RUNNING site-wide
  function gate(u, res) {
    const running = [...sessions.values()].filter((x) => x.status === 'running');
    if (!isAdmin(u) && running.some((x) => x.userId === u.id)) { res.status(409).json({ error: 'You already have a Lab session running. Cancel it or wait for it to finish.' }); return false; }
    if (running.length >= MAX_RUNNING) { res.status(429).json({ error: `The Lab is already building ${running.length} decks. Try again in a few minutes.` }); return false; }
    return true;
  }
  function field(index) {
    return (index.metaDecks?.length ? index.metaDecks : index.simDecks || []).slice(0, MAX_OPPS)
      .map((d) => ({ d, r: resolveDeck(index, d) })).filter(({ r }) => r.size >= 40)
      .map(({ d, r }) => ({ key: String(d.id), name: String(d.name).replace(/^(Meta|Demo):\s*/, ''), inks: r.inks, defs: r.defs }));
  }
  function newSession(u, { seed, rounds, games, options, opps, base = null, from = null, parentId = null }) {
    const s = {
      id: crypto.randomBytes(9).toString('base64url'), userId: u.id, parentId, createdAt: Date.now(), status: 'running', phase: null,
      seed, base, from, options, rounds, games, confirmGames: Math.max(12, Math.round(games / 2)),
      opps, events: [], seq: 0, liveFrame: null, clients: new Set(), inflight: 0, cancelled: false, best: null, history: [], streamW: null,
      lists: new Map(), testLabels: new Set(), startRate: null, confirmed: null, round: 0,
    };
    sessions.set(s.id, s);
    start(s);
    return s;
  }

  app.post('/api/lab', (req, res) => {
    const u = signedIn(req, res);
    if (!u) return;
    const index = getIndex();
    if (!index) return res.status(503).json({ error: 'The card database is still loading. Try again in a moment.' });
    if (!gate(u, res)) return;

    const body = req.body || {};
    const sd = body.seed || {};
    const cards = [...new Set((Array.isArray(sd.cards) ? sd.cards : []).map(String))].filter((id) => index.byId.has(id)).slice(0, 6);
    let deck = null;
    if (sd.deckId != null && sd.deckId !== '') {
      const d = accounts.myDeck?.(u, String(sd.deckId));
      if (!d) return res.status(404).json({ error: "That isn't one of your decks." });
      deck = { name: d.name, cards: d.cards };
    }
    if (!cards.length && !deck) return res.status(400).json({ error: 'Pick 1 to 6 seed cards, or one of your decks, to start from.' });
    const inks = [...new Set((Array.isArray(sd.inks) ? sd.inks : []).map((x) => String(x).toLowerCase()))].filter((x) => INK_ORDER.includes(x));
    if (inks.length > 2) return res.status(400).json({ error: 'A deck can use at most 2 inks.' });
    const opps = field(index);
    if (!opps.length) return res.status(503).json({ error: 'There are no opponent decks to test against yet.' });

    const options = parseOptions(u, body.options);
    const s = newSession(u, { seed: { cards, deck, inks }, rounds: clamp(body.rounds, 1, 6, 3), games: clamp(body.games, 12, 60, 24), options, opps });
    res.json({ id: s.id, options });
  });

  app.post('/api/lab/:id/continue', (req, res) => {
    const r = readable(req, res);
    if (!r) return;
    const { u, s: parent } = r;
    const index = getIndex();
    if (!index) return res.status(503).json({ error: 'The card database is still loading. Try again in a moment.' });
    const body = req.body || {};
    const from = String(body.from || parent.best?.label || 'v1');
    const src = listOf(parent, from);
    if (!src) return res.status(404).json({ error: `That run has no list called ${from}.` });
    const d = resolveDeck(index, { cards: src.cards });
    if (d.size < 40) return res.status(409).json({ error: `${from} isn't a full list any more (${d.size} cards).` });
    if (!gate(u, res)) return;
    const opps = field(index);
    if (!opps.length) return res.status(503).json({ error: 'There are no opponent decks to test against yet.' });
    const ps = parent.seed || {};
    const seedCards = (Array.isArray(ps.cards) ? ps.cards : []).map(String).filter((id) => index.byId.has(id));
    const options = parseOptions(u, body.options);
    const s = newSession(u, {
      seed: { cards: seedCards, deck: null, inks: [], format: ps.format || parent.format || null },
      base: d.counts, from: { id: parent.id, name: parent.best?.name || parent.name || 'Lab deck', label: from, rate: src.rate },
      parentId: parent.id, rounds: clamp(body.rounds, 1, 6, 3), games: clamp(body.games, 12, 60, 24), options, opps,
    });
    res.json({ id: s.id, options });
  });

  app.get('/api/lab', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const u = signedIn(req, res);
    if (!u) return;
    let runs;
    if (store.on) runs = store.mine(u.id, MY_RUNS).map((x) => ({ ...x, status: sessions.get(x.id)?.status || (x.status === 'running' ? 'interrupted' : x.status) }));
    else runs = [...sessions.values()].filter((x) => x.userId === u.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, MY_RUNS)
      .map((x) => ({ id: x.id, name: x.best?.name || null, created: x.createdAt, status: x.status, start_rate: x.startRate ?? null, best_rate: x.best?.rate ?? null, best_inks: x.best?.inks || null, parent_id: x.parentId || null }));
    res.json(runs);
  });

  app.get('/api/admin/lab/runs', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!accounts.requireRole?.(req, res, 'moderator')) return;
    const limit = clamp(req.query.limit, 1, 500, 100);
    res.json(store.admin(limit, req.query.user != null ? String(req.query.user) : null).map((x) => ({ ...x, status: sessions.get(x.id)?.status || (x.status === 'running' ? 'interrupted' : x.status) })));
  });

  app.get('/api/admin/lab/export', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!accounts.requireRole?.(req, res, 'admin')) return;
    const raw = req.query.since;
    const since = raw == null || raw === '' ? 0 : Number.isFinite(Number(raw)) ? Number(raw) : Date.parse(String(raw)) || 0;
    res.json({ since, ...store.exportSince(since) });
  });

  app.get('/api/lab/:id/events', (req, res) => {
    const r = readable(req, res);
    if (!r) return;
    const { s } = r;
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    const after = Number(req.get('Last-Event-ID')) || 0;
    for (const ev of s.events) if (ev.seq > after) res.write(ev.line);
    if (s.liveFrame && s.liveFrame.seq > after) res.write(s.liveFrame.line);
    if (s.fromDb || !sessions.has(s.id)) return res.end();
    s.clients.add(res);
    const beat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
    beat.unref();
    const close = () => { clearInterval(beat); s.clients.delete(res); };
    req.on('close', close);
    res.on('close', close);
  });

  app.get('/api/lab/:id', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const r = readable(req, res);
    if (!r) return;
    const { s } = r;
    res.json({ id: s.id, status: s.status, events: s.events.map((x) => x.e), frame: s.liveFrame?.e.view || null, options: s.options || {}, parent: s.parentId || null });
  });

  app.post('/api/lab/:id/cancel', (req, res) => {
    const r = readable(req, res);
    if (!r) return;
    if (!r.s.fromDb) cancel(r.s);
    res.json({ ok: true, status: r.s.status });
  });

  app.post('/api/lab/:id/save', (req, res) => {
    const r = readable(req, res);
    if (!r) return;
    const { u, s } = r;
    if (s.userId !== u.id) return res.status(403).json({ error: "Only the player who ran this Lab session can save its deck." });
    if (!s.best?.cards?.length) return res.status(409).json({ error: "There's no list to save yet." });
    if (!accounts.saveDeck) return res.status(503).json({ error: 'Saving decks is not available right now.' });
    // never overwrite one of their decks that happens to have the same name
    const base = String(req.body?.name || s.best.name || 'Lab deck').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 52) || 'Lab deck';
    const taken = new Set((accounts.listMine?.(u) || []).map((d) => d.name));
    let name = base;
    for (let n = 2; taken.has(name) && n < 100; n++) name = `${base} (${n})`;
    try { res.json({ deckId: accounts.saveDeck(u, { name, cards: s.best.cards }), name }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  console.log(`[lab] deck lab ready · ${POOL} game worker${POOL === 1 ? '' : 's'}${store.on ? ' · runs saved' : ''}`);
}
