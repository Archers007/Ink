// Deck browser, two sources: decks Ink players shared (our database, /api/community/decks — the default), and
// popular/trending decks from dreamborn.ink via our /api/decks proxy. Import puts the list into the active deck.

import { DB, INK_ORDER } from './db.js';
import * as Deck from './deck.js';
import * as account from './account.js';

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  sort: 'popular',
  format: '',
  color: [],
  q: '',
  page: 1,
  loading: false,
  decks: [],
  lastError: null,
};

const comm = { q: '', color: [], loading: false, decks: [], error: null, seq: 0 };
let src = 'ink';
let onImportCb = null;
let onCloseCb = null;

// ---------- modal helpers ----------
function show()  { $('#decksModal')?.classList.add('show'); }
function hide()  { $('#decksModal')?.classList.remove('show'); onCloseCb?.(); }

export function open({ onImport, onClose } = {}) {
  onImportCb = onImport || null;
  onCloseCb = onClose || null;
  show();
  setSource(src);
}

function setSource(next) {
  src = next;
  $$('.src-tabs [data-src]').forEach((b) => b.classList.toggle('on', b.dataset.src === src));
  $('#commPane').hidden = src !== 'ink';
  $('#dbPane').hidden = src !== 'dreamborn';
  if (src === 'ink') fetchCommunity(); else fetchAndRender();
}

// ---------- Ink players' shared decks ----------
async function fetchCommunity() {
  const seq = ++comm.seq;
  comm.loading = true; comm.error = null;
  renderCommunity();
  try {
    const j = await account.communityDecks({ q: comm.q, ink: comm.color });
    if (seq !== comm.seq) return;
    comm.decks = j.decks || [];
  } catch (e) { if (seq === comm.seq) { comm.error = e.message; comm.decks = []; } }
  if (seq !== comm.seq) return;
  comm.loading = false;
  renderCommunity();
}
function renderCommunity() {
  $$('#commColorBtns .ink-btn').forEach((b) => b.classList.toggle('active', comm.color.includes(b.dataset.color)));
  const grid = $('#commResults');
  if (comm.loading && !comm.decks.length) { grid.innerHTML = '<div class="muted" style="padding:20px">Loading decks…</div>'; return; }
  if (comm.error) { grid.innerHTML = `<div class="warn" style="padding:20px">${escapeHtml(comm.error)}</div>`; return; }
  if (!comm.decks.length) { grid.innerHTML = `<div class="muted" style="padding:20px">${comm.q || comm.color.length ? 'No shared decks match.' : 'No one has shared a deck yet. Be the first: tick “Share with other players” on yours.'}</div>`; return; }
  grid.innerHTML = comm.decks.map((d) => `<div class="deck-card">
      <div class="deck-card-head"><span class="inks">${(d.inks || []).map((c) => `<span class="ink ink-${escapeAttr(c)}" title="${escapeAttr(c)}"></span>`).join('')}</span><span class="deck-name">${escapeHtml(d.name)}</span></div>
      <div class="deck-card-meta"><span class="creator">by <b>${escapeHtml(d.author || '?')}</b></span><span>${new Date(d.updated).toLocaleDateString()}</span></div>
      <div class="deck-card-stats"><span>${d.size ?? '?'} cards${d.legal ? ' · legal' : ''}</span><span class="spacer"></span><button class="deck-import-btn" data-comm="${escapeAttr(d.id)}">Import</button></div>
    </div>`).join('');
}
function importCommunity(id) {
  const d = comm.decks.find((x) => x.id === id);
  if (!d) return;
  if (Deck.totalCount() > 0 && !confirm(`Replace your current deck (${Deck.totalCount()} cards) with "${d.name}" by ${d.author}?`)) return;
  Deck.clear();
  const known = new Set(DB.allCards.map((c) => c.id));
  const errs = [];
  for (const [cid, qty] of d.cards) { if (known.has(String(cid))) Deck.setQty(String(cid), qty); else errs.push(`unknown card ${cid}`); }
  onImportCb?.({ deck: { name: d.name }, errs });
  hide();
}

