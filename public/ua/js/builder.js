// Union Arena deck builder (/ua). Cards from /api/ua/cards, decks saved to /api/ua/my/decks on the same account as
// the Lorcana builder (public/js/account.js signs in; a guest's first save makes a guest account for this browser).

import * as account from '/js/account.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const COLORS = ['red', 'blue', 'green', 'yellow', 'purple'];
const PAGE = 120;
const LS = 'ink.ua.draft';

const state = { cards: [], byNo: new Map(), titles: {}, rules: null, deck: { id: null, name: '', cards: new Map(), shared: false }, shown: PAGE, colors: new Set(), dirty: false };

function notice(msg, bad = false) {
  const n = $('#notice');
  n.textContent = msg; n.hidden = !msg; n.className = `notice${bad ? ' bad' : ''}`;
}
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${path} failed (${r.status})`);
  return j;
}

// ---------- cards ----------
async function loadCards() {
  for (let tries = 0; ; tries++) {
    try {
      const j = await api('/api/ua/cards');
      state.cards = j.cards; state.titles = j.titles; state.rules = j.rules;
      for (const c of j.cards) state.byNo.set(c.no, c);
      return;
    } catch (e) {
      notice(`${e.message}`, true);
      if (tries > 40) throw e;
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}

const deckSrc = () => { for (const no of state.deck.cards.keys()) return state.byNo.get(no)?.src || no.split('-')[0]; return null; };

function filtered() {
  const src = $('#title').value;
  const q = $('#q').value.trim().toLowerCase();
  const type = $('#type').value, en = $('#energy').value, trig = $('#trig').value;
  return state.cards.filter((c) => {
    if (src && c.src !== src) return false;
    if (state.colors.size && !state.colors.has(c.color)) return false;
    if (type && c.type !== type) return false;
    if (en !== '' && (en === '6' ? (c.energy || 0) < 6 : (c.energy || 0) !== Number(en))) return false;
    if (trig === 'none' && c.trigger) return false;
    if (trig && trig !== 'none' && c.trigger?.type !== trig) return false;
    if (q) {
      const hay = `${c.name} ${c.no} ${(c.aff || []).join(' ')} ${c.effect || ''} ${c.trigger?.text || ''}`.toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  }).sort((a, b) => (a.energy || 0) - (b.energy || 0) || a.no.localeCompare(b.no, 'en', { numeric: true }));
}

function cardTile(c) {
  const n = state.deck.cards.get(c.no) || 0;
  return `<div class="ua-card" data-no="${esc(c.no)}" tabindex="0" title="${esc(c.name)} · ${esc(c.no)}">
    <img loading="lazy" src="${esc(c.img)}" alt="${esc(c.name)}" referrerpolicy="no-referrer" onerror="this.remove()">
    <div class="fallback"><b>${esc(c.name)}</b><span>${esc(c.no)}</span><span>${c.energy || 0} ${esc(c.color || '')} · AP ${c.ap ?? '-'}${c.bp ? ` · ${c.bp} BP` : ''}</span></div>
    ${n ? `<span class="qty">${n}</span>` : ''}
    <div class="addrm"><button data-rm aria-label="Remove one">−</button><button data-add aria-label="Add one">+</button></div>
  </div>`;
}
function renderGrid() {
  const list = filtered();
  const grid = $('#grid');
  grid.innerHTML = list.length ? list.slice(0, state.shown).map(cardTile).join('') : '<p class="ua-empty">No cards match.</p>';
  // the fallback text sits under the image and only shows if the image fails
  $('#more').hidden = list.length <= state.shown;
}

// ---------- deck ----------
const total = () => [...state.deck.cards.values()].reduce((a, b) => a + b, 0);
function problems() {
  const out = [];
  const t = total();
  if (t !== 50) out.push(`${t} of 50 cards.`);
  const srcs = new Set([...state.deck.cards.keys()].map((no) => state.byNo.get(no)?.src));
  if (srcs.size > 1) out.push(`One title only: this deck mixes ${[...srcs].join(', ')}.`);
  const lim = {};
  for (const [no, q] of state.deck.cards) {
    const c = state.byNo.get(no);
    if (!c) { out.push(`Unknown card ${no}.`); continue; }
    const max = /up to three copies of this card/i.test(c.effect || '') ? 3 : /any number of copies of this card/i.test(c.effect || '') ? 50 : 4;
    if (q > max) out.push(`${c.name}: ${q} copies (limit ${max}).`);
    const tt = c.trigger?.type;
    if (['special', 'color', 'final'].includes(tt)) lim[tt] = (lim[tt] || 0) + q;
  }
  for (const [k, v] of Object.entries(lim)) if (v > 4) out.push(`${v} ${k.toUpperCase()}-trigger cards (limit 4).`);
  return out;
}
function add(no, d) {
  const c = state.byNo.get(no);
  if (!c) return;
  const src = deckSrc();
  if (d > 0 && src && src !== c.src) { notice(`A deck uses one title. This deck is ${state.titles[src] || src}; start a new deck for ${state.titles[c.src] || c.src}.`, true); return; }
  const n = Math.max(0, Math.min(50, (state.deck.cards.get(no) || 0) + d));
  if (n) state.deck.cards.set(no, n); else state.deck.cards.delete(no);
  if (d > 0 && !src) { $('#title').value = c.src; }
  state.dirty = true;
  saveDraft();
  renderDeck();
  updateTile(no);
}
// just the count badge on that card's tile (re-rendering the grid would lose hover and scroll)
function updateTile(no) {
  const tile = document.querySelector(`.ua-card[data-no="${CSS.escape(no)}"]`);
  if (!tile) return;
  const n = state.deck.cards.get(no) || 0;
  let q = tile.querySelector('.qty');
  if (!n) { q?.remove(); return; }
  if (!q) { q = document.createElement('span'); q.className = 'qty'; tile.insertBefore(q, tile.querySelector('.addrm')); }
  q.textContent = n;
}
function renderDeck() {
  const t = total();
  $('#count').textContent = `${t}/50`;
  $('#count').className = `count${t === 50 && !problems().length ? ' ok' : ''}`;
  const groups = { character: [], site: [], event: [] };
  for (const [no, q] of state.deck.cards) { const c = state.byNo.get(no); if (c) (groups[c.type] || (groups[c.type] = [])).push([c, q]); }
  const label = { character: 'Characters', site: 'Sites', event: 'Events' };
  $('#list').innerHTML = Object.entries(groups).filter(([, l]) => l.length).map(([k, l]) => {
    l.sort((a, b) => (a[0].energy || 0) - (b[0].energy || 0) || a[0].name.localeCompare(b[0].name));
    return `<div class="group lbl">${label[k] || k} · ${l.reduce((n, [, q]) => n + q, 0)}</div>` + l.map(([c, q]) => `
      <div class="line" data-no="${esc(c.no)}"><span class="n">${q}</span><span class="e"><span class="dot ${esc(c.color)}"></span>${c.energy || 0}</span>
      <span class="nm" data-detail>${esc(c.name)} <span class="ua-note">${esc(c.no)}${c.trigger ? ` · ${esc(c.trigger.label)}` : ''}</span></span>
      <span class="pm"><button data-rm aria-label="Remove one">−</button> <button data-add aria-label="Add one">+</button></span></div>`).join('');
  }).join('') || '<p class="ua-note">Click cards to add them. A deck is 50 cards from one title, up to 4 of each.</p>';
  const pr = problems();
  $('#problems').className = `ua-problems${pr.length ? '' : ' ok'}`;
  $('#problems').innerHTML = pr.length ? pr.map((p) => `<li>${esc(p)}</li>`).join('') : '<li>Legal deck ✓</li>';
  const curve = Array(8).fill(0);
  for (const [no, q] of state.deck.cards) { const c = state.byNo.get(no); if (c) curve[Math.min(7, c.energy || 0)] += q; }
  const mx = Math.max(1, ...curve);
  $('#curve').innerHTML = curve.map((n, i) => `<div style="height:${(n / mx) * 100}%" title="${n} card${n === 1 ? '' : 's'} needing ${i}${i === 7 ? '+' : ''} energy"><span>${i}${i === 7 ? '+' : ''}</span></div>`).join('');
  $('#playIt').href = state.deck.id ? `/ua/play?deck=${encodeURIComponent(state.deck.id)}` : '/ua/play';
  $('#share').checked = !!state.deck.shared;
}
function saveDraft() {
  try { localStorage.setItem(LS, JSON.stringify({ id: state.deck.id, name: $('#deckName').value, cards: [...state.deck.cards], shared: state.deck.shared })); } catch { /* private mode */ }
}
function loadDeck(d) {
  state.deck = { id: d.id || null, name: d.name || '', cards: new Map(d.cards || []), shared: !!d.shared };
  $('#deckName').value = state.deck.name;
  const src = deckSrc();
  if (src) $('#title').value = src;
  state.dirty = false;
  state.shown = PAGE;
  saveDraft();
  renderDeck(); renderGrid();
}

async function save() {
  const name = $('#deckName').value.trim() || `${state.titles[deckSrc()] || 'Union Arena'} deck`;
  $('#deckName').value = name;
  try {
    const j = await api('/api/ua/my/decks', { method: 'POST', body: JSON.stringify({ id: state.deck.id, name, cards: [...state.deck.cards], shared: account.signedIn() ? $('#share').checked : undefined }) });
    state.deck.id = j.deck.id; state.deck.shared = j.deck.shared;
    state.dirty = false;
    saveDraft();
    $('#saveNote').textContent = `Saved ${new Date().toLocaleTimeString()}${account.signedIn() ? '' : ' in this browser’s guest account. Sign in to keep it on every device.'}`;
    renderDeck();
    await account.load();
    renderAccount();
  } catch (e) { notice(`Couldn’t save: ${e.message}`, true); }
}

async function showMine() {
  const box = $('#mineList');
  box.innerHTML = '<p class="ua-note">Loading…</p>';
  $('#mineModal').showModal();
  try {
    const { decks } = await api('/api/ua/my/decks');
    box.innerHTML = decks.length ? decks.map((d) => `<div class="d" data-id="${esc(d.id)}"><b>${esc(d.name)}</b><span class="ua-note">${esc(state.titles[d.src] || d.src || '')} · ${d.cards.reduce((n, [, q]) => n + q, 0)}</span>
      <button class="btn btn-sm" data-open>Open</button><a class="btn btn-quiet btn-sm" href="/ua/play?deck=${encodeURIComponent(d.id)}">Play</a><button class="btn btn-danger btn-sm" data-del>Delete</button></div>`).join('') : '<p class="ua-note">No Union Arena decks saved yet.</p>';
    box.onclick = async (e) => {
      const row = e.target.closest('.d'); if (!row) return;
      const d = decks.find((x) => x.id === row.dataset.id);
      if (e.target.matches('[data-open]')) { loadDeck(d); $('#mineModal').close(); }
      if (e.target.matches('[data-del]') && confirm(`Delete “${d.name}”?`)) { await api(`/api/ua/my/decks/${encodeURIComponent(d.id)}`, { method: 'DELETE' }); row.remove(); if (state.deck.id === d.id) state.deck.id = null; }
    };
  } catch (e) { box.innerHTML = `<p class="ua-note">${esc(e.message)}</p>`; }
}

function showDetail(no) {
  const c = state.byNo.get(no);
  if (!c) return;
  $('#detailTitle').textContent = c.name;
  const fmt = (t) => esc(t).replace(/\[([^\]]+)\]/g, '<b>[$1]</b>');
  $('#detailBody').innerHTML = `<div class="ua-detail"><img src="${esc(c.img)}" alt="" referrerpolicy="no-referrer">
    <div><dl><dt>Number</dt><dd>${esc(c.no)} · ${esc(c.rarity || '')}</dd><dt>Title</dt><dd>${esc(state.titles[c.src] || c.src)}</dd>
    <dt>Type</dt><dd>${esc(c.type)}</dd><dt>Required energy</dt><dd><span class="dot ${esc(c.color)}"></span> ${c.energy || 0} ${esc(c.color || '')}</dd>
    <dt>AP cost</dt><dd>${c.ap ?? '-'}</dd>${c.bp != null ? `<dt>BP</dt><dd>${c.bp}</dd>` : ''}${c.aff?.length ? `<dt>Affinity</dt><dd>${esc(c.aff.join(', '))}</dd>` : ''}
    <dt>Generates</dt><dd>${c.gen?.length ? c.gen.map((g) => `<span class="dot ${esc(g)}"></span>`).join(' ') : '—'}${c.genPlus ? ' +' : ''}</dd></dl>
    ${c.effect ? `<div class="txt">${fmt(c.effect)}</div>` : ''}
    ${c.trigger ? `<p class="txt"><b>Trigger · ${esc(c.trigger.label)}</b>: ${fmt(c.trigger.text)}</p>` : ''}
    <div class="row" style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-sm" data-rm>− Remove</button><button class="btn btn-gold btn-sm" data-add>+ Add</button><span class="ua-note">In deck: ${state.deck.cards.get(c.no) || 0}</span></div></div></div>`;
  $('#detailBody').onclick = (e) => {
    if (e.target.matches('[data-add]')) { add(no, 1); showDetail(no); }
    if (e.target.matches('[data-rm]')) { add(no, -1); showDetail(no); }
  };
  if (!$('#detailModal').open) $('#detailModal').showModal();
}

