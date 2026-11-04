// Glue: boot DB, render catalog, render deck, wire UI, talk to auth.

import { DB, loadDB, INK_ORDER, canonicalPrintings } from './db.js';
import * as Deck from './deck.js';
import * as Auth from './auth.js';
import { compileQuery, HELP_HTML } from './search.js';
import * as Decks from './decks.js';
import * as account from './account.js';
import * as Sim from './simui.js';

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const IMG = (id) => `https://cdn.dreamborn.ink/images/en/cards/${id}`;

// ---------- state ----------
const state = {
  catalog: [],          // canonical printings, used in the grid
  filtered: [],
  query: '',
  ownedOnly: false,
  role: null,           // role chip filter: 'removal' · 'draw' · … · 'class:pirate'
};
let byId = new Map();   // every printing by id
const cardById = (id) => byId.get(String(id)) || null;

// ---------- boot ----------
boot().catch((err) => {
  console.error(err);
  $('#dbStatus').textContent = 'DB: error — ' + err.message;
});

async function boot() {
  setStatus('Loading cards…');
  const acct = account.load();
  await loadDB((stage, msg) => setStatus(msg));

  byId = new Map(DB.allCards.map((c) => [c.id, c]));
  state.catalog = canonicalPrintings(DB.allCards);
  applyFilters();

  setStatus('');
  $('#resultCount').title = `${state.catalog.length.toLocaleString()} cards in ${new Set(DB.allCards.map((c) => c.setId)).size} sets`;

  wireUI();
  renderDeck();
  markClean();
  renderChips();

  loadRoles();

  const { migrated, signin } = await acct;
  if (signin === 'failed') showNotice("Sign-in didn't go through. Try again, or keep building as a guest.", true);
  else if (migrated) showNotice(`Moved ${migrated} deck${migrated === 1 ? '' : 's'} saved in this browser to ${account.signedIn() ? 'your account' : 'your guest account on the Ink server'}.`);
  renderAccount();
  account.onChange(() => { renderAccount(); refreshDeckMeta(); });

  // reopen the last deck
  const last = localStorage.getItem('ink.lastDeck');
  if (last) {
    const d = await account.getDeck(last).catch(() => null);
    if (d && !isDirty()) openDeck(d);
  }
  await refreshDeckMeta();

  // /?adminDeck=<id> (the admin page's "Open copy in builder"): an unsaved copy of a player's deck. The server only
  // answers admins; saving it puts the copy in the admin's own account and never touches the owner's deck.
  const adminDeck = new URLSearchParams(location.search).get('adminDeck');
  if (adminDeck) {
    history.replaceState(null, '', location.pathname + location.hash);
    try {
      const r = await fetch('/api/admin/decks/' + encodeURIComponent(adminDeck), { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `couldn't open that deck (${r.status})`);
      startDeck({ name: `${j.deck.name} (${j.deck.author || 'player'})`.slice(0, 60), cards: j.deck.cards });
      showNotice(`Viewing a copy of ${j.deck.author || 'a player'}'s deck "${j.deck.name}". Saving keeps the copy in your account; theirs isn't changed.`);
    } catch (e) { showNotice(e.message, true); }
  }

  // /#browse (the "Browse decks" link on other pages) opens the deck browser
  if (location.hash === '#browse') { history.replaceState(null, '', location.pathname + location.search); $('#openDecksBtn').click(); }

  // Dreamborn collection link (separate from the Ink account)
  const m = await Auth.me().catch(() => ({}));
  if (m.ok) onSignedIn(m.displayName);
}

function showNotice(text, bad = false) {
  const el = $('#notice');
  el.className = `notice strip ${bad ? 'bad' : ''}`;
  el.innerHTML = `<span class="txt">${escapeHtml(text)}</span><button aria-label="Dismiss">✕</button>`;
  el.hidden = false;
  el.querySelector('button').onclick = () => { el.hidden = true; };
}

function setStatus(s) { $('#dbStatus').textContent = s; }

// ---------- account + saved decks ----------
function avatarHtml(u, cls = 'avatar') {
  return u.avatar ? `<img class="${cls}" src="${escapeHtml(u.avatar)}" alt="">` : `<span class="${cls}">${escapeHtml(u.name.slice(0, 1).toUpperCase())}</span>`;
}
function renderAccount() {
  const u = account.user();
  const box = $('#accountBox');
  box.innerHTML = u
    ? `<button class="who" id="accountBtn" title="Your account">${avatarHtml(u)}<span>${escapeHtml(u.name)}</span></button>`
    : `<button class="btn btn-sm" id="accountBtn">Sign in</button>`;
  $('#accountBtn').onclick = () => { renderAccountModal(); openModal('#accountModal'); $('#accountModal input, #accountModal .btn')?.focus(); };
  $('#saveNote').textContent = '';
}
function renderAccountModal() {
  const u = account.user();
  const body = $('#accountBody');
  const db = Auth.Session.displayName;
  const owned = Auth.Session.collection ? Object.keys(Auth.Session.collection).length : 0;
  body.innerHTML = `
    ${u ? `<div class="acct-row">${avatarHtml(u, 'avatar lg')}<div><b>${escapeHtml(u.name)}</b><span class="note">${u.email ? `Signed in as ${escapeHtml(u.email)}` : `Signed in with ${u.providers.map((p) => p[0].toUpperCase() + p.slice(1)).join(' + ')}`}. Your decks are saved to this account.</span></div>${u.role === 'admin' || u.role === 'moderator' ? '<a class="btn btn-sm" href="/admin">Admin</a>' : ''}<button class="btn btn-quiet btn-sm" id="acctSignOut">Sign out</button></div>`
      : `<p class="note">Sign in so your decks follow you between phone and desktop. Decks you've saved in this browser move into your account.</p>${account.signInForm({ next: '/' })}`}
    <div class="acct-row"><div><b>Dreamborn collection</b><span class="note">${db ? `Linked as ${escapeHtml(db)}${owned ? ` · ${owned.toLocaleString()} owned printings synced` : ' · not synced yet'}` : 'Link your dreamborn.ink account to filter the pool to cards you own.'}</span></div>
      ${db ? `<button class="btn btn-sm" id="acctSync">Sync</button><button class="btn btn-quiet btn-sm" id="acctUnlink">Unlink</button>` : `<button class="btn btn-sm" id="acctLink">Link</button>`}</div>`;
  account.bindSignInForm(body, () => location.reload());
  $('#acctSignOut')?.addEventListener('click', async () => {
    if (!(await confirmLeave('sign out'))) return;
    await account.signOut(); closeModal('#accountModal'); newDeck();
  });
  $('#acctLink')?.addEventListener('click', () => { closeModal('#accountModal'); openModal('#signInModal'); });
  $('#acctSync')?.addEventListener('click', () => $('#syncCollectionBtn').click());
  $('#acctUnlink')?.addEventListener('click', () => $('#signOutBtn').click());
}

// The bits of the deck panel that depend on the saved decks: My decks count, Delete, Share.
async function refreshDeckMeta() {
  let decks = [];
  try { decks = await account.listDecks(); } catch (e) { showNotice(`Couldn't load your decks: ${e.message}`, true); }
  $('#myDecksBtn').textContent = decks.length ? `My decks · ${decks.length}` : 'My decks';
  $('#deleteDeckBtn').hidden = !Deck.Deck.id;
  const share = $('#shareDeck');
  share.disabled = !account.signedIn();
  share.checked = !!Deck.Deck.shared && account.signedIn();
  $('#shareWrap').title = account.signedIn() ? 'List this deck under Browse decks → Ink players' : 'Create an account to share decks';
}
function setDeckName(n) { Deck.Deck.name = n; $('#deckTitle').value = n; }
const deckName = () => ($('#deckTitle').value || '').trim() || 'Untitled deck';

// ---------- unsaved changes (#36) ----------
// The deck as last opened or saved: name, cards and cover. Comparing against it (rather than setting a flag in each
// edit path) catches every way the deck can change — pool clicks, the list's − / +, keys, auto-fix, renaming,
// the cover star — and taking an edit back makes the deck clean again.
let cleanSnap = '';
function snapshot() {
  return JSON.stringify([deckName(), [...Deck.Deck.cards.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)), Deck.Deck.cover || null]);
}
function markClean() { cleanSnap = snapshot(); updateDirty(); }
// an empty deck that was never saved has nothing to lose
function isDirty() { return (!!Deck.Deck.id || Deck.Deck.cards.size > 0) && snapshot() !== cleanSnap; }
function updateDirty() { $('#dirtyMark').hidden = !isDirty(); }

// Before anything replaces the open deck: Save, Discard or Cancel. Resolves true when it's fine to go on.
async function confirmLeave(doing) {
  if (!isDirty()) return true;
  const dlg = $('#leaveModal');
  $('#leaveText').textContent = `“${deckName()}” has changes you haven't saved. Save them before you ${doing}?`;
  dlg.returnValue = '';
  openModal(dlg);
  const choice = await new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue), { once: true }));
  if (choice === 'discard') return true;
  if (choice !== 'save') return false;
  try { await saveCurrent(); flash($('#saveDeckBtn'), 'Saved'); return true; }
  catch (e) { alert("Can't save: " + e.message); return false; }
}
window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

