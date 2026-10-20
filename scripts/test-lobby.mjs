// End-to-end lobby test against a running server:  node scripts/test-lobby.mjs [ws://localhost:3000/ws/play]
import WebSocket from 'ws';

const URL_ = process.argv[2] || 'ws://localhost:3000/ws/play';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(URL_);
  const c = { ws, name, msgs: [], room: null, view: null, defs: {}, token: null, demo: [], errors: [] };
  ws.on('message', (b) => {
    const m = JSON.parse(b);
    c.msgs.push(m);
    if (m.t === 'welcome') { c.token = m.token; c.demo = m.demoDecks; }
    if (m.t === 'room') c.room = m.room;
    if (m.t === 'game') { c.view = m.view; Object.assign(c.defs, m.defs || {}); }
    if (m.t === 'err') c.errors.push(m.msg);
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.open = new Promise((r) => ws.on('open', r));
  return c;
}
const assert = (ok, msg) => { if (!ok) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); };

const host = client('Host');
const guest = client('Guest');
await Promise.all([host.open, guest.open]);
host.send({ t: 'hello', name: 'Host' });
guest.send({ t: 'hello', name: 'Guest' });
await sleep(150);
assert(host.token && host.demo.length >= 2, 'welcome + demo decks');

host.send({ t: 'create', name: 'Host' });
await sleep(150);
const code = host.room?.code;
assert(/^[A-Z]{5}$/.test(code), `room created: ${code}`);

guest.send({ t: 'join', code, name: 'Guest' });
await sleep(150);
assert(host.room.seats[1]?.name === 'Guest' && guest.room.you === 1, 'guest took seat 2');

host.send({ t: 'start' });
await sleep(100);
assert(host.errors.pop()?.includes('pick a deck'), 'start blocked until decks are ready');

host.send({ t: 'setDeck', deck: host.demo[0] });
guest.send({ t: 'setDeck', deck: { name: 'bad', text: '4 Mickey Mouse - Brave Little Tailor\n2 Not A Real Card' } });
await sleep(150);
assert(guest.room.seats[1].deck.legal === false, 'illegal deck flagged: ' + guest.room.seats[1].deck.problems.join('; '));
guest.send({ t: 'setDeck', deck: guest.demo[1] });
host.send({ t: 'ready', ready: true });
guest.send({ t: 'ready', ready: true });
await sleep(150);
guest.send({ t: 'start' });
await sleep(100);
assert(guest.errors.pop()?.includes('Only the host'), 'only host can start');
host.send({ t: 'start' });
await sleep(250);
assert(host.view?.status === 'mulligan' && guest.view?.status === 'mulligan', 'game started in mulligan');
assert(host.view.players[0].hand.length === 7 && host.view.players[1].hand === null, 'host sees own hand only');
assert(guest.view.players[1].hand.length === 7 && guest.view.players[0].hand === null, 'guest sees own hand only');
const guestHandIds = new Set(guest.view.players[1].hand.map((c) => c.cardId));
const leaked = Object.keys(host.defs).filter((id) => guestHandIds.has(id) && !host.view.players[0].hand.some((c) => c.cardId === id));
assert(leaked.length === 0, 'no opponent hand defs leaked to host');

host.send({ t: 'act', a: { type: 'mulligan', iids: host.view.players[0].hand.slice(0, 2).map((c) => c.iid) } });
guest.send({ t: 'act', a: { type: 'mulligan', iids: [] } });
await sleep(250);
const v = host.view;
assert(v.status === 'playing' && v.turn === 1, `playing, turn 1, active seat ${v.active}`);
const active = v.active === 0 ? host : guest;
const other = v.active === 0 ? guest : host;
const me = active.view.players[active.view.you];
const inkable = me.hand.find((c) => active.defs[c.cardId]?.inkable);
active.send({ t: 'act', a: { type: 'ink', iid: inkable.iid }, rid: 1 });
await sleep(150);
assert(active.view.players[active.view.you].inkTotal === 1, 'inked a card');
active.send({ t: 'act', a: { type: 'ink', iid: active.view.players[active.view.you].hand.find((c) => active.defs[c.cardId]?.inkable).iid }, rid: 2 });
await sleep(150);
assert(active.errors.pop()?.includes('already put a card'), 'second ink blocked');
other.send({ t: 'act', a: { type: 'endTurn' } });
await sleep(100);
assert(other.errors.pop()?.includes('not your turn'), "can't end opponent's turn");

// reconnect: guest drops and comes back with the token
const tok = guest.token;
guest.ws.close();
await sleep(150);
assert(host.room.seats[1].online === false, 'host sees guest offline');
const back = client('Guest');
await back.open;
back.send({ t: 'hello', token: tok, name: 'Guest' });
await sleep(250);
assert(back.view?.status === 'playing' && back.room?.you === 1 && back.view.players[1].hand.length >= 6, 'guest resumed seat + game after reconnect');

active === host ? host.send({ t: 'act', a: { type: 'concede' } }) : back.send({ t: 'act', a: { type: 'concede' } });
await sleep(200);
assert(host.view.status === 'over', `game over: ${host.view.endReason}`);

// bot room
const solo = client('Solo');
await solo.open;
solo.send({ t: 'hello', name: 'Solo' });
await sleep(100);
solo.send({ t: 'create', name: 'Solo', vsBot: true });
await sleep(100);
solo.send({ t: 'setDeck', deck: solo.demo[2] });
solo.send({ t: 'ready', ready: true });
await sleep(100);
solo.send({ t: 'start' });
await sleep(200);
solo.send({ t: 'act', a: { type: 'mulligan', iids: [] } });
await sleep(3000);
assert(solo.view.players[1].mulliganDone && solo.view.status === 'playing', `bot mulliganed; turn ${solo.view.turn}, active ${solo.view.active}`);
console.log('ALL OK');
process.exit(0);