function parseList(text) {
  const out = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(/(?:[A-Z0-9]+\/)?([A-Z0-9]{2,4}-[A-Z0-9]+-[A-Z0-9]+)/i);
    if (!m) continue;
    const no = m[1].toUpperCase();
    const q = Number(raw.replace(m[0], ' ').match(/(\d+)/)?.[1] || 1);
    out.set(no, (out.get(no) || 0) + q);
  }
  return out;
}

// ---------- account ----------
function renderAccount() {
  const u = account.user();
  const box = $('#accountBox');
  box.innerHTML = u ? `<button class="who" id="accountBtn"><span class="avatar">${esc(u.name.slice(0, 1).toUpperCase())}</span><span>${esc(u.name)}</span></button>` : '<button class="btn btn-sm" id="accountBtn">Sign in</button>';
  $('#accountBtn').onclick = () => {
    const body = $('#accountBody');
    body.innerHTML = u ? `<p>Signed in as <b>${esc(u.name)}</b>. Your Union Arena decks are saved to this account, next to your Lorcana decks.</p><button class="btn btn-quiet btn-sm" id="out">Sign out</button>`
      : `<p class="ua-note">One Ink account for Lorcana and Union Arena.</p>${account.signInForm({ next: '/ua' })}`;
    account.bindSignInForm?.(body, () => location.reload());
    $('#out', body)?.addEventListener('click', async () => { await account.signOut(); location.reload(); });
    $('#accountModal').showModal();
  };
  $('#shareWrap').title = account.signedIn() ? 'List this deck for other Ink players' : 'Create an account to share decks';
  $('#share').disabled = !account.signedIn();
}