let sugDismissed = null;   // the role nudge the player waved away, for this deck
function openDeck(d) {
  Deck.clear();
  for (const [id, q] of d.cards) Deck.setQty(String(id), q);
  Deck.Deck.id = d.id;
  Deck.Deck.shared = !!d.shared;
  Deck.Deck.cover = d.cover || null;
  setDeckName(d.name);
  localStorage.setItem('ink.lastDeck', d.id);
  sugDismissed = null;
  syncTiles(); renderDeck(); markClean(); refreshDeckMeta();
}
// A deck that isn't saved yet: a blank one, an import, or a copy of someone's shared deck.
function startDeck({ name = 'Untitled deck', cards = [] } = {}) {
  Deck.clear(); Deck.Deck.id = null; Deck.Deck.shared = false; Deck.Deck.cover = null;
  setDeckName(name);
  localStorage.removeItem('ink.lastDeck');
  sugDismissed = null;
  markClean();                                   // against an empty deck, so imported cards count as unsaved
  for (const [id, q] of cards) Deck.setQty(String(id), q);
  syncTiles(); renderDeck(); refreshDeckMeta();
}
function newDeck() { startDeck(); }
async function saveCurrent() {
  if (!Deck.Deck.cards.size) throw new Error('add some cards first');
  const name = deckName();
  setDeckName(name);
  const d = await account.saveDeck({ id: Deck.Deck.id, name, cards: [...Deck.Deck.cards.entries()], shared: account.signedIn() ? $('#shareDeck').checked : undefined, cover: Deck.Deck.cover });
  Deck.Deck.id = d.id;
  Deck.Deck.shared = d.shared;
  Deck.Deck.cover = d.cover || null;
  localStorage.setItem('ink.lastDeck', d.id);
  $('#saveNote').textContent = account.signedIn() ? '' : 'Saved as a guest on this device. Create an account to keep it on every device and share it.';
  markClean();
  await refreshDeckMeta();
  return d;
}

// ---------- My decks: the visual picker (#32) ----------
const picker = { decks: [], info: {} };     // info: id → deck-check summary { key, size, inks, legal, problems, cover }
const infoKey = (d) => `${d.updated}|${d.cover || ''}|${d.cards.length}`;
async function openPicker() {
  $('#pickerSearch').value = '';
  $('#pickerWhere').textContent = account.signedIn() ? '' : 'Guest decks are kept on Ink for this device. Sign in to have them everywhere.';
  openModal('#pickerModal');
  renderPicker();
  try { picker.decks = await account.listDecks({ fresh: true }); } catch (e) { $('#pickerGrid').innerHTML = `<p class="warn empty">Couldn't load your decks: ${escapeHtml(e.message)}</p>`; return; }
  renderPicker();
  const need = picker.decks.filter((d) => picker.info[d.id]?.key !== infoKey(d));
  if (!need.length) return;
  try {
    const r = await fetch('/api/play/deck-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decks: need.map(({ id, cards, cover }) => ({ id, cards, cover })) }) });
    if (!r.ok) return;
    const j = await r.json();
    for (const d of need) if (j[d.id]) picker.info[d.id] = { ...j[d.id], key: infoKey(d) };
    if ($('#pickerModal').open) renderPicker();
  } catch { /* the tiles show without cover art and legality */ }
}
function renderPicker() {
  const q = $('#pickerSearch').value.trim().toLowerCase();
  const list = picker.decks.filter((d) => !q || d.name.toLowerCase().includes(q)).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const add = q ? '' : `<button class="dtile add" data-deck="+new"><span class="plus">+</span><span class="dt-sub">New deck</span></button>`;
  const none = !picker.decks.length ? '<p class="note empty">No saved decks yet. Build one and press Save, or import a list from the ⋯ menu.</p>'
    : !list.length ? `<p class="note empty">No deck called “${escapeHtml(q)}”.</p>` : '';
  $('#pickerGrid').innerHTML = add + list.map(pickerTile).join('') + none;
}
function pickerTile(d) {
  const info = picker.info[d.id];
  const on = d.id === Deck.Deck.id;
  const size = info?.size ?? d.cards.reduce((n, [, q]) => n + q, 0);
  const status = !info ? `<span class="dt-sub">${size} cards</span>`
    : info.legal ? `<span class="dt-sub">${size} cards · legal</span>`
    : `<span class="dt-sub bad" title="${escapeHtml(info.problems.join('\n'))}">${size} cards · ${size < 60 ? `needs ${60 - size}` : 'not legal'}</span>`;
  return `<button class="dtile ${on ? 'on' : ''}" data-deck="${escapeHtml(d.id)}" ${on ? 'aria-current="true"' : ''}>
    <span class="dt-art">${info?.cover != null ? `<img src="${IMG(info.cover)}" alt="" loading="lazy">` : ''}</span>
    <span class="dt-meta"><b title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</b>
      <span class="dt-inks">${(info?.inks || []).map((x) => `<i class="hexi ${x}" title="${x}"></i>`).join('')}${on ? `<span class="dt-tag">${isDirty() ? 'Open · unsaved' : 'Open'}</span>` : ''}</span>
      ${status}<span class="dt-sub">Edited ${escapeHtml(ago(d.updated))}</span></span>
  </button>`;
}
function ago(ts) {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 60) return 'just now';
  if (s < 3600) return rtf.format(-Math.floor(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), 'hour');
  if (s < 7 * 86400) return rtf.format(-Math.floor(s / 86400), 'day');
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: s > 300 * 86400 ? 'numeric' : undefined });
}
async function pickDeck(id) {
  if (id === '+new') {
    if (!(await confirmLeave('start a new deck'))) return;
    closeModal('#pickerModal'); newDeck(); $('#deckTitle').select();
    return;
  }
  if (id === Deck.Deck.id) { closeModal('#pickerModal'); return; }
  const d = picker.decks.find((x) => x.id === id);
  if (!d || !(await confirmLeave(`open “${d.name}”`))) return;
  closeModal('#pickerModal');
  openDeck(d);
}

// ---------- filter UI (Scryfall-style query bar) ----------
function applyFilters() {
  const { predicate, errors } = compileQuery(state.query);
  $('#searchError').textContent = errors.length ? errors.join(' · ') : '';
  let arr = state.catalog.filter(predicate);
  if (state.ownedOnly) arr = arr.filter((c) => Auth.ownedQty(c.id));
  if (state.role) arr = arr.filter(roleMatch(state.role));
  // sort: cost asc, then name
  arr.sort((a, b) => (a.cost - b.cost) || a.name.localeCompare(b.name));
  state.filtered = arr;
  renderGrid();
}

// Canonical setter: bar value + state + filters + builder + chips, all in sync.
function setQuery(text) {
  $('#search').value = text;
  state.query = text;
  applyFilters();
  syncBuilderFromQuery();
  renderChips();
}

// ---- top-level tokenizer (respects parens + quotes, ignores depth>0 spaces)
function splitTopLevel(text) {
  const out = [];
  const s = text || '';
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let depth = 0, inQuote = false, start = i;
    while (i < s.length) {
      const c = s[i];
      if (inQuote) { if (c === '"' && s[i - 1] !== '\\') inQuote = false; i++; continue; }
      if (c === '"') { inQuote = true; i++; continue; }
      if (c === '(') { depth++; i++; continue; }
      if (c === ')') { depth = Math.max(0, depth - 1); i++; continue; }
      if (depth === 0 && /\s/.test(c)) break;
      i++;
    }
    out.push(s.slice(start, i));
  }
  return out;
}

// Remove ONE occurrence of a token from the current query.
function removeToken(tok) {
  const toks = splitTopLevel(state.query);
  const idx = toks.indexOf(tok);
  if (idx >= 0) toks.splice(idx, 1);
  setQuery(toks.join(' '));
}

// ---------- friendly chip labels ----------
// the search bar's colour aliases (search.js), so a chip names the colour whichever way it was typed
const INK_ALIAS = {
  a: 'amber', am: 'amber', m: 'amethyst', purple: 'amethyst', p: 'amethyst', e: 'emerald', g: 'emerald', green: 'emerald',
  r: 'ruby', red: 'ruby', s: 'sapphire', b: 'sapphire', blue: 'sapphire', t: 'steel', gray: 'steel', grey: 'steel',
};
const FIELD_LABEL = {
  c: 'Color', color: 'Color', ink: 'Color', id: 'Colors', identity: 'Colors',
  t: 'Type', type: 'Type',
  n: 'Name', name: 'Name',
  tt: 'Subtitle', title: 'Subtitle',
  o: 'Text', oracle: 'Text', text: 'Text',
  kw: 'Keyword', keyword: 'Keyword',
  p: 'Property', prop: 'Property', char: 'Property',
  f: 'Franchise', franchise: 'Franchise',
  r: 'Rarity', rarity: 'Rarity',
  set: 'Set', s: 'Set',
  i: 'Inkable', inkable: 'Inkable',
  illu: 'Illustrator', illus: 'Illustrator', illustrator: 'Illustrator', artist: 'Illustrator',
  cost: 'Cost',
  str: 'Strength', a: 'Strength', attack: 'Strength', strength: 'Strength',
  wp: 'Willpower', w: 'Willpower', def: 'Willpower', willpower: 'Willpower',
  lore: 'Lore', l: 'Lore',
  mv: 'Move', move: 'Move', movement: 'Move',
};

