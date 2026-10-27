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
//   create {name, public?, vsBot?, botLevel?: 'easy'|'hard'}   — make a room, become host (hard = the search bot)
//   join {code, name}                  — take a free seat (or spectate if full)
//   leave
//   setDeck {deck: {name, cards:[[id,qty]]} | {name, text}}
//   ready {ready}
//   start                              — host only, both seats ready
//   act {a, rid}                       — a game action (see engine.js)
//   chat {text}
//   rematch                            — back to the room after a game ends
//   rooms                              — list public open rooms
// Messages server → client:
//   welcome {token, demoDecks}  room {room}  game {view, defs, events, rid?}  err {msg, rid?}
//   chat {from, text, ts}  rooms {rooms}

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
function askSearchBot(state, seat, seen) {
  return new Promise((resolve) => {
    const id = ++workerSeq;
    waiting.set(id, resolve);
    searchWorker().postMessage({ id, state, seat, seen, budgetMs: HARD_BUDGET_MS });
  });
}

const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'Player';

export function attachLobby(server, { getIndex, path = '/ws/play' }) {
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
  function roomSummary(room) {
    return {
      code: room.code,
      host: room.host,
      public: room.public,
      status: room.game ? (room.game.status === 'over' ? 'over' : 'playing') : 'lobby',
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
    }
  }
  function touch(room) { room.lastActive = Date.now(); }

  function leaveRoom(cl) {
    const room = cl.room && rooms.get(cl.room);
    cl.room = null;
    if (!room) return;
    room.spectators.delete(cl.token);
    const seat = seatOf(room, cl.token);
    if (seat >= 0) {
      if (room.game && room.game.status !== 'over') {
        // leaving mid-game = concede, but keep the seat so the result is visible
        const r = applyAction(room.game, seat, { type: 'concede' });
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
      let r = applyAction(g, botSeat, act);
      if (!r.ok && g.active === botSeat) r = applyAction(g, botSeat, { type: 'endTurn', force: true });
      if (!r.ok && g.pending?.seat === botSeat) {
        r = applyAction(g, botSeat, g.pending.type === 'support' ? { type: 'support' } : { type: 'choose', skip: true });
        if (!r.ok && g.pending?.valid?.length) r = applyAction(g, botSeat, { type: 'choose', target: g.pending.valid[0] });
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
        seats: [{ token: cl.token, name: cl.name, ready: false, deck: null }, null],
        spectators: new Set(),
        game: null,
        chat: [],
        sentDefs: new Map(),
        createdAt: Date.now(),
        lastActive: Date.now(),
        botTimer: null,
      };
      if (m.vsBot) {
        const demo = getIndex().demoDecks;
        const pick = demo[Math.floor(Math.random() * demo.length)];
        const level = m.botLevel === 'easy' ? 'easy' : 'hard';
        room.seats[1] = { token: `bot:${room.code}`, bot: true, level, name: level === 'easy' ? 'Practice Bot' : 'Ink Bot', ready: true, deck: resolveDeck(getIndex(), pick) };
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
        if (free >= 0 && !room.game) room.seats[free] = { token: cl.token, name: cl.name, ready: false, deck: null };
        else room.spectators.add(cl.token);
      }
      touch(room);
      broadcastRoom(room);
      if (room.game) { room.sentDefs.delete(cl.token); sendGame(room, []); }
      for (const c of room.chat.slice(-30)) sendClient(cl, { t: 'chat', ...c });
    },

    leave(cl) { leaveRoom(cl); sendClient(cl, { t: 'room', room: null }); },

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
      room.game = newGame({ players: room.seats.map((s) => ({ name: s.name, deck: s.deck.defs })) });
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
      const r = applyAction(room.game, seat, m.a || {});
      if (!r.ok) { send(ws, { t: 'err', msg: r.error, rid: m.rid ?? null }); return; }
      touch(room);
      sendGame(room, r.events, cl.token, m.rid ?? null);
      if (room.game.status === 'over') broadcastRoom(room);
      scheduleBot(room);
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
  wss.on('connection', (ws) => {
    let cl = null;
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
          send(ws, { t: 'welcome', token: cl.token, name: cl.name, demoDecks: getIndex()?.demoDecks || [] });
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
