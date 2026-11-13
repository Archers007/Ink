// Union Arena lobby + rooms over WebSockets (path /ws/ua). Same shape as game/lobby.js, smaller.
//
// Host creates a room (5-letter code, /ua/play?room=CODE) or a game against the bot → both pick decks → host starts →
// the server runs game/ua/engine.js and sends every seat its own view.
//
// client → server:
//   hello {token?}                        resume a seat
//   create {name, vsBot?}                 new room; vsBot fills seat 2 with the bot
//   join {code, name}
//   setDeck {deck: {id} | {cards: [[no, qty]], name} | {auto: 'HTR'}}
//   botDeck {auto: 'HTR'} | {id}          host: the bot's deck
//   ready {ready}
//   start                                 host, both seats ready with legal decks
//   act {a, rid}
//   chat {text}
//   leave · rematch · rooms
// server → client:
//   welcome {token, titles}  room {room}  game {view, defs?, rid?}  err {msg, rid?}  chat {from, text, ts}  rooms {rooms}

import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { loadUaCards, deckProblems } from './cards.js';
import { autoDeck } from './decks.js';
import { newGame, applyAction, viewFor } from './engine.js';
import { botDecide } from './bot.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_ROOMS = 300;
const MAX_MSG = 64 * 1024;
const BOT_DELAY_MS = 550;
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'Player';

