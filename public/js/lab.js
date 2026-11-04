// /lab — the Deck Lab. A signed-in player gives it a few seed cards (or one of their decks) and watches it build a deck
// out loud: it reads the idea, finds enablers and payoffs, assembles a list, plays it against the meta field, names
// the cards that do nothing, and tries swaps, keeping only the ones that win more (lib/lab.js, game/lab/brain.js).
//
// The page is three areas while a run goes: the thinking feed (narration, phases, synergy cards, tries and verdicts),
// the one game being streamed move by move plus the win rate of every version, and the deck as it stands.
//
//   POST /api/lab               start a run → { id }
//   GET  /api/lab/:id/events    Server-Sent Events; replays everything so far (frames: only the latest) on connect,
//                               so ?id= survives a reload; reconnects resume from Last-Event-ID
//   GET  /api/lab/:id           { id, status, events, frame } snapshot (used when the stream can't be opened)
//   POST /api/lab/:id/cancel · POST /api/lab/:id/save → { deckId, name }
//
//   Labels: lists v1, v2…; tries t<round>.<n>; the kept swaps together c<round>; '<vN> smart' = vN rerun by the smart pilot
//
//   /lab?id=…        reconnect to a run
//   /lab?mock=1      a scripted Zero To Hero run, no server needed (&speed=4 plays it faster)

import * as account from '/js/account.js';
import { DB, loadDB, INK_ORDER } from '/js/db.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IMG = (id) => `https://cdn.dreamborn.ink/images/en/cards/${id}`;
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
const pct = (p) => `${Math.round(norm(p) * 100)}%`;
const norm = (p) => { const n = Number(p) || 0; return n > 1 ? n / 100 : n; };   // rates may come as 0..1 or 0..100
const PLAY_DECK_KEY = 'ink.play.deck';           // public/js/play/main.js DECK_KEY: 'saved:<deckId>' picks a saved deck
const LAST_KEY = 'ink.lab.last';
const MAX_SEED = 6;
const LORE_TO_WIN = 20;

const params = new URLSearchParams(location.search);
const MOCK = params.has('mock');
const app = $('#app');

// ---------- card data: the builder's sanitized.db (db.js), with names from search results and events as a fallback ----------
const byId = new Map();
const seen = new Map();
const fullOf = (c) => (c.title ? `${c.name} - ${c.title}` : c.name);
let dbReady = null;
function loadCards() {
  dbReady ||= loadDB().then((all) => {
    for (const c of all) byId.set(String(c.id), { id: String(c.id), name: c.name, title: c.title, full: fullOf(c), cost: c.cost, type: c.type, inks: c.inks, inkable: Number(c.ink) === 1, lore: c.lore });
  }).catch((e) => console.warn('[lab] card data unavailable:', e.message));
  return dbReady;
}
function remember(id, full, extra = {}) { if (id != null && full && !byId.has(String(id))) seen.set(String(id), { id: String(id), full, ...extra }); }
function meta(id) {
  return byId.get(String(id)) || seen.get(String(id)) || { id: String(id), full: String(id), cost: null, type: '', inks: [], inkable: null, lore: 0 };
}
const nameOf = (id, full) => full || meta(id).full;
// a card by its full name (the mock script names cards the way the narration does)
function idByFull(full) {
  const lc = full.toLowerCase();
  let best = null;
  for (const c of byId.values()) if (c.full.toLowerCase() === lc && (!best || String(c.id) < String(best.id))) best = c;
  return best?.id || null;
}

// ---------- the card shown on hover (tap on touch screens) ----------
const peek = $('#peek');
const coarse = matchMedia('(pointer: coarse)').matches;
document.addEventListener('mouseover', (e) => {
  if (coarse) return;
  const t = e.target.closest('[data-peek]');
  if (!t) { peek.classList.remove('on'); return; }
  peek.querySelector('img').src = IMG(t.dataset.peek);
  const r = t.getBoundingClientRect();
  const w = 250, h = 350;
  const left = r.right + 12 + w < innerWidth ? r.right + 12 : Math.max(8, r.left - w - 12);
  peek.style.left = `${left}px`;
  peek.style.top = `${Math.max(70, Math.min(innerHeight - h - 8, r.top - 60))}px`;
  peek.classList.add('on');
});
document.addEventListener('click', (e) => {
  if (!coarse) return;
  const t = e.target.closest('[data-peek]');
  if (peek.classList.contains('tap')) { peek.classList.remove('on', 'tap'); return; }
  if (t && !e.target.closest('button, a')) { peek.querySelector('img').src = IMG(t.dataset.peek); peek.classList.add('on', 'tap'); }
});
const chip = (id, full) => `<span class="cchip" data-peek="${esc(id)}"><img src="${IMG(id)}" alt="" loading="lazy"><span>${esc(nameOf(id, full))}</span></span>`;
const swapText = (list, sign) => (list || []).map(([id, n]) => `<span class="${sign === '+' ? 'in' : 'out'}" data-peek="${esc(id)}">${sign}${n} ${esc(nameOf(id))}</span>`).join('');

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `${path} failed (${r.status})`); e.status = r.status; throw e; }
  return j;
}

// ---------- the top bar's account, as on /rules ----------
function renderAcct() {
  const u = account.user();
  $('#acct').innerHTML = u
    ? `<a class="who" href="/play" title="Signed in">${u.avatar ? `<img class="avatar" src="${esc(u.avatar)}" alt="">` : `<span class="avatar">${esc(u.name.slice(0, 1).toUpperCase())}</span>`}<span>${esc(u.name)}</span></a>`
    : '<button class="btn btn-sm" id="signInBtn">Sign in</button>';
  $('#signInBtn')?.addEventListener('click', openSignIn);
}
function openSignIn() {
  $('#signInBody').innerHTML = account.signInForm({ next: location.pathname + location.search });
  account.bindSignInForm($('#signInBody'), () => location.reload());
  $('#signIn').showModal();
}
$('[data-close-dlg]').onclick = () => $('#signIn').close();

// =====================================================================
//  Start form
// =====================================================================
const F = { mode: 'cards', seed: [], deckId: '', inks: new Set(), rounds: 3, games: 24, decks: [], sending: false };

