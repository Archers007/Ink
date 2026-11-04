// Deck Lab: a live AI deck builder. A player gives it a starting idea (1–6 seed cards, or one of their decks, and
// optionally the inks); it reads the idea, finds enablers and payoffs, builds a list, plays it against the meta field
// and keeps improving it, narrating as it goes. The page (public/lab.html) watches it over Server-Sent Events.
//
//   POST /api/lab               { seed: { cards?, deckId?, inks? }, rounds?: 1..6, games?: 12..60 } → { id }
//   GET  /api/lab/:id/events    SSE: every event so far, then live ones (`id:` lines, so a reconnect resumes)
//   GET  /api/lab/:id           { id, status, events, frame }
//   POST /api/lab/:id/cancel
//   POST /api/lab/:id/save      { name? } → { deckId }: the best list so far into the owner's decks
//
// One round: sim (the list on fresh games, quick pilot, plus one smart-pilot game streamed move by move) → impact
// (which cards do nothing) → try (each proposed swap on the same games as the list it changes; kept if it wins
// more) → confirm (the kept swaps together, against the list without them, smart pilot on fresh games).
// The brain (game/lab/brain.js) and every game run in worker threads (game/lab/labworker.js). Sessions live in
// memory only and are dropped an hour after they finish.
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
const SESSION_TTL = 60 * 60 * 1000;     // a finished session stays this long
const MAX_RUN_MS = 45 * 60 * 1000;      // a session still running after this is stopped
const HEARTBEAT_MS = 20 * 1000;
const WORKER_URL = new URL('../game/lab/labworker.js', import.meta.url);

class Cancelled extends Error {}