// ---------- wire up ----------
document.addEventListener('click', (e) => { const x = e.target.closest('[data-close]'); if (x) x.closest('dialog')?.close(); });
$('#grid').addEventListener('click', (e) => {
  const tile = e.target.closest('.ua-card'); if (!tile) return;
  if (e.target.matches('[data-add]')) add(tile.dataset.no, 1);
  else if (e.target.matches('[data-rm]')) add(tile.dataset.no, -1);
  else showDetail(tile.dataset.no);
});
$('#grid').addEventListener('contextmenu', (e) => { const tile = e.target.closest('.ua-card'); if (tile) { e.preventDefault(); add(tile.dataset.no, -1); } });
$('#list').addEventListener('click', (e) => {
  const line = e.target.closest('.line'); if (!line) return;
  if (e.target.matches('[data-add]')) add(line.dataset.no, 1);
  else if (e.target.matches('[data-rm]')) add(line.dataset.no, -1);
  else if (e.target.closest('[data-detail]')) showDetail(line.dataset.no);
});
for (const id of ['title', 'type', 'energy', 'trig']) $(`#${id}`).addEventListener('change', () => { state.shown = PAGE; renderGrid(); });
let qt = null;
$('#q').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(() => { state.shown = PAGE; renderGrid(); }, 150); });
$('#more').addEventListener('click', () => { state.shown += PAGE; renderGrid(); });
$('#save').addEventListener('click', save);
$('#mine').addEventListener('click', showMine);
$('#newDeck').addEventListener('click', () => { if (state.dirty && total() && !confirm('Start a new deck? Unsaved changes are lost.')) return; loadDeck({}); });
$('#deckName').addEventListener('input', () => { state.dirty = true; saveDraft(); });
$('#share').addEventListener('change', () => { state.deck.shared = $('#share').checked; if (state.deck.id) save(); });
$('#io').addEventListener('click', () => {
  $('#ioText').value = [...state.deck.cards].map(([no, q]) => `${q} ${no}  ${state.byNo.get(no)?.name || ''}`).join('\n');
  $('#ioModal').showModal();
});
$('#ioCopy').addEventListener('click', () => navigator.clipboard?.writeText($('#ioText').value));
$('#ioLoad').addEventListener('click', () => {
  const m = parseList($('#ioText').value);
  const unknown = [...m.keys()].filter((no) => !state.byNo.has(no));
  loadDeck({ name: $('#deckName').value, cards: [...m].filter(([no]) => state.byNo.has(no)) });
  state.deck.id = null;
  $('#ioModal').close();
  if (unknown.length) notice(`Not found: ${unknown.join(', ')}`, true);
});
window.addEventListener('beforeunload', (e) => { if (state.dirty && total()) { e.preventDefault(); e.returnValue = ''; } });

(async function init() {
  $('#colors').innerHTML = COLORS.map((c) => `<button class="chip" data-c="${c}" aria-pressed="false" title="${c}"><span class="dot ${c}"></span></button>`).join('');
  $('#colors').addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    const c = b.dataset.c;
    if (state.colors.has(c)) state.colors.delete(c); else state.colors.add(c);
    b.setAttribute('aria-pressed', state.colors.has(c));
    state.shown = PAGE; renderGrid();
  });
  account.load().then(renderAccount).catch(() => renderAccount());
  await loadCards();
  notice('');
  $('#title').innerHTML = '<option value="">All titles</option>' + Object.entries(state.titles).sort((a, b) => a[1].localeCompare(b[1])).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(LS) || 'null'); } catch { /* */ }
  const want = new URLSearchParams(location.search).get('deck');
  if (want) {
    try { const { decks } = await api('/api/ua/my/decks'); const d = decks.find((x) => x.id === want); if (d) draft = d; } catch { /* */ }
  }
  if (draft) loadDeck(draft); else { renderDeck(); renderGrid(); }
})();
