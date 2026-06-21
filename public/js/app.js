// Glue: boot DB, render catalog, render deck, wire UI, talk to AI/auth.

import { DB, loadDB, INK_ORDER, inkSymbol, canonicalPrintings } from './db.js';
import * as Deck from './deck.js';
import * as Auth from './auth.js';
import * as AI from './ai.js';
import { compileQuery, HELP_HTML } from './search.js';

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- state ----------
const state = {
  catalog: [],          // canonical printings, used in the grid
  filtered: [],
  query: '',
  ownedOnly: false,
};

// ---------- boot ----------
boot().catch((err) => {
  console.error(err);
  $('#dbStatus').textContent = 'DB: error — ' + err.message;
});

async function boot() {
  setStatus('DB: loading SQLite…');
  await loadDB((stage, msg) => setStatus('DB: ' + msg));

  state.catalog = canonicalPrintings(DB.allCards);
  applyFilters();

  setStatus('DB: ready');
  $('#cardCount').textContent = 'Cards: ' + DB.allCards.length.toLocaleString();
  $('#setCount').textContent  = 'Sets: '  + new Set(DB.allCards.map((c) => c.setId)).size;

  wireUI();
  renderDeck();

  // restore last deck if present
  if (localStorage.getItem('ink.lastDeck')) {
    const n = localStorage.getItem('ink.lastDeck');
    if (Deck.load(n)) { $('#deckTitle').textContent = n; renderDeck(); }
  }

  // auth
  const m = await Auth.me();
  if (m.ok) {
    onSignedIn(m.displayName);
  }

  // ai
  const cfg = await AI.serverConfig();
  $('#aiProvider').textContent = cfg.provider
    ? `${cfg.provider} (${cfg.model})`
    : (AI.loadByok().key ? `${AI.loadByok().provider} (BYO key)` : 'none');

  // silly hit counter
  const hits = Number(localStorage.getItem('ink.hits') || 0) + 1;
  localStorage.setItem('ink.hits', hits);
  $('#hitCounter').textContent = String(hits).padStart(6, '0');
}

function setStatus(s) { $('#dbStatus').textContent = s; }

// ---------- filter UI (Scryfall-style query bar) ----------
function applyFilters() {
  const { predicate, errors } = compileQuery(state.query);
  $('#searchError').textContent = errors.length ? errors.join(' · ') : '';
  let arr = state.catalog.filter(predicate);
  if (state.ownedOnly) arr = arr.filter((c) => Auth.ownedQty(c.id));
  // sort: cost asc, then name
  arr.sort((a, b) => (a.cost - b.cost) || a.name.localeCompare(b.name));
  state.filtered = arr;
  renderGrid();
}

// Append a fragment to the current query bar (so chips compose).
function appendQuery(snippet) {
  const inp = $('#search');
  const cur = inp.value.trim();
  inp.value = cur ? cur + ' ' + snippet : snippet;
  state.query = inp.value;
  applyFilters();
  inp.focus();
}

// ---------- card grid ----------
function renderGrid() {
  const grid = $('#cardGrid');
  grid.innerHTML = '';
  const max = 400;
  const slice = state.filtered.slice(0, max);
  $('#resultCount').textContent = `${state.filtered.length} match${state.filtered.length === 1 ? '' : 'es'}${state.filtered.length > max ? ` (showing first ${max})` : ''}`;
  const frag = document.createDocumentFragment();
  for (const c of slice) {
    const t = document.createElement('div');
    t.className = 'card-tile';
    t.dataset.id = c.id;
    const qty = Deck.Deck.cards.get(c.id) || 0;
    const owned = Auth.Session.collection ? Auth.ownedQty(c.id) : null;
    t.innerHTML = `
      <img loading="lazy" src="${c.image}" alt="${escapeHtml(c.name)}" onerror="this.style.background='#222'">
      ${qty ? `<div class="qty-badge">×${qty}</div>` : ''}
      <div class="meta">
        <span>${c.cost}◇ ${c.inks.map(ink => `<span class="ink ink-${ink}" style="width:8px;height:8px;display:inline-block;outline:1px solid #fff;"></span>`).join('')}</span>
        <span>${owned != null ? `${owned} own` : ''}</span>
      </div>
    `;
    frag.appendChild(t);
  }
  grid.appendChild(frag);
}