async function renderStart() {
  document.title = 'Ink · Deck Lab';
  if (!account.signedIn()) {
    app.innerHTML = `<div class="start">
      <h1>Deck Lab</h1>
      <p class="lede">Give the Lab a few cards and watch it build a deck around them, out loud: it finds the cards that make your idea work, plays test games against the meta, names what does nothing and keeps only the swaps that win more.</p>
      <div class="box"><h2>Sign in to use the Lab</h2><p class="note">Runs take a few minutes of the server's time, so the Lab is for signed-in players. What it builds can go straight into your decks.</p>
        <div style="max-width:380px;margin-top:12px">${account.signInForm({ next: '/lab' })}</div>
        <p class="note" style="margin-top:14px">Curious first? <a href="/lab?mock=1">Watch a demo run</a>.</p></div></div>`;
    account.bindSignInForm(app, () => location.reload());
    return;
  }
  let last = null;
  try { last = localStorage.getItem(LAST_KEY); } catch { /* storage blocked */ }
  app.innerHTML = `<div class="start">
    <h1>Deck Lab</h1>
    <p class="lede">Give the Lab an idea, one to six cards or one of your decks, and watch it build a deck around it: it finds enablers and payoffs, plays test games against the meta, names the card that does nothing and keeps only the swaps that win more.</p>
    <div class="box">
      <h2>Start from</h2>
      <div class="seg" role="group" aria-label="Start from"><button type="button" data-mode="cards" aria-pressed="${F.mode === 'cards'}">Seed cards</button><button type="button" data-mode="deck" aria-pressed="${F.mode === 'deck'}">One of my decks</button></div>
      <div id="modeCards" ${F.mode === 'cards' ? '' : 'hidden'}>
        <div class="finder"><input id="q" class="field-in" type="search" placeholder="Search a card by name or rules text, e.g. Zero to Hero" autocomplete="off" aria-label="Search cards" aria-controls="results"></div>
        <div id="picked" class="picked" aria-live="polite"></div>
        <div id="results" class="results" role="listbox" aria-label="Cards"></div>
        <p class="note" id="seedNote"></p>
      </div>
      <div id="modeDeck" ${F.mode === 'deck' ? '' : 'hidden'}>
        <label class="field">Deck <select id="deckSel" class="field-in"><option value="">Loading your decks…</option></select></label>
        <p class="note">The Lab treats the deck's most-played cards as the idea and rebuilds around them.</p>
      </div>
    </div>
    <div class="box">
      <h2>Options</h2>
      <div class="knobs">
        <div class="knob"><div class="lblrow"><span class="lbl">Inks</span><span class="note" id="inkNote"></span></div>
          <div class="inkpick" role="group" aria-label="Inks (optional, up to two)">${INK_ORDER.map((i) => `<button type="button" class="ink" data-ink="${i}" aria-pressed="${F.inks.has(i)}" title="${cap(i)}" aria-label="${cap(i)}"></button>`).join('')}</div></div>
        <div class="knob"><div class="lblrow"><label class="lbl" for="rounds">Rounds of swaps</label><output id="roundsOut">${F.rounds}</output></div>
          <input type="range" id="rounds" min="1" max="6" step="1" value="${F.rounds}"></div>
        <div class="knob"><div class="lblrow"><label class="lbl" for="games">Games per test</label><output id="gamesOut">${F.games}</output></div>
          <input type="range" id="games" min="12" max="60" step="4" value="${F.games}"></div>
      </div>
      <p class="note" id="estimate"></p>
      <div class="go"><button class="btn btn-gold btn-lg" id="startBtn">Start the Lab</button><span class="msg" id="startMsg" role="status"></span></div>
    </div>
    <p class="note" style="margin-top:14px">${last ? `<a href="/lab?id=${encodeURIComponent(last)}">Open your last run</a> · ` : ''}<a href="/lab?mock=1">Watch a demo run</a></p>
  </div>`;
  app.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => {
    F.mode = b.dataset.mode;
    app.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('#modeCards').hidden = F.mode !== 'cards'; $('#modeDeck').hidden = F.mode !== 'deck';
    msg('');
  });
  app.querySelectorAll('.ink').forEach((b) => b.onclick = () => {
    const i = b.dataset.ink;
    if (F.inks.has(i)) F.inks.delete(i);
    else { if (F.inks.size >= 2) F.inks.delete([...F.inks][0]); F.inks.add(i); }
    app.querySelectorAll('.ink').forEach((x) => x.setAttribute('aria-pressed', String(F.inks.has(x.dataset.ink))));
    paintInkNote();
  });
  $('#rounds').oninput = (e) => { F.rounds = +e.target.value; $('#roundsOut').textContent = F.rounds; estimate(); };
  $('#games').oninput = (e) => { F.games = +e.target.value; $('#gamesOut').textContent = F.games; estimate(); };
  let timer = 0;
  $('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(search, 140); };
  $('#q').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#results .res:not([aria-disabled="true"])')?.click(); } };
  $('#results').onclick = (e) => { const r = e.target.closest('.res'); if (r && r.getAttribute('aria-disabled') !== 'true') addSeed(JSON.parse(r.dataset.card)); };
  $('#picked').onclick = (e) => { const b = e.target.closest('[data-drop]'); if (b) { F.seed = F.seed.filter((c) => c.id !== b.dataset.drop); paintPicked(); } };
  $('#startBtn').onclick = startRun;
  paintPicked(); paintInkNote(); estimate();
  F.decks = await account.listDecks().catch(() => []);
  const sel = $('#deckSel');
  if (!sel) return;
  sel.innerHTML = F.decks.length
    ? `<option value="">Pick a deck…</option>${F.decks.map((d) => `<option value="${esc(d.id)}" ${d.id === F.deckId ? 'selected' : ''}>${esc(d.name)} (${d.cards.reduce((n, [, q]) => n + q, 0)} cards)</option>`).join('')}`
    : '<option value="">No saved decks yet</option>';
  sel.onchange = () => { F.deckId = sel.value; msg(''); };
}
function paintInkNote() { $('#inkNote').textContent = F.inks.size ? [...F.inks].map(cap).join(' / ') : 'the Lab picks'; }
function estimate() {
  const tests = 1 + F.rounds * 3;                               // the first list, then a few swaps a round, plus confirmations
  const games = tests * F.games;
  $('#estimate').textContent = `About ${games} test games over ${F.rounds} round${F.rounds === 1 ? '' : 's'}: usually ${Math.max(2, Math.round(games * 0.06 / 6) + 2)}–${Math.max(4, Math.round(games * 0.12 / 6) + 4)} minutes. One game of each test is played out slowly so you can watch it.`;
}
function msg(t, bad = false) { const m = $('#startMsg'); if (m) { m.textContent = t; m.classList.toggle('err', bad); } }
let searchSeq = 0;
async function search() {
  const q = $('#q').value.trim();
  const my = ++searchSeq;
  if (!q) { $('#results').innerHTML = ''; return; }
  let res;
  try { res = await api(`/api/procs/search?q=${encodeURIComponent(q)}&limit=30`); } catch (e) { $('#results').innerHTML = `<p class="note" style="padding:8px 12px">${esc(e.message)}</p>`; return; }
  if (my !== searchSeq) return;
  const rows = res.results || [];
  for (const r of rows) remember(r.id, r.full, { cost: r.cost, type: r.type, inks: r.inks });
  const full = F.seed.length >= MAX_SEED;
  $('#results').innerHTML = rows.length ? rows.map((r) => {
    const off = full || F.seed.some((c) => c.id === r.id);
    const [nm, ...rest] = r.full.split(' - ');
    return `<button type="button" class="res" role="option" data-card="${esc(JSON.stringify({ id: r.id, full: r.full }))}" aria-disabled="${off}" data-peek="${esc(r.id)}">
      <img src="${IMG(r.id)}" alt="" loading="lazy"><span class="nm"><b>${esc(nm)}</b><span>${esc(rest.join(' - ') || cap(r.type))}</span></span>
      <span class="side">${(r.inks || []).map((i) => `<span class="dot ${i}" title="${cap(i)}"></span>`).join('')}<span class="cost">${r.cost ?? ''}</span></span></button>`;
  }).join('') : '<p class="note" style="padding:8px 12px">No cards match.</p>';
}
function addSeed(c) {
  if (F.seed.length >= MAX_SEED || F.seed.some((x) => x.id === c.id)) return;
  F.seed.push(c); paintPicked(); search(); msg('');
  $('#q').select();
}
function paintPicked() {
  $('#picked').innerHTML = F.seed.map((c) => `<span class="pchip" data-peek="${esc(c.id)}"><img src="${IMG(c.id)}" alt="">${esc(c.full)}<button type="button" data-drop="${esc(c.id)}" aria-label="Remove ${esc(c.full)}">✕</button></span>`).join('');
  $('#seedNote').textContent = F.seed.length ? `${F.seed.length} of ${MAX_SEED} seed cards.` : 'Pick one to six cards the deck should be about.';
}
async function startRun() {
  if (F.sending) return;
  const seed = F.mode === 'cards' ? { cards: F.seed.map((c) => c.id) } : { deckId: F.deckId };
  if (F.mode === 'cards' && !seed.cards.length) return msg('Pick at least one seed card.', true);
  if (F.mode === 'deck' && !seed.deckId) return msg('Pick one of your decks.', true);
  if (F.inks.size) seed.inks = [...F.inks];
  F.sending = true; $('#startBtn').disabled = true; msg('Starting…');
  try {
    const j = await api('/api/lab', { method: 'POST', body: JSON.stringify({ seed, rounds: F.rounds, games: F.games }) });
    try { localStorage.setItem(LAST_KEY, j.id); } catch { /* storage blocked */ }
    history.pushState(null, '', `/lab?id=${encodeURIComponent(j.id)}`);
    openRun(j.id);
  } catch (e) {
    msg(e.status === 401 ? 'Sign in again to start the Lab.' : e.status === 404 ? "The Deck Lab isn't running on this server yet." : e.message, true);
    $('#startBtn').disabled = false;
  } finally { F.sending = false; }
}

// =====================================================================
//  A run: state, the event handler and the three areas
// =====================================================================
let R = null;
function newRun(id) {
  return {
    id, mock: MOCK, status: 'running', phase: null, decks: [], view: null, game: null, gameSeq: 0, progress: {}, results: [],
    tries: {}, verdicts: {}, done: null, error: null, saved: null, startClock: Date.now(), lastAt: 0, cancelling: false,
  };
}
const dirty = new Set();
let raf = 0;
function mark(...parts) { parts.forEach((p) => dirty.add(p)); if (!raf) raf = requestAnimationFrame(flush); }
function flush() {
  raf = 0;
  if (!R) return;
  if (dirty.has('head')) renderHead();
  if (dirty.has('board')) renderBoard();
  if (dirty.has('chart')) renderChart();
  if (dirty.has('deck')) renderDeck();
  if (dirty.has('done')) renderDone();
  dirty.clear();
}

