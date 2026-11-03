// Saved games: every finished game in the lobby (people vs bots, people vs people) is kept in data/ink.db as a
// replay — the seed, both decklists and the accepted actions (the engine is deterministic). Replays can be
// watched back from either seat, and they train the bot (game/learn/): after every few new games a worker
// replays them all and refits the model the bots read (data/bot-model.json).
//
//   GET /api/replays             this player's games
//   GET /api/replays/:id?seat=0  the game as frames (the view that seat had after each action)
//   POST /api/replays/:id/review          engine review of both players' moves (queued, one at a time; every finished
//                                         game with a person in it is queued on its own, this moves it to the front)
//   GET  /api/replays/:id/review          its progress, then the result (kept in data/ink.db)
//   GET /api/bot/training        what the bot has learned from
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { viewFor, eventsFor } from '../game/engine.js';
import { replayGame } from '../game/learn/replay.js';
import { getModel } from '../game/learn/model.js';

const RETRAIN_EVERY = 10;          // new games between training runs (each one replays every game and plays a head-to-head test)
const MAX_FRAMES_CACHED = 8;

export function attachReplays(app, { db, dbFile, cardsDb, getIndex, accounts }) {
  if (!db) return { save: () => null };
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id        TEXT PRIMARY KEY,
      source    TEXT NOT NULL,          -- 'lobby' · 'selfplay'
      created   INTEGER NOT NULL,
      finished  INTEGER NOT NULL,
      seed      INTEGER NOT NULL,
      seats     TEXT NOT NULL,          -- JSON [{name, userId, bot, level, deckName, cards}]
      actions   TEXT NOT NULL,          -- JSON [[seat, action], …]
      winner    INTEGER,
      turns     INTEGER,
      reason    TEXT,
      human     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_games_finished ON games(finished);
    CREATE TABLE IF NOT EXISTS game_players (
      game_id   TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL,
      seat      INTEGER NOT NULL,
      PRIMARY KEY (game_id, seat)
    );
    CREATE INDEX IF NOT EXISTS idx_gp_user ON game_players(user_id);
    CREATE TABLE IF NOT EXISTS game_reviews (
      game_id   TEXT NOT NULL,
      seat      INTEGER NOT NULL,
      created   INTEGER NOT NULL,
      review    TEXT NOT NULL,
      PRIMARY KEY (game_id, seat)
    );
  `);
  const q = {
    add: db.prepare('INSERT INTO games (id, source, created, finished, seed, seats, actions, winner, turns, reason, human) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    addPlayer: db.prepare('INSERT OR IGNORE INTO game_players (game_id, user_id, seat) VALUES (?, ?, ?)'),
    get: db.prepare('SELECT * FROM games WHERE id = ?'),
    mine: db.prepare(`SELECT g.id, g.finished, g.seats, g.winner, g.turns, g.reason, p.seat FROM game_players p JOIN games g ON g.id = p.game_id
      WHERE p.user_id = ? ORDER BY g.finished DESC LIMIT 30`),
    counts: db.prepare("SELECT COUNT(*) AS games, SUM(human) AS human, SUM(source = 'selfplay') AS selfplay FROM games WHERE winner IS NOT NULL"),
  };

  // ---- training ----
  let training = null, lastTrain = null, newSince = 0;
  function retrain(reason) {
    if (training || !getIndex()) return;
    newSince = 0;
    training = new Worker(new URL('../game/learn/trainworker.js', import.meta.url), { workerData: { dbFile, cardsDb } });
    const t0 = Date.now();
    training.on('message', (m) => {
      lastTrain = { ...m, at: Date.now(), ms: Date.now() - t0, reason };
      console.log(m.ok ? `[train] ${m.summary.log.join(' · ')} (${Math.round((Date.now() - t0) / 1000)}s)` : `[train] failed: ${m.error}`);
    });
    training.on('error', (e) => { lastTrain = { ok: false, error: e.message, at: Date.now() }; console.warn('[train] crashed:', e.message); });
    training.on('exit', () => { training = null; });
    training.unref();
  }
  setTimeout(() => { if ((q.counts.get().games || 0) >= 20 && !getModel()) retrain('startup'); }, 30000).unref();

  function save(rec, source = 'lobby') {
    const id = crypto.randomBytes(8).toString('base64url');
    const human = rec.seats.some((p) => !p.bot) ? 1 : 0;
    q.add.run(id, source, rec.startedAt || Date.now(), rec.finishedAt || Date.now(), rec.seed, JSON.stringify(rec.seats), JSON.stringify(rec.actions),
      rec.winner ?? null, rec.turns ?? null, rec.reason || '', human);
    rec.seats.forEach((p, seat) => { if (p.userId != null) q.addPlayer.run(id, p.userId, seat); });
    if (++newSince >= RETRAIN_EVERY) retrain('new games');
    if (human && source === 'lobby' && rec.actions.length) queueReview(id);   // ready for the replay (see engine reviews)
    return id;
  }

  // ---- watching ----
  const frames = new Map();          // `${id}:${seat}` → payload (a few recent ones)
  function framesFor(row, seat) {
    const key = `${row.id}:${seat}`;
    if (frames.has(key)) return frames.get(key);
    const rec = { seed: row.seed, seats: JSON.parse(row.seats), actions: JSON.parse(row.actions) };
    const out = [];
    let defs = null;
    const r = replayGame(getIndex(), rec, (s, k, who, a, events) => {
      defs ||= s.defs;
      const v = viewFor(s, seat);
      v.log = v.log.slice(-14);
      out.push({ k, who, type: a?.type || 'start', view: v, events: k < 0 ? [] : eventsFor(events, seat) });
    });
    const payload = { id: row.id, seat, finished: row.finished, winner: row.winner, seats: rec.seats.map(({ name, bot, level, deckName }) => ({ name, bot, level, deckName })), defs, frames: out, complete: r.ok, error: r.ok ? null : `This replay stops at move ${r.at + 1}: the cards' rules changed since it was played.` };
    frames.set(key, payload);
    if (frames.size > MAX_FRAMES_CACHED) frames.delete(frames.keys().next().value);
    return payload;
  }

  app.get('/api/replays', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const u = accounts.userFromReq(req);
    if (!u) return res.json({ games: [] });
    res.json({ games: q.mine.all(u.id).map((g) => {
      const seats = JSON.parse(g.seats);
      const opp = seats[1 - g.seat];
      return { id: g.id, finished: g.finished, seat: g.seat, won: g.winner === g.seat, turns: g.turns, reason: g.reason, deck: seats[g.seat]?.deckName, opponent: opp?.name, oppDeck: opp?.deckName, oppBot: !!opp?.bot };
    }) });
  });
  app.get('/api/replays/:id', (req, res) => {
    if (!getIndex()) return res.status(503).json({ error: 'The card database is still loading.' });
    const row = q.get.get(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'No such replay.' });
    const seats = JSON.parse(row.seats);
    const u = accounts.userFromReq(req);
    const mineSeat = u ? seats.findIndex((p) => p.userId === u.id) : -1;
    const seat = req.query.seat != null ? (Number(req.query.seat) === 1 ? 1 : 0) : Math.max(0, mineSeat);
    res.set('Cache-Control', 'private, max-age=300');
    res.json(framesFor(row, seat));
  });
  // ---- engine reviews ----
  // One review covers both players (game/analysis/review.js, v2), stored under seat BOTH. Every finished game with a
  // person in it is queued as it's saved, so the review is usually ready by the time anyone opens the replay; a
  // replay opened before that asks for it and goes to the front of the queue.
  const REVIEW_BUDGET_MS = 300;
  const BOTH = 2;
  const MAX_QUEUE = 30;
  const reviews = new Map();            // game id → { state: 'queued'|'running'|'done'|'failed', progress, error }
  const rq = [];
  let rworker = null, rbusy = null;
  const getReviewRow = db.prepare('SELECT review FROM game_reviews WHERE game_id = ? AND seat = ?');
  const getReview = (id) => { const r = getReviewRow.get(id, BOTH); const v = r && JSON.parse(r.review); return v?.v >= 2 ? v : null; };
  const putReview = db.prepare('INSERT OR REPLACE INTO game_reviews (game_id, seat, created, review) VALUES (?, ?, ?, ?)');
  function reviewWorker() {
    if (rworker) return rworker;
    rworker = new Worker(new URL('../game/analysis/reviewworker.js', import.meta.url), { workerData: { cardsDb } });
    rworker.on('message', (m) => {
      if (m.ready) return;
      const job = rbusy && reviews.get(rbusy);
      if (!job || m.id !== rbusy) return;
      if (m.progress) { job.progress = m.progress; return; }
      if (m.review) { putReview.run(rbusy, BOTH, Date.now(), JSON.stringify(m.review)); job.state = 'done'; }
      else { job.state = 'failed'; job.error = m.error; }
      rbusy = null;
      nextReview();
    });
    rworker.on('error', (e) => { console.warn('[review] worker crashed:', e.message); if (rbusy) { const j = reviews.get(rbusy); if (j) { j.state = 'failed'; j.error = e.message; } } rbusy = null; rworker = null; nextReview(); });
    rworker.unref();
    return rworker;
  }
  function nextReview() {
    if (rbusy || !rq.length) return;
    const id = rq.shift();
    const row = q.get.get(id);
    if (!row) { reviews.get(id).state = 'failed'; return nextReview(); }
    rbusy = id;
    reviews.get(id).state = 'running';
    reviewWorker().postMessage({ id, rec: { seed: row.seed, seats: JSON.parse(row.seats), actions: JSON.parse(row.actions) }, budgetMs: REVIEW_BUDGET_MS });
  }
  // queue a game's review; front: someone is waiting on this one. false when the queue is full.
  function queueReview(id, { front = false } = {}) {
    if (getReview(id)) return true;
    const job = reviews.get(id);
    if (job && job.state === 'running') return true;
    if (job && job.state === 'queued') {
      if (front && rq.indexOf(id) > 0) { rq.splice(rq.indexOf(id), 1); rq.unshift(id); }
      return true;
    }
    if (rq.length >= MAX_QUEUE) {
      if (!front) return false;
      reviews.delete(rq.pop());                                  // drop the newest automatic one for the person waiting
    }
    reviews.set(id, { state: 'queued', progress: [0, 0] });
    front ? rq.unshift(id) : rq.push(id);
    nextReview();
    return true;
  }
  const status = (id) => {
    if (reviews.get(id)?.state === 'done') reviews.delete(id);     // the saved row is the result; without it, start over
    const job = reviews.get(id);
    return job ? { state: job.state, progress: job.progress, error: job.error || null, ahead: rq.indexOf(id) + 1 } : { state: 'none' };
  };
  app.post('/api/replays/:id/review', (req, res) => {
    const row = q.get.get(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'No such replay.' });
    if (getReview(row.id)) return res.json({ state: 'done' });
    if (!queueReview(row.id, { front: true })) return res.status(503).json({ error: 'The engine is busy reviewing other games. Try again in a minute.' });
    res.json(status(row.id));
  });
  app.get('/api/replays/:id/review', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const row = q.get.get(String(req.params.id));
    if (!row) return res.status(404).json({ error: 'No such replay.' });
    const saved = getReview(row.id);
    if (saved) return res.json({ state: 'done', review: saved });
    res.json(status(row.id));
  });

  app.get('/api/bot/training', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const m = getModel();
    const c = q.counts.get();
    res.json({ saved: { games: c.games || 0, people: c.human || 0, selfplay: c.selfplay || 0 },
      model: m ? { trainedAt: m.trainedAt, games: m.games, humanGames: m.humanGames, positions: m.positions, using: !!m.value?.use, holdout: m.value?.holdout || null, gate: m.value?.gate || null, cardsWithHabits: Object.values(m.habits || {}).filter((h) => h.ink + h.play >= 15).length } : null,
      training: !!training, last: lastTrain && { ok: lastTrain.ok, at: lastTrain.at, error: lastTrain.error || null } });
  });

  return { save, retrain };
}