export function attachLab(app, { getIndex, accounts, dbFile, brainUrl = null }) {
  const sessions = new Map();

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
    }
    for (const res of s.clients) res.write(line);
  }
  const say = (s, text, cards) => emit(s, { t: 'think', text, ...(cards?.length ? { cards } : {}) });
  const phase = (s, ph, round, label) => { s.phase = ph; emit(s, { t: 'phase', phase: ph, round, label }); };
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

  // one test: the list on `games`, the background ones in the pool, plus (stream) one streamed smart game
  async function test(s, label, cards, games, pilot, stream = false) {
    check(s);
    const defs = resolveDeck(getIndex(), { cards }).defs;
    const budgetMs = pilot === 'smart' ? SMART_BUDGET_MS : 0;
    let done = 0, wins = 0, lastProgress = 0;
    const records = [];
    const bg = Promise.all(games.map((g) => playOne(s, { deck: defs, oppDeck: g.opp.defs, me: g.me, seed: g.seed, pilot, budgetMs, preview: false }).then((rec) => {
      if (rec) { rec.opp = g.opp.key; records.push(rec); if (rec.win) wins++; }
      done++;
      const now = Date.now();
      if (!s.cancelled && (done === games.length || now - lastProgress > 400)) { lastProgress = now; emit(s, { t: 'progress', label, done, total: games.length, wins }); }
    })));
    const shown = stream ? streamGame(s, label, defs) : null;
    await Promise.all([bg, shown]);
    check(s);
    const res = summarize(label, records, s.opps);
    emit(s, { t: 'result', ...res });
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
      w.postMessage({ id, game: { deck: defs, oppDeck: opp.defs, me, seed, pilot: 'smart', budgetMs: SMART_BUDGET_MS, preview: true, paceMs: PACE_MS } });
    }).then((rec) => {
      if (s.cancelled) return;
      emit(s, rec ? { t: 'gameEnd', label, win: !!rec.win, turns: rec.endTurn, reason: rec.reason, lore: rec.lore } : { t: 'gameEnd', label, win: false, turns: 0, reason: 'the game crashed', lore: [0, 0] });
    });
  }

  // ---------- the runner ----------
  async function run(s) {
    const index = getIndex();
    phase(s, 'seed', 0, 'Reading the idea');
    const seed = await brain(s, 'readSeed', { cards: s.seed.cards, deck: s.seed.deck, inks: s.seed.inks });
    if (seed.idea && !seed.thoughts?.length) say(s, seed.idea, seed.core);
    for (const th of seed.thoughts || []) say(s, th.text, th.cards);
    const core = (seed.core || []).filter((id) => index.byId.has(String(id)));
    if (!core.length) throw new Error('None of those cards can start a deck here.');
    let inks = seed.inks?.length ? seed.inks : s.seed.inks;
    const format = seed.format || null;
    s.format = format;
    if (format === 'infinity') say(s, "Some of these cards have rotated out of Core, so I'm building for Infinity. The meta decks I test against are Core lists, so treat the win rates as a rough guide.");
    else if (format) say(s, `Building for ${format === 'core' ? 'Core' : format}, the same format as the meta decks I test against.`);

    phase(s, 'synergy', 0, 'Looking for enablers and payoffs');
    const synergies = await brain(s, 'findSynergies', { core, opts: { inks, format } });
    emit(s, { t: 'synergy', cards: synergies.slice(0, 20).map((c) => ({ id: c.id, full: full(c.id), role: c.role, score: c.score, reasons: c.reasons || [] })) });

    phase(s, 'build', 0, 'Putting a list together');
    const built = await brain(s, 'assemble', { core, inks, synergies, locks: [], base: seed.base || null, format });
    for (const th of built.thoughts || []) say(s, th.text, th.cards);
    let version = 1;
    let cur = { label: 'v1', name: built.name || 'Lab deck', cards: built.cards };
    const d1 = deckEvent(s, cur.label, cur.name, cur.cards);
    cur.cards = d1.counts;
    if (d1.size < 40) throw new Error(`Couldn't build a full list from that idea (only ${d1.size} cards fit).`);
    if (!d1.legal) say(s, `This list isn't fully legal yet: ${[...d1.errors, ...d1.problems].slice(0, 2).join('; ')}.`);
    inks = d1.inks;
    s.best = { label: cur.label, name: cur.name, cards: cur.cards, rate: null, lo: null, hi: null };
    const tried = [];

    for (let round = 1; round <= s.rounds; round++) {
      phase(s, 'sim', round, `Testing ${cur.label} against the field`);
      const seeds = makeGames(s, s.games);                 // the tries below replay these exact games
      const base = await test(s, cur.label, cur.cards, seeds, 'quick', true);
      Object.assign(s.best, { rate: base.rate, lo: base.lo, hi: base.hi });

      phase(s, 'impact', round, 'Finding the cards that do nothing');
      const impact = await brain(s, 'cardImpact', { records: base.records, cards: cur.cards });
      emit(s, { t: 'impact', label: cur.label, cards: impact.slice(0, 10).map((c) => ({ id: c.id, full: c.full || full(c.id), drawn: c.drawn, played: c.played, dead: c.dead, note: c.note })) });
      if (impact[0] && impact[0].dead > 0.3) say(s, `Number 1 cut: ${impact[0].full || full(impact[0].id)}. ${impact[0].note || ''}`.trim(), [impact[0].id]);

      phase(s, 'try', round, 'Trying new combos');
      const swaps = await brain(s, 'proposeSwaps', {
        cards: cur.cards, impact, records: base.records, opponents: s.opps.map(({ key, name }) => ({ key, name })),
        synergies, inks, locks: core, tried, max: MAX_SWAPS, format,
      });
      if (!swaps?.length) { say(s, 'Nothing new worth trying, so the list is as good as I can make it.'); break; }
      const kept = [];
      for (let i = 0; i < swaps.length; i++) {
        const sw = swaps[i];
        const label = `t${round}.${i + 1}`;
        tried.push(sw);
        emit(s, { t: 'try', label, swap: { out: sw.out, in: sw.in, why: sw.why, kind: sw.kind } });
        const next = resolveDeck(index, { cards: applySwap(cur.cards, sw) });
        const h = { label, swap: { out: sw.out, in: sw.in, why: sw.why, kind: sw.kind }, rate: null, kept: false };
        s.history.push(h);
        if (!next.legal) { emit(s, { t: 'verdict', label, kept: false, rate: null, base: base.rate, why: "That swap would make the list illegal, so I didn't test it." }); continue; }
        const tr = await test(s, label, next.counts, seeds, 'quick');
        h.rate = tr.rate;
        const won = tr.wins > base.wins;
        emit(s, { t: 'verdict', label, kept: won, rate: tr.rate, base: base.rate,
          why: won ? `It won ${tr.wins - base.wins} more of the same ${tr.games} games.` : tr.wins === base.wins ? 'It won exactly as often, so it is not worth the change.' : `It won ${base.wins - tr.wins} fewer of the same games.` });
        if (won) kept.push({ sw, gain: tr.wins - base.wins, h });
      }
      if (!kept.length) { say(s, `None of these won more than ${cur.label}, so the list stays as it is for now.`); continue; }

      // the kept swaps together (best first, skipping any that touch the same cards), against the list without them
      kept.sort((a, b) => b.gain - a.gain);
      let cand = cur.cards;
      const used = new Set(), stacked = [];
      for (const k of kept) {
        const ids = swapIds(k.sw);
        if (ids.some((id) => used.has(id))) continue;
        const next = resolveDeck(index, { cards: applySwap(cand, k.sw) });
        if (!next.legal) continue;
        cand = next.counts;
        ids.forEach((id) => used.add(id));
        stacked.push(k);
      }
      const candLabel = `c${round}`;
      phase(s, 'confirm', round, 'Checking with the smart pilot');
      say(s, `The quick pilot liked ${stacked.length === 1 ? 'that swap' : `${stacked.length} swaps`}. The smart pilot plays combos better, so it gets the final say on new games.`);
      const fresh = makeGames(s, s.confirmGames);
      const [b2, c2] = await Promise.all([
        test(s, `${cur.label} smart`, cur.cards, fresh, 'smart'),
        test(s, candLabel, cand, fresh, 'smart', true),
      ]);
      const ok = c2.wins >= b2.wins;
      emit(s, { t: 'verdict', label: candLabel, kept: ok, rate: c2.rate, base: b2.rate,
        why: ok ? `With the smart pilot it won ${c2.wins} of ${c2.games} against ${b2.wins} for ${cur.label}.` : `With the smart pilot it won only ${c2.wins} of ${c2.games} against ${b2.wins} for ${cur.label}, so I'm keeping ${cur.label}.` });
      if (!ok) continue;
      version++;
      const label = `v${version}`;
      const changes = diff(cur.cards, cand);
      stacked.forEach((k) => { k.h.kept = true; });
      cur = { label, name: cur.name, cards: cand };
      deckEvent(s, label, cur.name, cur.cards, changes);
      s.best = { label, name: cur.name, cards: cur.cards, rate: c2.rate, lo: c2.lo, hi: c2.hi };
    }
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
    setTimeout(() => drop(s), SESSION_TTL).unref();
    pump();
  }
  function drop(s) {
    for (const res of s.clients) res.end();
    s.clients.clear();
    sessions.delete(s.id);
  }
  function start(s) {
    s.timer = setTimeout(() => { s.timedOut = true; cancel(s); }, MAX_RUN_MS);
    s.timer.unref();
    run(s).then(() => {
      phase(s, 'done', s.rounds, 'Done');
      emit(s, { t: 'done', best: s.best, history: s.history });
      finish(s, 'done');
    }, (e) => {
      if (e instanceof Cancelled) {
        if (s.best) emit(s, { t: 'done', best: s.best, history: s.history, cancelled: true });
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

  // ---------- routes ----------
  const isAdmin = (u) => !!accounts.hasRole?.(u, 'admin');
  function signedIn(req, res) {
    const u = accounts.userFromReq(req);
    if (!u || u.guest) { res.status(401).json({ error: 'Sign in with an account to use the Deck Lab.' }); return null; }
    return u;
  }
  function readable(req, res) {
    const u = signedIn(req, res);
    if (!u) return null;
    const s = sessions.get(String(req.params.id));
    if (!s) { res.status(404).json({ error: 'No such Lab session (they expire an hour after finishing).' }); return null; }
    if (s.userId !== u.id && !isAdmin(u)) { res.status(403).json({ error: 'That Lab session belongs to another player.' }); return null; }
    return { u, s };
  }
  const clamp = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

  app.post('/api/lab', (req, res) => {
    const u = signedIn(req, res);
    if (!u) return;
    const index = getIndex();
    if (!index) return res.status(503).json({ error: 'The card database is still loading. Try again in a moment.' });
    const running = [...sessions.values()].filter((x) => x.status === 'running');
    if (!isAdmin(u) && running.some((x) => x.userId === u.id)) return res.status(409).json({ error: 'You already have a Lab session running. Cancel it or wait for it to finish.' });
    if (running.length >= MAX_RUNNING) return res.status(429).json({ error: `The Lab is already building ${running.length} decks. Try again in a few minutes.` });

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

    const opps = (index.metaDecks?.length ? index.metaDecks : index.simDecks || []).slice(0, MAX_OPPS)
      .map((d) => ({ d, r: resolveDeck(index, d) })).filter(({ r }) => r.size >= 40)
      .map(({ d, r }) => ({ key: String(d.id), name: String(d.name).replace(/^(Meta|Demo):\s*/, ''), inks: r.inks, defs: r.defs }));
    if (!opps.length) return res.status(503).json({ error: 'There are no opponent decks to test against yet.' });

    const games = clamp(body.games, 12, 60, 24);
    const s = {
      id: crypto.randomBytes(9).toString('base64url'), userId: u.id, createdAt: Date.now(), status: 'running', phase: null,
      seed: { cards, deck, inks }, rounds: clamp(body.rounds, 1, 6, 3), games, confirmGames: Math.max(12, Math.round(games / 2)),
      opps, events: [], seq: 0, liveFrame: null, clients: new Set(), inflight: 0, cancelled: false, best: null, history: [], streamW: null,
    };
    sessions.set(s.id, s);
    start(s);
    res.json({ id: s.id });
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
    if (!sessions.has(s.id)) return res.end();
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
    res.json({ id: s.id, status: s.status, events: s.events.map((x) => x.e), frame: s.liveFrame?.e.view || null });
  });

  app.post('/api/lab/:id/cancel', (req, res) => {
    const r = readable(req, res);
    if (!r) return;
    cancel(r.s);
    res.json({ ok: true, status: r.s.status });
  });

  app.post('/api/lab/:id/save', (req, res) => {
    const r = readable(req, res);
    if (!r) return;
    const { u, s } = r;
    if (s.userId !== u.id) return res.status(403).json({ error: "Only the player who ran this Lab session can save its deck." });
    if (!s.best) return res.status(409).json({ error: "There's no list to save yet." });
    if (!accounts.saveDeck) return res.status(503).json({ error: 'Saving decks is not available right now.' });
    // never overwrite one of their decks that happens to have the same name
    const base = String(req.body?.name || s.best.name || 'Lab deck').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 52) || 'Lab deck';
    const taken = new Set((accounts.listMine?.(u) || []).map((d) => d.name));
    let name = base;
    for (let n = 2; taken.has(name) && n < 100; n++) name = `${base} (${n})`;
    try { res.json({ deckId: accounts.saveDeck(u, { name, cards: s.best.cards }), name }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  console.log(`[lab] deck lab ready · ${POOL} game worker${POOL === 1 ? '' : 's'}`);
}