function shell() {
  R.actsSig = null;
  app.innerHTML = `
    <div class="runhead"><div><h1 id="runTitle">Deck Lab</h1></div><span id="runState" class="state"><i class="spin"></i><span>Starting…</span></span>${R.mock ? '<span class="demo-tag" title="A scripted run: nothing here is real">Demo</span>' : ''}<span class="grow"></span><div class="acts" id="runActs"></div></div>
    <div id="doneBox"></div>
    <div class="grid">
      <section class="pane feed-pane" aria-label="What the Lab is thinking"><h2>Thinking</h2><div id="feed" class="feed" aria-live="polite"></div></section>
      <div class="stack">
        <section class="pane" aria-label="The game being played"><div class="h2"><span>Live game</span><span class="grow"></span><span id="gameTag"></span></div><div id="board" class="board idle">The first test game shows up here.</div><div id="bgprog" class="bgprog"></div></section>
        <section class="pane" aria-label="Win rate by version"><div class="h2"><span>Win rate</span></div><div id="chart" class="chart"><p class="empty">No results yet.</p></div><div id="matchups"></div></section>
      </div>
      <section class="pane deck-pane" aria-label="The deck"><h2>Deck</h2><div id="deck"><p class="empty">No list yet.</p></div></section>
    </div>`;
  const feed = $('#feed');
  // the feed follows the newest line until the reader scrolls up; scrolling back to the bottom picks it up again
  R.follow = true;
  const reread = () => setTimeout(() => { R.follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60; }, 60);
  for (const ev of ['wheel', 'touchmove', 'keydown', 'pointerdown']) feed.addEventListener(ev, reread, { passive: true });
  feed.addEventListener('load', () => { if (R?.follow) scrollFeed(); }, true);   // card images grow the feed as they arrive
  feed.addEventListener('scroll', () => { if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 30) R.follow = true; }, { passive: true });
  feed.addEventListener('click', (e) => {
    const b = e.target.closest('.more-syn');
    if (b) { b.parentElement.querySelectorAll('.syn-row[hidden]').forEach((r) => { r.hidden = false; }); b.remove(); }
  });
}

function openRun(id) {
  stopRun();
  R = newRun(id);
  shell();
  mark('head');
  clockTimer = setInterval(() => mark('head'), 1000);
  loadCards().then(() => (MOCK ? playMock() : connect(id)));
}
let clockTimer = 0;
let es = null;
let mockTimer = 0;
function stopRun() {
  clearInterval(clockTimer); clearTimeout(mockTimer);
  if (es) { es.close(); es = null; }
}

// ---------- the stream ----------
function connect(id) {
  // the server sends ids and `retry`; an automatic reconnect sends Last-Event-ID and gets only newer events, so the
  // page keeps its state. A fresh open (a reload of ?id=) gets every event again, plus only the latest frame.
  es = new EventSource(`/api/lab/${encodeURIComponent(id)}/events`);
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    apply(ev);
    if (ev.t === 'done' || ev.t === 'error') { es?.close(); es = null; }
  };
  es.onerror = async () => {
    if (!es || es.readyState !== EventSource.CLOSED) return;      // the browser is retrying by itself
    es = null;
    try {
      const j = await api(`/api/lab/${encodeURIComponent(id)}`);
      R = newRun(id); shell();
      for (const ev of j.events || []) apply(ev);
      if (j.frame) apply({ t: 'frame', view: j.frame });               // frames aren't kept in the history, only the latest
      if (j.status === 'running' && R.status === 'running') setTimeout(() => { if (R?.id === id && !es) connect(id); }, 3000);
      mark('head');
    } catch (e) {
      R.status = 'error';
      R.error = e.status === 404 ? "This Lab run isn't around any more. Runs are kept while the server is up." : e.status === 401 ? 'Sign in to watch this run.' : e.status === 403 ? 'This run belongs to another account. Sign in as its owner to watch it.' : `Lost the connection: ${e.message}`;
      feedAdd(`<div class="ev bad"><span class="ico">⚠️</span><div class="tx">${esc(R.error)}</div></div>`);
      mark('head', 'board');
    }
  };
}