function friendlyChip(raw) {
  // negation
  let neg = false;
  let t = raw;
  if (t.startsWith('-') && t.length > 1) { neg = true; t = t.slice(1); }
  // boolean grouping or stand-alone bare word
  if (t.includes('(') || /^or$/i.test(t) || /^and$/i.test(t)) {
    return { html: `<span class="label-text">${escapeHtml(raw)}</span>`, negated: neg };
  }
  const m = t.match(/^([a-z]+)([:=]|>=|<=|>|<|!=|!)(.+)$/i);
  if (!m) {
    // bare-word search → defaults to card name / subtitle (see search.js #4)
    return { html: `<span class="label-text">Name: <i>${escapeHtml(t.replace(/^"|"$/g, ''))}</i></span>`, negated: neg };
  }
  const key = m[1].toLowerCase();
  const op  = m[2];
  const val = m[3].replace(/^"|"$/g, '');
  const negated = neg || op === '!';
  const fieldLabel = FIELD_LABEL[key] || key;

  // colours: theme swatches and names, never the raw syntax (#45)
  if (['c', 'color', 'ink', 'id', 'identity'].includes(key)) {
    const lc = val.toLowerCase();
    if (['multi', 'm', '2+'].includes(lc) && !key.startsWith('i')) return { html: '<span class="label-text">Two inks</span>', negated };
    if (['mono', 'single', '1'].includes(lc) && !key.startsWith('i')) return { html: '<span class="label-text">One ink</span>', negated };
    const list = lc.split(/[,/+]/).map((x) => INK_ALIAS[x.trim()] || x.trim()).filter(Boolean);
    const sw = list.map((n) => (INK_ORDER.includes(n) ? `<span class="ink ink-${n}"></span>` : '')).join('');
    const names = list.map(cap);
    const text = key === 'id' || key === 'identity' ? `Colors: ${names.join(' + ')}` : names.join(' or ');
    return { html: `<span class="swatches" aria-hidden="true">${sw}</span><span class="label-text">${escapeHtml(text)}</span>`, negated };
  }
  if (['i', 'inkable'].includes(key)) {
    const yes = /^(yes|y|true|1)$/i.test(val);
    return { html: `<span class="label-text">${yes ? 'Inkable' : 'Uninkable'}</span>`, negated };
  }
  // numeric ops -> nice display
  if (['cost','str','a','attack','strength','wp','w','def','willpower','lore','l','mv','move','movement'].includes(key)) {
    if (op === ':' || op === '=') {
      const range = val.match(/^(\d+)\.\.(\d+)$/);
      const display = range ? `${range[1]}–${range[2]}` : val;
      return { html: `<span class="label-text">${fieldLabel}: ${escapeHtml(display)}</span>`, negated };
    }
    const display = (op === '>=' ? '≥ ' : op === '<=' ? '≤ ' : op === '>' ? '> ' : op === '<' ? '< ' : '≠ ') + val;
    return { html: `<span class="label-text">${fieldLabel} ${escapeHtml(display)}</span>`, negated };
  }
  // multi-value (comma list) for type/rarity/keyword/property/franchise/set
  if (['t','type','r','rarity','kw','keyword','p','prop','char','f','franchise','set','s'].includes(key)) {
    const list = val.split(/[,/+]/).map((x) => x.trim()).filter(Boolean);
    const joined = list.map((x) => key === 'set' || key === 's' ? x : cap(x)).join(', ');
    return { html: `<span class="label-text">${fieldLabel}: ${escapeHtml(joined)}</span>`, negated };
  }
  // text-ish fallback
  return { html: `<span class="label-text">${escapeHtml(fieldLabel)}: <i>${escapeHtml(val)}</i></span>`, negated };
}
function cap(s) { s = String(s); return s ? s[0].toUpperCase() + s.slice(1) : s; }

function renderChips() {
  const tokens = splitTopLevel(state.query);
  $('#activeChips').innerHTML = tokens.map((tok) => {
    const { html, negated } = friendlyChip(tok);
    return `<span class="active-chip${negated ? ' negated' : ''}" title="${escapeAttr(tok)}">`
         + (negated ? '<span class="not">NOT</span>' : '')
         + html
         + `<button class="x" data-token="${escapeAttr(tok)}" aria-label="Remove filter ${escapeAttr(tok)}">✕</button>`
         + `</span>`;
  }).join('');
}

function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

// ---------- builder <-> query sync ----------
//
// Builder fields manage a fixed slice of the query (specific tokens).
// Anything else in the bar (parens, OR groups, unknown fields, negations)
// passes through unchanged in the same place.

const BUILDER_KEYS = new Set([
  'c','color','ink','id','identity','t','type','i','inkable','cost','r','rarity','kw','keyword',
  'set','s','str','a','attack','strength','wp','w','def','willpower','lore','l',
  'p','prop','char','characteristic','f','franchise','n','name','tt','title','o','oracle','text',
]);

function parseSimpleToken(tok) {
  if (!tok || /[()]/.test(tok)) return null;
  if (/^(or|and)$/i.test(tok)) return null;
  if (tok.startsWith('-')) return null;          // leave negated tokens as passthrough
  const m = tok.match(/^([a-z]+)([:=]|>=|<=|>|<|!=|!)(.+)$/i);
  if (!m) return null;
  const key = m[1].toLowerCase();
  if (!BUILDER_KEYS.has(key)) return null;
  if (m[2] === '!') return null;                  // negation via ! → passthrough
  return { key, op: m[2], val: m[3].replace(/^"|"$/g, '') };
}

// Read current builder UI state from DOM.
function readBuilder() {
  const pick = (sel, attr) =>
    [...document.querySelectorAll(`#builder ${sel}.active`)].map((b) => b.dataset[attr]);
  const v = (id) => (document.getElementById(id)?.value || '').trim();
  const inkable = document.querySelector('#builder [data-inkable].active')?.dataset.inkable || '';
  return {
    colors:    pick('.ink-btn[data-color]', 'color'),
    types:     pick('[data-type]', 'type'),
    rarities:  pick('[data-rarity]', 'rarity'),
    keywords:  pick('[data-kw]', 'kw'),
    sets:      pick('[data-set]', 'set'),
    inkable,
    costMin: v('bCostMin'), costMax: v('bCostMax'),
    strMin:  v('bStrMin'),  strMax:  v('bStrMax'),
    wpMin:   v('bWpMin'),   wpMax:   v('bWpMax'),
    loreMin: v('bLoreMin'), loreMax: v('bLoreMax'),
    property: v('bProperty'),
    franchise: v('bFranchise'),
    name: v('bName'),
    title: v('bTitle'),
    text: v('bText'),
  };
}

// Turn a builder state into the canonical list of tokens.
function builderToTokens(b) {
  const out = [];
  const q = (s) => /\s/.test(s) ? '"' + s + '"' : s;
  // one colour: any card with it; two or more: cards those colours can play (colour identity, #25)
  if (b.colors.length)    out.push((b.colors.length > 1 ? 'id:' : 'c:') + b.colors.join(','));
  if (b.types.length)     out.push('t:' + b.types.join(','));
  if (b.rarities.length)  out.push('r:' + b.rarities.map(q).join(','));
  if (b.keywords.length)  out.push('kw:' + b.keywords.join(','));
  if (b.sets.length)      out.push('set:' + b.sets.join(','));
  if (b.inkable === 'yes') out.push('i:yes');
  if (b.inkable === 'no')  out.push('i:no');
  numericTokens(out, 'cost', b.costMin, b.costMax);
  numericTokens(out, 'str',  b.strMin,  b.strMax);
  numericTokens(out, 'wp',   b.wpMin,   b.wpMax);
  numericTokens(out, 'lore', b.loreMin, b.loreMax);
  if (b.property)  out.push('p:' + q(b.property));
  if (b.franchise) out.push('f:' + q(b.franchise));
  if (b.name)      out.push('n:' + q(b.name));
  if (b.title)     out.push('tt:' + q(b.title));
  if (b.text)      out.push('o:' + q(b.text));
  return out;
}
function numericTokens(out, key, min, max) {
  if (min && max && min === max) { out.push(`${key}:${min}`); return; }
  if (min) out.push(`${key}>=${min}`);
  if (max) out.push(`${key}<=${max}`);
}

// User changed a builder control → splice builder tokens back into the query.
// Builder-owned tokens get replaced wholesale; manual/complex tokens (parens,
// negated terms, unknown fields, bare phrases) are preserved as passthrough.
function writeBuilderToQuery() {
  const builderTokens = builderToTokens(readBuilder());
  const passthrough = splitTopLevel(state.query).filter((tok) => !parseSimpleToken(tok));
  setQuery([...builderTokens, ...passthrough].join(' '));
}

