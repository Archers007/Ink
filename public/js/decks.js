// Deck browser: lists popular/trending decks from dreamborn.ink via our
// /api/decks proxy, opens detail, imports the decklist into the active deck.

import { DB, INK_ORDER } from './db.js';
import * as Deck from './deck.js';

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

let onImportCb = null;
let onCloseCb = null;

// ---------- modal helpers ----------
function show()  { $('#decksModal')?.classList.add('show'); }
function hide()  { $('#decksModal')?.classList.remove('show'); onCloseCb?.(); }

export function open({ onImport, onClose } = {}) {
  onImportCb = onImport || null;
  onCloseCb = onClose || null;
  show();
  fetchAndRender();
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
        <span title="Total price">${d.totalPrice ? '$' + Number(d.totalPrice).toFixed(2) : '—'}</span>
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