// ---------- events ----------
function apply(ev) {
  if (!R || !ev || !ev.t) return;
  if (typeof ev.at === 'number') { R.lastAt = Math.max(R.lastAt, ev.at); if (R.mock || R.status === 'running') R.startClock = Math.min(R.startClock, Date.now() - ev.at); }
  for (const c of ev.cards && Array.isArray(ev.cards) && typeof ev.cards[0] === 'object' && !Array.isArray(ev.cards[0]) ? ev.cards : []) remember(c.id, c.full);
  switch (ev.t) {
    case 'phase':
      R.phase = ev;
      if (ev.phase !== 'done') feedAdd(`<h3 class="ph">${esc(ev.label || cap(ev.phase))}${ev.round ? `<span class="rd">Round ${ev.round}</span>` : ''}</h3>`);
      mark('head');
      break;
    case 'think':
      feedAdd(`<div class="think">${esc(ev.text)}${ev.cards?.length ? `<div class="chips">${ev.cards.map((id) => chip(id)).join('')}</div>` : ''}</div>`);
      break;
    case 'synergy': {
      const rows = ev.cards || [];
      feedAdd(`<div class="syn">${rows.map((c, i) => `<div class="syn-row" data-peek="${esc(c.id)}" ${i >= 8 ? 'hidden' : ''}><img src="${IMG(c.id)}" alt="" loading="lazy"><div><div class="nm">${esc(nameOf(c.id, c.full))} <span class="role ${esc(c.role)}">${esc(c.role)}</span>${c.score != null ? `<span class="score" title="How much it helps the idea">${Math.round(c.score * 10) / 10}</span>` : ''}</div>${c.reasons?.length ? `<div class="why">${c.reasons.map(esc).join(' · ')}</div>` : ''}</div></div>`).join('')}${rows.length > 8 ? `<button class="more-syn" type="button">Show all ${rows.length}</button>` : ''}</div>`);
      break;
    }
    case 'deck': {
      R.decks = R.decks.filter((d) => d.label !== ev.label).concat(ev);
      const ch = ev.changes;
      feedAdd(`<div class="ev"><span class="ico">🃏</span><div class="tx"><b>${esc(ev.label)}</b> · ${esc(ev.name || 'Deck')} · ${ev.size ?? sizeOf(ev.cards)} cards${ev.legal === false ? ' · <span class="legal no">Not legal</span>' : ''}${ch ? `<div class="swaps">${swapText(ch.out, '−')}${swapText(ch.in, '+')}</div>` : ''}</div></div>`);
      if (!R.view || R.view.follow) R.view = { label: ev.label, follow: true };
      mark('deck', 'head', 'chart');
      break;
    }
    case 'gameStart':
      R.game = { start: ev, frame: null, end: null, n: ++R.gameSeq };
      feedAdd(`<div class="ev"><span class="ico">▶</span><div class="tx">Watching <b>${esc(ev.label)}</b> play ${esc(ev.opp || 'an opponent')}${ev.oppInks?.length ? ` <span class="sub" style="display:inline">(${ev.oppInks.map(cap).join('/')})</span>` : ''}</div></div>`);
      mark('board');
      break;
    case 'frame':
      if (!R.game) R.game = { start: { label: ev.label || '', opp: 'Opponent' }, frame: null, end: null, n: ++R.gameSeq };
      else if (ev.label && R.game.start.label && ev.label !== R.game.start.label) break;   // a late joiner's last frame of an earlier game
      R.game.frame = ev.view;
      mark('board');
      break;
    case 'gameEnd':
      if (R.game) R.game.end = ev;
      feedAdd(`<div class="ev ${ev.win ? 'win' : 'loss'}"><span class="ico">${ev.win ? '🏆' : '✖'}</span><div class="tx"><b>${ev.win ? 'Won' : 'Lost'}</b> in ${ev.turns ?? '?'} turns${ev.lore ? ` · lore ${ev.lore[0]}–${ev.lore[1]}` : ''}${ev.reason ? ` <span class="sub" style="display:inline">· ${esc(ev.reason)}</span>` : ''}</div></div>`);
      mark('board');
      break;
    case 'progress': {
      R.progress[ev.label] = ev;
      const key = `prog-${ev.label}`;
      let el = document.getElementById(key);
      if (!el) el = feedAdd(`<div class="ev" id="${esc(key)}"><span class="ico">⏳</span><div class="tx"></div></div>`);
      el.querySelector('.tx').innerHTML = `Testing <b>${esc(ev.label)}</b>: ${ev.done} of ${ev.total} games · ${ev.wins} won<div class="bar"><i style="width:${ev.total ? Math.round((ev.done / ev.total) * 100) : 0}%"></i></div>`;
      mark('board');
      break;
    }
    case 'result': {
      R.results.push(ev);
      document.getElementById(`prog-${ev.label}`)?.remove();
      feedAdd(`<div class="ev res"><span class="ico">📊</span><div class="tx"><b>${esc(ev.label)}</b> won <span class="rate">${pct(ev.rate)}</span> · ${ev.wins} of ${ev.games}<div class="sub">likely between ${pct(ev.lo)} and ${pct(ev.hi)}</div></div></div>`);
      mark('chart', 'board');
      break;
    }
    case 'impact': {
      const rows = (ev.cards || []).slice(0, 10);
      feedAdd(`<div class="ev"><span class="ico">🔍</span><div class="tx"><b>What does the least in ${esc(ev.label)}</b>
        <table class="imp"><tbody>${rows.map((c, i) => `<tr class="${i === 0 ? 'cut1' : ''}" data-peek="${esc(c.id)}"><td>${esc(nameOf(c.id, c.full))}${c.note ? `<div class="nt">${esc(c.note)}</div>` : ''}</td><td class="n" title="drawn · played">${c.drawn ?? '–'}·${c.played ?? '–'}</td><td class="deadbar" title="How dead: ${pct(c.dead)}"><div class="bar"><i style="width:${Math.round(norm(c.dead) * 100)}%"></i></div></td></tr>`).join('')}</tbody></table>
        <div class="sub">drawn · played, and how often it did nothing</div></div></div>`);
      break;
    }
    case 'try': {
      R.tries[ev.label] = ev;
      const s = ev.swap || {};
      feedAdd(`<div class="ev try" id="try-${esc(ev.label)}"><span class="ico">🧪</span><div class="tx"><b>${/^try/i.test(ev.label) ? esc(cap(ev.label)) : `Trying ${esc(ev.label)}`}</b>${s.kind ? ` <span class="role">${esc(s.kind)}</span>` : ''}<div class="swaps">${swapText(s.out, '−')}${swapText(s.in, '+')}</div>${s.why ? `<div class="sub">${esc(s.why)}</div>` : ''}<div class="sub vwhy"></div></div><span class="verdict">Testing…</span></div>`);
      break;
    }
    case 'verdict': {
      R.verdicts[ev.label] = ev;
      let el = document.getElementById(`try-${ev.label}`);
      if (!el) el = feedAdd(`<div class="ev try" id="try-${esc(ev.label)}"><span class="ico">🧪</span><div class="tx"><b>${/^c\d/.test(ev.label) ? `The kept swaps together (${esc(ev.label)})` : esc(ev.label)}</b><div class="sub vwhy"></div></div><span class="verdict"></span></div>`);
      el.classList.add(ev.kept ? 'kept' : 'rejected');
      el.querySelector('.verdict').textContent = ev.kept ? 'Kept' : 'Rejected';
      el.querySelector('.vwhy').innerHTML = `${ev.rate != null ? `<b>${pct(ev.rate)}</b>${ev.base != null ? ` vs ${pct(ev.base)}` : ''}. ` : ev.kept ? '' : 'Not tested. '}${esc(ev.why || '')}`;
      if (R.follow) scrollFeed();
      mark('chart');
      break;
    }
    case 'done':
      R.done = ev; R.status = ev.cancelled ? 'cancelled' : 'done';   // cancelled once a list existed: still saveable
      if (ev.best?.cards && !R.decks.some((d) => d.label === ev.best.label)) R.decks.push({ t: 'deck', label: ev.best.label, name: ev.best.name, cards: ev.best.cards, size: sizeOf(ev.best.cards) });
      R.view = { label: ev.best?.label || R.decks.at(-1)?.label, follow: false };
      feedAdd(`<h3 class="ph">${ev.cancelled ? 'Stopped' : 'Done'}</h3><div class="think">${ev.cancelled ? 'Best so far' : 'Best version'}: <b>${esc(ev.best?.label || '')}</b>${ev.best?.rate != null ? `, winning ${pct(ev.best.rate)} (${pct(ev.best.lo)}–${pct(ev.best.hi)})` : ''}. ${ev.history?.length ? `Tried ${ev.history.length} swap${ev.history.length === 1 ? '' : 's'}, kept ${ev.history.filter((h) => h.kept).length}.` : ''}</div>`);
      mark('head', 'deck', 'done', 'chart', 'board');
      clearInterval(clockTimer);
      break;
    case 'error':
      R.error = ev.msg || 'Something went wrong.'; R.status = /^cancel/i.test(R.error) ? 'cancelled' : 'error';
      feedAdd(`<div class="ev bad"><span class="ico">⚠️</span><div class="tx">${esc(R.error)}</div></div>`);
      mark('head', 'done', 'board');
      clearInterval(clockTimer);
      break;
    default: break;
  }
}
const sizeOf = (cards) => (cards || []).reduce((n, [, q]) => n + q, 0);

// ---------- the feed ----------
function feedAdd(html) {
  const feed = $('#feed');
  if (!feed) return null;
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  const first = tpl.content.firstElementChild;
  const last = tpl.content.lastElementChild;
  feed.append(tpl.content);
  if (R.follow) scrollFeed();
  return last || first;
}
function scrollFeed() { const f = $('#feed'); if (f) f.scrollTop = f.scrollHeight; }

// ---------- the head: title, state, buttons ----------
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function renderHead() {
  const latest = R.decks.at(-1);
  const title = R.done?.best?.name || latest?.name || 'Deck Lab';
  $('#runTitle').textContent = title;
  document.title = title === 'Deck Lab' ? 'Ink · Deck Lab' : `Ink · Deck Lab · ${title}`;
  const st = $('#runState');
  st.classList.toggle('done', R.status === 'done');
  st.classList.toggle('bad', R.status === 'error' || R.status === 'cancelled');
  const elapsed = R.status === 'running' ? Date.now() - R.startClock : R.lastAt;
  const label = R.status === 'done' ? 'Done' : R.status === 'cancelled' ? 'Stopped' : R.status === 'error' ? 'Stopped' : R.cancelling ? 'Stopping…' : R.phase ? `${R.phase.label || cap(R.phase.phase)}${R.phase.round ? ` · round ${R.phase.round}` : ''}` : 'Starting…';
  st.querySelector('span').textContent = `${label} · ${clock(elapsed)}`;
  const sig = `${R.status}|${R.cancelling}`;
  if (R.actsSig === sig) return;                                 // the clock ticks every second; leave the buttons be
  R.actsSig = sig;
  $('#runActs').innerHTML = R.status === 'running'
    ? `<button class="btn btn-quiet btn-sm" id="cancelBtn" ${R.cancelling ? 'disabled' : ''}>${R.cancelling ? 'Stopping…' : 'Cancel'}</button>`
    : '<a class="btn btn-quiet btn-sm" href="/lab" id="againBtn">New run</a>';
  $('#cancelBtn')?.addEventListener('click', cancelRun);
  $('#againBtn')?.addEventListener('click', (e) => { e.preventDefault(); stopRun(); R = null; history.pushState(null, '', '/lab'); renderStart(); });
}
async function cancelRun() {
  if (!R || R.status !== 'running') return;
  R.cancelling = true; mark('head');
  if (R.mock) { clearTimeout(mockTimer); apply({ t: 'error', msg: 'Cancelled. The best list so far is still here.', at: R.lastAt }); return; }
  try { await api(`/api/lab/${encodeURIComponent(R.id)}/cancel`, { method: 'POST' }); }
  catch (e) { R.cancelling = false; mark('head'); feedAdd(`<div class="ev bad"><span class="ico">⚠️</span><div class="tx">Couldn't cancel: ${esc(e.message)}</div></div>`); }
}

