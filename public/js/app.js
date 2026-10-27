// Glue: boot DB, render catalog, render deck, wire UI, talk to auth.

import { DB, loadDB, INK_ORDER, inkSymbol, canonicalPrintings } from './db.js';
import * as Deck from './deck.js';
import * as Auth from './auth.js';
import { compileQuery, HELP_HTML } from './search.js';
import * as Decks from './decks.js';
import * as account from './account.js';

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
  setStatus('Loading cards…');
  const acct = account.load();
  await loadDB((stage, msg) => setStatus(msg));

  state.catalog = canonicalPrintings(DB.allCards);
  applyFilters();

  setStatus(`${state.catalog.length.toLocaleString()} cards · ${new Set(DB.allCards.map((c) => c.setId)).size} sets`);

  wireUI();
  renderDeck();
  renderChips();

  const { migrated, signin } = await acct;
  if (signin === 'failed') showNotice("Sign-in didn't go through. Try again, or keep building as a guest.", true);
  else if (migrated) showNotice(`Moved ${migrated} deck${migrated === 1 ? '' : 's'} from this browser into your account.`);
  renderAccount();
  account.onChange(() => { renderAccount(); refreshDeckPicker(); });

  // reopen the last deck
  const last = localStorage.getItem('ink.lastDeck');
  if (last) {
    const d = await account.getDeck(last).catch(() => null);
    if (d) openDeck(d);
  }
  await refreshDeckPicker();

  // Dreamborn collection link (separate from the Ink account)
  const m = await Auth.me().catch(() => ({}));
  if (m.ok) onSignedIn(m.displayName);
}