// Bar changed → reflect builder-owned tokens back into the UI.
function syncBuilderFromQuery() {
  const tokens = splitTopLevel(state.query);
  const owned = { colors: new Set(), types: new Set(), rarities: new Set(), keywords: new Set(), sets: new Set(),
                  inkable: '', costMin: '', costMax: '', strMin: '', strMax: '', wpMin: '', wpMax: '',
                  loreMin: '', loreMax: '', property: '', franchise: '', name: '', title: '', text: '' };
  for (const tok of tokens) {
    const p = parseSimpleToken(tok); if (!p) continue;
    switch (p.key) {
      case 'c': case 'color': case 'ink': case 'id': case 'identity':
        p.val.split(/[,/+]/).forEach((c) => owned.colors.add(INK_ALIAS[c.trim().toLowerCase()] || c.trim().toLowerCase()));
        break;
      case 't': case 'type':
        p.val.split(/,/).forEach((c) => owned.types.add(c.trim()));
        break;
      case 'r': case 'rarity':
        p.val.split(/,/).forEach((c) => owned.rarities.add(c.trim()));
        break;
      case 'kw': case 'keyword':
        p.val.split(/,/).forEach((c) => owned.keywords.add(c.trim()));
        break;
      case 'set': case 's':
        p.val.split(/,/).forEach((c) => owned.sets.add(c.trim().padStart(3, '0')));
        break;
      case 'i': case 'inkable':
        owned.inkable = /^(yes|y|true|1)$/i.test(p.val) ? 'yes' : /^(no|n|false|0)$/i.test(p.val) ? 'no' : '';
        break;
      case 'cost': case 'str': case 'a': case 'attack': case 'strength':
      case 'wp': case 'w': case 'def': case 'willpower':
      case 'lore': case 'l': {
        const prefix = ({cost:'cost',str:'str',a:'str',attack:'str',strength:'str',
                         wp:'wp',w:'wp',def:'wp',willpower:'wp',
                         lore:'lore',l:'lore'})[p.key];
        applyNumericToOwned(owned, prefix, p.op, p.val);
        break;
      }
      case 'p': case 'prop': case 'char': case 'characteristic':
        owned.property = (owned.property ? owned.property + ',' : '') + p.val; break;
      case 'f': case 'franchise':
        owned.franchise = (owned.franchise ? owned.franchise + ',' : '') + p.val; break;
      case 'n': case 'name':       owned.name = p.val; break;
      case 'tt': case 'title':     owned.title = p.val; break;
      case 'o': case 'oracle': case 'text': owned.text = p.val; break;
    }
  }
  applyOwnedToBuilder(owned);
}

function applyNumericToOwned(o, prefix, op, val) {
  if (op === ':' || op === '=') {
    const r = val.match(/^(\d+)\.\.(\d+)$/);
    if (r) { o[prefix + 'Min'] = r[1]; o[prefix + 'Max'] = r[2]; }
    else if (/^\d+$/.test(val)) { o[prefix + 'Min'] = val; o[prefix + 'Max'] = val; }
  } else if (op === '>=') o[prefix + 'Min'] = val;
    else if (op === '>')  o[prefix + 'Min'] = String(Number(val) + 1);
    else if (op === '<=') o[prefix + 'Max'] = val;
    else if (op === '<')  o[prefix + 'Max'] = String(Number(val) - 1);
}

