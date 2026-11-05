// Ink Play — lobby + rooms over WebSockets (path /ws/play).
//
// Flow:  host creates a room → gets a 5-letter code + invite link (/play?room=CODE)
//        → friend opens the link (or types the code) → both pick decks → both
//        "Ready" → host starts → server deals and runs the game.
//
// The server is authoritative: clients send intents ({t:'act', a:{type:...}}),
// the engine validates them, then every connected socket gets its own filtered
// view (hands/decks/inkwells hidden). Players get a reconnect token so a page
// refresh or flaky wifi doesn't drop them from the game.
//
// Messages client → server:
//   hello {token?}                     — first message; resumes an existing seat if token matches
//   create {name, public?, vsBot?, botLevel?: 'easy'|'hard', botDeck?}   — make a room, become host (hard = the search bot)
//   botDeck {deck: {id: 'random' | 'meta:…' | 'demo:…'} | {name, cards}}   — host only: the bot's deck (#111)
//   join {code, name}                  — take a free seat (or spectate if full)
//   leave
//   setDeck {deck: {name, cards:[[id,qty]]} | {name, text}}
//   ready {ready}
//   start                              — host only, both seats ready
//   act {a, rid}                       — a game action (see engine.js)
//   chat {text}
//   coach {on}                         — admins only: suggestions from the hard bot on each of your turns and choices
//   rematch                            — back to the room after a game ends
//   rooms                              — list public open rooms
// Messages server → client:
//   welcome {token, demoDecks, metaDecks}  room {room}  game {view, defs, events, rid?}  err {msg, rid?}
//   chat {from, text, ts}  rooms {rooms}  coach {seq, eval, moves:[{label, score, pm, action}]} | coach {seq, mulligan}  coachState {on}

import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { resolveDeck } from './cards.js';
import { newGame, applyAction, viewFor, eventsFor, defsInView } from './engine.js';
import { botDecide } from './bot.js';
import { Worker } from 'node:worker_threads';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I/O to avoid confusion
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;           // drop rooms idle for 2h
const MAX_ROOMS = 500;
const MAX_MSG_BYTES = 64 * 1024;
const RATE = { windowMs: 5000, max: 80 };
const BOT_DELAY_MS = 650;
const HARD_BUDGET_MS = 450;          // the search bot's thinking time per decision

// one worker runs the search bot for every room; requests queue up
let worker = null, workerSeq = 0;
const waiting = new Map();
function searchWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./botworker.js', import.meta.url));
  worker.on('message', (m) => { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } });
  worker.on('error', (e) => { console.error('[bot] search worker crashed:', e.message); for (const w of waiting.values()) w({ error: e.message }); waiting.clear(); worker = null; });
  worker.unref();
  return worker;
}
function askSearchBot(state, seat, seen, { analyze = false, mulligan = false, budgetMs = HARD_BUDGET_MS } = {}) {
  return new Promise((resolve) => {
    const id = ++workerSeq;
    waiting.set(id, resolve);
    searchWorker().postMessage({ id, state, seat, seen, budgetMs, analyze, mulligan });
  });
}
const HINT_BUDGET_MS = 1200;
const COACH_BUDGET_MS = 900;          // the admin coach's thinking time per position (it runs on every turn and choice)

const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'Player';