// ---------- the live board ----------
function renderBoard() {
  const el = $('#board');
  const g = R.game;
  const bg = Object.values(R.progress).filter((p) => p.done < p.total && !R.results.some((r) => r.label === p.label));
  $('#bgprog').textContent = bg.length ? bg.map((p) => `${p.label}: ${p.done}/${p.total} games in the background`).join(' · ') : '';
  if (!g?.frame) {
    el.className = 'board idle';
    el.innerHTML = g?.end ? `<div><b>${esc(g.start.label)} ${g.end.win ? 'won' : 'lost'}</b> against ${esc(g.start.opp || 'the opponent')} in ${g.end.turns ?? '?'} turns${g.end.lore ? `, ${g.end.lore[0]}–${g.end.lore[1]} lore` : ''}.<br><span class="note">The moves of a finished game aren't kept.</span></div>`
      : g ? `Setting up ${esc(g.start.label)} vs ${esc(g.start.opp || 'an opponent')}…` : R.status === 'running' ? 'The first test game shows up here.' : 'No game was streamed.';
    $('#gameTag').textContent = '';
    return;
  }
  const f = g.frame;
  el.className = 'board';
  $('#gameTag').textContent = `${g.start.label || ''}${g.start.opp ? ` vs ${g.start.opp}` : ''}`;
  const card = (c) => {
    const m = meta(c.cardId);
    const lore = m.type === 'character' && m.lore ? `<span class="lr">◆${m.lore}</span>` : '';
    return `<span class="bc ${c.exerted ? 'ex' : ''}" data-peek="${esc(c.cardId)}" title="${esc(m.full)}${c.exerted ? ' (exerted)' : ''}${c.damage ? ` · ${c.damage} damage` : ''}"><img src="${IMG(c.cardId)}" alt="${esc(m.full)}" loading="lazy">${c.damage ? `<b class="dmg">${c.damage}</b>` : ''}${lore}</span>`;
  };
  const hand = (n) => `<span class="hand" title="${n} in hand">${Array.from({ length: Math.min(n, 10) }, () => '<i></i>').join('')}</span> ${n} in hand`;
  const who = (side, nm, on) => `<div class="bv-who ${on ? 'on' : ''}"><span class="nm">${esc(nm)}</span><span class="lorebar" title="Lore, first to ${LORE_TO_WIN} wins"><span class="track"><i style="width:${Math.min(100, (side.lore / LORE_TO_WIN) * 100)}%"></i></span><b>${side.lore}</b></span><span>⬡ ${side.ink ?? 0}</span><span>${hand(Array.isArray(side.hand) ? side.hand.length : side.hand ?? 0)}</span></div>`;
  const end = g.end;
  el.innerHTML = `
    <div class="bv-head"><span>Game ${g.n} · <b>Turn ${f.turn ?? '?'}</b></span><span>${f.status === 'over' || end ? 'Game over' : f.active === 'you' ? `${esc(g.start.label || 'Lab deck')} to play` : 'Opponent to play'}</span></div>
    <div class="bv-side">${who(f.opp, g.start.opp || 'Opponent', f.active === 'opp' && !end)}<div class="bv-row">${(f.opp.play || []).map(card).join('')}</div></div>
    <div class="bv-mid"></div>
    <div class="bv-side"><div class="bv-row">${(f.me.play || []).map(card).join('')}</div>${who(f.me, g.start.label ? `Lab deck ${g.start.label}` : 'Lab deck', f.active === 'you' && !end)}</div>
    <ol class="bv-log">${(f.log || []).map((l) => `<li>${esc(l)}</li>`).join('')}</ol>
    ${end ? `<div class="bv-end ${end.win ? 'win' : 'loss'}"><div><b>${end.win ? 'Won' : 'Lost'}</b><span>${end.turns ?? f.turn} turns${end.lore ? ` · ${end.lore[0]}–${end.lore[1]} lore` : ''}</span></div></div>` : ''}`;
}