// ---------- deck list ----------
function renderDeck() {
  const list = $('#deckList');
  list.innerHTML = '';
  const groups = Deck.grouped();
  const ORDER = ['character', 'action', 'song', 'item', 'location'];
  for (const type of ORDER) {
    const ents = groups[type] || [];
    if (!ents.length) continue;
    const section = document.createElement('div');
    section.className = 'deck-section';
    const total = ents.reduce((s, e) => s + e.qty, 0);
    section.innerHTML = `<h4>${type.toUpperCase()} (${total})</h4>`;
    for (const { card, qty } of ents) {
      const row = document.createElement('div');
      row.className = 'deck-row';
      row.dataset.id = card.id;
      const inkChips = card.inks.map(ink => `<span class="ink ink-${ink}"></span>`).join('');
      row.innerHTML = `
        <span class="ctrl">
          <button data-act="dec" title="−1">−</button>
        </span>
        <span class="name" title="${escapeHtml(card.name + (card.title ? ' - ' + card.title : ''))}">
          ${inkChips} ${escapeHtml(card.name)}${card.title ? ' <span class="muted">— ' + escapeHtml(card.title) + '</span>' : ''}
          <span class="muted small"> (${card.cost}◇)</span>
        </span>
        <span class="qty">×${qty} <button data-act="inc" title="+1">+</button></span>
      `;
      list.appendChild(row);
    }
  }
  if (Deck.Deck.cards.size === 0) {
    list.innerHTML = `<div class="muted small center" style="padding:20px; font-family:var(--font-ui)">Empty deck. Click a card on the left, or ask the A.I. helper.</div>`;
  }

  // summary
  const s = Deck.summary();
  $('#statCount').textContent = s.total;
  $('#statInkable').textContent = s.inkable;
  $('#statAvgCost').textContent = s.avgCost.toFixed(2);
  $('#deckInks').innerHTML = s.inks.length
    ? s.inks.map((i) => `<span class="ink ink-${i}" title="${i}"></span>`).join('')
    : '—';

  const errs = Deck.legality();
  const lab = $('#deckLegality');
  if (errs.length === 0 && s.total === 60) {
    lab.textContent = '✅ legal'; lab.style.color = 'var(--good)';
  } else {
    lab.textContent = '⚠ ' + errs[0];
    lab.style.color = 'var(--accent)';
    lab.title = errs.join('\n');
  }
}