export function attachUaLobby(server, { path = '/ws/ua', userFromReq = null, uaDecks = null } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG });
  const rooms = new Map();
  const clients = new Map();

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return; }
    if (url.pathname !== path) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws, m) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(m)); } catch { /* gone */ } };
  const toClient = (cl, m) => { for (const ws of cl.ws) send(ws, m); };
  const code = () => { for (;;) { const c = Array.from({ length: 5 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join(''); if (!rooms.has(c)) return c; } };

  function roomView(room) {
    return {
      code: room.code, vsBot: !!room.vsBot, started: !!room.game, over: room.game?.winner != null,
      seats: room.seats.map((st) => st && { name: st.name, bot: !!st.bot, ready: !!st.ready, deck: st.deck ? { name: st.deck.name, size: st.deck.size, legal: st.deck.legal, problems: st.deck.problems, src: st.deck.src } : null, online: st.bot || [...(clients.get(st.token)?.ws || [])].some((w) => w.readyState === 1) }),
      spectators: room.watchers.size,
    };
  }
  function broadcastRoom(room) {
    const v = roomView(room);
    room.seats.forEach((st, i) => { if (st && !st.bot) { const cl = clients.get(st.token); if (cl) toClient(cl, { t: 'room', room: { ...v, you: i, host: room.host === st.token } }); } });
    for (const tok of room.watchers) { const cl = clients.get(tok); if (cl) toClient(cl, { t: 'room', room: { ...v, you: -1, host: false } }); }
  }
  function sendGame(room, rid = null, rseat = null) {
    if (!room.game) return;
    room.seats.forEach((st, seat) => {
      if (!st || st.bot) return;
      const cl = clients.get(st.token);
      if (!cl) return;
      const first = !cl.sentDefs?.has(room.gameId);
      if (first) (cl.sentDefs ||= new Set()).add(room.gameId);
      toClient(cl, { t: 'game', view: viewFor(room.game, seat), ...(first ? { defs: room.game.defs } : {}), ...(rid != null && rseat === seat ? { rid } : {}) });
    });
    for (const tok of room.watchers) {
      const cl = clients.get(tok);
      if (!cl) continue;
      const first = !cl.sentDefs?.has(room.gameId);
      if (first) (cl.sentDefs ||= new Set()).add(room.gameId);
      const v = viewFor(room.game, 0);
      v.players[0].hand = v.players[0].hand.length;      // spectators see neither hand
      v.legal = undefined;
      v.spectator = true;
      toClient(cl, { t: 'game', view: v, ...(first ? { defs: room.game.defs } : {}) });
    }
    scheduleBot(room);
  }
  function scheduleBot(room) {
    const g = room.game;
    if (!g || g.winner != null || room.botTimer) return;
    const seat = g.pending?.seat;
    if (seat == null || !room.seats[seat]?.bot) return;
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      if (room.game !== g || g.pending?.seat !== seat) return;
      try {
        const a = botDecide(g, seat);
        if (a) applyAction(g, seat, a);
      } catch (e) {
        console.error('[ua bot]', e.message);
        try { applyAction(g, seat, { type: 'concede' }); } catch { /* over */ }
      }
      room.touched = Date.now();
      sendGame(room);
    }, BOT_DELAY_MS);
  }

  function resolveDeck(cl, deck) {
    const idx = loadUaCards();
    if (!idx) throw new Error('Union Arena cards are still being imported.');
    let cards, name;
    if (deck?.auto) { cards = autoDeck(idx.defs, String(deck.auto).toUpperCase(), crypto.randomInt(1e9)); name = `${idx.titles[deck.auto] || deck.auto} starter`; if (!cards) throw new Error('No starter deck for that title.'); }
    else if (deck?.id) { const d = uaDecks?.deck(cl.user, deck.id); if (!d) throw new Error('No such deck.'); cards = d.cards; name = d.name; }
    else if (Array.isArray(deck?.cards)) { cards = deck.cards.map(([no, q]) => [String(no).toUpperCase(), Math.max(1, Math.min(50, Number(q) || 1))]).slice(0, 120); name = cleanName(deck.name || 'Deck'); }
    else throw new Error('Pick a deck.');
    const problems = deckProblems(cards, idx.defs);
    const size = cards.reduce((n, [, q]) => n + q, 0);
    const src = idx.defs.get(cards[0]?.[0])?.src || null;
    return { name, cards, size, src, legal: !problems.length, problems: problems.slice(0, 5) };
  }

  function seatOf(room, cl) { return room.seats.findIndex((st) => st && st.token === cl.token); }

  function startGame(room) {
    const idx = loadUaCards();
    room.gameId = crypto.randomBytes(6).toString('hex');
    room.game = newGame({ players: room.seats.map((st) => ({ name: st.name, cards: st.deck.cards })), defs: idx.defs, seed: crypto.randomInt(2 ** 31) });
    room.touched = Date.now();
    broadcastRoom(room);
    sendGame(room);
  }

  const handlers = {
    hello(cl, m) {
      if (m.token && clients.has(String(m.token))) {
        const prev = clients.get(String(m.token));
        for (const ws of cl.ws) prev.ws.add(ws);
        clients.delete(cl.token);
        prev.user = cl.user || prev.user;
        cl = prev;
      }
      const idx = loadUaCards();
      for (const ws of cl.ws) ws.cl = cl;
      toClient(cl, { t: 'welcome', token: cl.token, titles: idx?.titles || {}, ready: !!idx });
      const room = cl.room && rooms.get(cl.room);
      if (room) { if (room.game) cl.sentDefs?.delete(room.gameId); broadcastRoom(room); sendGame(room); }
      return cl;
    },
    create(cl, m) {
      if (rooms.size >= MAX_ROOMS) throw new Error('Too many open tables right now.');
      handlers.leave(cl);
      const room = { code: code(), host: cl.token, seats: [{ token: cl.token, name: cleanName(m.name), ready: false, deck: null }, null], watchers: new Set(), touched: Date.now(), vsBot: !!m.vsBot };
      if (m.vsBot) room.seats[1] = { bot: true, name: 'Bot', ready: true, deck: null };
      rooms.set(room.code, room);
      cl.room = room.code;
      cl.name = cleanName(m.name);
      broadcastRoom(room);
    },
    join(cl, m) {
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) throw new Error('No table with that code.');
      handlers.leave(cl);
      cl.room = room.code;
      const free = room.seats.findIndex((st) => !st);
      if (free >= 0 && !room.game) room.seats[free] = { token: cl.token, name: cleanName(m.name), ready: false, deck: null };
      else room.watchers.add(cl.token);
      room.touched = Date.now();
      broadcastRoom(room);
      sendGame(room);
    },
    leave(cl) {
      const room = cl.room && rooms.get(cl.room);
      cl.room = null;
      if (!room) return;
      room.watchers.delete(cl.token);
      const seat = seatOf(room, cl);
      if (seat >= 0) {
        if (room.game && room.game.winner == null) { try { applyAction(room.game, seat, { type: 'concede' }); } catch { /* */ } sendGame(room); }
        room.seats[seat] = null;
      }
      if (!room.seats.some((st) => st && !st.bot)) { clearTimeout(room.botTimer); rooms.delete(room.code); return; }
      if (room.host === cl.token) room.host = room.seats.find((st) => st && !st.bot)?.token;
      broadcastRoom(room);
    },
    setDeck(cl, m) {
      const room = rooms.get(cl.room);
      const seat = room ? seatOf(room, cl) : -1;
      if (seat < 0 || room.game) throw new Error('Sit at a table first.');
      room.seats[seat].deck = resolveDeck(cl, m.deck);
      room.seats[seat].ready = false;
      broadcastRoom(room);
    },
    botDeck(cl, m) {
      const room = rooms.get(cl.room);
      if (!room || room.host !== cl.token || !room.seats[1]?.bot) throw new Error('Only the host picks the bot’s deck.');
      room.seats[1].deck = resolveDeck(cl, m.deck || m);
      broadcastRoom(room);
    },
    ready(cl, m) {
      const room = rooms.get(cl.room);
      const seat = room ? seatOf(room, cl) : -1;
      if (seat < 0) throw new Error('Sit at a table first.');
      if (m.ready && !room.seats[seat].deck?.legal) throw new Error('Pick a legal deck first.');
      room.seats[seat].ready = !!m.ready;
      broadcastRoom(room);
    },
    start(cl) {
      const room = rooms.get(cl.room);
      if (!room || room.host !== cl.token) throw new Error('Only the host can start.');
      if (room.game && room.game.winner == null) throw new Error('A game is already going.');
      if (room.vsBot && !room.seats[1].deck) {
        const src = room.seats[0]?.deck?.src;
        const idx = loadUaCards();
        const titles = Object.keys(idx?.titles || {});
        room.seats[1].deck = resolveDeck(cl, { auto: titles[crypto.randomInt(titles.length)] || src });
      }
      if (!room.seats.every((st) => st && st.ready && st.deck?.legal)) throw new Error('Both players need a legal deck and to be ready.');
      startGame(room);
    },
    act(cl, m) {
      const room = rooms.get(cl.room);
      const seat = room ? seatOf(room, cl) : -1;
      if (seat < 0 || !room.game) throw new Error('No game.');
      applyAction(room.game, seat, m.a || {});
      room.touched = Date.now();
      sendGame(room, m.rid ?? null, seat);
    },
    chat(cl, m) {
      const room = rooms.get(cl.room);
      if (!room) return;
      const text = String(m.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 300);
      if (!text) return;
      const msg = { t: 'chat', from: cl.name || 'Player', text, ts: Date.now() };
      for (const st of room.seats) if (st && !st.bot) { const c = clients.get(st.token); if (c) toClient(c, msg); }
      for (const tok of room.watchers) { const c = clients.get(tok); if (c) toClient(c, msg); }
    },
    rematch(cl) {
      const room = rooms.get(cl.room);
      if (!room || room.game?.winner == null) return;
      room.game = null;
      for (const st of room.seats) if (st && !st.bot) st.ready = false;
      broadcastRoom(room);
    },
    rooms(cl) {
      const list = [...rooms.values()].filter((r) => !r.vsBot && !r.game && r.seats.some((st) => !st)).slice(0, 30)
        .map((r) => ({ code: r.code, host: r.seats.find((st) => st?.token === r.host)?.name || '?' }));
      toClient(cl, { t: 'rooms', rooms: list });
    },
  };

  wss.on('connection', (ws, req) => {
    let user = null;
    try { user = userFromReq?.(req) || null; } catch { /* */ }
    let cl = { token: crypto.randomBytes(16).toString('hex'), ws: new Set([ws]), room: null, user, name: null };
    clients.set(cl.token, cl);
    ws.cl = cl;
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      const fn = handlers[m?.t];
      if (!fn) return;
      try {
        const r = fn(ws.cl, m);
        if (m.t === 'hello' && r) ws.cl = r;
      } catch (e) {
        send(ws, { t: 'err', msg: e.message, rid: m.rid ?? null });
      }
    });
    ws.on('close', () => {
      const c = ws.cl;
      c.ws.delete(ws);
      const room = c.room && rooms.get(c.room);
      if (room) broadcastRoom(room);
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [k, r] of rooms) if (now - r.touched > ROOM_IDLE_MS) { clearTimeout(r.botTimer); rooms.delete(k); }
    for (const [k, c] of clients) if (!c.ws.size && !c.room) clients.delete(k);
  }, 10 * 60 * 1000).unref();

  return { rooms };
}