// ---------- fetching ----------
async function fetchAndRender() {
  if (state.loading) return;
  state.loading = true;
  state.lastError = null;
  renderHeader();
  renderResults({ loading: true });

  try {
    const params = new URLSearchParams();
    params.set('sort', state.sort);
    if (state.format) params.set('format', state.format);
    if (state.color.length) params.set('color', state.color.join(','));
    if (state.q.trim()) params.set('q', state.q.trim());
    params.set('page', String(state.page));

    const r = await fetch('/api/decks?' + params, { credentials: 'same-origin' });
    const j = await r.json();
    if (!r.ok || !j.ok) {
      state.lastError = j.error || `HTTP ${r.status}`;
      state.decks = [];
    } else {
      state.decks = j.decks || [];
    }
  } catch (e) {
    state.lastError = e.message;
    state.decks = [];
  } finally {
    state.loading = false;
    renderHeader();
    renderResults();
  }
}

async function fetchDetail(id) {
  const r = await fetch('/api/decks/' + encodeURIComponent(id), { credentials: 'same-origin' });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.deck;
}

// ---------- rendering ----------
function renderHeader() {
  // Format select + sort buttons + color toggles + search input — set their
  // visual state to match current filters.
  $$('#deckSortBtns button').forEach((b) => {
    b.classList.toggle('active', b.dataset.sort === state.sort);
  });
  $$('#deckColorBtns .ink-btn').forEach((b) => {
    b.classList.toggle('active', state.color.includes(b.dataset.color));
  });
  $('#deckFormatSel').value = state.format;
  $('#deckSearch').value = state.q;
  $('#deckPageInfo').textContent = state.loading ? 'Loading…' : `Page ${state.page}`;
}

function renderResults({ loading } = {}) {
  const grid = $('#deckResults');
  if (loading) {
    grid.innerHTML = '<div class="muted" style="padding:20px; font-family:var(--font-ui);">Fetching decks…</div>';
    return;
  }
  if (state.lastError) {
    grid.innerHTML = `<div class="warn" style="padding:20px; font-family:var(--font-ui);">⚠ ${escapeHtml(state.lastError)}</div>`;
    return;
  }
  if (!state.decks.length) {
    grid.innerHTML = '<div class="muted" style="padding:20px; font-family:var(--font-ui);">No decks found. Try fewer filters, or page 2+ (requires sign-in).</div>';
    return;
  }
  grid.innerHTML = '';
  for (const d of state.decks) {
    const card = document.createElement('div');
    card.className = 'deck-card bevel-out';
    card.dataset.id = d.id;
    const colors = (d.colors || []).map((c) => `<span class="ink ink-${escapeAttr(c.toLowerCase())}" title="${escapeAttr(c)}"></span>`).join('');
    const formats = (d.formats || []).map((f) => `<span class="format-pill">${formatName(f)}</span>`).join(' ');
    card.innerHTML = `
      <div class="deck-card-head">
        <span class="inks">${colors}</span>
        <span class="deck-name">${escapeHtml(d.name || '(untitled)')}</span>
      </div>
      <div class="deck-card-meta">
        <span class="creator">by <b>${escapeHtml(d.creatorName || '?')}</b></span>
        ${formats ? `<span class="formats">${formats}</span>` : ''}
      </div>
      <div class="deck-card-stats">
        <span title="Likes">❤ ${d.likeCount ?? 0}</span>
        <span title="Views">👁 ${d.views ?? 0}</span>
        <span class="spacer"></span>
        <button class="deck-import-btn" data-id="${escapeAttr(d.id)}">Import</button>
        <a href="https://dreamborn.ink/decks/${encodeURIComponent(d.id)}" target="_blank" rel="noopener" title="Open on dreamborn.ink">↗</a>
      </div>
    `;
    grid.appendChild(card);
  }
}