// userFromReq(req): the signed-in account for a connection (lib/accounts.js), stored on the seat
// onGameOver(record): a finished game — { seed, seats:[{name, userId, bot, level, deckName, cards}], actions:[[seat, action]], winner, … };
//   returns the replay id (lib/replays.js), sent to the room so players can watch it back
export function attachLobby(server, { getIndex, path = '/ws/play', userFromReq = null, onGameOver = null }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });
  const rooms = new Map();    // code -> room
  const clients = new Map();  // token -> { token, ws:Set, name, room }

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
    if (url.pathname !== path) return;  // let other upgrade handlers (if any) run
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // ---------- helpers ----------
  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
  function sendClient(cl, msg) {
    for (const ws of cl.ws) send(ws, msg);
  }
  function newCode() {
    for (let tries = 0; tries < 1000; tries++) {
      let c = '';
      const bytes = crypto.randomBytes(5);
      for (const b of bytes) c += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (!rooms.has(c)) return c;
    }
    throw new Error('no room codes left');
  }
  function seatOf(room, token) {
    return room.seats.findIndex((s) => s && s.token === token);
  }
  // the bot's deck from a client's choice: {id:'random'} (or nothing) picks from the meta and demo decks
  function botDeckFor(spec) {
    const idx = getIndex();
    const pool = [...(idx.metaDecks || []), ...idx.demoDecks];
    const id = typeof spec?.id === 'string' ? spec.id : spec?.cards ? null : 'random';
    if (id === 'random') return resolveDeck(idx, pool[Math.floor(Math.random() * pool.length)]);
    if (id) {
      const named = (idx.metaDecks || []).find((d) => d.id === id) || idx.demoDecks.find((d) => `demo:${d.id}` === id || d.id === id);
      if (!named) throw new Error('That deck is no longer on the list. Pick another.');
      return resolveDeck(idx, named);
    }
    const deck = resolveDeck(idx, { name: String(spec.name || 'Your deck').slice(0, 60), cards: spec.cards });
    if (!deck.size) throw new Error(deck.errors[0] || 'That deck is empty.');
    return deck;
  }
  function roomSummary(room) {
    return {
      code: room.code,
      host: room.host,
      public: room.public,
      status: room.game ? (room.game.status === 'over' ? 'over' : 'playing') : 'lobby',
      replay: room.game?.status === 'over' ? room.rec?.id || null : null,
      seats: room.seats.map((s) => s && {
        name: s.name,
        bot: !!s.bot,
        online: s.bot ? true : (clients.get(s.token)?.ws.size || 0) > 0,
        ready: !!s.ready,
        deck: s.deck ? { name: s.deck.name, size: s.deck.size, inks: s.deck.inks, legal: s.deck.legal, problems: [...s.deck.problems, ...s.deck.errors].slice(0, 6) } : null,
      }),
      spectators: [...room.spectators].map((t) => clients.get(t)?.name).filter(Boolean),
      createdAt: room.createdAt,
    };
  }
  function broadcastRoom(room) {
    const summary = roomSummary(room);
    for (const t of roomTokens(room)) {
      const cl = clients.get(t);
      if (!cl) continue;
      sendClient(cl, { t: 'room', room: { ...summary, you: seatOf(room, t), isHost: room.host === t ? true : false } });
    }
  }
  function roomTokens(room) {
    return [...room.seats.filter((s) => s && !s.bot).map((s) => s.token), ...room.spectators];
  }
  function sendGame(room, events, actor = null, rid = null) {
    const g = room.game;
    if (!g) return;
    for (const t of roomTokens(room)) {
      const cl = clients.get(t);
      if (!cl) continue;
      const seat = seatOf(room, t);
      const view = viewFor(g, seat);
      const defs = {};
      const known = room.sentDefs.get(t) || new Set();
      for (const id of defsInView(g, view)) if (!known.has(id)) { defs[id] = g.defs[id]; known.add(id); }
      // cards revealed by events (actions played, etc.) also need defs
      const evs = eventsFor(events, seat);
      for (const e of evs) if (e.cardId && !known.has(e.cardId) && g.defs[e.cardId]) { defs[e.cardId] = g.defs[e.cardId]; known.add(e.cardId); }
      room.sentDefs.set(t, known);
      sendClient(cl, { t: 'game', view, defs, events: evs, rid: t === actor ? rid : null });
      if (cl.coach) coachTick(room, cl);
    }
  }

  // ---------- coach (admins only) ----------
  // The hard bot's analysis, run for an admin's own seat whenever it's their turn or their choice, and sent back as
  // suggestions — never played. It sees only what that player could know (searchbot.js re-deals hidden cards), and
  // runs on the same worker as the bot. One request per player at a time; a newer position replaces a queued one.
  // Before the game, while they choose their opening hand, it sends mulligan advice instead (analysis/mulligan.js).
  function coachTick(room, cl) {
    const g = room.game;
    const seat = seatOf(room, cl.token);
    if (!g || seat < 0) return;
    const mull = g.status === 'mulligan' && !g.players[seat].mulligan.done;
    if (!mull && (g.status !== 'playing' || (g.pending ? g.pending.seat !== seat : g.active !== seat))) return;
    if (mull && cl.coachMull?.g === g && cl.coachMull.hand === g.players[seat].hand.join(',')) return;   // this hand's advice was sent
    if (cl.coachBusy) { cl.coachAgain = true; return; }
    cl.coachBusy = true;
    const seq = g.seq;
    const hand = mull ? g.players[seat].hand.join(',') : null;
    askSearchBot(g, seat, [], { analyze: !mull, mulligan: mull, budgetMs: COACH_BUDGET_MS }).then((m) => {
      cl.coachBusy = false;
      const again = cl.coachAgain; cl.coachAgain = false;
      if (!cl.coach) return;
      if (m.error) sendClient(cl, { t: 'coach', seq, error: m.error });
      else if (mull) { if (room.game === g && g.status === 'mulligan') { cl.coachMull = { g, hand }; sendClient(cl, { t: 'coach', seq, mulligan: m.mulligan }); } }
      else if (room.game === g && g.seq === seq) sendClient(cl, { t: 'coach', seq, ...m.analysis });
      if (again || room.game !== g || g.seq !== seq) coachTick(room, cl);   // the position moved on while thinking
    });
  }
  function touch(room) { room.lastActive = Date.now(); }
  // every action goes through here: accepted ones join the replay, and a finished game is saved once
  function play(room, seat, a) {
    const g = room.game;
    const r = applyAction(g, seat, a);
    if (r.ok && room.rec) {
      room.rec.actions.push([seat, a]);
      if (g.status === 'over' && !room.rec.saved) {
        room.rec.saved = true;
        try {
          room.rec.id = onGameOver?.({ ...room.rec, winner: g.winner, turns: g.turn, reason: g.endReason || '', finishedAt: Date.now() }) || null;
        } catch (e) { console.warn('[lobby] replay save failed:', e.message); }
        queueMicrotask(() => broadcastRoom(room));          // the room summary now carries the replay id
      }
    }
    return r;
  }

  function leaveRoom(cl) {
    const room = cl.room && rooms.get(cl.room);
    cl.room = null;
    if (!room) return;
    room.spectators.delete(cl.token);
    const seat = seatOf(room, cl.token);
    if (seat >= 0) {
      if (room.game && room.game.status !== 'over') {
        // leaving mid-game = concede, but keep the seat so the result is visible
        const r = play(room, seat, { type: 'concede' });
        if (r.ok) sendGame(room, r.events);
      } else {
        room.seats[seat] = null;
      }
    }
    const humans = room.seats.filter((s) => s && !s.bot);
    if (!humans.length && !room.spectators.size) { rooms.delete(room.code); return; }
    if (room.host === cl.token) {
      room.host = humans.find((s) => s.token !== cl.token)?.token || [...room.spectators][0] || null;
    }
    broadcastRoom(room);
  }

  function scheduleBot(room) {
    if (!room.game || room.botTimer) return;
    const botSeat = room.seats.findIndex((s) => s?.bot);
    if (botSeat < 0) return;
    if (!botDecide(room.game, botSeat)) return;                  // nothing for the bot to do right now
    const hard = room.seats[botSeat].level !== 'easy';
    const started = Date.now();
    room.botTimer = setTimeout(async () => {
      if (!rooms.has(room.code) || !room.game) { room.botTimer = null; return; }
      const g = room.game;
      const seq = g.seq;
      let act = null;
      if (hard) {
        const m = await askSearchBot(g, botSeat, [...(room.botSeen || [])]);
        if (m.error) console.warn('[bot] search failed, using the quick bot:', m.error);
        else { act = m.action; room.botSeen = new Set(m.seen); }
        if (room.game !== g || g.seq !== seq) { room.botTimer = null; scheduleBot(room); return; }   // the game moved on meanwhile
      }
      act ||= botDecide(g, botSeat);
      if (!act) { room.botTimer = null; return; }
      const wait = BOT_DELAY_MS - (Date.now() - started);       // keep a readable pace when the search was quick
      if (hard && wait > 0) await new Promise((r) => setTimeout(r, wait));
      room.botTimer = null;
      if (room.game !== g || g.seq !== seq) { scheduleBot(room); return; }
      let r = play(room, botSeat, act);
      if (!r.ok && g.active === botSeat) r = play(room, botSeat, { type: 'endTurn', force: true });
      if (!r.ok && g.pending?.seat === botSeat) {
        r = play(room, botSeat, g.pending.type === 'support' ? { type: 'support' } : { type: 'choose', skip: true });
        if (!r.ok && g.pending?.valid?.length) r = play(room, botSeat, { type: 'choose', target: g.pending.valid[0] });
      }
      if (r.ok) sendGame(room, r.events);
      touch(room);
      scheduleBot(room);
    }, hard ? 60 : BOT_DELAY_MS);
  }

  // ---------- message handlers ----------
  const handlers = {
    rooms(cl, ws) {
      const list = [...rooms.values()]
        .filter((r) => r.public && !r.game && r.seats.some((s) => !s))
        .slice(0, 50)
        .map((r) => ({ code: r.code, host: r.seats.find(Boolean)?.name || '?', players: r.seats.filter(Boolean).length }));
      send(ws, { t: 'rooms', rooms: list });
    },

    create(cl, ws, m) {
      if (rooms.size >= MAX_ROOMS) throw new Error('The server is full right now — try again in a bit.');
      leaveRoom(cl);
      cl.name = cleanName(m.name || cl.name);
      const room = {
        code: newCode(),
        host: cl.token,
        public: !!m.public,
        seats: [{ token: cl.token, name: cl.name, userId: cl.userId ?? null, ready: false, deck: null }, null],
        spectators: new Set(),
        game: null,
        chat: [],
        sentDefs: new Map(),
        createdAt: Date.now(),
        lastActive: Date.now(),
        botTimer: null,
      };
      if (m.vsBot) {
        const level = m.botLevel === 'easy' ? 'easy' : 'hard';
        let deck; try { deck = botDeckFor(m.botDeck); } catch { deck = botDeckFor(null); }   // a stale choice falls back to random
        room.seats[1] = { token: `bot:${room.code}`, bot: true, level, name: level === 'easy' ? 'Practice Bot' : 'Ink Bot', ready: true, deck };
      }
      rooms.set(room.code, room);
      cl.room = room.code;
      broadcastRoom(room);
    },

    join(cl, ws, m) {
      const code = String(m.code || '').toUpperCase().replace(/[^A-Z]/g, '');
      const room = rooms.get(code);
      if (!room) throw new Error(`No room with code ${code || '(blank)'} — check the invite link.`);
      if (cl.room !== code) leaveRoom(cl);
      cl.name = cleanName(m.name || cl.name);
      cl.room = code;
      if (seatOf(room, cl.token) < 0) {
        const free = room.seats.findIndex((s) => !s);
        if (free >= 0 && !room.game) room.seats[free] = { token: cl.token, name: cl.name, userId: cl.userId ?? null, ready: false, deck: null };
        else room.spectators.add(cl.token);
      }
      touch(room);
      broadcastRoom(room);
      if (room.game) { room.sentDefs.delete(cl.token); sendGame(room, []); }
      for (const c of room.chat.slice(-30)) sendClient(cl, { t: 'chat', ...c });
    },

    leave(cl) { leaveRoom(cl); sendClient(cl, { t: 'room', room: null }); },

    // the host picks what the bot plays (#111): a named meta or demo deck, one of their own lists, or random. It stays
    // on the bot's seat for Play again, so a deck can be tested against the same opponent game after game.
    botDeck(cl, ws, m) {
      const room = rooms.get(cl.room);
      if (!room) throw new Error('Not in a room.');
      if (room.host !== cl.token) throw new Error('Only the host picks the bot\'s deck.');
      const seat = room.seats.findIndex((s) => s?.bot);
      if (seat < 0) throw new Error('There is no bot in this room.');
      if (room.game && room.game.status !== 'over') throw new Error("You can't change the bot's deck mid-game.");
      room.seats[seat].deck = botDeckFor(m.deck);
      touch(room);
      broadcastRoom(room);
    },

    setDeck(cl, ws, m) {
      const room = rooms.get(cl.room);
      const seat = room ? seatOf(room, cl.token) : -1;
      if (seat < 0) throw new Error('Join a seat first.');
      if (room.game && room.game.status !== 'over') throw new Error("You can't change decks mid-game.");
      const deck = resolveDeck(getIndex(), m.deck || {});
      if (!deck.size) throw new Error(deck.errors[0] || 'That deck is empty.');
      room.seats[seat].deck = deck;
      room.seats[seat].ready = false;
      touch(room);
      broadcastRoom(room);
    },

    ready(cl, ws, m) {
      const room = rooms.get(cl.room);
      const seat = room ? seatOf(room, cl.token) : -1;
      if (seat < 0) throw new Error('Join a seat first.');
      if (m.ready && !room.seats[seat].deck) throw new Error('Pick a deck first.');
      room.seats[seat].ready = !!m.ready;
      broadcastRoom(room);
    },

    start(cl) {
      const room = rooms.get(cl.room);
      if (!room) throw new Error('Not in a room.');
      if (room.host !== cl.token) throw new Error('Only the host can start the game.');
      if (room.game && room.game.status !== 'over') throw new Error('A game is already running.');
      if (room.seats.some((s) => !s)) throw new Error('Waiting for an opponent — send them the invite link.');
      if (room.seats.some((s) => !s.ready || !s.deck)) throw new Error('Both players need to pick a deck and hit Ready.');
      const seed = crypto.randomInt(2 ** 31);
      room.game = newGame({ seed, players: room.seats.map((s) => ({ name: s.name, deck: s.deck.defs })) });
      // the replay: the engine is deterministic, so the seed, both lists and every accepted action replay the game
      room.rec = { seed, startedAt: Date.now(), actions: [], id: null,
        seats: room.seats.map((s) => ({ name: s.name, userId: s.userId ?? null, bot: !!s.bot, level: s.level || null, deckName: s.deck.name, cards: s.deck.counts })) };
      room.botSeen = null;                                  // what the bot has seen is per game
      room.sentDefs = new Map();
      touch(room);
      broadcastRoom(room);
      sendGame(room, []);
      scheduleBot(room);
    },

    rematch(cl) {
      const room = rooms.get(cl.room);
      if (!room?.game || room.game.status !== 'over') throw new Error('No finished game to leave.');
      if (room.host !== cl.token && seatOf(room, cl.token) < 0) throw new Error('Only players can do that.');
      room.game = null;
      clearTimeout(room.botTimer); room.botTimer = null;
      room.seats = room.seats.map((s) => s && (s.bot || clients.get(s.token)?.ws.size ? { ...s, ready: !!s.bot } : null));
      broadcastRoom(room);
      for (const t of roomTokens(room)) { const c = clients.get(t); if (c) sendClient(c, { t: 'game', view: null }); }
    },

    act(cl, ws, m) {
      const room = rooms.get(cl.room);
      if (!room?.game) throw new Error('No game running.');
      const seat = seatOf(room, cl.token);
      if (seat < 0) throw new Error('Spectators can\'t act.');
      const r = play(room, seat, m.a || {});
      if (!r.ok) { send(ws, { t: 'err', msg: r.error, rid: m.rid ?? null }); return; }
      touch(room);
      sendGame(room, r.events, cl.token, m.rid ?? null);
      if (room.game.status === 'over') broadcastRoom(room);
      scheduleBot(room);
    },

    // the engine's take on your position (games against a bot only): eval and its top moves
    hint(cl, ws) {
      const room = rooms.get(cl.room);
      const g = room?.game;
      const seat = room ? seatOf(room, cl.token) : -1;
      if (!g || seat < 0) throw new Error('No game running.');
      if (!room.seats.some((s) => s?.bot)) throw new Error('Hints are for games against a bot.');
      if (g.status !== 'playing' || (g.pending ? g.pending.seat !== seat : g.active !== seat)) throw new Error('Hints are for your own turn or choice.');
      if (room.hintBusy) return;
      room.hintBusy = true;
      const seq = g.seq;
      askSearchBot(g, seat, [], { analyze: true, budgetMs: HINT_BUDGET_MS }).then((m) => {
        room.hintBusy = false;
        if (m.error) { send(ws, { t: 'err', msg: `The engine couldn't analyze this: ${m.error}` }); return; }
        send(ws, { t: 'hint', seq, current: room.game === g && g.seq === seq, ...m.analysis });
      });
    },

    // { on } — admins only: turn the coach on or off for this player (see coachTick)
    coach(cl, ws, m) {
      if (cl.role !== 'admin') throw new Error('The coach is for admins.');
      cl.coach = !!m.on;
      cl.coachMull = null;
      sendClient(cl, { t: 'coachState', on: cl.coach });
      const room = cl.coach && rooms.get(cl.room);
      if (room) coachTick(room, cl);
    },

    chat(cl, ws, m) {
      const room = rooms.get(cl.room);
      if (!room) throw new Error('Not in a room.');
      const text = String(m.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 280);
      if (!text) return;
      const msg = { from: cl.name, text, ts: Date.now() };
      room.chat.push(msg);
      if (room.chat.length > 100) room.chat.shift();
      for (const t of roomTokens(room)) { const c = clients.get(t); if (c) sendClient(c, { t: 'chat', ...msg }); }
    },
  };

  // ---------- connections ----------
  wss.on('connection', (ws, req) => {
    let cl = null;
    let userId = null, role = null;
    try { const u = userFromReq?.(req); userId = u?.id ?? null; role = u && !u.guest ? u.role || 'user' : null; } catch { /* no account */ }
    const hits = [];
    ws.on('message', (buf) => {
      const now = Date.now();
      hits.push(now);
      while (hits.length && hits[0] < now - RATE.windowMs) hits.shift();
      if (hits.length > RATE.max) { send(ws, { t: 'err', msg: 'Slow down a little!' }); return; }
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      try {
        if (m.t === 'hello') {
          const tok = typeof m.token === 'string' && /^[a-f0-9]{32}$/.test(m.token) ? m.token : null;
          cl = (tok && clients.get(tok)) || { token: tok || crypto.randomBytes(16).toString('hex'), ws: new Set(), name: cleanName(m.name), room: null };
          clients.set(cl.token, cl);
          cl.ws.add(ws);
          if (m.name) cl.name = cleanName(m.name);
          if (userId != null) { cl.userId = userId; cl.role = role; }
          send(ws, { t: 'welcome', token: cl.token, name: cl.name, demoDecks: getIndex()?.demoDecks || [], metaDecks: (getIndex()?.metaDecks || []).map(({ id, name, inks }) => ({ id, name, inks })) });
          const room = cl.room && rooms.get(cl.room);
          if (room) {
            broadcastRoom(room);
            if (room.game) { room.sentDefs.delete(cl.token); sendGame(room, []); }
            for (const c of room.chat.slice(-30)) send(ws, { t: 'chat', ...c });
          } else {
            cl.room = null;
          }
          return;
        }
        if (!cl) throw new Error('Say hello first.');
        if (!getIndex()) throw new Error('Card database is still loading — try again in a few seconds.');
        const h = Object.hasOwn(handlers, m.t) ? handlers[m.t] : null;
        if (!h) throw new Error(`Unknown message: ${m.t}`);
        h(cl, ws, m);
      } catch (e) {
        send(ws, { t: 'err', msg: e.message, rid: m.rid ?? null });
      }
    });
    ws.on('close', () => {
      if (!cl) return;
      cl.ws.delete(ws);
      const room = cl.room && rooms.get(cl.room);
      if (room) broadcastRoom(room);  // shows the player as offline; their seat is kept for reconnects
    });
  });

  // ---------- housekeeping ----------
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      const anyoneOnline = roomTokens(room).some((t) => clients.get(t)?.ws.size);
      if (!anyoneOnline && now - room.lastActive > 10 * 60 * 1000 || now - room.lastActive > ROOM_IDLE_MS) {
        clearTimeout(room.botTimer);
        rooms.delete(code);
        for (const t of roomTokens(room)) { const c = clients.get(t); if (c && c.room === code) c.room = null; }
      }
    }
    for (const [t, c] of clients) if (!c.ws.size && !c.room) clients.delete(t);
  }, 60 * 1000);
  sweep.unref();

  return { rooms, clients, wss };
}