// toggles report their state to screen readers too (#40)
function setPressed(b, on) { b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
function applyOwnedToBuilder(o) {
  const setActive = (sel, attr, set) => {
    document.querySelectorAll('#builder ' + sel).forEach((b) => setPressed(b, set.has(b.dataset[attr])));
  };
  setActive('.ink-btn[data-color]', 'color', o.colors);
  setActive('[data-type]', 'type', o.types);
  setActive('[data-rarity]', 'rarity', o.rarities);
  setActive('[data-kw]', 'kw', o.keywords);
  setActive('[data-set]', 'set', o.sets);
  document.querySelectorAll('#builder [data-inkable]').forEach((b) => setPressed(b, b.dataset.inkable === o.inkable));
  const setVal = (id, v) => { const e = document.getElementById(id); if (e && e.value !== v) e.value = v; };
  setVal('bCostMin', o.costMin); setVal('bCostMax', o.costMax);
  setVal('bStrMin',  o.strMin);  setVal('bStrMax',  o.strMax);
  setVal('bWpMin',   o.wpMin);   setVal('bWpMax',   o.wpMax);
  setVal('bLoreMin', o.loreMin); setVal('bLoreMax', o.loreMax);
  setVal('bProperty', o.property);
  setVal('bFranchise', o.franchise);
  setVal('bName',  o.name);
  setVal('bTitle', o.title);
  setVal('bText',  o.text);
  // how many of the hidden "More filters" are in use, so a closed popover still says so
  const more = o.rarities.size + o.keywords.size + o.sets.size + [o.strMin, o.strMax, o.wpMin, o.wpMax, o.loreMin, o.loreMax, o.property, o.franchise, o.name, o.title, o.text].filter(Boolean).length;
  $('#moreCount').textContent = more ? `(${more})` : '';
}

// ---------- card grid ----------
// Tiles are added a chunk at a time as the grid scrolls (#43), and a deck edit updates the tiles' badges in place
// rather than rebuilding the grid, so keyboard focus stays where it is (#40).
const CHUNK = 120;
const grid = { shown: 0, tiles: [], byId: new Map(), io: null };
function renderGrid() {
  const el = $('#cardGrid');
  el.innerHTML = '';
  grid.shown = 0; grid.tiles = []; grid.byId.clear();
  const n = state.filtered.length;
  $('#resultCount').textContent = `${n.toLocaleString()} match${n === 1 ? '' : 'es'}`;
  if (!n && state.catalog.length) el.innerHTML = '<div class="note" style="padding:20px">No cards match. Remove a filter, or press ✕ to clear them all.</div>';
  appendTiles();
}
function appendTiles(count = CHUNK) {
  const end = Math.min(state.filtered.length, grid.shown + count);
  const frag = document.createDocumentFragment();
  for (let i = grid.shown; i < end; i++) frag.appendChild(tileEl(state.filtered[i], i));
  $('#cardGrid').appendChild(frag);
  grid.shown = end;
  const left = state.filtered.length - end;
  $('#gridMore').hidden = left <= 0;
  $('#gridMoreBtn').textContent = `Show more (${left.toLocaleString()} left)`;
  requestAnimationFrame(moreIfNear);
}
// keep loading while the end of the grid is within a screen of view (a tall screen can show a whole chunk)
function moreIfNear() {
  const m = $('#gridMore');
  if (m.hidden || !m.offsetParent) return;
  if (m.getBoundingClientRect().top < innerHeight + 900) appendTiles();
}
function tileEl(c, i) {
  const t = document.createElement('div');
  t.className = 'card-tile';
  t.dataset.id = c.id;
  t._i = i;
  t._full = c.name + (c.title ? ' – ' + c.title : '');
  const owned = Auth.Session.collection ? Auth.ownedQty(c.id) : null;
  const inkChips = c.inks.map((ink) => `<span class="ink ink-${ink}" title="${ink}"></span>`).join('');
  t.innerHTML = `<button type="button" class="tile-main" tabindex="${i === 0 ? 0 : -1}">
      <img loading="lazy" src="${c.image}" alt="">
      <span class="label">
        <span class="name">${escapeHtml(c.name)}</span>
        ${c.title ? `<span class="title">${escapeHtml(c.title)}</span>` : ''}
        <span class="stats">
          <span class="cost ${Deck.inkable(c) ? '' : 'uninkable'}" title="${Deck.inkable(c) ? 'Inkable' : 'Uninkable'}">${c.cost}</span>
          ${inkChips}
          ${owned ? `<span class="owned" title="Owned">own ${owned}</span>` : ''}
        </span>
        ${roleTagsFor(c)}
      </span>
    </button>
    <span class="tile-qty"><button type="button" class="tile-dec" tabindex="-1" title="Take one out" aria-label="One fewer ${escapeAttr(t._full)}">−</button><b class="qty-badge"></b><button type="button" class="tile-inc" tabindex="-1" title="Add one" aria-label="One more ${escapeAttr(t._full)}">+</button></span>`;
  updateTile(t);
  grid.tiles.push(t);
  grid.byId.set(c.id, t);
  return t;
}
function updateTile(t) {
  const qty = Deck.Deck.cards.get(t.dataset.id) || 0;
  if (t._qty === qty) return;
  t._qty = qty;
  t.classList.toggle('in-deck', qty > 0);
  const b = t.querySelector('.qty-badge');
  if (!b.classList.contains('max')) b.textContent = `×${qty}`;
  t.firstElementChild.setAttribute('aria-label', `Add ${t._full}${qty ? `, ${qty} in deck` : ''}`);
}
function syncTiles() { for (const t of grid.tiles) updateTile(t); }

// One more or one fewer of a card, from anywhere (pool, list, keys). At the copy limit it says so (#43).
function changeQty(id, delta) {
  const before = Deck.Deck.cards.get(id) || 0;
  Deck.bump(id, delta);
  const after = Deck.Deck.cards.get(id) || 0;
  if (after === before) { if (delta > 0 && (before > 0 || Deck.roomFor(id) === 0)) flashMax(id); return; }   // at the limit, counting other printings (#31)
  const t = grid.byId.get(id);
  if (t) updateTile(t);
  renderDeck();
  live(`${cardById(id)?.name || 'Card'}: ${after} in deck`);
}
function flashMax(id) {
  const max = Deck.maxCopies(cardById(id) || {});
  const msg = `Max ${max}`;
  const t = grid.byId.get(id);
  if (t) {
    const b = t.querySelector('.qty-badge');
    b.classList.add('max'); b.textContent = msg;
    clearTimeout(t._maxT);
    t._maxT = setTimeout(() => { b.classList.remove('max'); b.textContent = `×${t._qty}`; }, 1300);
  }
  const q = $(`#deckList .deck-row[data-id="${CSS.escape(id)}"] .qty > span`);
  if (q) { q.classList.add('max'); q.textContent = msg; setTimeout(() => { q.classList.remove('max'); q.textContent = Deck.Deck.cards.get(id) || 0; }, 1300); }
  live(`${msg} copies of ${cardById(id)?.name || 'that card'}`);
}
function live(text) { const el = $('#poolLive'); el.textContent = ''; requestAnimationFrame(() => { el.textContent = text; }); }

function gridCols() { return getComputedStyle($('#cardGrid')).gridTemplateColumns.split(' ').length || 1; }
function focusTile(i) {
  i = Math.max(0, Math.min(state.filtered.length - 1, i));
  while (i >= grid.shown && grid.shown < state.filtered.length) appendTiles();
  const t = grid.tiles[i]; if (!t) return;
  for (const x of $$('#cardGrid .tile-main[tabindex="0"]')) x.tabIndex = -1;
  t.firstElementChild.tabIndex = 0;
  t.firstElementChild.focus();
  t.scrollIntoView({ block: 'nearest' });
}

// ---------- roles: what cards do, read off their compiled abilities (/api/cards/roles, game/procs/roles.js) ----------
const R = { labels: {}, roles: {}, cares: {}, ready: false };
const ROLE_ORDER = ['removal', 'draw', 'ramp', 'lore', 'protection', 'recursion', 'songs'];
// rules of thumb for a 60-card deck, shown as a band on the meter and used by the suggestion; not hard limits
const THUMB = { removal: [6, 8], draw: [4, 8] };
const rolesOf = (c) => R.roles[c.id] || [];
const classesOf = (c) => { try { return (JSON.parse(c.characteristics || '[]') || []).map((x) => String(x).toLowerCase()); } catch { return []; } };
function roleMatch(role) {
  if (role.startsWith('class:')) { const k = role.slice(6); return (c) => classesOf(c).includes(k) || (R.cares[c.id] || []).includes(k); }
  return (c) => rolesOf(c).includes(role);
}
const titleCase = (s) => String(s).replace(/\b\w/g, (x) => x.toUpperCase());
// the classification this deck leans on: its most common one among characters, if other cards pay it off
function deckClass() {
  const n = {};
  const generic = new Set(['storyborn', 'dreamborn', 'floodborn', 'ally']);
  for (const { card, qty } of Deck.entries()) if (card.type === 'character') for (const k of classesOf(card)) if (!generic.has(k)) n[k] = (n[k] || 0) + qty;
  const payoffs = (k) => Object.values(R.cares).filter((v) => v.includes(k)).length;
  return Object.entries(n).filter(([k, q]) => q >= 8 && payoffs(k) >= 3).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}
async function loadRoles() {
  try {
    const r = await fetch('/api/cards/roles');
    if (!r.ok) return;
    Object.assign(R, await r.json(), { ready: true });
  } catch { return; }
  renderRoleChips(); renderGrid(); renderDeck();
}
function renderRoleChips() {
  const el = $('#roleChips');
  if (!R.ready) { el.innerHTML = ''; return; }
  const cls = deckClass();
  const chips = ROLE_ORDER.map((k) => [k, R.labels[k] || k]);
  if (cls) chips.push([`class:${cls}`, `${titleCase(cls)} synergy`]);
  if (state.role?.startsWith('class:') && !chips.some(([k]) => k === state.role)) chips.push([state.role, `${titleCase(state.role.slice(6))} synergy`]);
  el.innerHTML = '<span class="lbl">Does</span>' + chips.map(([k, label]) => `<button class="role ${state.role === k ? 'on' : ''}" data-role="${escapeHtml(k)}" aria-pressed="${state.role === k}">${escapeHtml(label)}</button>`).join('');
  el.querySelectorAll('[data-role]').forEach((b) => b.onclick = () => { state.role = state.role === b.dataset.role ? null : b.dataset.role; renderRoleChips(); applyFilters(); });
}
function roleTagsFor(c) {
  if (!R.ready) return '';
  const r = rolesOf(c).filter((k) => k !== 'songs' || c.type !== 'song').slice(0, 2);
  return r.length ? `<span class="tags">${r.map((k) => `<span class="tag">${escapeHtml(R.labels[k] || k)}</span>`).join('')}</span>` : '';
}
// the meters fold away behind "Roles" so the list keeps its room on a short screen (#35); the player's choice sticks
const ROLES_KEY = 'ink.builder.roles';
function rolesOpen() {
  let v = null;
  try { v = localStorage.getItem(ROLES_KEY); } catch { /* storage blocked */ }
  return v ? v === '1' : innerHeight >= 900;
}
function renderRoleMeters() {
  const el = $('#roleMeters');
  const sug = $('#suggest');
  const tog = $('#rolesToggle');
  if (!R.ready || !Deck.Deck.cards.size) { el.innerHTML = ''; sug.hidden = true; tog.hidden = true; return; }
  const n = Object.fromEntries(ROLE_ORDER.map((k) => [k, 0]));
  for (const { card, qty } of Deck.entries()) for (const k of rolesOf(card)) if (k in n) n[k] += qty;
  const total = Deck.summary().total;
  const SCALE = 16;
  el.innerHTML = ['removal', 'draw', 'ramp', 'lore', 'protection', 'recursion'].map((k) => {
    const t = THUMB[k];
    const low = t && total >= 30 && n[k] < t[0];
    return `<div class="meter ${low ? 'low' : ''}" data-role="${k}" title="${n[k]} card${n[k] === 1 ? '' : 's'} with ${escapeHtml((R.labels[k] || k).toLowerCase())}${t ? ` · rule of thumb ${t[0]}–${t[1]}` : ''} · click to show them in the pool">
      <span>${escapeHtml(R.labels[k] || k)} <b>${n[k]}</b></span>
      <span class="track">${t ? `<u style="left:${(t[0] / SCALE) * 100}%;width:${((t[1] - t[0]) / SCALE) * 100}%"></u>` : ''}<i style="width:${Math.min(100, (n[k] / SCALE) * 100)}%"></i></span></div>`;
  }).join('');
  el.querySelectorAll('[data-role]').forEach((m) => m.onclick = () => showRoleInInks(m.dataset.role));
  const open = rolesOpen();
  const lows = ['removal', 'draw'].filter((k) => total >= 30 && n[k] < THUMB[k][0]).length;
  tog.hidden = false;
  tog.setAttribute('aria-expanded', String(open));
  $('#rolesLow').textContent = lows && !open ? ` (${lows} low)` : '';
  el.hidden = !open;
  // one suggestion at a time, once the deck has taken shape; one line, and it can be dismissed (#38)
  const need = total >= 20 && ['removal', 'draw'].find((k) => n[k] < THUMB[k][0]);
  if (!need || sugDismissed === need) { sug.hidden = true; renderRoleChips(); return; }
  const label = (R.labels[need] || need).toLowerCase();
  const inks = Deck.summary().inks;
  sug.innerHTML = `<span class="txt">Light on <b>${escapeHtml(label)}</b>: ${n[need]} card${n[need] === 1 ? '' : 's'}, where ${THUMB[need][0]}–${THUMB[need][1]} is a common rule of thumb.</span>
    <button class="linkish" id="sugBtn">Show ${escapeHtml(label)}${inks.length ? ` in ${inks.map(titleCase).join(' / ')}` : ''}</button>
    <button class="x" id="sugX" aria-label="Dismiss this suggestion" title="Dismiss">✕</button>`;
  sug.hidden = false;
  $('#sugBtn').onclick = () => showRoleInInks(need);
  $('#sugX').onclick = () => { sugDismissed = need; sug.hidden = true; };
  renderRoleChips();
}
function showRoleInInks(role) {
  state.role = role;
  const inks = Deck.summary().inks;
  setQuery(inks.length ? `${inks.length > 1 ? 'id' : 'c'}:${inks.join(',')}` : '');   // what the deck's colours can play
  renderRoleChips();
  $('.mtabs button[data-pane="pool"]')?.click();
}

// ---------- deck list ----------
// the card on the deck's tile: the chosen one, else what the server picks (lib: most copies of a character, then cost)
function coverCard() {
  if (Deck.Deck.cover && Deck.Deck.cards.has(Deck.Deck.cover)) return { card: cardById(Deck.Deck.cover), chosen: true };
  const best = Deck.entries().sort((a, b) => (b.card.type === 'character') - (a.card.type === 'character') || b.qty - a.qty || (b.card.cost || 0) - (a.card.cost || 0))[0];
  return best ? { card: best.card, chosen: false } : null;
}
function renderDeck() {
  const list = $('#deckList');
  // keep keyboard focus on the same row's button across the re-render
  const f = document.activeElement;
  const keep = list.contains(f) ? { id: f.closest('.deck-row')?.dataset.id, act: f.dataset.act } : null;
  list.innerHTML = '';
  const groups = Deck.grouped();
  if (Deck.Deck.cover && !Deck.Deck.cards.has(Deck.Deck.cover)) Deck.Deck.cover = null;   // the cover card left the deck
  const ORDER = ['character', 'action', 'song', 'item', 'location'];
  const LABEL = { character: 'Characters', action: 'Actions', song: 'Songs', item: 'Items', location: 'Locations' };
  for (const type of ORDER) {
    const ents = groups[type] || [];
    if (!ents.length) continue;
    const section = document.createElement('div');
    section.className = 'deck-section';
    const total = ents.reduce((s, e) => s + e.qty, 0);
    section.innerHTML = `<h4>${LABEL[type]} · ${total}</h4>`;
    for (const { card, qty } of ents) {
      const row = document.createElement('div');
      row.className = 'deck-row';
      row.dataset.id = card.id;
      const full = escapeHtml(card.name + (card.title ? ' – ' + card.title : ''));
      const isCover = Deck.Deck.cover === card.id;
      row.innerHTML = `
        <span class="cost ${Deck.inkable(card) ? '' : 'uninkable'}">${card.cost}</span>
        <span class="name">${escapeHtml(card.name)}${card.title ? ' <span class="muted">· ' + escapeHtml(card.title) + '</span>' : ''}</span>
        <button class="cover-btn ${isCover ? 'on' : ''}" data-act="cover" aria-pressed="${isCover}" aria-label="Cover card: ${full}" title="${isCover ? 'The cover card. Click to let Ink pick one' : 'Set as cover'}">★</button>
        <span class="qty"><button data-act="dec" aria-label="One fewer ${full}">−</button><span>${qty}</span><button data-act="inc" aria-label="One more ${full}">+</button></span>
      `;
      section.appendChild(row);
    }
    list.appendChild(section);
  }
  if (Deck.Deck.cards.size === 0) {
    list.innerHTML = `<div class="deck-empty">Empty deck. Click cards in the pool to add them.</div>`;
  }
  if (keep?.id) list.querySelector(`.deck-row[data-id="${CSS.escape(keep.id)}"] [data-act="${keep.act}"]`)?.focus();

  const s = Deck.summary();
  $('#statCount').textContent = s.total;
  $('#statInkable').textContent = s.inkable;
  $('#statAvgCost').textContent = s.avgCost.toFixed(1);
  $('#mtabCount').textContent = s.total;
  $('#deckInks').innerHTML = s.inks.length ? s.inks.map((i) => `<span class="ink ink-${i}" title="${i}"></span>`).join('') : '';

  // the cover beside the name (#46)
  const cov = coverCard();
  const th = $('#coverThumb');
  th.hidden = !cov?.card;
  if (cov?.card) {
    const img = th.firstElementChild;
    if (img.getAttribute('src') !== cov.card.image) img.src = cov.card.image;
    th.classList.toggle('chosen', cov.chosen);
    th.title = `Cover card${cov.chosen ? '' : ' (picked for you)'}: ${cov.card.name}${cov.card.title ? ' – ' + cov.card.title : ''}. Choose another with ★ in the list.`;
  }

  // ink curve: 1…7+ (0-cost folds into 1)
  const buckets = new Array(8).fill(0);
  for (const { card, qty } of Deck.entries()) buckets[Math.min(7, Math.max(1, card.cost || 0))] += qty;
  const peak = Math.max(1, ...buckets);
  $('#curve').innerHTML = buckets.slice(1).map((n, i) => `<div class="bar" title="${n} card${n === 1 ? '' : 's'} costing ${i + 1}${i === 6 ? '+' : ''}"><b>${n || ''}</b><i style="height:${(n / peak) * 26}px"></i>${i + 1}${i === 6 ? '+' : ''}</div>`).join('');
  $('#curve').setAttribute('aria-label', 'Ink curve: ' + buckets.slice(1).map((n, i) => `${n} at ${i + 1}${i === 6 ? '+' : ''}`).join(', '));

  const errs = Deck.legality();
  const lab = $('#deckLegality');
  if (errs.length === 0 && s.total >= 60) { lab.textContent = '✓ Legal'; lab.className = 'legal'; lab.title = ''; }
  else if (s.total === 0) { lab.textContent = ''; lab.className = 'legal'; }
  else { lab.textContent = errs[0][0].toUpperCase() + errs[0].slice(1); lab.className = 'legal bad'; lab.title = errs.join('\n'); }
  renderRoleMeters();
  updateDirty();
}

// ---------- import: preview first, then apply (#37) ----------
let importParsed = null;
function listStats(cards) {
  let total = 0, inkable = 0;
  const inks = new Set();
  for (const [id, q] of cards) { const c = cardById(id); if (!c) continue; total += q; if (Deck.inkable(c)) inkable += q; c.inks.forEach((i) => inks.add(i)); }
  const problems = [];
  if (total !== 60) problems.push(`${total} cards, not 60`);
  if (inks.size > 2) problems.push(`${inks.size} inks`);
  if (inkable < 30) problems.push(`${inkable} inkable, under 30`);
  return { total, inkable, inks: INK_ORDER.filter((i) => inks.has(i)), problems };
}
function openImport() {
  resetImport();
  $('#importText').value = '';
  const has = !!Deck.Deck.id || Deck.Deck.cards.size > 0;
  $('#importReplaceLabel').textContent = has ? `“${deckName()}”, replacing its ${Deck.totalCount()} cards` : 'This deck';
  openModal('#importModal');
}
function resetImport() {
  importParsed = null;
  $('#importPreview').hidden = true;
  $('#importMode').hidden = true;
  $('#importSubmit').hidden = true;
  $('#importPreviewBtn').hidden = false;
}
function previewImport() {
  const text = $('#importText').value;
  const box = $('#importPreview');
  box.hidden = false;
  if (!text.trim()) { box.innerHTML = '<p class="warn">Paste a decklist first.</p>'; $('#importText').focus(); return; }
  const p = Deck.parseText(text);
  const st = listStats(p.cards);
  const line = (id, q) => { const c = cardById(id); return `<li>${q} ${escapeHtml(c ? c.name + (c.title ? ' – ' + c.title : '') : id)}</li>`; };
  box.innerHTML = (p.cards.length
      ? `<p><b>${st.total} cards</b>, ${p.cards.length} different · ${st.inks.map((i) => `<span class="ink ink-${i}" title="${i}"></span>`).join(' ') || 'no inks'} · ${st.problems.length ? `<span class="warn">not legal yet: ${escapeHtml(st.problems.join(', '))}</span>` : '<span class="ok">✓ legal</span>'}</p>
         <ul class="cols">${p.cards.map(([id, q]) => line(id, q)).join('')}</ul>`
      : '<p class="warn">No cards recognised. Lines look like <code>4 Mickey Mouse - Brave Little Tailor</code>.</p>')
    + (p.errs.length ? `<p class="warn">Skipped ${p.errs.length} line${p.errs.length === 1 ? '' : 's'}:</p><ul>${p.errs.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : '')
    + (p.capped.length ? `<p class="warn">Cut to the copy limit: ${escapeHtml(p.capped.join(', '))}</p>` : '');
  if (!p.cards.length) return;
  importParsed = p;
  const has = !!Deck.Deck.id || Deck.Deck.cards.size > 0;
  $('#importMode').hidden = !has;
  $('#importPreviewBtn').hidden = true;
  const go = $('#importSubmit');
  go.hidden = false;
  go.textContent = `Import ${st.total} card${st.total === 1 ? '' : 's'}`;
  go.focus();
}
async function applyImport() {
  const p = importParsed; if (!p) return;
  const has = !!Deck.Deck.id || Deck.Deck.cards.size > 0;
  const mode = has ? $('#importMode input:checked').value : 'new';
  if (mode === 'new') {
    if (!(await confirmLeave('import this list as a new deck'))) return;
    startDeck({ name: 'Imported deck', cards: p.cards });
  } else {
    Deck.clear();
    for (const [id, q] of p.cards) Deck.setQty(id, q);
    syncTiles(); renderDeck();
  }
  closeModal('#importModal');
  showNotice(`Imported ${p.total} cards${p.errs.length ? `; skipped ${p.errs.length} line${p.errs.length === 1 ? '' : 's'} we couldn't match` : ''}. Save the deck to keep it.`, !!p.errs.length);
}

// ---------- UI wiring ----------
function wireUI() {
  wireDialogs();
  wireMenu();

  // populate the dynamic Set toggles in the builder (3-digit set ids).
  const sets = [...new Set(DB.allCards.map((c) => c.setId))].sort();
  const setsEl = $('#bSets');
  for (const s of sets) {
    const b = document.createElement('button');
    b.className = 'tog-btn';
    b.dataset.set = s;
    b.textContent = s;
    b.setAttribute('aria-pressed', 'false');
    setsEl.appendChild(b);
  }

  // search bar -> state
  let qTimer = 0;
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { applyFilters(); syncBuilderFromQuery(); renderChips(); }, 80);
  });
  // from the search box, ↓ goes to the first card
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && grid.tiles.length) { e.preventDefault(); focusTile(0); } });
  $('#searchClearBtn').addEventListener('click', () => {
    state.role = null; renderRoleChips();
    setQuery('');
    $('#search').focus();
  });
  $('#searchHelpBtn').addEventListener('click', () => {
    $('#helpBody').innerHTML = HELP_HTML;
    openModal('#helpModal');
  });
  $('#helpExampleBtn').addEventListener('click', () => {
    setQuery('(c:ruby or c:amber) t:character cost<=3 i:yes');
    closeModal('#helpModal');
  });

  // ---------- builder wiring ----------
  const more = $('#builderMore'), moreBtn = $('#builderToggleBtn');
  const setMore = (open, refocus) => {
    more.hidden = !open;
    moreBtn.setAttribute('aria-expanded', String(open));
    if (open) more.querySelector('button, input')?.focus();
    else if (refocus) moreBtn.focus();
  };
  moreBtn.addEventListener('click', () => setMore(more.hidden));
  $('#builderDoneBtn').addEventListener('click', () => setMore(false, true));
  more.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); setMore(false, true); } });
  document.addEventListener('pointerdown', (e) => { if (!more.hidden && !more.contains(e.target) && !moreBtn.contains(e.target)) setMore(false); });

  // colored ink buttons
  $$('#builder .ink-btn[data-color]').forEach((b) => {
    b.addEventListener('click', () => {
      b.classList.toggle('active');
      writeBuilderToQuery();
    });
  });
  // simple toggle-multi groups (data-X attrs)
  for (const sel of ['[data-type]', '[data-rarity]', '[data-kw]', '[data-set]']) {
    document.querySelectorAll('#builder ' + sel).forEach((b) => {
      b.addEventListener('click', () => {
        b.classList.toggle('active');
        writeBuilderToQuery();
      });
    });
  }
  // inkable: single-pick segmented control
  document.querySelectorAll('#builder [data-inkable]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#builder [data-inkable]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      writeBuilderToQuery();
    });
  });
  // ensure "Any" starts pressed
  setPressed(document.querySelector('#builder [data-inkable=""]'), true);

  // numeric + text inputs
  for (const id of ['bCostMin','bCostMax','bStrMin','bStrMax','bWpMin','bWpMax','bLoreMin','bLoreMax','bProperty','bFranchise','bName','bTitle','bText']) {
    const el = document.getElementById(id);
    if (!el) continue;
    let timer = 0;
    el.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(writeBuilderToQuery, 120);
    });
  }

  // active-chips strip
  $('#activeChips').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-token]'); if (!btn) return;
    removeToken(btn.dataset.token);
    $('#search').focus();
  });

  $('#ownedOnly').addEventListener('change',  (e) => { state.ownedOnly = e.target.checked; applyFilters(); });

  // deck browser: an import opens as a new, unsaved deck (after asking about this one's unsaved changes)
  Decks.wire();
  $('#openDecksBtn').addEventListener('click', () => {
    Decks.open({
      onImport: async ({ name, cards, errs }) => {
        if (!(await confirmLeave(`open “${name}”`))) return false;
        startDeck({ name: name || 'Imported deck', cards });
        if (errs?.length) showNotice(`Opened “${name}”, but ${errs.length} card${errs.length === 1 ? '' : 's'} couldn't be matched: ${errs.slice(0, 6).join(', ')}${errs.length > 6 ? '…' : ''}. Save it to keep it.`, true);
        else showNotice(`Opened a copy of “${name}”. Save it to keep it in My decks.`);
        return true;
      },
    });
  });

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

  // grid: click (or Enter) adds, right-click / long-press / − / Delete takes one out; hover or focus previews
  const gridEl = $('#cardGrid');
  gridEl.addEventListener('click', (e) => {
    const tile = e.target.closest('.card-tile'); if (!tile) return;
    changeQty(tile.dataset.id, e.target.closest('.tile-dec') ? -1 : +1);
  });
  let lastTouch = 0;
  gridEl.addEventListener('contextmenu', (e) => {
    const tile = e.target.closest('.card-tile'); if (!tile) return;
    e.preventDefault();
    if (Date.now() - lastTouch < 1500) return;                    // a long-press on a phone: the timer below took one out
    changeQty(tile.dataset.id, -1);
  });
  gridEl.addEventListener('keydown', (e) => {
    const main = e.target.closest('.tile-main'); if (!main) return;
    const tile = main.parentElement;
    if (['Delete', 'Backspace', '-', '_'].includes(e.key)) { e.preventDefault(); changeQty(tile.dataset.id, -1); return; }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); changeQty(tile.dataset.id, +1); return; }
    const cols = gridCols();
    const to = { ArrowRight: tile._i + 1, ArrowLeft: tile._i - 1, ArrowDown: tile._i + cols, ArrowUp: tile._i - cols, Home: 0, End: grid.shown - 1, PageDown: tile._i + cols * 3, PageUp: tile._i - cols * 3 }[e.key];
    if (to == null) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && tile._i < cols) { $('#search').focus(); return; }
    focusTile(to);
  });
  gridEl.addEventListener('focusin', (e) => {
    const main = e.target.closest('.tile-main'); if (!main) return;
    if (main.tabIndex !== 0) { for (const x of $$('#cardGrid .tile-main[tabindex="0"]')) x.tabIndex = -1; main.tabIndex = 0; }
    if (!main.matches(':focus-visible')) return;
    const card = cardById(main.parentElement.dataset.id);
    if (card) previewAt(card, besideRect(main.parentElement.getBoundingClientRect()), true);
  });
  gridEl.addEventListener('focusout', () => previewHide());
  let pressT = 0, pressed = false;
  gridEl.addEventListener('touchstart', (e) => {
    const tile = e.target.closest('.card-tile'); if (!tile || e.target.closest('.tile-qty')) return;
    pressed = false; lastTouch = Date.now();
    pressT = setTimeout(() => { pressed = true; changeQty(tile.dataset.id, -1); navigator.vibrate?.(15); }, 450);
  }, { passive: true });
  gridEl.addEventListener('touchend', (e) => { clearTimeout(pressT); if (pressed) e.preventDefault(); }, { passive: false });
  gridEl.addEventListener('touchmove', () => clearTimeout(pressT), { passive: true });
  // a mouse only: a tap on a phone also fires mouse events, which would leave a preview stuck on the screen
  gridEl.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const tile = e.target.closest('.card-tile'); if (!tile) return previewHide();
    const card = cardById(tile.dataset.id);
    if (card) previewAt(card, besideRect(tile.getBoundingClientRect()));   // beside the tile, so its −/+ and badge stay visible
  });
  gridEl.addEventListener('pointerleave', previewHide);
  $('#gridMoreBtn').addEventListener('click', () => appendTiles());
  grid.io = new IntersectionObserver((ents) => { if (ents.some((x) => x.isIntersecting)) appendTiles(); }, { rootMargin: '0px 0px 900px 0px' });
  grid.io.observe($('#gridMore'));

  // deck list: − / + / cover
  $('#deckList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const row = e.target.closest('.deck-row'); if (!row) return;
    if (btn.dataset.act === 'cover') {                             // the deck tile's card (#26); click again for automatic
      Deck.Deck.cover = Deck.Deck.cover === row.dataset.id ? null : row.dataset.id;
      $('#saveNote').textContent = Deck.Deck.cover ? 'Cover card set. Save the deck to keep it.' : 'Cover back to automatic. Save the deck to keep it.';
      renderDeck();
      return;
    }
    changeQty(row.dataset.id, btn.dataset.act === 'inc' ? +1 : -1);
  });
  // the preview opens outside the panel, beside the row, so it never covers the row's buttons (#44)
  $('#deckList').addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const row = e.target.closest('.deck-row'); if (!row) return previewHide();
    const card = cardById(row.dataset.id);
    if (card) previewAt(card, besidePanel(row));
  });
  $('#deckList').addEventListener('pointerleave', previewHide);

  // deck panel
  $('#myDecksBtn').addEventListener('click', openPicker);
  $('#pickerSearch').addEventListener('input', renderPicker);
  $('#pickerSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pickerGrid .dtile:not(.add)')?.click(); });
  $('#pickerGrid').addEventListener('click', (e) => { const t = e.target.closest('[data-deck]'); if (t) pickDeck(t.dataset.deck); });
  $('#newDeckBtn').addEventListener('click', async () => {
    if (!(await confirmLeave('start a new deck'))) return;
    newDeck();
    $('#deckTitle').select();
  });
  $('#deckTitle').addEventListener('change', (e) => { Deck.Deck.name = e.target.value.trim() || 'Untitled deck'; });
  $('#deckTitle').addEventListener('input', updateDirty);
  $('#deckTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#saveDeckBtn').addEventListener('click', async () => {
    try { await saveCurrent(); flash($('#saveDeckBtn'), 'Saved'); }
    catch (e) { alert("Can't save: " + e.message); }
  });
  $('#playDeckBtn').addEventListener('click', async () => {
    try {
      const d = await saveCurrent();
      localStorage.setItem('ink.play.deck', 'saved:' + d.id);
      location.href = '/play';
    } catch (e) { alert("Can't save: " + e.message); }
  });
  $('#shareDeck').addEventListener('change', async () => {
    if (!Deck.Deck.id || !Deck.Deck.cards.size) return;          // takes effect on the next save
    try { await saveCurrent(); flash($('#saveDeckBtn'), $('#shareDeck').checked ? 'Shared' : 'Unshared'); }
    catch (e) { alert("Can't save: " + e.message); }
  });
  $('#deleteDeckBtn').addEventListener('click', async () => {
    if (!Deck.Deck.id || !confirm(`Delete "${Deck.Deck.name}"? This can't be undone.`)) return;
    try { await account.deleteDeck(Deck.Deck.id); newDeck(); }
    catch (e) { alert('Delete failed: ' + e.message); }
  });
  $('#rolesToggle').addEventListener('click', () => {
    const open = !rolesOpen();
    try { localStorage.setItem(ROLES_KEY, open ? '1' : '0'); } catch { /* storage blocked */ }
    renderRoleMeters();
  });
  // test the deck: the engine plays it against other decks on the server (simui.js, lib/sim.js)
  Sim.init({
    getDeck: () => ({ name: deckName(), cards: [...Deck.Deck.cards.entries()] }),
    onRole: (role) => showRoleInInks(role),
    // auto-fix's list replaces the deck in the builder (saved only when the player saves)
    applyCards: (cards) => {
      Deck.clear();
      for (const [id, q] of cards) Deck.setQty(String(id), q);
      syncTiles(); renderDeck();
      showNotice('Auto-fix changes applied. Save the deck to keep them.');
    },
  });
  $('#testDeckBtn').addEventListener('click', () => Sim.open());
  // phones: pool and deck are two tabs
  $$('.mtabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.mtabs button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    $('#layout').dataset.pane = b.dataset.pane;
    window.scrollTo({ top: 0 });
  }));
  // Export: ask the user how they'd like the decklist (clipboard or .txt file).
  $('#exportDeckBtn').addEventListener('click', () => {
    if (Deck.Deck.cards.size === 0) return alert('Your deck is empty — nothing to export.');
    $('#exportText').value = Deck.toText();
    $('#exportDeckName').textContent = Deck.Deck.name || 'your deck';
    $('#exportStatus').textContent = '';
    openModal('#exportModal');
  });
  $('#exportCopyBtn').addEventListener('click', async () => {
    const ta = $('#exportText');
    let ok = false;
    if (navigator.clipboard?.writeText) {
      // Race a timeout: a backgrounded/unfocused tab can leave writeText pending
      // forever, so fall back rather than hang.
      ok = await Promise.race([
        navigator.clipboard.writeText(ta.value).then(() => true, () => false),
        new Promise((res) => setTimeout(() => res(false), 600)),
      ]);
    }
    if (!ok) {
      // Fallback for browsers without (or denied) the async clipboard API.
      ta.removeAttribute('readonly'); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.setAttribute('readonly', '');
    }
    $('#exportStatus').textContent = ok
      ? '✓ Copied to clipboard'
      : '⚠ Couldn’t copy automatically — the text is selected, press ⌘/Ctrl+C.';
    flash($('#exportCopyBtn'), ok ? 'Copied!' : 'Select+copy');
  });
  $('#exportDownloadBtn').addEventListener('click', () => {
    const filename = (Deck.Deck.name || 'deck') + '.txt';
    const blob = new Blob([$('#exportText').value], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    $('#exportStatus').textContent = '✓ Downloaded ' + filename;
    flash($('#exportDownloadBtn'), 'Saved!');
  });
  $('#importDeckBtn').addEventListener('click', openImport);
  $('#importText').addEventListener('input', () => { if (importParsed || !$('#importPreview').hidden) resetImport(); });
  $('#importText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); importParsed ? applyImport() : previewImport(); } });
  $('#importPreviewBtn').addEventListener('click', previewImport);
  $('#importSubmit').addEventListener('click', applyImport);

  // sign-in
  $('#signInBtn').addEventListener('click', () => openModal('#signInModal'));
  $('#signOutBtn').addEventListener('click', async () => {
    await Auth.logout();
    onSignedOut();
    if ($('#accountModal').open) renderAccountModal();
  });
  $('#syncCollectionBtn').addEventListener('click', async () => {
    flash($('#syncCollectionBtn'), 'Syncing…');
    try {
      const owned = await Auth.syncCollection();
      showNotice(`Synced your Dreamborn collection: ${Object.keys(owned).length.toLocaleString()} owned printings. Tick “Owned only” to filter the pool.`);
      renderGrid();
      if ($('#accountModal').open) renderAccountModal();
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
      $('#syncCollectionBtn').click();
    } catch (e) {
      $('#signInError').textContent = e.message;
    }
  });

  // about link
  $('#aboutLink').addEventListener('click', (e) => {
    e.preventDefault();
    alert(
      'Ink — Lorcana deck builder\n\n' +
      '· Card data: Ravensburger (cards.disneylorcana.com) merged onto dreamborn.ink (sanitized.db)\n' +
      '· Queried locally via sql.js\n' +
      '· Optional sign-in syncs your Dreamborn collection\n\n' +
      'Found a bug or have an idea? Open an issue:\n' +
      'https://github.com/Archers007/Ink/issues\n\n' +
      'Not affiliated with Disney, Ravensburger, or Dreamborn.'
    );
  });
}

function onSignedIn(displayName) {
  $('#userCell').textContent = displayName;
  $('#ownedOnlyWrap').hidden = false;
  $('#signInBtn').classList.add('hidden');
  $('#signOutBtn').classList.remove('hidden');
  $('#syncCollectionBtn').classList.remove('hidden');
}
function onSignedOut() {
  $('#userCell').textContent = '';
  $('#ownedOnlyWrap').hidden = true;
  if (state.ownedOnly) { state.ownedOnly = false; $('#ownedOnly').checked = false; applyFilters(); }
  $('#signInBtn').classList.remove('hidden');
  $('#signOutBtn').classList.add('hidden');
  $('#syncCollectionBtn').classList.add('hidden');
  Auth.Session.collection = null;
  renderGrid();
}

// ---------- dialogs (#41) ----------
// Every dialog is a <dialog> opened with showModal(): the page behind goes inert, Tab stays inside, Escape closes it,
// and [autofocus] picks the field that gets focus. This adds the rest for all of them, whichever module opens one
// (decks.js and simui.js call showModal themselves): focus goes back to whatever opened the dialog, ✕ / Cancel
// buttons ([data-close-modal]) close it, and so does a click on the backdrop.
function openModal(sel) { const d = typeof sel === 'string' ? $(sel) : sel; if (!d.open) d.showModal(); }
function closeModal(sel) { const d = typeof sel === 'string' ? $(sel) : sel; if (d.open) d.close(); }
function wireDialogs() {
  const recent = [];                                      // the last few focused elements, newest last
  document.addEventListener('focusin', (e) => { recent.push(e.target); if (recent.length > 8) recent.shift(); });
  const watch = new MutationObserver((muts) => {
    for (const m of muts) {
      const d = m.target;
      // showModal() has already moved focus inside, so the opener is the newest element outside this dialog
      if (d.open && m.oldValue === null) d._opener = [...recent].reverse().find((x) => x.isConnected && !d.contains(x)) || null;
    }
  });
  for (const d of $$('dialog')) {
    watch.observe(d, { attributes: true, attributeFilter: ['open'], attributeOldValue: true });
    d.addEventListener('close', () => {
      const back = d._opener; d._opener = null;
      // after any other close handlers have run (one may open a deck, or close the dialog underneath it)
      if (back) setTimeout(() => back.isConnected && back.focus(), 0);
    });
  }
  let downOutside = null;
  const outside = (d, e) => { const r = d.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
  document.addEventListener('pointerdown', (e) => { downOutside = e.target instanceof HTMLDialogElement && outside(e.target, e) ? e.target : null; });
  document.addEventListener('click', (e) => {
    const x = e.target.closest('[data-close-modal]');
    if (x) { x.closest('dialog')?.close(); return; }
    if (e.target instanceof HTMLDialogElement && e.target === downOutside && outside(e.target, e)) e.target.close();
  });
}

// ---------- the ⋯ deck menu (#35) ----------
function wireMenu() {
  const btn = $('#deckMenuBtn'), menu = $('#deckMenu');
  const items = () => [...menu.querySelectorAll('[role=menuitem]')].filter((b) => !b.hidden);
  const open = () => { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); items()[0]?.focus(); };
  const close = (refocus) => { if (menu.hidden) return; menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); };
  btn.addEventListener('click', () => (menu.hidden ? open() : close(true)));
  btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); open(); } });
  // capture: shut the menu (focus back on ⋯) before the item's own handler opens a dialog, so the dialog hands
  // focus back to ⋯ and not to a hidden menu item
  menu.addEventListener('click', (e) => { if (e.target.closest('[role=menuitem]')) close(true); }, true);
  menu.addEventListener('keydown', (e) => {
    const list = items(); const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); list.at(-1).focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') close(false);
  });
  document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(false); });
}