function formatName(f) {
  if (f === 1 || f === '1') return 'Infinity';
  if (f === 2 || f === '2') return 'Core';
  return String(f);
}

// ---------- import ----------
async function doImport(id) {
  const btn = $(`.deck-import-btn[data-id="${cssEscape(id)}"]`);
  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  try {
    const deck = await fetchDetail(id);
    const decklist = (deck.cards || []).map((c) => `${c.qty} ${c.name}${c.title ? ' - ' + c.title : ''}`).join('\n');
    if (!decklist) throw new Error('deck has no cards');

    // Confirm overwrite if current deck has content
    if (Deck.totalCount() > 0) {
      const ok = confirm(`Replace your current deck (${Deck.totalCount()} cards) with "${deck.name}" by ${deck.creatorName}? (${deck.size} cards, ${deck.cards.length} unique)`);
      if (!ok) return;
    }

    Deck.clear();
    const errs = Deck.fromText(decklist);

    // Pass to host so it can re-render the deck panel + set title.
    onImportCb?.({ deck, errs });

    // close after import
    hide();

    if (errs.length) {
      console.warn('[deck import] unmapped cards:', errs);
      // Fire-and-forget warning via flash if available
      try { window.dispatchEvent(new CustomEvent('ink.flash', { detail: { msg: `Imported "${deck.name}" — ${errs.length} cards couldn't be matched (see console)` } })); } catch {}
    }
  } catch (e) {
    alert('Import failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

// ---------- wiring ----------
export function wire() {
  $$('.src-tabs [data-src]').forEach((b) => b.addEventListener('click', () => setSource(b.dataset.src)));
  let ct = null;
  $('#commSearch')?.addEventListener('input', (e) => { clearTimeout(ct); ct = setTimeout(() => { comm.q = e.target.value; fetchCommunity(); }, 250); });
  $$('#commColorBtns .ink-btn').forEach((b) => b.addEventListener('click', () => {
    const c = b.dataset.color;
    comm.color = comm.color.includes(c) ? comm.color.filter((x) => x !== c) : [...comm.color, c];
    fetchCommunity();
  }));
  $('#commResults')?.addEventListener('click', (e) => { const b = e.target.closest('[data-comm]'); if (b) importCommunity(b.dataset.comm); });
  // Sort buttons
  $$('#deckSortBtns button').forEach((b) => {
    b.addEventListener('click', () => { state.sort = b.dataset.sort; state.page = 1; fetchAndRender(); });
  });
  // Color toggles
  $$('#deckColorBtns .ink-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const c = b.dataset.color;
      if (state.color.includes(c)) state.color = state.color.filter((x) => x !== c);
      else state.color = [...state.color, c];
      state.page = 1;
      fetchAndRender();
    });
  });
  // Format select
  $('#deckFormatSel')?.addEventListener('change', (e) => { state.format = e.target.value; state.page = 1; fetchAndRender(); });
  // Search
  let st = null;
  $('#deckSearch')?.addEventListener('input', (e) => {
    clearTimeout(st);
    st = setTimeout(() => { state.q = e.target.value; state.page = 1; fetchAndRender(); }, 250);
  });
  // Pagination
  $('#deckPagePrevBtn')?.addEventListener('click', () => { if (state.page > 1) { state.page--; fetchAndRender(); } });
  $('#deckPageNextBtn')?.addEventListener('click', () => { state.page++; fetchAndRender(); });
  // Result delegate (Import)
  $('#deckResults')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.deck-import-btn');
    if (btn) { doImport(btn.dataset.id); return; }
  });
  // Close
  $('#decksModal')?.addEventListener('click', (e) => {
    if (e.target.dataset.closeModal !== undefined) hide();
    if (e.target === e.currentTarget) hide();
  });
}

// ---------- utils ----------
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }
function cssEscape(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '\\$&'); }
