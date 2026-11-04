// /lab — the Deck Lab. A signed-in player gives it a few seed cards (or one of their decks) and watches it build a deck
// out loud: it reads the idea, finds enablers and payoffs, assembles a list, plays it against the meta field, names
// the cards that do nothing, and tries swaps, keeping only the ones that win more (lib/lab.js, game/lab/brain.js).
//
// The page is three areas while a run goes: the thinking feed (narration, phases, synergy cards, tries and verdicts),
// the one game being streamed move by move plus the win rate of every version, and the deck as it stands.
//
//   POST /api/lab               { seed, rounds, games, options: { pivot, freeRein, target?, untilTarget? } } → { id }
//   GET  /api/lab               my runs [{ id, name, created, status, start_rate, best_rate, best_inks, parent_id }]
//   GET  /api/lab/:id/events    Server-Sent Events; replays everything so far (frames: only the latest) on connect,
//                               so ?id= survives a reload; reconnects resume from Last-Event-ID
//   GET  /api/lab/:id           { id, status, events, frame } snapshot (used when the stream can't be opened)
//   POST /api/lab/:id/cancel · POST /api/lab/:id/save → { deckId, name }
//   POST /api/lab/:id/continue  { from, rounds, games, options } → { id } of a new run that starts from that version
//
//   Labels: lists v1, v2…; colour trials s1..s4 (seed); tries t<round>.<n>; whole-list pivots p<round>.<n>; the kept
//   swaps together c<round>; '<vN> smart' = vN rerun by the smart pilot
//
//   When a run ends the page shows a review: start → best, what changed, progress and matchups, a "Keep improving"
//   panel (continue from any version, with new options) and every attempt, collapsed.
//
//   /lab?id=…        reconnect to a run
//   /lab?mock=1      a scripted Zero To Hero run, no server needed (&speed=4 plays it faster, &goal=1 an until-55% run,
//                    &mod=1 shows the moderator options); "Keep improving" in the demo plays a scripted continuation

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
// inks may come as an array, a JSON array or 'amber/ruby'
function inksOf(x) {
  if (Array.isArray(x)) return x.map(String);
  if (!x) return [];
  try { const j = JSON.parse(x); if (Array.isArray(j)) return j.map(String); } catch { /* plain text */ }
  return String(x).toLowerCase().split(/[^a-z]+/).filter((i) => INK_ORDER.includes(i));
}
const hexes = (inks) => inksOf(inks).map((i) => `<span class="hexi ${esc(i)}" title="${cap(i)}"></span>`).join('');
const inkName = (inks) => inksOf(inks).map(cap).join('/');
const sameInks = (a, b) => inksOf(a).slice().sort().join() === inksOf(b).slice().sort().join();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const PIVOT_KIND = { 'pivot-ink': 'New colours', 'pivot-plan': 'New plan', rebuild: 'Rebuild' };
const isMod = () => ['moderator', 'admin'].includes(account.user()?.role) || (MOCK && params.has('mod'));
// a toggle switch: a real checkbox, so it's keyboard and screen-reader friendly
const toggle = (id, on, title, sub = '') => `<label class="tog"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="sw" aria-hidden="true"></span><span class="tl"><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</span></label>`;
// the moderator+ "until it wins X%" row: a toggle with its slider
const goalRow = (pre, on, target) => `<div class="goal"><label class="tog"><input type="checkbox" id="${pre}Goal" ${on ? 'checked' : ''}><span class="sw" aria-hidden="true"></span><span class="tl"><b>Keep going until it wins <output id="${pre}TargetOut">${target}%</output></b><span>Rounds don't stop until a version reaches it with the smart pilot, or you cancel. Moderators only.</span></span></label>
  <input type="range" id="${pre}Target" min="30" max="80" step="1" value="${target}" aria-label="Win rate to reach" ${on ? '' : 'disabled'}></div>`;

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
const F = { mode: 'cards', seed: [], deckId: '', inks: new Set(), rounds: 3, games: 24, decks: [], sending: false, pivot: true, freeRein: false, untilTarget: false, target: 55 };

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
        <div class="knob"><div class="lblrow"><label class="lbl" for="rounds">Rounds of swaps</label><output id="roundsOut">${F.untilTarget && isMod() ? '∞' : F.rounds}</output></div>
          <input type="range" id="rounds" min="1" max="6" step="1" value="${F.rounds}" ${F.untilTarget && isMod() ? 'disabled' : ''}></div>
        <div class="knob"><div class="lblrow"><label class="lbl" for="games">Games per test</label><output id="gamesOut">${F.games}</output></div>
          <input type="range" id="games" min="12" max="60" step="4" value="${F.games}"></div>
      </div>
      <div class="togs">
        ${toggle('optPivot', F.pivot, 'Let it change colours', 'Tries a few ink pairs first, and switches colours mid-run if the list gets stuck.')}
        ${toggle('optFree', F.freeRein, 'Change anything (free rein)', 'May rebuild the plan around the cards that work, not only swap a few cards.')}
        ${isMod() ? goalRow('opt', F.untilTarget, F.target) : ''}
      </div>
      <p class="note" id="estimate"></p>
      <div class="go"><button class="btn btn-gold btn-lg" id="startBtn">Start the Lab</button><span class="msg" id="startMsg" role="status"></span></div>
    </div>
    <div id="myRuns"></div>
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
  $('#optPivot').onchange = (e) => { F.pivot = e.target.checked; estimate(); };
  $('#optFree').onchange = (e) => { F.freeRein = e.target.checked; estimate(); };
  if ($('#optGoal')) {
    $('#optGoal').onchange = (e) => {
      F.untilTarget = e.target.checked;
      $('#optTarget').disabled = !F.untilTarget; $('#rounds').disabled = F.untilTarget;
      $('#roundsOut').textContent = F.untilTarget ? '∞' : F.rounds;
      estimate();
    };
    $('#optTarget').oninput = (e) => { F.target = +e.target.value; $('#optTargetOut').textContent = `${F.target}%`; estimate(); };
  }
  paintMyRuns();
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
// rough: the first list, a few swaps a round plus confirmations, two whole-list pivots a round when allowed, and the
// colour trials at the start (half-size tests of up to 4 ink pairs) when the Lab picks the inks
const minutes = (games) => `${Math.max(2, Math.round(games * 0.06 / 6) + 2)}–${Math.max(4, Math.round(games * 0.12 / 6) + 4)} minutes`;
function estimateText({ rounds, games, pivot, freeRein, untilTarget, target, inksFixed = false, seedTrials = true }) {
  const perRound = (3 + (pivot || freeRein ? 2 : 0)) * games;
  const seed = seedTrials && pivot && !inksFixed ? 4 * Math.max(12, Math.round(games / 2)) : 0;
  if (untilTarget) return `Runs round after round until a version wins ${target}% with the smart pilot, or you stop it. Each round is about ${perRound} test games (${minutes(perRound)}). One game of each test is played out slowly so you can watch it.`;
  const total = games + seed + rounds * perRound;
  return `About ${total} test games over ${plural(rounds, 'round')}: usually ${minutes(total)}. One game of each test is played out slowly so you can watch it.`;
}
function estimate() {
  $('#estimate').textContent = estimateText({ ...F, untilTarget: F.untilTarget && isMod(), inksFixed: F.inks.size === 2 });
}