function showNotice(text, bad = false) {
  const el = $('#notice');
  el.className = `notice strip ${bad ? 'bad' : ''}`;
  el.innerHTML = `<span>${escapeHtml(text)}</span><button aria-label="Dismiss">✕</button>`;
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
  $('#accountBtn').onclick = () => { renderAccountModal(); openModal('#accountModal'); };
  $('#saveNote').textContent = '';
}
function renderAccountModal() {
  const u = account.user();
  const body = $('#accountBody');
  const signin = account.signInButtons('/');
  const db = Auth.Session.displayName;
  const owned = Auth.Session.collection ? Object.keys(Auth.Session.collection).length : 0;
  body.innerHTML = `
    ${u ? `<div class="acct-row">${avatarHtml(u, 'avatar lg')}<div><b>${escapeHtml(u.name)}</b><span class="note">Signed in with ${u.providers.map((p) => p[0].toUpperCase() + p.slice(1)).join(' + ')}. Your decks are saved to this account.</span></div><button class="btn btn-quiet btn-sm" id="acctSignOut">Sign out</button></div>`
      : signin ? `<p class="note">Sign in so your decks follow you between phone and desktop. We only read your name and avatar. Decks you've saved in this browser move into your account.</p><div class="acct-signin">${signin}</div>`
      : `<p class="note">Sign-in isn't set up on this server, so decks are saved in this browser.</p>`}
    <div class="acct-row"><div><b>Dreamborn collection</b><span class="note">${db ? `Linked as ${escapeHtml(db)}${owned ? ` · ${owned.toLocaleString()} owned printings synced` : ' · not synced yet'}` : 'Link your dreamborn.ink account to filter the pool to cards you own.'}</span></div>
      ${db ? `<button class="btn btn-sm" id="acctSync">Sync</button><button class="btn btn-quiet btn-sm" id="acctUnlink">Unlink</button>` : `<button class="btn btn-sm" id="acctLink">Link</button>`}</div>`;
  $('#acctSignOut')?.addEventListener('click', async () => { await account.signOut(); closeModal('#accountModal'); newDeck(); });
  $('#acctLink')?.addEventListener('click', () => { closeModal('#accountModal'); openModal('#signInModal'); });
  $('#acctSync')?.addEventListener('click', () => $('#syncCollectionBtn').click());
  $('#acctUnlink')?.addEventListener('click', () => $('#signOutBtn').click());
}

async function refreshDeckPicker() {
  const sel = $('#deckPicker');
  let decks = [];
  try { decks = await account.listDecks(); } catch (e) { showNotice(`Couldn't load your decks: ${e.message}`, true); }
  const where = account.signedIn() ? 'My decks' : 'Saved in this browser';
  sel.innerHTML = `<option value="">${decks.length ? `Open a deck… (${decks.length})` : 'No saved decks yet'}</option>`
    + (decks.length ? `<optgroup label="${where}">${decks.map((d) => `<option value="${escapeHtml(d.id)}" ${d.id === Deck.Deck.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}</optgroup>` : '');
  $('#deleteDeckBtn').hidden = !Deck.Deck.id;
}
function setDeckName(n) { Deck.Deck.name = n; $('#deckTitle').value = n; }
function openDeck(d) {
  Deck.clear();
  for (const [id, q] of d.cards) Deck.setQty(String(id), q);
  Deck.Deck.id = d.id;
  setDeckName(d.name);
  localStorage.setItem('ink.lastDeck', d.id);
  renderGrid(); renderDeck(); refreshDeckPicker();
}
function newDeck() {
  Deck.clear(); Deck.Deck.id = null;
  setDeckName('Untitled deck');
  localStorage.removeItem('ink.lastDeck');
  renderGrid(); renderDeck(); refreshDeckPicker();
}
async function saveCurrent() {
  if (!Deck.Deck.cards.size) throw new Error('add some cards first');
  const name = ($('#deckTitle').value || '').trim() || 'Untitled deck';
  setDeckName(name);
  const d = await account.saveDeck({ id: Deck.Deck.id, name, cards: [...Deck.Deck.cards.entries()] });
  Deck.Deck.id = d.id;
  localStorage.setItem('ink.lastDeck', d.id);
  $('#saveNote').textContent = account.signedIn() ? '' : account.anyProvider() ? 'Saved in this browser. Sign in to keep it on every device.' : '';
  await refreshDeckPicker();
  return d;
}

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
  setQuery(cur ? cur + ' ' + snippet : snippet);
  inp.focus();
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
const INK_HEX = {
  amber: '#f4b400', amethyst: '#8a3ffc', emerald: '#00a26a',
  ruby: '#d6204e', sapphire: '#1a86d6', steel: '#94a3b8',
};
const FIELD_LABEL = {
  c: 'Color', color: 'Color', ink: 'Color',
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
    return {
      html: `<span class="label-text">Name: <i>${escapeHtml(t.replace(/^"|"$/g, ''))}</i></span>`,
      negated: neg,
    };
  }
  const key = m[1].toLowerCase();
  const op  = m[2];
  const val = m[3].replace(/^"|"$/g, '');
  const negOp = op === '!';
  const negated = neg || negOp;
  const fieldLabel = FIELD_LABEL[key] || key;

  // colors get a swatch
  if (['c','color','ink'].includes(key)) {
    const list = val.split(/[,/+]/).map((x) => x.trim().toLowerCase());
    const swatches = list.map((n) => `<span class="swatch" style="background:${INK_HEX[n] || '#888'}"></span>`).join('');
    return { html: `${swatches}<span class="label-text">${list.map(cap).join(', ')}</span>`, negated };
  }
  if (['i','inkable'].includes(key)) {
    const yes = /^(yes|y|true|1)$/i.test(val);
    return { html: `<span class="label-text">${yes ? 'Inkable' : 'Uninkable'}</span>`, negated };
  }
  // numeric ops -> nice display
  if (['cost','str','a','attack','strength','wp','w','def','willpower','lore','l','mv','move','movement'].includes(key)) {
    if (op === ':' || op === '=') {
      const range = val.match(/^(\d+)\.\.(\d+)$/);
      const display = range ? `${range[1]}–${range[2]}` : val;
      return { html: `<span class="label-text">${fieldLabel}: ${display}</span>`, negated };
    }
    const display = (op === '>=' ? '≥ ' : op === '<=' ? '≤ ' : op === '>' ? '> ' : op === '<' ? '< ' : '≠ ') + val;
    return { html: `<span class="label-text">${fieldLabel} ${display}</span>`, negated };
  }
  // multi-value (comma list) for type/rarity/keyword/property/franchise/set
  if (['t','type','r','rarity','kw','keyword','p','prop','char','f','franchise','set','s'].includes(key)) {
    const list = val.split(/[,/+]/).map((x) => x.trim()).filter(Boolean);
    const joined = list.map((x) => key === 'set' || key === 's' ? x : cap(x)).join(', ');
    return { html: `<span class="label-text">${fieldLabel}: ${escapeHtml(joined)}</span>`, negated };
  }
  // text-ish fallback
  return {
    html: `<span class="label-text">${fieldLabel}: <i>${escapeHtml(val)}</i></span>`,
    negated,
  };
}
function cap(s) { s = String(s); return s ? s[0].toUpperCase() + s.slice(1) : s; }

function renderChips() {
  const wrap = $('#activeChips');
  const tokens = splitTopLevel(state.query);
  if (!tokens.length) {
    wrap.innerHTML = '<span class="empty">No filters — click a color, type, or filter above to start.</span>';
    return;
  }
  const html = tokens.map((tok) => {
    const { html, negated } = friendlyChip(tok);
    return `<span class="active-chip${negated ? ' negated' : ''}" title="${escapeHtml(tok)}">`
         + (negated ? '<b style="color:#a00">NOT</b> ' : '')
         + html
         + `<button class="x" data-token="${escapeAttr(tok)}" title="Remove">✕</button>`
         + `</span>`;
  }).join('');
  wrap.innerHTML = html + `<button class="clear-all" data-act="clear-all" title="Clear all filters">clear all</button>`;
}

function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

// ---------- builder <-> query sync ----------
//
// Builder fields manage a fixed slice of the query (specific tokens).
// Anything else in the bar (parens, OR groups, unknown fields, negations)
// passes through unchanged in the same place.

const BUILDER_KEYS = new Set([
  'c','color','ink','t','type','i','inkable','cost','r','rarity','kw','keyword',
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
  if (b.colors.length)    out.push('c:' + b.colors.join(','));
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
      case 'c': case 'color': case 'ink':
        p.val.split(/[,/+]/).forEach((c) => owned.colors.add(c.trim()));
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

function applyOwnedToBuilder(o) {
  const setActive = (sel, attr, set) => {
    document.querySelectorAll('#builder ' + sel).forEach((b) => {
      b.classList.toggle('active', set.has(b.dataset[attr]));
    });
  };
  setActive('.ink-btn[data-color]', 'color', o.colors);
  setActive('[data-type]', 'type', o.types);
  setActive('[data-rarity]', 'rarity', o.rarities);
  setActive('[data-kw]', 'kw', o.keywords);
  setActive('[data-set]', 'set', o.sets);
  document.querySelectorAll('#builder [data-inkable]').forEach((b) => {
    b.classList.toggle('active', b.dataset.inkable === o.inkable);
  });
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
    const qty = Deck.Deck.cards.get(c.id) || 0;
    t.className = 'card-tile' + (qty ? ' in-deck' : '');
    t.dataset.id = c.id;
    const owned = Auth.Session.collection ? Auth.ownedQty(c.id) : null;
    const inkChips = c.inks.map((ink) => `<span class="ink ink-${ink}" title="${ink}"></span>`).join('');
    const tags = roleTagsFor ? roleTagsFor(c) : '';
    t.innerHTML = `
      <img loading="lazy" src="${c.image}" alt="${escapeHtml(c.name + (c.title ? ' - ' + c.title : ''))}">
      ${qty ? `<div class="qty-badge">×${qty}</div>` : ''}
      <div class="label">
        <div class="name" title="${escapeHtml(c.name + (c.title ? ' — ' + c.title : ''))}">${escapeHtml(c.name)}</div>
        ${c.title ? `<div class="title">${escapeHtml(c.title)}</div>` : ''}
        <div class="stats">
          <span class="cost ${Deck.inkable(c) ? '' : 'uninkable'}" title="${Deck.inkable(c) ? 'Inkable' : 'Uninkable'}">${c.cost}</span>
          ${inkChips}
          ${owned ? `<span class="owned" title="Owned">own ${owned}</span>` : ''}
        </div>
        ${tags}
      </div>
    `;
    frag.appendChild(t);
  }
  grid.appendChild(frag);
}

// ---------- deck list ----------
let roleTagsFor = null;        // set by the role filters (card → tag html)
let renderRoleMeters = () => {};

function renderDeck() {
  const list = $('#deckList');
  list.innerHTML = '';
  const groups = Deck.grouped();
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
      row.innerHTML = `
        <span class="cost ${Deck.inkable(card) ? '' : 'uninkable'}">${card.cost}</span>
        <span class="name" title="${escapeHtml(card.name + (card.title ? ' - ' + card.title : ''))}">${escapeHtml(card.name)}${card.title ? ' <span class="muted">· ' + escapeHtml(card.title) + '</span>' : ''}</span>
        <span class="qty"><button data-act="dec" aria-label="One fewer">−</button><span>${qty}</span><button data-act="inc" aria-label="One more">+</button></span>
      `;
      section.appendChild(row);
    }
    list.appendChild(section);
  }
  if (Deck.Deck.cards.size === 0) {
    list.innerHTML = `<div class="deck-empty">Empty deck. Click cards in the pool to add them.</div>`;
  }

  const s = Deck.summary();
  $('#statCount').textContent = s.total;
  $('#statInkable').textContent = s.inkable;
  $('#statAvgCost').textContent = s.avgCost.toFixed(1);
  $('#mtabCount').textContent = s.total;
  $('#deckInks').innerHTML = s.inks.length ? s.inks.map((i) => `<span class="ink ink-${i}" title="${i}"></span>`).join('') : '';

  // ink curve: 1…7+ (0-cost folds into 1)
  const buckets = new Array(8).fill(0);
  for (const { card, qty } of Deck.entries()) buckets[Math.min(7, Math.max(1, card.cost || 0))] += qty;
  const peak = Math.max(1, ...buckets);
  $('#curve').innerHTML = buckets.slice(1).map((n, i) => `<div class="bar" title="${n} card${n === 1 ? '' : 's'} costing ${i + 1}${i === 6 ? '+' : ''}"><b>${n || ''}</b><i style="height:${(n / peak) * 50}px"></i>${i + 1}${i === 6 ? '+' : ''}</div>`).join('');

  const errs = Deck.legality();
  const lab = $('#deckLegality');
  if (errs.length === 0 && s.total >= 60) { lab.textContent = '✓ Legal'; lab.className = 'legal'; lab.title = ''; }
  else if (s.total === 0) { lab.textContent = ''; lab.className = 'legal'; }
  else { lab.textContent = errs[0][0].toUpperCase() + errs[0].slice(1); lab.className = 'legal bad'; lab.title = errs.join('\n'); }
  renderRoleMeters();
}

// ---------- UI wiring ----------
function wireUI() {
  // populate the dynamic Set toggles in the builder (3-digit set ids).
  const sets = [...new Set(DB.allCards.map((c) => c.setId))].sort();
  const setsEl = $('#bSets');
  for (const s of sets) {
    const b = document.createElement('button');
    b.className = 'tog-btn';
    b.dataset.set = s;
    b.textContent = s;
    setsEl.appendChild(b);
  }

  // search bar -> state
  let qTimer = 0;
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { applyFilters(); syncBuilderFromQuery(); renderChips(); }, 80);
  });
  $('#searchClearBtn').addEventListener('click', () => {
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
  $('#builderToggleBtn').addEventListener('click', () => {
    const b = $('#builder');
    b.classList.toggle('builder-collapsed');
    $('#builderToggleBtn').textContent = b.classList.contains('builder-collapsed')
      ? 'More filters ▾' : 'Fewer filters ▴';
  });

  // colored ink buttons
  document.querySelectorAll('.ink-btn[data-color]').forEach((b) => {
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
  document.querySelector('#builder [data-inkable=""]').classList.add('active');

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
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.dataset.act === 'clear-all') { setQuery(''); return; }
    if (btn.dataset.token) {
      removeToken(btn.dataset.token);
    }
  });

  $('#ownedOnly').addEventListener('change',  (e) => { state.ownedOnly = e.target.checked; applyFilters(); });

  // deck browser
  Decks.wire();
  $('#openDecksBtn').addEventListener('click', () => {
    Decks.open({
      onImport: ({ deck, errs }) => {
        Deck.Deck.id = null;
        setDeckName(deck.name || 'Imported deck');
        renderGrid(); renderDeck();
        if (errs && errs.length) {
          alert(`Imported "${deck.name}" but ${errs.length} cards couldn't be matched in our DB:\n\n${errs.slice(0, 10).join('\n')}`);
        }
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
  let pressT = 0, pressed = false;
  grid.addEventListener('touchstart', (e) => {
    const tile = e.target.closest('.card-tile'); if (!tile) return;
    pressed = false;
    pressT = setTimeout(() => { pressed = true; Deck.bump(tile.dataset.id, -1); navigator.vibrate?.(15); renderGrid(); renderDeck(); }, 450);
  }, { passive: true });
  grid.addEventListener('touchend', (e) => { clearTimeout(pressT); if (pressed) e.preventDefault(); }, { passive: false });
  grid.addEventListener('touchmove', () => clearTimeout(pressT), { passive: true });
  grid.addEventListener('mousemove', (e) => {
    const tile = e.target.closest('.card-tile'); if (!tile) return previewHide();
    const id = tile.dataset.id;
    const card = state.catalog.find((c) => c.id === id);
    if (card) previewShow(card.image, e.clientX, e.clientY, card.type === 'location');
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
    if (card) previewShow(card.image, e.clientX, e.clientY, card.type === 'location');
  });
  $('#deckList').addEventListener('mouseleave', previewHide);

  // deck toolbar
  $('#newDeckBtn').addEventListener('click', () => {
    if (Deck.Deck.cards.size && !confirm('Start a new deck? Unsaved changes to this one are lost.')) return;
    newDeck();
  });
  $('#deckTitle').addEventListener('change', (e) => { Deck.Deck.name = e.target.value.trim() || 'Untitled deck'; });
  $('#deckTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#deckPicker').addEventListener('change', async (e) => {
    const id = e.target.value; if (!id) return;
    const d = await account.getDeck(id);
    if (d) openDeck(d);
  });
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
  $('#deleteDeckBtn').addEventListener('click', async () => {
    if (!Deck.Deck.id || !confirm(`Delete "${Deck.Deck.name}"? This can't be undone.`)) return;
    try { await account.deleteDeck(Deck.Deck.id); newDeck(); }
    catch (e) { alert('Delete failed: ' + e.message); }
  });
  // phones: pool and deck are two tabs
  $$('.mtabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.mtabs button').forEach((x) => x.classList.toggle('on', x === b));
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
    if ($('#accountModal').classList.contains('show')) renderAccountModal();
  });
  $('#syncCollectionBtn').addEventListener('click', async () => {
    flash($('#syncCollectionBtn'), 'Syncing…');
    try {
      const owned = await Auth.syncCollection();
      showNotice(`Synced your Dreamborn collection: ${Object.keys(owned).length.toLocaleString()} owned printings. Tick “Owned only” to filter the pool.`);
      renderGrid();
      if ($('#accountModal').classList.contains('show')) renderAccountModal();
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

  // modals
  document.body.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-modal]') || e.target.classList.contains('modal-backdrop')) {
      const m = e.target.closest('.modal-backdrop');
      if (m) m.classList.remove('show');
    }
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal-backdrop.show').forEach((m) => m.classList.remove('show')); });

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

// ---------- modal helpers ----------
function openModal(sel)  { $(sel).classList.add('show'); }
function closeModal(sel) { $(sel).classList.remove('show'); }

// ---------- preview popover ----------
// Location cards are landscape but their art ships portrait, so the popout is
// rotated 90° clockwise (see .preview.location in style.css). When rotated the
// popover's footprint is landscape, so swap the collision-detection extents.
function previewShow(src, x, y, isLocation = false) {
  const p = $('#preview');
  const img = p.querySelector('img');
  if (img.src !== src) img.src = src;
  p.classList.toggle('location', !!isLocation);
  p.classList.add('show');
  // Position: prefer right side, fall back to left
  const W = isLocation ? 372 : 268;
  const H = isLocation ? 276 : 380;
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