// ---------- win rate across versions, and matchups ----------
function resultsByLabel() {
  const m = new Map();
  for (const r of R.results) m.set(r.label, r);
  return m;
}
// '<vN> smart' is the confirm phase's smart-pilot rerun of vN: charted as that version's confirmed point, not as a try
const smartOf = (label) => /^(v\d+) smart$/.exec(String(label))?.[1] || null;
function renderChart() {
  const res = resultsByLabel();
  const el = $('#chart');
  if (!res.size) { el.innerHTML = '<p class="empty">No results yet.</p>'; $('#matchups').innerHTML = ''; return; }
  const versions = new Set(R.decks.map((d) => d.label));
  const pts = [...res.values()];
  const W = 340, H = 168, L = 30, Rr = 10, T = 10, B = 34;
  const step = pts.length > 1 ? (W - L - Rr) / (pts.length - 1) : 0;
  const x = (i) => (pts.length > 1 ? L + step * i : (L + W - Rr) / 2);
  const y = (p) => T + (1 - norm(p)) * (H - T - B);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((g) => `<line class="${g === 0.5 ? 'half' : 'ax'}" x1="${L}" x2="${W - Rr}" y1="${y(g)}" y2="${y(g)}"/><text x="${L - 6}" y="${y(g) + 3}" text-anchor="end">${g * 100}%</text>`).join('');
  const verPts = pts.map((p, i) => ({ p, i })).filter(({ p }) => versions.has(p.label));
  const line = verPts.length > 1 ? `<polyline class="line" points="${verPts.map(({ p, i }) => `${x(i)},${y(p.rate)}`).join(' ')}"/>` : '';
  const bars = pts.map((p, i) => {
    const v = R.verdicts[p.label];
    const smart = smartOf(p.label);
    const ver = versions.has(p.label) || !!smart;
    const cls = versions.has(p.label) ? 'ver' : smart ? 'ver smart' : `try ${v ? (v.kept ? 'kept' : 'rejected') : ''}`;
    const cx = x(i);
    const lab = smart ? `${smart} ✓` : String(p.label);
    const showLabel = pts.length <= 9 || ver || i === pts.length - 1;
    return `<g class="${cls}"><title>${esc(smart ? `${smart}, smart pilot` : lab)}: ${pct(p.rate)} (${pct(p.lo)}–${pct(p.hi)}), ${p.wins} of ${p.games}${v ? ` · ${v.kept ? 'kept' : 'rejected'}` : ''}</title>
      <line class="ci" x1="${cx}" x2="${cx}" y1="${y(p.hi)}" y2="${y(p.lo)}"/><line class="ci" x1="${cx - 4}" x2="${cx + 4}" y1="${y(p.hi)}" y2="${y(p.hi)}"/><line class="ci" x1="${cx - 4}" x2="${cx + 4}" y1="${y(p.lo)}" y2="${y(p.lo)}"/>
      <circle class="pt" cx="${cx}" cy="${y(p.rate)}" r="${ver ? 5 : 4}"/>
      ${showLabel ? `<text class="vl" x="${cx}" y="${H - B + 16}" text-anchor="middle">${esc(lab.length > 7 ? lab.slice(0, 7) : lab)}</text>` : ''}
      ${ver ? `<text x="${cx}" y="${H - B + 28}" text-anchor="middle">${pct(p.rate)}</text>` : ''}</g>`;
  }).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Win rate of each version and each tried swap, with a confidence range">${grid}${line}${bars}</svg>
    <div class="legend"><span class="v"><i></i>deck version</span><span class="s"><i></i>✓ rechecked by the smart pilot</span><span class="k"><i></i>swap kept</span><span class="r"><i></i>swap rejected</span><span>bars: likely range</span></div>`;
  // matchups: the version shown in the deck pane, else the latest result
  const want = R.view?.label;
  const r = (want && res.get(want)) || [...res.values()].filter((p) => versions.has(p.label)).at(-1) || pts.at(-1);
  const opps = r?.byOpp || [];
  $('#matchups').innerHTML = opps.length ? `<div class="h2" style="margin-top:14px"><span>Matchups · ${esc(r.label)}</span></div><div class="mu">${opps.map((o) => {
    const p = o.games ? o.wins / o.games : 0;
    return `<div class="mu-row"><span class="nm" title="${esc(o.name)}">${esc(o.name)}</span><span class="bar"><i class="${p < 0.45 ? 'lo' : ''}" style="width:${Math.round(p * 100)}%"></i></span><span class="n">${o.wins}/${o.games}</span></div>`;
  }).join('')}</div>` : '';
}

// ---------- the deck ----------
function renderDeck() {
  const el = $('#deck');
  if (!R.decks.length) { el.innerHTML = '<p class="empty">No list yet.</p>'; return; }
  const idx = Math.max(0, R.decks.findIndex((d) => d.label === R.view?.label));
  const d = R.decks[idx] || R.decks.at(-1);
  const prev = idx > 0 ? R.decks[idx - 1] : null;
  const now = new Map((d.cards || []).map(([id, q]) => [String(id), q]));
  // diff against the version before: the event's own changes if it sent them, else worked out here
  const plus = new Map(), minus = new Map();
  if (d.changes) {
    for (const [id, n] of d.changes.in || []) plus.set(String(id), n);
    for (const [id, n] of d.changes.out || []) minus.set(String(id), n);
  } else if (prev) {
    const was = new Map((prev.cards || []).map(([id, q]) => [String(id), q]));
    for (const [id, q] of now) if (q > (was.get(id) || 0)) plus.set(id, q - (was.get(id) || 0));
    for (const [id, q] of was) if (q > (now.get(id) || 0)) minus.set(id, q - (now.get(id) || 0));
  }
  const rows = [...now].map(([id, q]) => ({ id, q, m: meta(id), cut: false }));
  for (const [id, n] of minus) if (!now.has(id)) rows.push({ id, q: n, m: meta(id), cut: true });
  const groups = new Map();
  for (const r of rows) {
    const k = r.m.cost == null ? '?' : r.m.cost >= 7 ? '7+' : String(r.m.cost);
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  const order = [...groups.keys()].sort((a, b) => (a === '?' ? 99 : parseInt(a)) - (b === '?' ? 99 : parseInt(b)));
  const size = d.size ?? sizeOf(d.cards);
  let inkable = 0, known = 0, costSum = 0;
  for (const [id, q] of now) { const m = meta(id); if (m.inkable != null) { known += q; if (m.inkable) inkable += q; } if (m.cost != null) costSum += m.cost * q; }
  const inks = d.inks?.length ? d.inks : [...new Set([...now.keys()].flatMap((id) => meta(id).inks || []))];
  const res = resultsByLabel().get(d.label);
  el.innerHTML = `
    ${R.decks.length > 1 ? `<div class="vers" role="group" aria-label="Version">${R.decks.map((x) => `<button type="button" data-ver="${esc(x.label)}" aria-pressed="${x === d}">${esc(x.label)}</button>`).join('')}</div>` : ''}
    <div class="dhead"><div class="dn">${esc(d.name || 'Deck')} <span class="note">${esc(d.label)}</span></div>
      <div class="dstats">${inks.map((i) => `<span class="hexi ${esc(i)}" title="${cap(i)}"></span>`).join('')}<span>${size} cards</span>${known ? `<span title="Cards that can go into the inkwell">${inkable} inkable</span>` : ''}${size ? `<span>avg cost ${(costSum / size).toFixed(1)}</span>` : ''}${d.legal === false ? '<span class="legal no">Not legal</span>' : d.legal ? '<span class="legal">Legal</span>' : ''}${res ? `<span title="${res.wins} of ${res.games} games">${pct(res.rate)} wins</span>` : ''}</div></div>
    ${order.map((k) => {
      const list = groups.get(k).sort((a, b) => a.cut - b.cut || String(a.m.type).localeCompare(String(b.m.type)) || a.m.full.localeCompare(b.m.full));
      const n = list.filter((r) => !r.cut).reduce((s, r) => s + r.q, 0);
      return `<div class="cg"><h3>Cost ${k} <span>${n}</span></h3><ul class="dl">${list.map((r) => {
        const p = plus.get(r.id), mi = minus.get(r.id);
        return `<li class="${r.cut ? 'cut' : p ? 'added' : ''}" data-peek="${esc(r.id)}" tabindex="0"><span class="q">${r.cut ? '' : r.q}</span><span>${(r.m.inks || []).slice(0, 1).map((i) => `<span class="dot ${esc(i)}"></span>`).join('')}</span><span class="n" title="${esc(r.m.full)}">${esc(r.m.full)}</span><span>${p ? `<span class="badge plus">+${p}</span>` : ''}${mi ? `<span class="badge minus">−${mi}</span>` : ''}</span></li>`;
      }).join('')}</ul></div>`;
    }).join('')}`;
  el.querySelectorAll('[data-ver]').forEach((b) => b.onclick = () => {
    const latest = R.decks.at(-1).label;
    R.view = { label: b.dataset.ver, follow: R.status === 'running' && b.dataset.ver === latest };
    mark('deck', 'chart');
  });
}

// ---------- done: best list, history, save and play ----------
function renderDone() {
  const box = $('#doneBox');
  if (!R.done && !(R.status !== 'running' && R.decks.length)) { box.innerHTML = ''; return; }
  const best = R.done?.best || { label: R.decks.at(-1).label, name: R.decks.at(-1).name };
  const hist = R.done?.history || [];
  box.innerHTML = `<div class="done-box">
    <h2>${R.done && !R.done.cancelled ? `Best version: ${esc(best.label)}` : `Stopped. Best so far: ${esc(best.label)}`}</h2>
    <div class="note">${esc(best.name || '')}${best.rate != null ? ` · won ${pct(best.rate)}, likely ${pct(best.lo)}–${pct(best.hi)}` : ''}</div>
    ${hist.length ? `<table class="hist"><thead><tr><th>Test</th><th>Swap</th><th>Win rate</th><th></th></tr></thead><tbody>${hist.map((h) => `<tr><td>${esc(h.label)}</td><td><div class="swaps" style="margin:0">${swapText(h.swap?.out, '−')}${swapText(h.swap?.in, '+')}</div>${h.swap?.why ? `<div class="note">${esc(h.swap.why)}</div>` : ''}</td><td>${h.rate != null ? pct(h.rate) : '–'}</td><td class="${h.kept ? 'k' : 'r'}">${h.kept ? 'Kept' : 'Rejected'}</td></tr>`).join('')}</tbody></table>` : ''}
    <div class="acts"><button class="btn btn-gold" id="saveBtn" ${R.saved ? 'disabled' : ''}>${R.saved ? (R.mock ? 'Not saved (demo)' : 'Saved to your decks') : 'Save to my decks'}</button><button class="btn" id="playBtn">Play it vs bot</button><span class="saved" id="saveMsg" role="status">${R.saved ? (R.mock ? 'Demo run: nothing was saved.' : `Saved as “${esc(R.savedName || best.name || 'Lab deck')}”. Find it under Decks.`) : ''}</span></div>
  </div>`;
  $('#saveBtn').onclick = () => saveBest().catch(() => {});
  $('#playBtn').onclick = async () => {
    try {
      const deckId = await saveBest();
      if (R.mock) { $('#saveMsg').textContent = 'Demo run: save a real run to play it.'; return; }
      try { localStorage.setItem(PLAY_DECK_KEY, `saved:${deckId}`); } catch { /* storage blocked */ }
      location.href = '/play';
    } catch { /* message shown */ }
  };
}
async function saveBest() {
  if (R.saved) return R.saved;
  const m = $('#saveMsg');
  $('#saveBtn').disabled = true; m.textContent = 'Saving…'; m.style.color = '';
  if (R.mock) { R.saved = 'mock'; mark('done'); return R.saved; }
  try {
    const j = await api(`/api/lab/${encodeURIComponent(R.id)}/save`, { method: 'POST', body: '{}' });
    R.saved = j.deckId; R.savedName = j.name;
    mark('done');
    return R.saved;
  } catch (e) {
    $('#saveBtn').disabled = false; m.textContent = `Couldn't save: ${e.message}`; m.style.color = 'var(--ember)';
    throw e;
  }
}