// ---------- my runs, newest first (GET /api/lab) ----------
const when = (t) => {
  const ms = Number(t) < 1e12 ? Number(t) * 1000 : Number(t);
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `today ${hm}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
};
const STATUS_WORD = { running: 'Running', done: 'Done', cancelled: 'Stopped', error: 'Failed', interrupted: 'Interrupted' };
// a change in points, with a clear up or down
const deltaTag = (from, to) => {
  if (from == null || to == null) return '';
  const d = Math.round((norm(to) - norm(from)) * 100);
  return `<span class="delta ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}">${d > 0 ? `▲ ${d}` : d < 0 ? `▼ ${-d}` : '±0'}</span>`;
};
async function myRuns() {
  const j = await api('/api/lab');
  return Array.isArray(j) ? j : j.runs || [];
}
async function paintMyRuns() {
  const el = $('#myRuns');
  if (!el) return;
  let rows;
  try { rows = await myRuns(); } catch { el.innerHTML = ''; return; }   // not on this server yet: no list
  if (!$('#myRuns') || !rows.length) { el.innerHTML = ''; return; }
  const names = new Map(rows.map((r) => [r.id, r.name]));
  el.innerHTML = `<div class="box runs"><h2>My runs</h2><p class="note">Open one to see its review, or keep improving it.</p><ul class="runlist">${rows.map((r) => `
    <li><a href="/lab?id=${encodeURIComponent(r.id)}" data-run="${esc(r.id)}">
      <span class="rn"><b>${esc(r.name || 'Lab run')}</b><span class="note">${esc(when(r.created))} · ${esc(STATUS_WORD[r.status] || cap(r.status || ''))}${r.parent_id ? ` · continued${names.has(r.parent_id) ? ` from ${esc(names.get(r.parent_id))}` : ''}` : ''}</span></span>
      <span class="ri">${hexes(r.best_inks)}</span>
      <span class="rr">${r.start_rate != null ? pct(r.start_rate) : '–'} <span class="arr">→</span> <b>${r.best_rate != null ? pct(r.best_rate) : '–'}</b>${deltaTag(r.start_rate, r.best_rate)}</span>
    </a></li>`).join('')}</ul></div>`;
  el.onclick = (e) => {
    const a = e.target.closest('a[data-run]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    goRun(a.dataset.run);
  };
}
function goRun(id, opts) {
  try { localStorage.setItem(LAST_KEY, id); } catch { /* storage blocked */ }
  history.pushState(null, '', `/lab?id=${encodeURIComponent(id)}`);
  openRun(id, opts);
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
  const options = { pivot: F.pivot, freeRein: F.freeRein, ...(isMod() && F.untilTarget ? { untilTarget: true, target: F.target / 100 } : {}) };
  F.sending = true; $('#startBtn').disabled = true; msg('Starting…');
  try {
    const j = await api('/api/lab', { method: 'POST', body: JSON.stringify({ seed, rounds: F.rounds, games: F.games, options }) });
    goRun(j.id, { options: { ...options, ...(j.options || {}), games: F.games } });
  } catch (e) {
    msg(e.status === 401 ? 'Sign in again to start the Lab.' : e.status === 404 ? "The Deck Lab isn't running on this server yet." : e.message, true);
    $('#startBtn').disabled = false;
  } finally { F.sending = false; }
}

// =====================================================================
//  A run: state, the event handler and the three areas
// =====================================================================
let R = null;
function newRun(id, opts = {}) {
  return {
    id, mock: MOCK, status: 'running', phase: null, decks: [], view: null, game: null, gameSeq: 0, progress: {}, results: [],
    tries: {}, verdicts: {}, done: null, error: null, saved: null, startClock: Date.now(), lastAt: 0, cancelling: false,
    // v2: the run's options (known when this page started it, or from the snapshot), its parent run, every attempt in
    // order (colour trials, swaps, pivots, combined), the colour trials, the latest target report, the review's state
    options: opts.options || null, parent: opts.parent || null, attempts: new Map(), inkTrials: [], target: null,
    round: 0, lastKept: null, lastSeq: 0, rvFilter: null, rvOpen: false, cont: null, contDirty: false,
  };
}
const dirty = new Set();
let raf = 0;
function mark(...parts) {
  parts.forEach((p) => dirty.add(p));
  if (raf) return;
  raf = requestAnimationFrame(flush);
  // a background tab gets no animation frames: draw anyway, so a tab brought back (or a silent reload) is up to date
  setTimeout(() => { if (raf) { cancelAnimationFrame(raf); flush(); } }, 400);
}
function flush() {
  raf = 0;
  if (!R) return;
  if (dirty.has('head')) renderHead();
  if (dirty.has('head') || dirty.has('goal')) renderGoal();
  if (dirty.has('board')) renderBoard();
  if (dirty.has('chart')) renderChart();
  if (dirty.has('deck')) renderDeck();
  if (dirty.has('done')) renderDone();
  dirty.clear();
}

function shell() {
  R.actsSig = null;
  app.innerHTML = `
    <div class="runhead"><div><h1 id="runTitle">Deck Lab</h1><div id="runSub" class="runsub"></div></div><span id="runState" class="state"><i class="spin"></i><span>Starting…</span></span>${R.mock ? '<span class="demo-tag" title="A scripted run: nothing here is real">Demo</span>' : ''}<span class="grow"></span><div class="acts" id="runActs"></div></div>
    <div id="goalBar"></div>
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
  const reread = () => setTimeout(() => { if (R) R.follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60; }, 60);
  for (const ev of ['wheel', 'touchmove', 'keydown', 'pointerdown']) feed.addEventListener(ev, reread, { passive: true });
  feed.addEventListener('load', () => { if (R?.follow) scrollFeed(); }, true);   // card images grow the feed as they arrive
  feed.addEventListener('scroll', () => { if (R && feed.scrollHeight - feed.scrollTop - feed.clientHeight < 30) R.follow = true; }, { passive: true });
  feed.addEventListener('click', (e) => {
    const b = e.target.closest('.more-syn');
    if (b) { b.parentElement.querySelectorAll('.syn-row[hidden]').forEach((r) => { r.hidden = false; }); b.remove(); }
  });
}

function openRun(id, opts = {}) {
  stopRun();
  R = newRun(id, opts);
  shell();
  mark('head');
  clockTimer = setInterval(() => mark('head'), 1000);
  if (!MOCK && !R.parent) findParent(id);
  loadCards().then(() => (MOCK ? playMock(opts.mockCont) : connect(id)));
}
// the run this one continued from, named from my runs (so the head can link back to it)
async function findParent(id) {
  try {
    const rows = await myRuns();
    const me = rows.find((r) => r.id === id);
    if (!me?.parent_id || R?.id !== id) return;
    R.parent = { id: me.parent_id, name: rows.find((r) => r.id === me.parent_id)?.name || null };
    R.actsSig = null; mark('head');
  } catch { /* the list isn't on this server yet */ }
}
let clockTimer = 0;
let es = null;
let mockTimer = 0;
function stopRun() {
  clearInterval(clockTimer); clearTimeout(mockTimer);
  if (es) { es.close(); es = null; }
}

// ---------- the stream ----------
// a run that has finished (or was interrupted by a server restart) is no longer streaming: say so and stop listening
function settle(status) {
  if (!R || R.status !== 'running') return;
  R.status = status === 'done' && !R.done ? 'interrupted' : status;
  clearInterval(clockTimer);
  mark('head', 'done', 'board', 'goal');
}
function connect(id) {
  // the server sends ids and `retry`; an automatic reconnect sends Last-Event-ID and gets only newer events, so the
  // page keeps its state. A fresh open (a reload of ?id=) gets every event again, plus only the latest frame.
  es = new EventSource(`/api/lab/${encodeURIComponent(id)}/events`);
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    // a reconnect that resumed from a frame's id replays the events after it: skip the ones already applied
    const seq = Number(m.lastEventId);
    if (ev.t !== 'frame' && m.lastEventId && Number.isFinite(seq)) { if (seq <= R.lastSeq) return; R.lastSeq = seq; }
    apply(ev);
    if (ev.t === 'done' || ev.t === 'error') { es?.close(); es = null; }
  };
  es.onerror = async () => {
    if (!es) return;
    if (es.readyState !== EventSource.CLOSED) {
      // the browser is retrying by itself. A stored run's stream just ends, so ask once whether it's still going.
      if (R.checking) return;
      R.checking = true;
      try {
        const j = await api(`/api/lab/${encodeURIComponent(id)}`);
        if (R?.id === id && j.status && j.status !== 'running') { es?.close(); es = null; settle(j.status); }
      } catch { /* let the browser keep trying */ } finally { if (R) R.checking = false; }
      return;
    }
    es = null;
    try {
      const j = await api(`/api/lab/${encodeURIComponent(id)}`);
      const keep = { options: j.options && Object.keys(j.options).length ? { ...R.options, ...j.options } : R.options, parent: R.parent || (typeof j.parent === 'string' && j.parent ? { id: j.parent } : j.parent || null) };
      R = newRun(id, keep); shell();
      for (const ev of j.events || []) apply(ev);
      if (j.frame) apply({ t: 'frame', view: j.frame });               // frames aren't kept in the history, only the latest
      if (j.status === 'running' && R.status === 'running') setTimeout(() => { if (R?.id === id && !es) connect(id); }, 3000);
      else if (j.status) settle(j.status);
      mark('head', 'goal');
    } catch (e) {
      R.status = 'error';
      R.error = e.status === 404 ? "This Lab run isn't around any more." : e.status === 401 ? 'Sign in to watch this run.' : e.status === 403 ? 'This run belongs to another account. Sign in as its owner to watch it.' : `Lost the connection: ${e.message}`;
      feedAdd(`<div class="ev bad"><span class="ico">⚠️</span><div class="tx">${esc(R.error)}</div></div>`);
      mark('head', 'board');
    }
  };
}