// ---------- UI wiring ----------
function wireUI() {
  // search bar
  let qTimer = 0;
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    clearTimeout(qTimer);
    qTimer = setTimeout(applyFilters, 80);
  });
  $('#searchClearBtn').addEventListener('click', () => {
    $('#search').value = '';
    state.query = '';
    applyFilters();
    $('#search').focus();
  });
  $('#searchHelpBtn').addEventListener('click', () => {
    $('#helpBody').innerHTML = HELP_HTML;
    openModal('#helpModal');
  });
  $('#helpExampleBtn').addEventListener('click', () => {
    $('#search').value = '(c:ruby or c:amber) t:character cost<=3 i:yes';
    state.query = $('#search').value;
    applyFilters();
    closeModal('#helpModal');
  });

  // chips append into the query
  $('#searchChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    appendQuery(b.dataset.q);
  });

  $('#ownedOnly').addEventListener('change',  (e) => { state.ownedOnly = e.target.checked; applyFilters(); });

  // dreamborn sniffer modal
  $('#openSnifferBtn').addEventListener('click', async () => {
    const r = await fetch('/dreamborn-sniffer.js');
    const txt = await r.text();
    $('#snifferText').value = txt;
    openModal('#snifferModal');
  });
  $('#snifferCopyBtn').addEventListener('click', async () => {
    const ta = $('#snifferText');
    ta.select();
    try { await navigator.clipboard.writeText(ta.value); flash($('#snifferCopyBtn'), 'Copied!'); }
    catch { document.execCommand('copy'); flash($('#snifferCopyBtn'), 'Copied!'); }
  });

  // grid: left-click adds, right-click removes; hover preview
  const grid = $('#cardGrid');
  grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.card-tile'); if (!tile) return;
    Deck.bump(tile.dataset.id, +1);
    renderGrid(); renderDeck();
  });
  grid.addEventListener('contextmenu', (e) => {
    const tile = e.target.closest('.card-tile'); if (!tile) return;
    e.preventDefault();
    Deck.bump(tile.dataset.id, -1);
    renderGrid(); renderDeck();
  });
  grid.addEventListener('mousemove', (e) => {
    const tile = e.target.closest('.card-tile'); if (!tile) return previewHide();
    const id = tile.dataset.id;
    const card = state.catalog.find((c) => c.id === id);
    if (card) previewShow(card.image, e.clientX, e.clientY);
  });
  grid.addEventListener('mouseleave', previewHide);

  // deck list: +/-
  $('#deckList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const row = e.target.closest('.deck-row'); if (!row) return;
    Deck.bump(row.dataset.id, btn.dataset.act === 'inc' ? +1 : -1);
    renderGrid(); renderDeck();
  });
  $('#deckList').addEventListener('mousemove', (e) => {
    const row = e.target.closest('.deck-row'); if (!row) return previewHide();
    const card = DB.allCards.find((c) => c.id === row.dataset.id);
    if (card) previewShow(card.image, e.clientX, e.clientY);
  });
  $('#deckList').addEventListener('mouseleave', previewHide);

  // deck toolbar
  $('#newDeckBtn').addEventListener('click', () => {
    if (!confirm('Discard current deck?')) return;
    Deck.clear(); Deck.Deck.name = 'Untitled Deck';
    $('#deckTitle').textContent = Deck.Deck.name;
    renderGrid(); renderDeck();
  });
  $('#saveDeckBtn').addEventListener('click', () => {
    const name = prompt('Save deck as:', Deck.Deck.name) || Deck.Deck.name;
    Deck.save(name);
    localStorage.setItem('ink.lastDeck', name);
    $('#deckTitle').textContent = name;
    flash($('#saveDeckBtn'), 'Saved!');
  });
  $('#loadDeckBtn').addEventListener('click', () => {
    const names = Deck.listSaved();
    if (!names.length) return alert('No saved decks.');
    const picked = prompt('Load which deck?\n\n' + names.map((n, i) => `${i+1}. ${n}`).join('\n'), names[0]);
    if (!picked) return;
    const name = /^\d+$/.test(picked) ? names[Number(picked) - 1] : picked;
    if (Deck.load(name)) {
      $('#deckTitle').textContent = name;
      renderGrid(); renderDeck();
    } else alert('Not found.');
  });
  $('#exportDeckBtn').addEventListener('click', () => {
    const txt = Deck.toText();
    navigator.clipboard?.writeText(txt).catch(() => {});
    const blob = new Blob([txt], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (Deck.Deck.name || 'deck') + '.txt';
    a.click();
    flash($('#exportDeckBtn'), 'Copied!');
  });
  $('#importDeckBtn').addEventListener('click', () => openModal('#importModal'));
  $('#importSubmit').addEventListener('click', () => {
    const errs = Deck.fromText($('#importText').value);
    $('#importError').textContent = errs.length ? errs.join(' · ') : '';
    if (!errs.length) closeModal('#importModal');
    renderGrid(); renderDeck();
  });

  // sign-in
  $('#signInBtn').addEventListener('click', () => openModal('#signInModal'));
  $('#signOutBtn').addEventListener('click', async () => {
    await Auth.logout();
    onSignedOut();
  });
  $('#syncCollectionBtn').addEventListener('click', async () => {
    flash($('#syncCollectionBtn'), 'Syncing…');
    try {
      const owned = await Auth.syncCollection();
      const n = Object.keys(owned).length;
      flash($('#syncCollectionBtn'), `${n} owned`);
      renderGrid();
    } catch (e) {
      alert('Sync failed: ' + e.message);
    }
  });
  $('#signInSubmit').addEventListener('click', async () => {
    const email = $('#signInEmail').value.trim();
    const password = $('#signInPassword').value;
    $('#signInError').textContent = '';
    try {
      const r = await Auth.login(email, password);
      onSignedIn(r.displayName);
      closeModal('#signInModal');
    } catch (e) {
      $('#signInError').textContent = e.message;
    }
  });

  // modals
  document.body.addEventListener('click', (e) => {
    if (e.target.matches('[data-close-modal]')) {
      const m = e.target.closest('.modal-backdrop');
      if (m) m.classList.remove('show');
    }
  });

  // AI
  $('#aiForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#aiInput').value.trim();
    if (v) sendToAI(v);
    $('#aiInput').value = '';
  });
  $$('.ai-suggest button').forEach((b) => {
    b.addEventListener('click', () => sendToAI(b.dataset.prompt));
  });
  $('#aiSettingsLink').addEventListener('click', (e) => {
    e.preventDefault();
    const v = AI.loadByok();
    $('#aiByokProvider').value = v.provider || 'openai';
    $('#aiByokKey').value = v.key || '';
    $('#aiByokModel').value = v.model || '';
    openModal('#aiModal');
  });
  $('#aiSaveBtn').addEventListener('click', async () => {
    AI.saveByok({
      provider: $('#aiByokProvider').value,
      key: $('#aiByokKey').value.trim(),
      model: $('#aiByokModel').value.trim(),
    });
    const cfg = await AI.serverConfig();
    $('#aiProvider').textContent = cfg.provider
      ? `${cfg.provider} (${cfg.model})`
      : (AI.loadByok().key ? `${AI.loadByok().provider} (BYO key)` : 'none');
    closeModal('#aiModal');
  });

  // about link
  $('#aboutLink').addEventListener('click', (e) => {
    e.preventDefault();
    alert(
      'Ink — Lorcana deck builder\n\n' +
      '· Card data fetched from dreamborn.ink (cards.db / prices.db)\n' +
      '· Queried locally via sql.js\n' +
      '· Optional sign-in syncs your Dreamborn collection\n' +
      '· A.I. helper uses OpenAI or Anthropic\n\n' +
      'Not affiliated with Disney, Ravensburger, or Dreamborn.'
    );
  });
}