// =====================================================================
//  ?mock=1 — a scripted Zero To Hero run, so the page can be built and checked without the server's Lab
// =====================================================================
function playMock() {
  const speed = Math.max(0.25, Math.min(20, Number(params.get('speed')) || 1));
  const script = mockScript();
  let i = 0;
  const next = () => {
    if (!R || i >= script.length) return;
    const [, ev] = script[i++];
    apply(ev);
    if (i < script.length) mockTimer = setTimeout(next, script[i][0] / speed);
  };
  mockTimer = setTimeout(next, 300 / speed);
}
function mockScript() {
  const id = (full) => idByFull(full);
  const ids = (...names) => names.map(id).filter(Boolean);
  const list = (rows) => rows.map(([q, n]) => [id(n), q]).filter(([x]) => x);
  const out = [];
  let at = 0;
  const E = (gap, e) => { at += gap; out.push([gap, { ...e, at }]); };
  const opps = ['Ruby/Amethyst Aggro', 'Sapphire/Steel Ramp', 'Amber/Emerald Songs', 'Emerald/Ruby Discard'];
  const byOpp = (w) => opps.map((name, i) => ({ name, wins: w[i], games: 6 }));
  const wilson = (w, n) => { const z = 1.96, p = w / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n)); return [(c - m) / d, (c + m) / d]; };
  const result = (gap, label, w) => { const wins = w.reduce((a, b) => a + b, 0), games = w.length * 6; const [lo, hi] = wilson(wins, games); E(gap, { t: 'result', label, wins, games, rate: wins / games, lo, hi, byOpp: byOpp(w) }); };
  const progress = (label, wins) => { for (const [d, w] of [[6, wins[0]], [12, wins[1]], [18, wins[2]]]) E(500, { t: 'progress', label, done: d, total: 24, wins: w }); };

  const ZTH = 'Zero to Hero', PUDGE = 'Pudge - Controls the Weather';
  const v1 = [
    [4, ZTH], [4, PUDGE], [4, 'Lilo - Making a Wish'], [4, 'Lilo - Patient Weaver'], [4, 'Stitch - Alien Dancer'], [4, 'Stitch - New Dog'],
    [4, 'Mickey Mouse - Best in Town'], [4, 'Fru Fru - VIP Guest'], [4, 'Monterey Jack - Hypnotized by Cheese'], [4, 'Boo - In Disguise'],
    [4, 'Gazelle - Pop Diva'], [4, 'Stitch - Protector of Frogs'], [4, 'Kit Cloudkicker - Unpredictable Courier'], [4, 'Lilo - Galactic Hero'],
    [2, 'Stitch - Carefree Surfer'], [2, 'Sebastian - Loyal Crab'],
  ];
  const v2 = v1.map(([q, n]) => [n === 'Gazelle - Pop Diva' ? 1 : q, n]).concat([[3, 'Fire the Cannons!']]);
  const v3 = v2.filter(([, n]) => n !== 'Sebastian - Loyal Crab').concat([[2, 'Rex - Protective Dinosaur']]);
  const deck = (label, rows, changes) => { const cards = list(rows); return { t: 'deck', label, name: 'AS - Zero To Hero', cards, inks: ['amber', 'steel'], size: sizeOf(cards), legal: true, ...(changes ? { changes: { out: list(changes.out), in: list(changes.in) } } : {}) }; };
  const swap = (o, n, why, kind) => ({ out: list(o), in: list(n), why, kind });

  E(0, { t: 'phase', phase: 'seed', round: 0, label: 'Reading the seed' });
  E(900, { t: 'think', text: 'Zero to Hero plays a character for free if its cost is no more than the number of characters you have in play. So the deck wants a wide board early, and lots of cheap characters to get there.', cards: ids(ZTH) });
  E(1500, { t: 'think', text: 'Pudge - Controls the Weather names Lilo, so the cheap Lilos come along with it. Lilo pulls in Stitch, and Stitch has cheap versions too.', cards: ids(PUDGE, 'Lilo - Making a Wish', 'Stitch - New Dog') });
  E(1400, { t: 'think', text: 'Both seed cards are Amber. That leaves room for a second ink: I\'ll pick the one that supports a wide board of small characters best.' });
  E(900, { t: 'phase', phase: 'synergy', round: 0, label: 'Finding enablers and payoffs' });
  E(800, { t: 'think', text: 'Searching for cheap characters with high lore, cards that care about low costs, cards that play characters for free, and cheap Bodyguards to protect the early drops.' });
  const syn = [
    ['Lilo - Making a Wish', 'chain', 5.1, ['named by Pudge - Controls the Weather', 'costs 1']],
    ['Lilo - Patient Weaver', 'chain', 4.6, ['a Lilo for Pudge', 'Support helps a wide board quest']],
    ['Monterey Jack - Hypnotized by Cheese', 'payoff', 4.4, ['3 lore for 2 ink']],
    ['Stitch - New Dog', 'enabler', 4.2, ['costs 1', 'grows the board for Zero to Hero']],
    ['Mickey Mouse - Best in Town', 'enabler', 4.0, ['costs 1, 2 lore']],
    ['Fru Fru - VIP Guest', 'enabler', 3.9, ['costs 1']],
    ['Boo - In Disguise', 'payoff', 3.6, ['2 lore for 2']],
    ['Stitch - Alien Dancer', 'chain', 3.5, ['a Stitch for Lilo']],
    ['Rex - Protective Dinosaur', 'defense', 3.2, ['Bodyguard for 2', 'keeps 1-drops alive']],
    ['Stitch - Protector of Frogs', 'enabler', 3.1, ['Steel 1-drop']],
    ['Kit Cloudkicker - Unpredictable Courier', 'enabler', 3.0, ['Steel 1-drop']],
    ['Fire the Cannons!', 'removal', 2.9, ['deals 2 damage for 1', 'clears a blocker']],
    ['Lilo - Galactic Hero', 'chain', 2.7, ['a Lilo in Steel']],
    ['Gazelle - Pop Diva', 'payoff', 2.4, ['Singer 4 sings Zero to Hero early']],
    ['Stitch - Carefree Surfer', 'draw', 2.2, ['draws when the board is wide']],
    ['Sebastian - Loyal Crab', 'fallback', 2.0, ['3 lore for 2 in a flood']],
  ].map(([n, role, score, reasons]) => ({ id: id(n), full: n, role, score, reasons })).filter((c) => c.id);
  E(1400, { t: 'synergy', cards: syn });
  E(1600, { t: 'think', text: 'Steel has the most support: cheap 1-drops, a Lilo of its own and removal like Fire the Cannons! to protect the early board. Going Amber/Steel.', cards: ids('Stitch - Protector of Frogs', 'Fire the Cannons!') });
  E(900, { t: 'phase', phase: 'build', round: 0, label: 'Building v1' });
  E(1000, { t: 'think', text: 'Core: 4 Zero to Hero, 4 Pudge - Controls the Weather and every cheap Lilo and Stitch. Fill with 1- and 2-cost characters that quest for 2, and a couple of 7-drops to play for free.' });
  E(1000, deck('v1', v1));
  E(900, { t: 'think', text: 'The curve peaks at 1 and 2 and most of the deck can go in the inkwell. Legal, 60 cards, two inks. Time to play it.' });

  E(900, { t: 'phase', phase: 'sim', round: 0, label: 'Testing v1 against the meta' });
  const myPool = ids('Stitch - New Dog', 'Fru Fru - VIP Guest', 'Lilo - Making a Wish', PUDGE, 'Monterey Jack - Hypnotized by Cheese', 'Mickey Mouse - Best in Town', 'Boo - In Disguise', 'Lilo - Patient Weaver', 'Stitch - Alien Dancer', 'Kit Cloudkicker - Unpredictable Courier', 'Stitch - Carefree Surfer', 'Sebastian - Loyal Crab');
  const oppPool = ids('Stitch - Abomination', 'Lilo - Causing an Uproar', 'Gaston - Frightful Bully', 'Ursula - Vanessa', 'Simba - Playful Pouncer', 'Angel - Siren Singer');
  const game = (label, opp, oppInks, win, seed) => {
    E(700, { t: 'gameStart', label, opp, oppInks, me: 0, seed });
    for (const view of mockFrames(myPool, oppPool, win, seed)) E(380, { t: 'frame', label, view });
    const last = mockFrames(myPool, oppPool, win, seed).at(-1);
    E(500, { t: 'gameEnd', label, win, turns: last.turn, reason: 'lore', lore: [last.me.lore, last.opp.lore] });
  };
  game('v1', opps[0], ['ruby', 'amethyst'], true, 41);
  progress('v1', [3, 7, 10]);
  result(600, 'v1', [3, 2, 5, 3]);
  E(800, { t: 'think', text: 'v1 wins about half its games. It beats songs decks but loses to Sapphire/Steel Ramp, which removes the board faster than it can grow.' });
  E(800, { t: 'phase', phase: 'impact', round: 0, label: 'What does nothing?' });
  E(1000, { t: 'impact', label: 'v1', cards: [
    ['Gazelle - Pop Diva', 19, 6, 0.71, 'drawn in 19 games, played in 6: stuck in hand while the 1-drops go first'],
    ['Sebastian - Loyal Crab', 9, 5, 0.52, 'played late, rarely quests'],
    ['Stitch - Carefree Surfer', 10, 3, 0.48, 'usually inked'],
    ['Lilo - Galactic Hero', 15, 9, 0.33, ''],
    ['Kit Cloudkicker - Unpredictable Courier', 14, 11, 0.21, ''],
  ].map(([n, drawn, played, dead, note]) => ({ id: id(n), full: n, drawn, played, dead, note })).filter((c) => c.id) });
  E(1300, { t: 'think', text: 'Number 1 cut: Gazelle - Pop Diva. It\'s meant to sing Zero to Hero early, but by the time it lands the board is already wide enough to play things for free.', cards: ids('Gazelle - Pop Diva') });

  E(900, { t: 'phase', phase: 'try', round: 1, label: 'Trying swaps' });
  E(800, { t: 'try', label: 't1.1', swap: swap([[3, 'Gazelle - Pop Diva']], [[3, 'Fire the Cannons!']], 'Cut the dead card for cheap removal: Ramp\'s early blockers stop the board from questing.', 'removal') });
  progress('t1.1', [4, 8, 12]);
  result(600, 't1.1', [4, 3, 5, 4]);
  E(700, { t: 'verdict', label: 't1.1', kept: true, rate: 16 / 24, base: 13 / 24, why: 'Won 3 more of the same 24 games, most of them against Ramp.' });
  E(800, { t: 'try', label: 't1.2', swap: swap([[2, 'Stitch - Carefree Surfer']], [[2, 'David - Protective Snowboarder']], 'Trade the 7-drop for a second Bodyguard so Aggro can\'t pick off the 1-drops.', 'defense') });
  progress('t1.2', [3, 7, 10]);
  result(600, 't1.2', [3, 2, 4, 3]);
  E(700, { t: 'verdict', label: 't1.2', kept: false, rate: 12 / 24, base: 13 / 24, why: 'One game worse: without the Surfer the deck runs out of cards against Ramp.' });
  E(800, { t: 'phase', phase: 'confirm', round: 1, label: 'Checking with the smart pilot' });
  E(800, { t: 'think', text: 'The quick pilot liked that swap. The smart pilot plays combos better, so it gets the final say on new games.' });
  progress('v1 smart', [3, 6, 9]);
  progress('c1', [4, 8, 11]);
  result(600, 'v1 smart', [3, 2, 4, 3]);
  result(300, 'c1', [4, 3, 4, 4]);
  E(700, { t: 'verdict', label: 'c1', kept: true, rate: 15 / 24, base: 12 / 24, why: 'With the smart pilot it won 15 of 24 against 12 for v1.' });
  E(600, deck('v2', v2, { out: [[3, 'Gazelle - Pop Diva']], in: [[3, 'Fire the Cannons!']] }));

  E(900, { t: 'phase', phase: 'sim', round: 2, label: 'Testing v2 against the meta' });
  progress('v2', [4, 8, 11]);
  result(600, 'v2', [4, 3, 4, 4]);
  E(900, { t: 'phase', phase: 'try', round: 2, label: 'Trying swaps' });
  E(800, { t: 'think', text: 'Next least useful: Sebastian - Loyal Crab. A cheap Bodyguard does more in that slot.', cards: ids('Sebastian - Loyal Crab', 'Rex - Protective Dinosaur') });
  E(800, { t: 'try', label: 't2.1', swap: swap([[2, 'Sebastian - Loyal Crab']], [[2, 'Rex - Protective Dinosaur']], 'A Bodyguard for 2 protects Pudge and the Lilos while they quest.', 'defense') });
  progress('t2.1', [5, 9, 13]);
  result(600, 't2.1', [5, 4, 4, 4]);
  E(700, { t: 'verdict', label: 't2.1', kept: true, rate: 17 / 24, base: 15 / 24, why: 'Two more wins, and Aggro now needs two turns to clear the board.' });
  E(800, { t: 'phase', phase: 'confirm', round: 2, label: 'Checking with the smart pilot' });
  game('c2', opps[1], ['sapphire', 'steel'], true, 77);
  progress('v2 smart', [4, 8, 11]);
  progress('c2', [4, 8, 12]);
  result(600, 'v2 smart', [4, 3, 3, 4]);
  result(300, 'c2', [5, 3, 4, 4]);
  E(700, { t: 'verdict', label: 'c2', kept: true, rate: 16 / 24, base: 14 / 24, why: 'With the smart pilot it won 16 of 24 against 14 for v2.' });
  E(600, deck('v3', v3, { out: [[2, 'Sebastian - Loyal Crab']], in: [[2, 'Rex - Protective Dinosaur']] }));
  E(900, { t: 'phase', phase: 'done', round: 2, label: 'Done' });
  const v3cards = list(v3);
  const [lo, hi] = wilson(16, 24);
  E(500, { t: 'done', best: { label: 'v3', name: 'AS - Zero To Hero', cards: v3cards, rate: 16 / 24, lo, hi }, history: [
    { label: 't1.1', swap: swap([[3, 'Gazelle - Pop Diva']], [[3, 'Fire the Cannons!']], 'Cheap removal for Ramp\'s blockers.', 'removal'), rate: 16 / 24, kept: true },
    { label: 't1.2', swap: swap([[2, 'Stitch - Carefree Surfer']], [[2, 'David - Protective Snowboarder']], 'A second Bodyguard.', 'defense'), rate: 14 / 24, kept: false },
    { label: 't2.1', swap: swap([[2, 'Sebastian - Loyal Crab']], [[2, 'Rex - Protective Dinosaur']], 'A Bodyguard for 2.', 'defense'), rate: 17 / 24, kept: true },
  ] });
  return out;
}
// a short made-up game in the shape of playGame's onFrame views (game/analysis/playgame.js)
function mockFrames(myPool, oppPool, win, seed) {
  let r = seed;
  const rnd = () => { r = (r * 9301 + 49297) % 233280; return r / 233280; };
  const lore = (cid) => meta(cid).lore || 1;
  const me = { lore: 0, hand: myPool.slice(0, 7), ink: 0, play: [] };
  const op = { lore: 0, hand: 7, ink: 0, play: [] };
  const log = [];
  const frames = [];
  let draw = 7, oDraw = 0, turn = 0;
  const snap = (active, status = 'playing') => frames.push({
    turn, active, status,
    me: { lore: me.lore, hand: [...me.hand], ink: me.ink, play: me.play.map((c) => ({ ...c })) },
    opp: { lore: op.lore, hand: op.hand, ink: op.ink, play: op.play.map((c) => ({ ...c })) },
    log: log.slice(-6),
  });
  const say = (t) => log.push(t);
  while (turn < 16) {
    turn++;
    const mine = turn % 2 === 1;
    const side = mine ? me : op;
    const who = mine ? 'Lab deck' : 'Opponent';
    side.play.forEach((c) => { c.exerted = false; });
    if (turn > 1) { if (mine) me.hand.push(myPool[draw++ % myPool.length]); else op.hand++; }
    side.ink++;
    say(`${who} put a card into the inkwell.`); snap(mine ? 'you' : 'opp');
    // play one or two cards
    const plays = mine ? (side.ink >= 2 && rnd() > 0.4 ? 2 : 1) : 1;
    for (let k = 0; k < plays; k++) {
      const cid = mine ? me.hand.shift() : oppPool[oDraw++ % oppPool.length];
      if (!cid) break;
      if (!mine) op.hand = Math.max(0, op.hand - 1);
      side.play.push({ cardId: cid, exerted: false, damage: 0, fresh: true });
      say(`${who} played ${meta(cid).full}.`); snap(mine ? 'you' : 'opp');
    }
    // the opponent challenges sometimes
    if (!mine && me.play.length && rnd() > 0.45) {
      const atk = op.play.find((c) => !c.fresh && !c.exerted);
      const tgt = me.play.find((c) => c.exerted) || null;
      if (atk && tgt) {
        atk.exerted = true; tgt.damage += 2;
        say(`${meta(atk.cardId).full} challenged ${meta(tgt.cardId).full}.`);
        if (tgt.damage >= 3) { me.play.splice(me.play.indexOf(tgt), 1); say(`${meta(tgt.cardId).full} was banished.`); }
        snap('opp');
      }
    }
    // quest with everything that's dry
    for (const c of side.play) {
      if (c.fresh || c.exerted) continue;
      const gain = mine ? lore(c.cardId) : Math.max(1, lore(c.cardId) - (win ? 1 : 0));
      c.exerted = true; side.lore = Math.min(LORE_TO_WIN, side.lore + gain);
      say(`${meta(c.cardId).full} quested for ${gain} lore.`); snap(mine ? 'you' : 'opp');
      if (side.lore >= LORE_TO_WIN) break;
    }
    side.play.forEach((c) => { delete c.fresh; });
    if (me.lore >= LORE_TO_WIN || op.lore >= LORE_TO_WIN) { say(`${me.lore >= LORE_TO_WIN ? 'Lab deck' : 'Opponent'} reached ${LORE_TO_WIN} lore.`); snap(mine ? 'you' : 'opp', 'over'); break; }
    say(`${who} ended the turn.`);
  }
  if (frames.at(-1).status !== 'over') { if (win) me.lore = LORE_TO_WIN; else op.lore = LORE_TO_WIN; say('Game over.'); snap('you', 'over'); }
  return frames;
}

// =====================================================================
//  boot
// =====================================================================
async function boot() {
  try { await account.load(); } catch { /* offline */ }
  renderAcct();
  account.onChange(renderAcct);
  loadCards();                                                   // in the background: the deck list wants costs and inks
  const id = params.get('id');
  if (MOCK) openRun('mock');
  else if (id) {
    try { localStorage.setItem(LAST_KEY, id); } catch { /* storage blocked */ }
    openRun(id);
  } else renderStart();
}
addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('id');
  if (id) openRun(id); else { stopRun(); R = null; renderStart(); }
});
boot();