// ---------- events ----------
const kindOf = (label) => (/^s\d/.test(label) ? 'ink' : /^p\d/.test(label) ? 'pivot' : /^c\d/.test(label) ? 'combined' : /^t\d/.test(label) ? 'swap' : 'other');
function attempt(label, patch) {
  const a = R.attempts.get(label) || { label, kind: kindOf(label), round: R.round, kept: null, rate: null, base: null };
  Object.assign(a, patch);
  R.attempts.set(label, a);
  return a;
}
const VERDICT_WORD = (a) => (a.kind === 'ink' ? (a.kept ? 'Chosen' : 'Not chosen') : a.kept ? 'Kept' : a.rate == null ? 'Skipped' : 'No gain');
// a try or pivot row's progress bar, filled in place instead of adding a row of its own
const progBar = () => '<div class="bar tp" data-prog hidden><i style="width:0"></i></div><div class="sub tps" data-progtx hidden></div>';
function apply(ev) {
  if (!R || !ev || !ev.t) return;
  if (typeof ev.at === 'number') { R.lastAt = Math.max(R.lastAt, ev.at); if (R.mock || R.status === 'running') R.startClock = Math.min(R.startClock, Date.now() - ev.at); }
  for (const c of ev.cards && Array.isArray(ev.cards) && typeof ev.cards[0] === 'object' && !Array.isArray(ev.cards[0]) ? ev.cards : []) remember(c.id, c.full);
  switch (ev.t) {
    case 'phase':
      R.phase = ev;
      if (ev.round != null) R.round = ev.round;
      if (['sim', 'impact', 'try'].includes(ev.phase)) R.lastKept = null;   // a kept screen that wasn't confirmed made no version
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
    case 'inkTrial': {
      // the colour pairs tried at the start sit side by side in one box, each filling in its own rate
      R.inkTrials.push(ev);
      attempt(ev.label, { round: 0, inks: ev.inks, why: ev.why });
      let box = document.getElementById('inkTrials');
      if (!box) box = feedAdd('<div class="itbox" id="inkTrials"><div class="ith"></div><div class="itgrid"></div></div>');
      box.querySelector('.ith').textContent = `Trying ${plural(R.inkTrials.length, 'colour pair')}…`;
      const card = document.createElement('div');
      card.className = 'it ev try';
      card.id = `try-${ev.label}`;
      card.innerHTML = `<div class="it-inks">${hexes(ev.inks)}<b>${esc(inkName(ev.inks) || ev.label)}</b><span class="lbl">${esc(ev.label)}</span></div>
        <div class="it-rate" data-rate>…</div>${progBar()}${ev.why ? `<div class="sub it-why" title="${esc(ev.why)}">${esc(ev.why)}</div>` : ''}<div class="sub vwhy"></div><span class="verdict">Testing…</span>`;
      box.querySelector('.itgrid').append(card);
      if (R.follow) scrollFeed();
      break;
    }
    case 'deck': {
      const prev = R.decks.filter((d) => d.label !== ev.label).at(-1);
      const d = { ...ev };
      // the test this version came from: the kept candidate just before it, or the chosen colour trial for v1
      if (R.lastKept) { d.from = R.lastKept; R.lastKept = null; }
      R.decks = R.decks.filter((x) => x.label !== ev.label).concat(d);
      const ch = ev.changes;
      const recolour = prev && ev.inks?.length && prev.inks?.length && !sameInks(prev.inks, ev.inks);
      const many = ch && sizeOf(ch.in) > 10;
      feedAdd(`<div class="ev ${recolour ? 'newinks' : ''}"><span class="ico">🃏</span><div class="tx"><b>${esc(ev.label)}</b> · ${esc(ev.name || 'Deck')} · ${ev.size ?? sizeOf(ev.cards)} cards ${hexes(ev.inks)}${recolour ? ` <span class="tag ink">New colours: ${esc(inkName(ev.inks))}</span>` : ''}${ev.legal === false ? ' · <span class="legal no">Not legal</span>' : ''}${ch ? (many ? `<div class="sub">${sizeOf(ch.out)} cards out, ${sizeOf(ch.in)} in. See the deck for the full list.</div>` : `<div class="swaps">${swapText(ch.out, '−')}${swapText(ch.in, '+')}</div>`) : ''}</div></div>`);
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
      const w = ev.total ? Math.round((ev.done / ev.total) * 100) : 0;
      const host = document.getElementById(`try-${ev.label}`);
      if (host?.querySelector('[data-prog]')) {                   // a try, pivot or colour trial: its own row shows it
        const bar = host.querySelector('[data-prog]'), tx = host.querySelector('[data-progtx]');
        bar.hidden = false; bar.querySelector('i').style.width = `${w}%`;
        if (tx) { tx.hidden = false; tx.textContent = `${ev.done} of ${ev.total} games · ${ev.wins} won`; }
      } else {
        const key = `prog-${ev.label}`;
        let el = document.getElementById(key);
        if (!el) el = feedAdd(`<div class="ev" id="${esc(key)}"><span class="ico">⏳</span><div class="tx"></div></div>`);
        el.querySelector('.tx').innerHTML = `Testing <b>${esc(ev.label)}</b>: ${ev.done} of ${ev.total} games · ${ev.wins} won<div class="bar"><i style="width:${w}%"></i></div>`;
      }
      mark('board');
      break;
    }
    case 'result': {
      R.results.push(ev);
      document.getElementById(`prog-${ev.label}`)?.remove();
      const host = document.getElementById(`try-${ev.label}`);
      if (R.attempts.has(ev.label)) attempt(ev.label, { rate: ev.rate, lo: ev.lo, hi: ev.hi, wins: ev.wins, games: ev.games });
      if (host?.querySelector('[data-prog]')) {
        host.querySelector('[data-prog]').hidden = true;
        const tx = host.querySelector('[data-progtx]');
        if (tx) { tx.hidden = false; tx.textContent = `won ${ev.wins} of ${ev.games}`; }
        const r = host.querySelector('[data-rate]');
        if (r) r.textContent = pct(ev.rate);
      } else {
        feedAdd(`<div class="ev res"><span class="ico">📊</span><div class="tx"><b>${esc(ev.label)}</b> won <span class="rate">${pct(ev.rate)}</span> · ${ev.wins} of ${ev.games}<div class="sub">likely between ${pct(ev.lo)} and ${pct(ev.hi)}</div></div></div>`);
      }
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
      attempt(ev.label, { swap: s, why: s.why });
      feedAdd(`<div class="ev try" id="try-${esc(ev.label)}"><span class="ico">🧪</span><div class="tx"><b>${/^try/i.test(ev.label) ? esc(cap(ev.label)) : `Trying ${esc(ev.label)}`}</b>${s.kind ? ` <span class="role">${esc(s.kind)}</span>` : ''}<div class="swaps">${swapText(s.out, '−')}${swapText(s.in, '+')}</div>${s.why ? `<div class="sub">${esc(s.why)}</div>` : ''}${progBar()}<div class="sub vwhy"></div></div><span class="verdict">Testing…</span></div>`);
      break;
    }
    case 'pivot': {
      // a whole new list: other colours, another plan, or a rebuild around the cards that work
      if (ev.round != null) R.round = ev.round;
      attempt(ev.label, { round: ev.round ?? R.round, pkind: ev.kind, inks: ev.inks, why: ev.why, cards: ev.cards, changed: ev.changed });
      const prevInks = R.decks.at(-1)?.inks;
      const recolour = ev.inks?.length && prevInks?.length && !sameInks(prevInks, ev.inks);
      feedAdd(`<div class="ev try pivot" id="try-${esc(ev.label)}"><span class="ico">🔀</span><div class="tx"><b>New direction ${esc(ev.label)}</b> <span class="tag pv">${esc(PIVOT_KIND[ev.kind] || 'Pivot')}</span>
        <div class="pv-inks">${hexes(ev.inks)}<span>${esc(inkName(ev.inks))}${recolour ? ` <span class="sub" style="display:inline">instead of ${esc(inkName(prevInks))}</span>` : ''}</span>${ev.changed != null ? `<span class="sub" style="display:inline">· ${plural(ev.changed, 'card')} changed</span>` : ''}</div>
        ${ev.why ? `<div class="sub">${esc(ev.why)}</div>` : ''}${progBar()}<div class="sub vwhy"></div></div><span class="verdict">Testing…</span></div>`);
      break;
    }
    case 'verdict': {
      R.verdicts[ev.label] = ev;
      const a = attempt(ev.label, { kept: !!ev.kept, rate: ev.rate ?? R.attempts.get(ev.label)?.rate ?? null, base: ev.base, vwhy: ev.why, ...(ev.adopts ? { adopts: ev.adopts } : {}) });
      if (ev.kept && /^[cps]\d/.test(ev.label)) R.lastKept = ev.label;    // the next deck event is this one, adopted
      let el = document.getElementById(`try-${ev.label}`);
      if (!el) el = feedAdd(`<div class="ev try" id="try-${esc(ev.label)}"><span class="ico">🧪</span><div class="tx"><b>${a.kind === 'combined' ? (ev.adopts?.length ? `Smart-pilot check of ${esc(ev.adopts.join(' + '))} (${esc(ev.label)})` : `The kept changes together (${esc(ev.label)})`) : esc(ev.label)}</b><div class="sub vwhy"></div></div><span class="verdict"></span></div>`);
      el.classList.add(ev.kept ? 'kept' : 'rejected');
      el.querySelector('.verdict').textContent = VERDICT_WORD(a);
      const r = el.querySelector('[data-rate]');
      if (r && ev.rate != null) r.textContent = pct(ev.rate);
      const vw = el.querySelector('.vwhy');
      if (vw) vw.innerHTML = a.kind === 'ink' ? esc(ev.why || '') : `${ev.rate != null ? `<b>${pct(ev.rate)}</b>${ev.base != null ? ` vs ${pct(ev.base)}` : ''}. ` : ev.kept ? '' : 'Not tested. '}${esc(ev.why || '')}`;
      if (a.kind === 'ink' && ev.kept) { const h = document.querySelector('#inkTrials .ith'); if (h) h.textContent = `Tried ${plural(R.inkTrials.length, 'colour pair')}: going ${inkName(a.inks)}`; }
      if (R.follow) scrollFeed();
      mark('chart');
      break;
    }
    case 'target': {
      const first = !R.target;
      R.target = ev;
      R.options = { ...(R.options || {}), untilTarget: true, target: ev.target };
      const b = ev.best || {};
      if (first || ev.reached || b.label !== R.lastTargetLabel) {
        feedAdd(`<div class="ev goal ${ev.reached ? 'win' : ''}"><span class="ico">🎯</span><div class="tx">${ev.reached ? `<b>Goal reached:</b> ${esc(b.label)} wins ${pct(b.rate)}, the goal was ${pct(ev.target)}.` : `Goal ${pct(ev.target)} · best so far <b>${esc(b.label || '')}</b> at ${pct(b.rate)}${b.lo != null ? ` <span class="sub" style="display:inline">(likely ${pct(b.lo)}–${pct(b.hi)})</span>` : ''}. Keep going.`}</div></div>`);
      }
      R.lastTargetLabel = b.label;
      mark('goal');
      break;
    }
    case 'done':
      R.done = ev; R.status = ev.interrupted ? 'interrupted' : ev.cancelled ? 'cancelled' : 'done';   // stopped once a list existed: still saveable
      if (ev.target?.target != null) R.target = { ...(R.target || {}), ...ev.target, best: ev.target.best || R.target?.best || null };
      if (ev.best?.cards && !R.decks.some((d) => d.label === ev.best.label)) R.decks.push({ t: 'deck', label: ev.best.label, name: ev.best.name, cards: ev.best.cards, size: sizeOf(ev.best.cards) });
      for (const h of ev.history || []) if (h.label && !R.attempts.has(h.label)) attempt(h.label, { swap: h.swap, why: h.swap?.why, rate: h.rate ?? null, kept: !!h.kept, round: h.round ?? (Number(/^[tp](\d+)\./.exec(h.label)?.[1]) || 0) });
      R.view = { label: ev.best?.label || R.decks.at(-1)?.label, follow: false };
      feedAdd(`<h3 class="ph">${ev.interrupted ? 'Interrupted' : ev.cancelled ? 'Stopped' : 'Done'}</h3><div class="think">${ev.cancelled ? 'Best so far' : 'Best version'}: <b>${esc(ev.best?.label || '')}</b>${ev.best?.rate != null ? `, winning ${pct(ev.best.rate)} (${pct(ev.best.lo)}–${pct(ev.best.hi)})` : ''}. The review is at the top of the page.</div>`);
      mark('head', 'deck', 'done', 'chart', 'board', 'goal');
      clearInterval(clockTimer);
      break;
    case 'error':
      R.error = ev.msg || 'Something went wrong.'; R.status = /^cancel/i.test(R.error) ? 'cancelled' : 'error';
      feedAdd(`<div class="ev bad"><span class="ico">⚠️</span><div class="tx">${esc(R.error)}</div></div>`);
      mark('head', 'done', 'board', 'goal');
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
  st.classList.toggle('bad', ['error', 'cancelled', 'interrupted'].includes(R.status));
  const elapsed = R.status === 'running' ? Date.now() - R.startClock : R.lastAt;
  const label = R.status === 'done' ? 'Done' : R.status === 'cancelled' ? 'Stopped' : R.status === 'error' ? 'Stopped' : R.status === 'interrupted' ? 'Interrupted' : R.cancelling ? 'Stopping…' : R.phase ? `${R.phase.label || cap(R.phase.phase)}${R.phase.round ? ` · round ${R.phase.round}` : ''}` : 'Starting…';
  st.querySelector('span').textContent = `${label} · ${clock(elapsed)}`;
  const sig = `${R.status}|${R.cancelling}|${R.parent?.id || ''}`;
  if (R.actsSig === sig) return;                                 // the clock ticks every second; leave the buttons be
  R.actsSig = sig;
  $('#runSub').innerHTML = R.parent ? `Continued from <a href="${R.parent.mock ? '/lab?mock=1' : `/lab?id=${encodeURIComponent(R.parent.id)}`}" id="parentLink">${esc(R.parent.name || 'an earlier run')}${R.parent.from ? ` ${esc(R.parent.from)}` : ''}</a>` : '';
  $('#parentLink')?.addEventListener('click', (e) => {
    if (R.parent.mock || e.ctrlKey || e.metaKey) return;
    e.preventDefault(); goRun(R.parent.id);
  });
  $('#runActs').innerHTML = R.status === 'running'
    ? `<button class="btn btn-quiet btn-sm" id="cancelBtn" ${R.cancelling ? 'disabled' : ''}>${R.cancelling ? 'Stopping…' : 'Cancel'}</button>`
    : '<a class="btn btn-quiet btn-sm" href="/lab" id="againBtn">New run</a>';
  $('#cancelBtn')?.addEventListener('click', cancelRun);
  $('#againBtn')?.addEventListener('click', (e) => { e.preventDefault(); stopRun(); R = null; history.pushState(null, '', '/lab'); renderStart(); });
}
// the until-X% runs: how close the best confirmed list is to the goal
function renderGoal() {
  const el = $('#goalBar');
  if (!el) return;
  const goal = R.target?.target ?? (R.options?.untilTarget ? R.options.target : null);
  if (goal == null) { el.innerHTML = ''; return; }
  const b = R.target?.best || null;
  const reached = !!R.target?.reached;
  const g = Math.round(norm(goal) * 100);
  const w = b?.rate != null ? Math.min(100, Math.round(norm(b.rate) * 100)) : 0;
  const tail = R.status === 'running' ? (b ? 'Keeps going until it gets there, or you cancel.' : 'The first confirmed result shows up here.') : reached ? '' : 'Stopped before reaching it.';
  el.innerHTML = `<div class="goalbar ${reached ? 'reached' : ''}" role="group" aria-label="Goal">
    <div class="gb-tx"><span class="ico">🎯</span><span><b>${reached ? 'Goal reached' : `Goal: win ${g}%`}</b>${b ? ` · best so far ${esc(b.label)} at <b>${pct(b.rate)}</b>${b.lo != null ? ` <span class="note">(likely ${pct(b.lo)}–${pct(b.hi)})</span>` : ''}` : ''}${tail ? ` <span class="note">${tail}</span>` : ''}</span></div>
    <div class="gb-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${w}" aria-label="Best win rate against the goal"><i style="width:${w}%"></i><span class="gb-mark" style="left:${g}%" title="Goal ${g}%"></span></div>
  </div>`;
}
async function cancelRun() {
  if (!R || R.status !== 'running') return;
  R.cancelling = true; mark('head');
  if (R.mock) {
    clearTimeout(mockTimer);
    const d = R.decks.at(-1);
    if (d) apply({ t: 'done', cancelled: true, best: { label: d.label, name: d.name, cards: d.cards, rate: versionRate(d.label) }, start: { label: 'v1', rate: versionRate('v1') }, history: [], at: R.lastAt });
    else apply({ t: 'error', msg: 'Cancelled.', at: R.lastAt });
    return;
  }
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
  let pts = [...res.values()];
  // a long run (until X%) tests hundreds of lists: keep the versions, what was kept and the latest few readable
  if (pts.length > 40) pts = pts.filter((p, i) => versions.has(p.label) || smartOf(p.label) || R.verdicts[p.label]?.kept || i >= pts.length - 8);
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
    const kind = kindOf(p.label);
    const cls = versions.has(p.label) ? 'ver' : smart ? 'ver smart' : `try k-${kind} ${v ? (v.kept ? 'kept' : 'rejected') : ''}`;
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
    <div class="legend"><span class="v"><i></i>deck version</span><span class="s"><i></i>✓ rechecked by the smart pilot</span><span class="k"><i></i>kept</span><span class="r"><i></i>not kept</span>${pts.some((p) => /^[ps]\d/.test(p.label)) ? '<span class="p"><i></i>new colours or plan</span>' : ''}<span>bars: likely range</span></div>`;
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

// ---------- the review once a run ends: start → best, what changed, progress, keep improving, every attempt ----------
// a version's win rate: the test that made it a version (the smart pilot's confirm, or the chosen colour trial), else
// its own smart rerun, else its quick test
function versionResult(label) {
  const res = resultsByLabel();
  const d = R.decks.find((x) => x.label === label);
  return res.get(d?.from) || res.get(`${label} smart`) || res.get(label) || null;
}
function versionRate(label) {
  if (R.done?.best?.label === label && R.done.best.rate != null) return R.done.best.rate;
  if ((R.done?.start?.label || 'v1') === label && R.done?.start?.rate != null) return R.done.start.rate;
  return versionResult(label)?.rate ?? null;
}
const inksFromCards = (cards) => [...new Set((cards || []).flatMap(([id]) => meta(id).inks || []))];
const deckInks = (d) => (d?.inks?.length ? d.inks : inksFromCards(d?.cards));
function cardDiff(from, to) {
  const a = new Map((from || []).map(([id, q]) => [String(id), q])), b = new Map((to || []).map(([id, q]) => [String(id), q]));
  const add = [], cut = [];
  for (const [id, q] of b) if (q > (a.get(id) || 0)) add.push([id, q - (a.get(id) || 0)]);
  for (const [id, q] of a) if (q > (b.get(id) || 0)) cut.push([id, q - (b.get(id) || 0)]);
  const by = (x, y) => y[1] - x[1] || meta(x[0]).full.localeCompare(meta(y[0]).full);
  return { in: add.sort(by), out: cut.sort(by) };
}
function review() {
  const last = R.decks.at(-1);
  const best = R.done?.best || { label: last.label, name: last.name, cards: last.cards };
  const bestDeck = R.decks.find((d) => d.label === best.label) || { label: best.label, name: best.name, cards: best.cards, inks: best.inks };
  const first = R.decks.find((d) => d.label === (R.done?.start?.label || 'v1')) || R.decks[0];
  const startRate = R.done?.start?.rate ?? versionRate(first.label);
  const bestRate = best.rate ?? versionRate(best.label);
  const firstInks = deckInks(first), bestInks = deckInks(bestDeck);
  const diff = cardDiff(first.cards, bestDeck.cards);
  const all = [...R.attempts.values()];
  const tried = all.filter((a) => a.kind === 'swap' || a.kind === 'pivot');
  const kept = tried.filter((a) => a.kept);
  const goal = R.target?.target ?? (R.options?.untilTarget ? R.options.target : null);
  return {
    best, bestDeck, first, startRate, bestRate, firstInks, bestInks, diff, all, tried, kept, goal,
    same: best.label === first.label, recolour: !sameInks(firstInks, bestInks) && firstInks.length > 0 && bestInks.length > 0,
    stopped: R.status !== 'done' || !!R.done?.cancelled,
    delta: startRate != null && bestRate != null ? Math.round((norm(bestRate) - norm(startRate)) * 100) : null,
    pivotOn: R.options?.pivot ?? (R.inkTrials.length > 0 || all.some((a) => a.kind === 'pivot')),
    freeOn: R.options?.freeRein ?? all.some((a) => a.pkind === 'pivot-plan' || a.pkind === 'rebuild'),
  };
}
// one plain sentence or two: did it get better, how, and what to try next
function verdictLine(v) {
  const out = [];
  if (v.goal != null) out.push(R.target?.reached ? `Reached the goal of ${pct(v.goal)}.` : `Didn't reach the goal of ${pct(v.goal)}.`);
  const changed = sizeOf(v.diff.in);
  if (v.same || !changed) {
    const tip = !v.pivotOn ? 'Let it change colours and run it again.' : !v.freeOn ? 'Try free rein, so it can rebuild the plan instead of swapping a few cards.' : 'Try another seed card, or more games per test so small gains show up.';
    out.push(`Nothing beat ${v.first.label}: ${v.startRate != null ? `this idea wins about ${pct(v.startRate)} against the meta` : 'this idea struggles against the meta'}. ${tip}`);
  } else if (v.delta == null || v.delta > 0) {
    const how = v.recolour ? `after switching to ${inkName(v.bestInks)}` : changed >= 16 ? `after rebuilding the plan (${changed} cards changed)` : `with ${plural(changed, 'card')} changed`;
    out.push(v.delta == null ? `${v.best.label} beat ${v.first.label} ${how}.` : `Better by ${plural(v.delta, 'point')} ${how}.`);
  } else {
    out.push(`${v.best.label} won its head-to-head tests${v.recolour ? ` in ${inkName(v.bestInks)}` : ''}, but against the whole field it ${v.delta === 0 ? 'wins about as often as' : 'sits a little below where'} ${v.first.label}${v.delta === 0 ? '' : ' started'}. Call it a sideways step.`);
  }
  if (v.stopped) out.push(R.status === 'interrupted' ? 'The server restarted before the run finished.' : 'The run was stopped early.');
  return out.join(' ');
}
function changedHtml(v) {
  if (v.same || (!v.diff.in.length && !v.diff.out.length)) {
    // nothing to diff: show how close the best tries came instead
    const close = v.tried.filter((a) => a.rate != null).sort((a, b) => b.rate - a.rate).slice(0, 3);
    return `<p class="note">No changes: ${esc(v.first.label)} is still the best list.${close.length ? ' The closest tries:' : ''}</p>${close.length ? `<ul class="atl close">${close.map((a) => `<li class="at no k-${a.kind}"><span class="al">${esc(a.label)}</span><div class="ab">${a.kind === 'pivot' ? `<div class="pv-inks"><span class="tag pv">${esc(PIVOT_KIND[a.pkind] || 'New direction')}</span>${hexes(a.inks)}<span>${esc(inkName(a.inks))}</span></div>` : `<div class="swaps">${swapText(a.swap?.out, '−')}${swapText(a.swap?.in, '+')}</div>`}</div><div class="ar"><b>${pct(a.rate)}</b>${a.base != null ? `<span>vs ${pct(a.base)}</span>` : ''}</div></li>`).join('')}</ul>` : ''}`;
  }
  const MAXROWS = 8;
  const rows = (list, sign) => list.map(([id, n], i) => `<li class="${i >= MAXROWS ? 'more' : ''}" data-peek="${esc(id)}"><span class="q ${sign === '+' ? 'in' : 'out'}">${sign}${n}</span><img src="${IMG(id)}" alt="" loading="lazy"><span class="n">${esc(meta(id).full)}</span></li>`).join('');
  const long = v.diff.in.length > MAXROWS || v.diff.out.length > MAXROWS;
  return `${v.recolour ? `<p class="rc">${hexes(v.firstInks)}<span>${esc(inkName(v.firstInks))}</span><span class="arr">→</span>${hexes(v.bestInks)}<b>${esc(inkName(v.bestInks))}</b></p>` : ''}
    <div class="chg"><div><h4>In <span>${sizeOf(v.diff.in)}</span></h4><ul class="cl">${rows(v.diff.in, '+')}</ul></div><div><h4>Out <span>${sizeOf(v.diff.out)}</span></h4><ul class="cl">${rows(v.diff.out, '−')}</ul></div></div>
    ${long ? `<button type="button" class="linkbtn" data-more>Show all ${v.diff.in.length + v.diff.out.length} changes</button>` : ''}`;
}
// the versions' win rates as a line, with the goal when there is one
function progressSvg(v) {
  const pts = R.decks.map((d) => ({ label: d.label, rate: versionRate(d.label) })).filter((p) => p.rate != null);
  if (!pts.length) return '<p class="empty">No results to chart.</p>';
  const W = 340, H = 140, L = 30, Rr = 14, T = 12, B = 26;
  const x = (i) => (pts.length > 1 ? L + ((W - L - Rr) / (pts.length - 1)) * i : (L + W - Rr) / 2);
  const y = (p) => T + (1 - norm(p)) * (H - T - B);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((g) => `<line class="${g === 0.5 ? 'half' : 'ax'}" x1="${L}" x2="${W - Rr}" y1="${y(g)}" y2="${y(g)}"/><text x="${L - 6}" y="${y(g) + 3}" text-anchor="end">${g * 100}%</text>`).join('');
  const goal = v.goal != null ? `<line class="goal" x1="${L}" x2="${W - Rr}" y1="${y(v.goal)}" y2="${y(v.goal)}"/><text class="goalt" x="${(L + W - Rr) / 2}" y="${y(v.goal) + 12}" text-anchor="middle">goal ${pct(v.goal)}</text>` : '';
  const every = Math.max(1, Math.ceil(pts.length / 10));
  const dots = pts.map((p, i) => {
    const isBest = p.label === v.best.label;
    const show = isBest || i === 0 || i === pts.length - 1 || i % every === 0;
    return `<g class="${isBest ? 'best' : ''}"><title>${esc(p.label)}: ${pct(p.rate)}</title><circle class="pt" cx="${x(i)}" cy="${y(p.rate)}" r="${isBest ? 6 : 4}"/>${show ? `<text class="vl" x="${x(i)}" y="${H - B + 15}" text-anchor="middle">${esc(p.label)}</text>${isBest || pts.length <= 8 ? `<text class="vr" x="${x(i) + (pts.length > 1 && i === 0 ? 7 : 0)}" y="${y(p.rate) - 9}" text-anchor="${pts.length > 1 && i === 0 ? 'start' : pts.length > 1 && i === pts.length - 1 ? 'end' : 'middle'}">${pct(p.rate)}</text>` : ''}` : ''}</g>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Win rate of each version">${grid}${goal}${pts.length > 1 ? `<polyline class="line" points="${pts.map((p, i) => `${x(i)},${y(p.rate)}`).join(' ')}"/>` : ''}${dots}</svg>`;
}
function matchupsHtml(v) {
  const r = versionResult(v.best.label) || resultsByLabel().get(v.best.label);
  const opps = (r?.byOpp || []).filter((o) => o.games).map((o) => ({ ...o, p: o.wins / o.games })).sort((a, b) => b.p - a.p);
  if (!opps.length) return '';
  const row = (o) => `<div class="mu-row"><span class="nm" title="${esc(o.name)}">${esc(o.name)}</span><span class="bar"><i class="${o.p < 0.45 ? 'lo' : ''}" style="width:${Math.round(o.p * 100)}%"></i></span><span class="n">${o.wins}/${o.games}</span></div>`;
  if (opps.length <= 5) return `<h4>${esc(v.best.label)} against the meta</h4><div class="mu">${opps.map(row).join('')}</div>`;
  return `<div class="mu2"><div><h4>Best against</h4><div class="mu">${opps.slice(0, 3).map(row).join('')}</div></div><div><h4>Struggles against</h4><div class="mu">${opps.slice(-3).reverse().map(row).join('')}</div></div></div>`;
}
function improveHtml(v) {
  const c = R.cont;
  const mod = isMod();
  return `<div class="rv-card rv-improve" id="improve">
    <h3>Keep improving</h3>
    <p class="note">Start a new run from one of these versions, with more freedom if it got stuck. This run stays as it is.</p>
    <div class="imp-grid">
      <label class="field">Start from <select id="cFrom" class="field-in">${R.decks.map((d) => {
        const r = versionRate(d.label);
        return `<option value="${esc(d.label)}" ${d.label === c.from ? 'selected' : ''}>${esc(d.label)}${r != null ? ` · ${pct(r)}` : ''}${d.label === v.best.label ? ' · best' : ''}${deckInks(d).length ? ` · ${esc(inkName(deckInks(d)))}` : ''}</option>`;
      }).join('')}</select></label>
      <div class="knob"><div class="lblrow"><label class="lbl" for="cRounds">Rounds</label><output id="cRoundsOut">${c.untilTarget && mod ? '∞' : c.rounds}</output></div>
        <input type="range" id="cRounds" min="1" max="6" step="1" value="${c.rounds}" ${c.untilTarget && mod ? 'disabled' : ''}></div>
      <div class="knob"><div class="lblrow"><label class="lbl" for="cGames">Games per test</label><output id="cGamesOut">${c.games}</output></div>
        <input type="range" id="cGames" min="12" max="60" step="4" value="${c.games}"></div>
    </div>
    <div class="togs">
      ${toggle('cPivot', c.pivot, 'Change colours', 'May switch one or both inks.')}
      ${toggle('cFree', c.freeRein, 'Change anything (free rein)', 'May rebuild the plan, not only swap cards.')}
      ${mod ? goalRow('c', c.untilTarget, c.target) : ''}
    </div>
    <p class="note" id="cEstimate"></p>
    <div class="go"><button class="btn btn-gold" id="contBtn">Keep improving from ${esc(c.from)}</button><span class="msg" id="contMsg" role="status"></span></div>
  </div>`;
}
function attemptsHtml(v) {
  const all = v.all;
  if (!all.length) return '';
  const keptAll = all.filter((a) => a.kept);
  const f = R.rvFilter || (keptAll.length ? 'kept' : 'all');
  const shown = f === 'kept' ? keptAll : all;
  const groups = new Map();
  for (const a of shown) { const r = a.round || 0; (groups.get(r) || groups.set(r, []).get(r)).push(a); }
  const what = (a) => (a.kind === 'swap' ? `<div class="swaps">${swapText(a.swap?.out, '−')}${swapText(a.swap?.in, '+')}</div>`
    : a.kind === 'pivot' ? `<div class="pv-inks"><span class="tag pv">${esc(PIVOT_KIND[a.pkind] || 'New direction')}</span>${hexes(a.inks)}<span>${esc(inkName(a.inks))}${a.changed != null ? ` · ${plural(a.changed, 'card')} changed` : ''}</span></div>`
      : a.kind === 'ink' ? `<div class="pv-inks"><span class="tag">Colours</span>${hexes(a.inks)}<span>${esc(inkName(a.inks))}</span></div>`
        : a.kind === 'combined' ? `<div class="pv-inks"><span class="tag">Smart check</span><span>${a.adopts?.length ? `${esc(a.adopts.join(' + '))}${a.adopts.length > 1 ? ' together' : ''}` : 'The kept changes together'}, rechecked by the smart pilot on new games</span></div>` : '');
  const row = (a) => `<li class="at ${a.kept ? 'kept' : 'no'} k-${a.kind}" tabindex="0"><span class="al">${esc(a.label)}</span>
    <div class="ab">${what(a)}${a.why && a.kind !== 'combined' ? `<div class="aw">${esc(a.why)}</div>` : ''}${a.vwhy ? `<div class="av">${esc(a.vwhy)}</div>` : ''}</div>
    <div class="ar"><b>${a.rate != null ? pct(a.rate) : '–'}</b>${a.base != null ? `<span>vs ${pct(a.base)}</span>` : ''}<span class="ao">${VERDICT_WORD(a)}</span></div></li>`;
  return `<details class="rv-attempts" id="attempts" ${R.rvOpen ? 'open' : ''}><summary><span class="st">Everything it tried</span><span class="note">${plural(v.tried.length, 'attempt')}, ${v.kept.length} kept${R.inkTrials.length ? ` · ${plural(R.inkTrials.length, 'colour pair')}` : ''}</span></summary>
    <div class="seg sm" role="group" aria-label="Show"><button type="button" data-f="kept" aria-pressed="${f === 'kept'}">Kept (${keptAll.length})</button><button type="button" data-f="all" aria-pressed="${f === 'all'}">All (${all.length})</button></div>
    ${shown.length ? [...groups].sort((a, b) => a[0] - b[0]).map(([r, list]) => `<h4 class="atr">${r === 0 ? 'Picking colours' : `Round ${r}`}</h4><ul class="atl">${list.map(row).join('')}</ul>`).join('')
    : '<p class="note">Nothing was kept: every attempt lost to the list it was trying to improve. Show all to see what it tried.</p>'}
  </details>`;
}
function renderDone() {
  const box = $('#doneBox');
  if (!(R.done || (R.status !== 'running' && R.decks.length))) { box.innerHTML = ''; return; }
  if (!R.decks.length) { box.innerHTML = ''; return; }
  const v = review();
  R.cont ||= {
    from: v.best.label, pivot: true, freeRein: v.same || (v.delta != null && v.delta <= 0), untilTarget: false,
    target: Math.max(30, Math.min(80, v.bestRate != null ? Math.round(norm(v.bestRate) * 100) + 10 : 55)),
    rounds: 3, games: R.options?.games || 24,
  };
  const up = v.delta != null && v.delta > 0 && !v.same, down = v.delta != null && v.delta < 0;
  box.innerHTML = `<section class="review" aria-label="Review">
    <div class="rv-top">
      <div class="rv-title">
        <div class="eyebrow">${v.stopped ? 'Best so far' : 'Best version'}</div>
        <h2>${esc(v.best.name || 'Lab deck')} <span class="vtag">${esc(v.best.label)}</span></h2>
        <div class="rv-meta">${hexes(v.bestInks)}<span>${esc(inkName(v.bestInks))}</span><span>· ${plural(v.tried.length, 'attempt')}, ${v.kept.length} kept</span>${v.best.lo != null ? `<span>· likely ${pct(v.best.lo)}–${pct(v.best.hi)}</span>` : ''}</div>
      </div>
      <div class="rv-rate ${up ? 'up' : down ? 'down' : 'flat'}" aria-label="Win rate from start to best">
        <div class="rr"><span class="rl">Started</span><b>${v.startRate != null ? pct(v.startRate) : '–'}</b><span class="rl">${esc(v.first.label)}</span></div>
        <span class="rr-arr" aria-hidden="true">→</span>
        <div class="rr best"><span class="rl">${v.same ? 'Still' : 'Best'}</span><b>${v.bestRate != null ? pct(v.bestRate) : '–'}</b><span class="rl">${esc(v.best.label)}</span></div>
        ${v.same ? '' : deltaTag(v.startRate, v.bestRate).replace('class="delta', 'class="delta big')}
      </div>
    </div>
    <p class="rv-verdict">${esc(verdictLine(v))}</p>
    <div class="rv-acts"><button class="btn btn-gold" id="saveBtn" ${R.saved ? 'disabled' : ''}>${R.saved ? (R.mock ? 'Not saved (demo)' : 'Saved to your decks') : `Save ${esc(v.best.label)} to my decks`}</button><button class="btn" id="playBtn">Play it vs bot</button><a class="btn btn-quiet" href="#improve" id="toImprove">Keep improving</a><span class="saved" id="saveMsg" role="status">${R.saved ? (R.mock ? 'Demo run: nothing was saved.' : `Saved as “${esc(R.savedName || v.best.name || 'Lab deck')}”. Find it under Decks.`) : ''}</span></div>
    <div class="rv-grid">
      <div class="rv-card"><h3>${v.same ? 'What it tried' : `What changed <span class="note">${esc(v.first.label)} → ${esc(v.best.label)}</span>`}</h3>${changedHtml(v)}</div>
      <div class="rv-card"><h3>Progress</h3><div class="chart rv-chart">${progressSvg(v)}</div>${matchupsHtml(v)}</div>
    </div>
    ${improveHtml(v)}
    ${attemptsHtml(v)}
  </section>`;
  bindReview(v);
}
function bindReview(v) {
  const box = $('#doneBox');
  $('#saveBtn').onclick = () => saveBest().catch(() => {});
  $('#playBtn').onclick = async () => {
    try {
      const deckId = await saveBest();
      if (R.mock) { $('#saveMsg').textContent = 'Demo run: save a real run to play it.'; return; }
      try { localStorage.setItem(PLAY_DECK_KEY, `saved:${deckId}`); } catch { /* storage blocked */ }
      location.href = '/play';
    } catch { /* message shown */ }
  };
  $('#toImprove').onclick = (e) => { e.preventDefault(); $('#improve').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#cFrom').focus({ preventScroll: true }); };
  box.querySelector('[data-more]')?.addEventListener('click', (e) => { box.querySelector('.chg').classList.add('all'); e.target.remove(); });
  const det = $('#attempts');
  if (det) {
    det.addEventListener('toggle', () => { R.rvOpen = det.open; });
    det.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { R.rvFilter = b.dataset.f; R.rvOpen = true; renderDone(); });
    det.addEventListener('click', (e) => { const li = e.target.closest('.at'); if (li && !e.target.closest('button, a')) li.classList.toggle('open'); });
    det.addEventListener('keydown', (e) => { const li = e.target.closest('.at'); if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); li.classList.toggle('open'); } });
  }
  // keep improving: every change is remembered (and makes a silent reload wait) until the run is started
  const c = R.cont, mod = isMod();
  const est = () => { $('#cEstimate').textContent = estimateText({ ...c, untilTarget: c.untilTarget && mod, target: c.target, seedTrials: false }); };
  const touch = () => { R.contDirty = true; est(); };
  $('#cFrom').onchange = (e) => { c.from = e.target.value; $('#contBtn').textContent = `Keep improving from ${c.from}`; touch(); };
  $('#cRounds').oninput = (e) => { c.rounds = +e.target.value; $('#cRoundsOut').textContent = c.rounds; touch(); };
  $('#cGames').oninput = (e) => { c.games = +e.target.value; $('#cGamesOut').textContent = c.games; touch(); };
  $('#cPivot').onchange = (e) => { c.pivot = e.target.checked; touch(); };
  $('#cFree').onchange = (e) => { c.freeRein = e.target.checked; touch(); };
  if ($('#cGoal')) {
    $('#cGoal').onchange = (e) => {
      c.untilTarget = e.target.checked;
      $('#cTarget').disabled = !c.untilTarget; $('#cRounds').disabled = c.untilTarget;
      $('#cRoundsOut').textContent = c.untilTarget ? '∞' : c.rounds;
      touch();
    };
    $('#cTarget').oninput = (e) => { c.target = +e.target.value; $('#cTargetOut').textContent = `${c.target}%`; touch(); };
  }
  $('#contBtn').onclick = continueRun;
  est();
}
async function continueRun() {
  const c = R.cont;
  if (!c || R.contSending) return;
  const options = { pivot: c.pivot, freeRein: c.freeRein, ...(isMod() && c.untilTarget ? { untilTarget: true, target: c.target / 100 } : {}) };
  const body = { from: c.from, rounds: c.rounds, games: c.games, options };
  const parent = { id: R.id, name: R.done?.best?.name || R.decks.at(-1)?.name, from: c.from, rate: versionRate(c.from), mock: R.mock };
  const m = $('#contMsg');
  if (R.mock) {
    history.pushState(null, '', `/lab?mock=1&cont=${encodeURIComponent(c.from)}${params.has('mod') ? '&mod=1' : ''}`);
    const d = R.decks.find((x) => x.label === c.from);
    openRun('mock', { options, parent, mockCont: { ...parent, cards: d?.cards, inks: deckInks(d), freeRein: c.freeRein, untilTarget: !!options.untilTarget, target: options.target } });
    scrollTo({ top: 0 });
    return;
  }
  R.contSending = true; $('#contBtn').disabled = true; m.textContent = 'Starting…'; m.classList.remove('err');
  try {
    const j = await api(`/api/lab/${encodeURIComponent(R.id)}/continue`, { method: 'POST', body: JSON.stringify(body) });
    goRun(j.id, { options: { ...options, ...(j.options || {}), games: c.games }, parent });
    scrollTo({ top: 0 });
  } catch (e) {
    if (!R) return;
    R.contSending = false;
    $('#contBtn').disabled = false;
    m.textContent = e.status === 404 ? "Continuing a run isn't available on this server yet." : e.status === 401 ? 'Sign in again to continue.' : e.message;
    m.classList.add('err');
  }
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
function playMock(cont) {
  const speed = Math.max(0.25, Math.min(20, Number(params.get('speed')) || 1));
  const script = cont ? mockContinue(cont) : mockScript();
  let i = 0;
  const next = () => {
    if (!R || i >= script.length) return;
    const [, ev] = script[i++];
    apply(ev);
    if (i < script.length) mockTimer = setTimeout(next, script[i][0] / speed);
  };
  mockTimer = setTimeout(next, 300 / speed);
}
// the shared pieces of both scripts
function mockKit() {
  const id = (full) => idByFull(full);
  const ids = (...names) => names.map(id).filter(Boolean);
  const list = (rows) => rows.map(([q, n]) => [id(n), q]).filter(([x]) => x);
  const out = [];
  let at = 0;
  const E = (gap, e) => { at += gap; out.push([gap, { ...e, at }]); };
  const opps = ['Ruby/Amethyst Aggro', 'Sapphire/Steel Ramp', 'Amber/Emerald Songs', 'Emerald/Ruby Discard'];
  const wilson = (w, n) => { const z = 1.96, p = w / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n)); return [(c - m) / d, (c + m) / d]; };
  // w: wins against each opponent, `per` games each
  const result = (gap, label, w, per = 6) => {
    const wins = w.reduce((a, b) => a + b, 0), games = w.length * per;
    const [lo, hi] = wilson(wins, games);
    const ev = { t: 'result', label, wins, games, rate: wins / games, lo, hi, byOpp: opps.map((name, i) => ({ name, wins: w[i], games: per })) };
    E(gap, ev);
    return ev;
  };
  const progress = (label, wins, total = 24) => { for (const k of [1, 2, 3]) E(450, { t: 'progress', label, done: Math.round((total * k) / 4), total, wins: wins[k - 1] }); };
  const myPool = ids('Stitch - New Dog', 'Fru Fru - VIP Guest', 'Lilo - Making a Wish', 'Pudge - Controls the Weather', 'Monterey Jack - Hypnotized by Cheese', 'Mickey Mouse - Best in Town', 'Boo - In Disguise', 'Lilo - Patient Weaver', 'Stitch - Alien Dancer', 'Kit Cloudkicker - Unpredictable Courier', 'Stitch - Carefree Surfer', 'Sebastian - Loyal Crab');
  const oppPool = ids('Stitch - Abomination', 'Lilo - Causing an Uproar', 'Gaston - Frightful Bully', 'Ursula - Vanessa', 'Simba - Playful Pouncer', 'Angel - Siren Singer');
  const game = (label, opp, oppInks, win, seed) => {
    E(700, { t: 'gameStart', label, opp, oppInks, me: 0, seed });
    const frames = mockFrames(myPool, oppPool, win, seed);
    for (const view of frames) E(300, { t: 'frame', label, view });
    const last = frames.at(-1);
    E(500, { t: 'gameEnd', label, win, turns: last.turn, reason: 'lore', lore: [last.me.lore, last.opp.lore] });
  };
  // a list in other colours: the cards of `drop` ink go, cheap characters of `ink` come in, four of each
  const recolour = (cards, drop, ink) => {
    const keep = cards.filter(([cid]) => !(meta(cid).inks || []).includes(drop));
    const have = new Set(keep.map(([cid]) => meta(cid).full));
    const fill = [...byId.values()]
      .filter((c) => c.inks?.length === 1 && c.inks[0] === ink && /character/i.test(c.type) && c.cost >= 1 && c.cost <= 4 && !have.has(c.full) && have.add(c.full))
      .sort((a, b) => a.cost - b.cost || (b.lore || 0) - (a.lore || 0) || a.full.localeCompare(b.full));
    let n = sizeOf(keep);
    const add = [];
    for (const c of fill) { if (n >= 60) break; const q = Math.min(4, 60 - n); add.push([c.id, q]); n += q; }
    return keep.concat(add);
  };
  const diff = (a, b) => { const d = cardDiff(a, b); return { out: d.out, in: d.in }; };
  return { id, ids, list, out, E, opps, result, progress, game, recolour, diff, wilson };
}
function mockScript() {
  const { id, ids, list, out, E, opps, result, progress, game, recolour, diff } = mockKit();
  const goal = params.has('goal') ? 0.55 : null;
  const ZTH = 'Zero to Hero', PUDGE = 'Pudge - Controls the Weather';
  const v1rows = [
    [4, ZTH], [4, PUDGE], [4, 'Lilo - Making a Wish'], [4, 'Lilo - Patient Weaver'], [4, 'Stitch - Alien Dancer'], [4, 'Stitch - New Dog'],
    [4, 'Mickey Mouse - Best in Town'], [4, 'Fru Fru - VIP Guest'], [4, 'Monterey Jack - Hypnotized by Cheese'], [4, 'Boo - In Disguise'],
    [4, 'Gazelle - Pop Diva'], [4, 'Stitch - Protector of Frogs'], [4, 'Kit Cloudkicker - Unpredictable Courier'], [4, 'Lilo - Galactic Hero'],
    [2, 'Stitch - Carefree Surfer'], [2, 'Sebastian - Loyal Crab'],
  ];
  const v2rows = v1rows.map(([q, n]) => [n === 'Gazelle - Pop Diva' ? 1 : q, n]).concat([[3, 'Fire the Cannons!']]);
  const v1 = list(v1rows), v2 = list(v2rows);
  const ruby = recolour(v2, 'steel', 'ruby'), sapphire = recolour(v2, 'steel', 'sapphire');
  const deck = (label, cards, inks, changes) => ({ t: 'deck', label, name: 'AS - Zero To Hero', cards, inks, size: sizeOf(cards), legal: true, ...(changes ? { changes } : {}) });
  const swap = (o, n, why, kind) => ({ out: list(o), in: list(n), why, kind });
  const verdict = (gap, label, kept, w, base, why) => E(gap, { t: 'verdict', label, kept, rate: w == null ? null : w / 24, base: base / 24, why });

  E(0, { t: 'phase', phase: 'seed', round: 0, label: 'Reading the seed' });
  E(900, { t: 'think', text: 'Zero to Hero plays a character for free if its cost is no more than the number of characters you have in play. So the deck wants a wide board early, and lots of cheap characters to get there.', cards: ids(ZTH) });
  E(1400, { t: 'think', text: 'Pudge - Controls the Weather names Lilo, so the cheap Lilos come along with it. Lilo pulls in Stitch, and Stitch has cheap versions too.', cards: ids(PUDGE, 'Lilo - Making a Wish', 'Stitch - New Dog') });
  E(1200, { t: 'think', text: "Both seed cards are Amber. Rather than guess the second ink, I'll build a list for each likely partner and play a few games with each." });
  const trials = [
    ['s1', ['amber', 'steel'], 'Steel has cheap 1-drops, a Lilo of its own and removal for blockers.', [1, 2, 1, 1]],
    ['s2', ['amber', 'sapphire'], 'Sapphire ramps into the free 7-drops sooner.', [1, 1, 1, 0]],
    ['s3', ['amber', 'ruby'], 'Ruby is fast and can challenge through a Bodyguard.', [0, 1, 1, 1]],
    ['s4', ['amber', 'emerald'], 'Emerald has cheap evasive questers.', [1, 1, 0, 1]],
  ];
  for (const [label, inks, why] of trials) E(500, { t: 'inkTrial', label, inks, why });
  for (const [label, , , w] of trials) { progress(label, [1, 2, 4], 12); result(300, label, w, 3); }
  for (const [label, inks] of trials) E(300, { t: 'verdict', label, kept: label === 's1', rate: null, base: null, why: label === 's1' ? 'Won the most of the same 12 games: going Amber/Steel.' : `Fewer wins than Amber/Steel, so not ${inkName(inks)}.` });
  E(700, { t: 'phase', phase: 'synergy', round: 0, label: 'Finding enablers and payoffs' });
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
    ['Fire the Cannons!', 'removal', 2.9, ['deals 2 damage for 1', 'clears a blocker']],
  ].map(([n, role, score, reasons]) => ({ id: id(n), full: n, role, score, reasons })).filter((c) => c.id);
  E(1000, { t: 'synergy', cards: syn });
  E(900, { t: 'phase', phase: 'build', round: 0, label: 'Building v1' });
  E(900, deck('v1', v1, ['amber', 'steel']));

  // round 1: one swap helps, a Ruby pivot doesn't
  E(900, { t: 'phase', phase: 'sim', round: 1, label: 'Testing v1 against the meta' });
  game('v1', opps[0], ['ruby', 'amethyst'], false, 41);
  progress('v1', [2, 5, 7]);
  result(500, 'v1', [2, 3, 2, 2]);
  E(700, { t: 'phase', phase: 'impact', round: 1, label: 'What does nothing?' });
  E(900, { t: 'impact', label: 'v1', cards: [
    ['Gazelle - Pop Diva', 19, 6, 0.71, 'drawn in 19 games, played in 6: stuck in hand while the 1-drops go first'],
    ['Sebastian - Loyal Crab', 9, 5, 0.52, 'played late, rarely quests'],
    ['Stitch - Carefree Surfer', 10, 3, 0.48, 'usually inked'],
    ['Lilo - Galactic Hero', 15, 9, 0.33, ''],
  ].map(([n, drawn, played, dead, note]) => ({ id: id(n), full: n, drawn, played, dead, note })).filter((c) => c.id) });
  E(1000, { t: 'think', text: "Number 1 cut: Gazelle - Pop Diva. It's meant to sing Zero to Hero early, but by the time it lands the board is already wide enough to play things for free.", cards: ids('Gazelle - Pop Diva') });
  E(800, { t: 'phase', phase: 'try', round: 1, label: 'Trying new combos' });
  E(600, { t: 'try', label: 't1.1', swap: swap([[3, 'Gazelle - Pop Diva']], [[3, 'Fire the Cannons!']], "Cut the dead card for cheap removal: Ramp's early blockers stop the board from questing.", 'removal') });
  progress('t1.1', [3, 6, 9]);
  result(400, 't1.1', [3, 3, 3, 2]);
  verdict(500, 't1.1', true, 11, 9, 'It won 2 more of the same 24 games.');
  E(600, { t: 'try', label: 't1.2', swap: swap([[2, 'Stitch - Carefree Surfer']], [[2, 'David - Protective Snowboarder']], "Trade the 7-drop for a second Bodyguard so Aggro can't pick off the 1-drops.", 'defense') });
  progress('t1.2', [2, 4, 6]);
  result(400, 't1.2', [2, 2, 2, 2]);
  verdict(500, 't1.2', false, 8, 9, 'It won 1 fewer of the same games.');
  E(600, { t: 'pivot', label: 'p1.1', round: 1, inks: ['amber', 'ruby'], kind: 'pivot-ink', changed: sizeOf(diff(v1, ruby).in), cards: ruby, why: "Steel's cards are the ones sitting in hand, so I'm trying Amber/Ruby instead, keeping Zero to Hero, Pudge and the Lilos." });
  progress('p1.1', [2, 5, 7]);
  result(400, 'p1.1', [2, 2, 3, 2]);
  verdict(500, 'p1.1', false, 9, 9, 'It won exactly as often, so it is not worth the change.');
  E(700, { t: 'phase', phase: 'confirm', round: 1, label: 'Checking with the smart pilot' });
  progress('v1 smart', [2, 4, 6]);
  progress('c1', [3, 6, 8]);
  result(400, 'v1 smart', [2, 2, 2, 2]);
  const c1 = result(200, 'c1', [3, 3, 2, 3]);
  verdict(500, 'c1', true, 11, 8, 'With the smart pilot it won 11 of 24 against 8 for v1.');
  E(500, deck('v2', v2, ['amber', 'steel'], diff(v1, v2)));
  if (goal) E(400, { t: 'target', target: goal, best: { label: 'v2', rate: c1.rate, lo: c1.lo, hi: c1.hi }, reached: false });

  // round 2: small swaps stall, a switch to Sapphire wins
  E(900, { t: 'phase', phase: 'sim', round: 2, label: 'Testing v2 against the meta' });
  progress('v2', [3, 6, 8]);
  result(500, 'v2', [3, 3, 2, 3]);
  E(800, { t: 'phase', phase: 'try', round: 2, label: 'Trying new combos' });
  E(600, { t: 'try', label: 't2.1', swap: swap([[2, 'Sebastian - Loyal Crab']], [[2, 'Rex - Protective Dinosaur']], 'A Bodyguard for 2 protects Pudge and the Lilos while they quest.', 'defense') });
  progress('t2.1', [2, 5, 7]);
  result(400, 't2.1', [3, 2, 2, 3]);
  verdict(500, 't2.1', false, 10, 11, 'It won 1 fewer of the same games.');
  E(600, { t: 'try', label: 't2.2', swap: swap([[4, 'Lilo - Galactic Hero']], [[4, 'Rex - Protective Dinosaur']], 'More Bodyguards for the early board.', 'defense') });
  verdict(400, 't2.2', false, null, 11, "That swap would make the list illegal, so I didn't test it.");
  E(600, { t: 'pivot', label: 'p2.1', round: 2, inks: ['amber', 'sapphire'], kind: 'pivot-ink', changed: sizeOf(diff(v2, sapphire).in), cards: sapphire, why: "Amber/Steel has been stuck below half for two rounds and nothing I swap helps. Steel's cards sit in hand, so I'm trying Amber/Sapphire, keeping Zero to Hero and the 1-drops." });
  progress('p2.1', [4, 7, 11]);
  result(400, 'p2.1', [4, 3, 4, 3]);
  verdict(500, 'p2.1', true, 14, 11, 'It won 3 more of the same 24 games.');
  E(700, { t: 'phase', phase: 'confirm', round: 2, label: 'Checking with the smart pilot' });
  game('c2', opps[1], ['sapphire', 'steel'], true, 77);
  progress('v2 smart', [3, 5, 8]);
  progress('c2', [4, 7, 10]);
  result(400, 'v2 smart', [3, 2, 3, 3]);
  const c2 = result(200, 'c2', [4, 3, 4, 3]);
  verdict(500, 'c2', true, 14, 11, 'With the smart pilot it won 14 of 24 against 11 for v2.');
  E(500, deck('v3', sapphire, ['amber', 'sapphire'], diff(v2, sapphire)));
  if (goal) E(400, { t: 'target', target: goal, best: { label: 'v3', rate: c2.rate, lo: c2.lo, hi: c2.hi }, reached: true });
  E(800, { t: 'phase', phase: 'done', round: 2, label: 'Done' });
  E(400, { t: 'done', best: { label: 'v3', name: 'AS - Zero To Hero', cards: sapphire, rate: c2.rate, lo: c2.lo, hi: c2.hi }, start: { label: 'v1', rate: 9 / 24 }, history: [] });
  return out;
}
// "Keep improving" in the demo: a new run that starts from the chosen version and squeezes out a little more
function mockContinue(cont) {
  const { ids, list, out, E, opps, result, progress, game, diff } = mockKit();
  const v1 = cont.cards?.length ? cont.cards : list([[4, 'Zero to Hero'], [4, 'Pudge - Controls the Weather']]);
  const inks = cont.inks?.length ? cont.inks : ['amber', 'steel'];
  const cut = v1.filter(([cid, q]) => q >= 2 && !/^(Zero to Hero|Pudge)/.test(meta(cid).full)).at(-1) || v1.at(-1);
  const add = ids('Rex - Protective Dinosaur', 'Fire the Cannons!').find((x) => !v1.some(([cid]) => cid === x)) || v1[0][0];
  const n = Math.min(2, cut[1]);
  const v2 = v1.map(([cid, q]) => [cid, cid === cut[0] ? q - n : q]).filter(([, q]) => q > 0);
  const at = v2.find(([cid]) => cid === add);
  if (at) at[1] += n; else v2.push([add, n]);
  const free = cont.freeRein;
  const goal = cont.untilTarget ? cont.target : null;
  E(0, { t: 'phase', phase: 'seed', round: 0, label: 'Picking up where it stopped' });
  E(700, { t: 'think', text: `Continuing from ${cont.name || 'the last run'} ${cont.from}${cont.rate != null ? ` (won ${pct(cont.rate)})` : ''}. Its seed cards stay as a soft core, so they can go if something better turns up.` });
  E(700, { t: 'deck', label: 'v1', name: cont.name || 'Lab deck', cards: v1, inks, size: sizeOf(v1), legal: true });
  E(800, { t: 'phase', phase: 'sim', round: 1, label: 'Testing v1 against the meta' });
  game('v1', opps[2], ['amber', 'emerald'], true, 13);
  progress('v1', [3, 7, 10]);
  result(400, 'v1', [4, 3, 3, 3]);
  E(700, { t: 'phase', phase: 'try', round: 1, label: 'Trying new combos' });
  E(500, { t: 'try', label: 't1.1', swap: { out: [[cut[0], n]], in: [[add, n]], why: `${meta(cut[0]).full} rarely does anything; ${meta(add).full} protects the early board.`, kind: 'defense' } });
  progress('t1.1', [4, 8, 11]);
  result(400, 't1.1', [4, 4, 3, 4]);
  E(400, { t: 'verdict', label: 't1.1', kept: true, rate: 15 / 24, base: 13 / 24, why: 'It won 2 more of the same 24 games.' });
  E(500, { t: 'pivot', label: 'p1.1', round: 1, inks, kind: free ? 'pivot-plan' : 'pivot-ink', changed: 22, cards: v1, why: free ? 'Keeping the 30 cards that pull their weight and rebuilding the rest as a control deck.' : 'Trying the other colour pair the seed supports.' });
  progress('p1.1', [2, 5, 8]);
  result(400, 'p1.1', [3, 3, 2, 3]);
  E(400, { t: 'verdict', label: 'p1.1', kept: false, rate: 11 / 24, base: 13 / 24, why: 'It won 2 fewer of the same games.' });
  E(700, { t: 'phase', phase: 'confirm', round: 1, label: 'Checking with the smart pilot' });
  progress('v1 smart', [3, 6, 9]);
  progress('c1', [4, 7, 11]);
  result(400, 'v1 smart', [3, 3, 3, 4]);
  const c1 = result(200, 'c1', [4, 4, 3, 4]);
  E(400, { t: 'verdict', label: 'c1', kept: true, rate: c1.rate, base: 13 / 24, why: 'With the smart pilot it won 15 of 24 against 13 for v1.' });
  E(500, { t: 'deck', label: 'v2', name: cont.name || 'Lab deck', cards: v2, inks, size: sizeOf(v2), legal: true, changes: diff(v1, v2) });
  if (goal) E(300, { t: 'target', target: goal, best: { label: 'v2', rate: c1.rate, lo: c1.lo, hi: c1.hi }, reached: c1.rate >= goal });
  E(700, { t: 'phase', phase: 'done', round: 1, label: 'Done' });
  E(300, { t: 'done', best: { label: 'v2', name: cont.name || 'Lab deck', cards: v2, rate: c1.rate, lo: c1.lo, hi: c1.hi }, start: { label: 'v1', rate: 13 / 24 }, history: [] });
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
  if (MOCK) {
    const goal = params.has('goal');
    const from = params.get('cont');
    openRun('mock', { options: { pivot: true, freeRein: false, ...(goal ? { untilTarget: true, target: 0.55 } : {}) }, ...(from ? { parent: { mock: true, name: 'AS - Zero To Hero', from }, mockCont: { name: 'AS - Zero To Hero', from } } : {}) });
  }
  else if (id) {
    try { localStorage.setItem(LAST_KEY, id); } catch { /* storage blocked */ }
    openRun(id);
  } else renderStart();
}
addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('id');
  if (MOCK) location.reload();
  else if (id) openRun(id); else { stopRun(); R = null; renderStart(); }
});
// the silent front-end update (public/js/pwa.js) reloads the page only when this says it's safe. A run lives on the
// server and ?id= resumes it, so a reload is fine, except while someone is filling in the start form or has
// unsent choices in the "Keep improving" panel.
window.inkReloadSafe = () => {
  if ($('#signIn')?.open) return false;
  if (R) return !R.contDirty && !R.contSending;
  if (!$('.start #startBtn')) return true;                       // signed out, or still loading
  const a = document.activeElement;
  const typing = a && app.contains(a) && a.matches('input, select, textarea');
  return !(typing || F.sending || F.seed.length || F.deckId || $('#q')?.value.trim());
};
boot();