function onSignedIn(displayName) {
  $('#userCell').textContent = '👤 ' + displayName;
  $('#signInBtn').classList.add('hidden');
  $('#signOutBtn').classList.remove('hidden');
  $('#syncCollectionBtn').classList.remove('hidden');
}
function onSignedOut() {
  $('#userCell').textContent = 'Guest';
  $('#signInBtn').classList.remove('hidden');
  $('#signOutBtn').classList.add('hidden');
  $('#syncCollectionBtn').classList.add('hidden');
  Auth.Session.collection = null;
  renderGrid();
}

// ---------- AI ----------
const aiHistory = [];
async function sendToAI(text) {
  appendAI('user', text);
  aiHistory.push({ role: 'user', content: text });
  $('#aiStatus').textContent = 'A.I. thinking…';
  try {
    const reply = await AI.chat(aiHistory);
    aiHistory.push({ role: 'assistant', content: reply });
    appendAI('assistant', reply);
    $('#aiStatus').textContent = 'A.I. idle';

    // if AI proposed a decklist, offer to apply
    const list = AI.extractDecklist(reply);
    if (list && list.length) {
      const apply = confirm(`The A.I. suggested a ${list.reduce((s, e) => s + e.qty, 0)}-card decklist. Replace your current deck with it?`);
      if (apply) {
        const errs = Deck.fromText(list.map((e) => `${e.qty} ${e.rest}`).join('\n'));
        renderGrid(); renderDeck();
        if (errs.length) appendAI('system', `Couldn't match ${errs.length} line(s): ${errs.slice(0,5).join(' · ')}`);
      }
    }
  } catch (e) {
    appendAI('system', '⚠ ' + e.message);
    $('#aiStatus').textContent = 'A.I. error';
  }
}

function appendAI(role, text) {
  const log = $('#aiLog');
  const div = document.createElement('div');
  div.className = 'msg role-' + role;
  div.innerHTML = `<b>${role === 'user' ? 'You' : role === 'assistant' ? 'Inkwell' : 'System'}:</b> ${renderMarkdownLite(text)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// minimal markdown: code blocks, bold, lists, line breaks
function renderMarkdownLite(text) {
  let html = escapeHtml(text);
  html = html.replace(/```([\s\S]*?)```/g, (_, code) => `<pre style="background:#fff; padding:6px; outline:1px solid #808080; white-space:pre-wrap;">${code}</pre>`);
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

// ---------- modal helpers ----------
function openModal(sel)  { $(sel).classList.add('show'); }
function closeModal(sel) { $(sel).classList.remove('show'); }

// ---------- preview popover ----------
function previewShow(src, x, y) {
  const p = $('#preview');
  const img = p.querySelector('img');
  if (img.src !== src) img.src = src;
  p.classList.add('show');
  // Position: prefer right side, fall back to left
  const W = 268, H = 380;
  let px = x + 20, py = y - H / 2;
  if (px + W > window.innerWidth) px = x - W - 20;
  if (py < 8) py = 8;
  if (py + H > window.innerHeight) py = window.innerHeight - H - 8;
  p.style.left = px + 'px';
  p.style.top  = py + 'px';
}
function previewHide() { $('#preview').classList.remove('show'); }

// ---------- misc ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function flash(el, msg) {
  // Cancel any prior flash on this element so back-to-back calls don't fight.
  if (el.__flashTimer) {
    clearTimeout(el.__flashTimer);
    if (el.__flashOrig != null) el.textContent = el.__flashOrig;
  } else {
    el.__flashOrig = el.textContent;
  }
  el.textContent = msg;
  el.disabled = true;
  el.__flashTimer = setTimeout(() => {
    el.textContent = el.__flashOrig;
    el.disabled = false;
    el.__flashTimer = null;
    el.__flashOrig = null;
  }, 900);
}