// ---------- preview popover (#44) ----------
// About min(380px, 48vh) wide so the rules text reads. It waits ~150ms before it first appears, so sweeping the
// mouse across the grid doesn't flash cards, then follows without a delay. Location cards are landscape but their
// art ships portrait, so the image is turned 90° in a landscape box (see .preview.location in style.css).
const pv = { timer: 0, shown: false };
function previewSize(isLocation) {
  const w = Math.min(380, innerHeight * 0.48), h = w * 1024 / 734;
  return isLocation ? [h, w] : [w, h];
}
function previewAt(card, place, now = false) {
  const go = () => {
    const p = $('#preview');
    const img = p.firstElementChild;
    const loc = card.type === 'location';
    const [W, H] = previewSize(loc);
    const xy = place(W, H);
    if (!xy) { previewHide(); return; }
    if (img.getAttribute('src') !== card.image) img.src = card.image;
    p.classList.toggle('location', loc);
    p.style.left = xy[0] + 'px';
    p.style.top = xy[1] + 'px';
    p.classList.add('show');
    pv.shown = true;
  };
  clearTimeout(pv.timer);
  if (pv.shown || now) go(); else pv.timer = setTimeout(go, 150);
}
function previewHide() { clearTimeout(pv.timer); pv.shown = false; $('#preview').classList.remove('show'); }
const clampY = (y, H) => Math.max(8, Math.min(innerHeight - H - 8, y));
// beside a tile: right of it, or left when there's no room
const besideRect = (r) => (W, H) => {
  const x = r.right + 12 + W <= innerWidth - 8 ? r.right + 12 : r.left - W - 12;
  return x < 8 ? null : [x, clampY(r.top + r.height / 2 - H / 2, H)];
};
// outside the deck panel, level with the row
function besidePanel(row) {
  return (W, H) => {
    const pr = $('.deckpanel').getBoundingClientRect(), rr = row.getBoundingClientRect();
    const x = pr.left - W - 14;
    return x < 8 ? null : [x, clampY(rr.top + rr.height / 2 - H / 2, H)];
  };
}

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
