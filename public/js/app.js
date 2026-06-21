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

  // initial render of the chips strip
  renderChips();

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
    // bare-word oracle search
    return {
      html: `<span class="label-text">Text: <i>${escapeHtml(t.replace(/^"|"$/g, ''))}</i></span>`,
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
    t.className = 'card-tile';
    t.dataset.id = c.id;
    const qty = Deck.Deck.cards.get(c.id) || 0;
    const owned = Auth.Session.collection ? Auth.ownedQty(c.id) : null;
    const inkChips = c.inks.map(ink => `<span class="ink ink-${ink}" style="width:8px;height:8px;display:inline-block;outline:1px solid #000;"></span>`).join('');
    t.innerHTML = `
      <img loading="lazy" src="${c.image}" alt="${escapeHtml(c.name)}" onerror="this.style.background='#222'">
      ${qty ? `<div class="qty-badge">×${qty}</div>` : ''}
      <div class="label">
        <div class="name" title="${escapeHtml(c.name + (c.title ? ' — ' + c.title : ''))}">${escapeHtml(c.name)}</div>
        ${c.title ? `<div class="title">${escapeHtml(c.title)}</div>` : ''}
        <div class="stats">
          <span class="cost">${c.cost}</span>
          ${inkChips}
          ${typeof c.strength === 'number' && c.type === 'character' ? `<span title="strength">${c.strength}⚔</span>` : ''}
          ${typeof c.willpower === 'number' && (c.type === 'character' || c.type === 'location') ? `<span title="willpower">${c.willpower}❈</span>` : ''}
          ${typeof c.lore === 'number' && c.lore ? `<span title="lore">${c.lore}◇</span>` : ''}
          ${owned ? `<span class="owned" title="owned">×${owned}</span>` : ''}
        </div>
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
