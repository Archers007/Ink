// /admin → External calls: every request Ink makes to Dreamborn (and the duels.ink scaffold), from the recorder in
// lib/extcalls/. The store keeps at most the last 24 hours, so everything here is about "recently": how many calls per
// few minutes by kind, how they did, how full the store is, and a table to find one call and read what came back.
//
// admin.js builds the pane and tells this module when the tab opens and closes; while it's open it refreshes every
// 30 seconds. With ?mock=1 on localhost the data comes from admin-ext-mock.js instead of the server.

const RANGES = [1, 6, 24];
const BUCKET = { 1: '1m', 6: '5m', 24: '15m' };          // 60, 72 and 96 bars
const BUCKET_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3 };
const SOURCES = [['', 'All'], ['dreamborn', 'Dreamborn'], ['duels', 'duels.ink']];
const SOURCE_LABEL = { dreamborn: 'Dreamborn', duels: 'duels.ink' };

// One colour per kind, fixed, so a kind keeps its colour whatever the filter (checked for colour-blind separation on
// the panel background). Red is left out: it means errors. Kinds not listed here (duels.ink's, new ones) take a hue
// by name, and duels.ink kinds are hatched so the two sources stay apart even when hues repeat.
const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'];
const KNOWN = ['decks', 'deck', 'login', 'firebase-signin', 'user', 'owned', 'cardsdb'];

const X = {
  ctx: null, source: '', hours: 24, f: { kind: '', ok: '', caller: '', q: '' },
  stats: null, statsErr: null, calls: [], next: null, callsErr: null, callsLoading: false, pages: 0,
  callers: new Set(), kindSource: {}, detail: null, detailId: null, detailErr: null,
  open: false, timer: null, updated: null, seq: 0, mock: null, hover: -1,
};
const $ = (s) => X.ctx.root.querySelector(s);
const esc = (s) => X.ctx.esc(s);

// ---------- formatting ----------
const fmtN = (n) => Number(n || 0).toLocaleString();
function fmtBytes(b) {
  b = Number(b || 0);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}
const fmtMs = (ms) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);
const pct = (a, b) => (b ? (a / b) * 100 : 0);
const fmtPct = (p) => (p === 0 ? '0%' : p < 0.1 ? '<0.1%' : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`);
function longAgo(t) {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
const hhmm = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const hhmmss = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fullTime = (t) => new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const rangeWords = (h) => (h === 1 ? 'the last hour' : `the last ${h} hours`);

function kindColor(kind) {
  const i = KNOWN.indexOf(kind);
  if (i >= 0) return PALETTE[i];
  let h = 0;
  for (const c of String(kind)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const hatched = (kind) => (X.kindSource[kind] || 'dreamborn') !== 'dreamborn';
// stack order: the known Dreamborn kinds first, as listed, then the rest by name
const kindOrder = (a, b) => {
  const ia = KNOWN.indexOf(a), ib = KNOWN.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a).localeCompare(String(b));
};
const swatch = (kind) => `<span class="xsw${hatched(kind) ? ' hatch' : ''}" style="--c:${kindColor(kind)}"></span>`;

// ---------- data ----------
function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
}
async function get(path, params = {}) {
  if (X.ctx.mock) { X.mock ??= await import('./admin-ext-mock.js'); return X.mock.mockGet(path, params); }
  return X.ctx.api(path + qs(params));
}
const since = () => Date.now() - X.hours * 3600e3;
// The 404 the page gets before the server has the recorder reads better as words
const why = (e) => (/\(404\)/.test(e.message) ? 'this server doesn\'t have the external-calls recorder yet (404)' : e.message);

async function loadStats() {
  const seq = ++X.seq;
  try {
    const s = await get('/api/admin/ext/stats', { source: X.source, since: since(), bucket: BUCKET[X.hours] });
    if (seq !== X.seq) return;
    X.stats = s; X.statsErr = null; X.updated = Date.now();
    for (const k of s.kinds || []) X.kindSource[k.kind] = k.source;
  } catch (e) { if (seq === X.seq) X.statsErr = why(e); }
  fillTop(); fillChart(); fillKinds(); fillFilters();
}

let callsSeq = 0;
async function loadCalls(more = false) {
  const seq = ++callsSeq;
  X.callsLoading = true; fillTable();
  const f = X.f;
  try {
    const j = await get('/api/admin/ext/calls', { source: X.source, kind: f.kind, ok: f.ok, caller: f.caller, q: f.q, since: since(), before: more ? X.next : '', limit: 100 });
    if (seq !== callsSeq) return;
    X.calls = more ? [...X.calls, ...j.calls] : j.calls;
    X.next = j.next ?? null; X.pages = more ? X.pages + 1 : 1; X.callsErr = null;
    for (const c of j.calls) { if (c.caller) X.callers.add(c.caller); X.kindSource[c.kind] ??= c.source; }
  } catch (e) { if (seq === callsSeq) X.callsErr = why(e); }
  if (seq !== callsSeq) return;
  X.callsLoading = false;
  fillTable(); fillCallerList();
}

const refreshAll = () => Promise.all([loadStats(), loadCalls()]);

// every 30 s while the tab is open and the page is visible. The table only reloads while it's on its first page:
// someone who pressed "Load more" is reading further down and shouldn't be moved.
function tick() {
  if (!X.open || document.visibilityState !== 'visible') return;
  loadStats();
  if (X.pages <= 1 && !X.callsLoading) loadCalls();
}

// ---------- the shell, built once ----------
export function initExt(ctx) {
  X.ctx = ctx;
  const admin = ctx.role === 'admin';
  ctx.root.innerHTML = `
    ${ctx.mock ? '<div class="warn">Mock data (<code>?mock=1</code>): these calls are generated in the browser, not read from the server.</div>' : ''}
    <div class="box xc-head">
      <div class="xc-ctl">
        <div class="seg" role="group" aria-label="Source">${SOURCES.map(([v, l]) => `<button data-xsrc="${v}">${l}</button>`).join('')}</div>
        <div class="seg" role="group" aria-label="Range">${RANGES.map((h) => `<button data-xh="${h}">${h} h</button>`).join('')}</div>
        <span class="sp"></span>
        <span class="note" id="xcUpd"></span>
        <button class="btn btn-quiet btn-sm" id="xcRefresh">Refresh</button>
        ${admin ? '<a class="btn btn-quiet btn-sm" id="xcExport" href="#" title="Download these calls, bodies included, as NDJSON (one JSON row per line)">Export</a>' : ''}
      </div>
      <div class="xc-gauge" id="xcGauge"></div>
    </div>
    <div class="box" id="xcChartBox"><h2>Calls <span class="note" id="xcTotals"></span></h2><div id="xcChart" class="xc-chart"></div><div id="xcLegend" class="xc-legend"></div></div>
    <div class="xc-kinds" id="xcKinds"></div>
    <div class="box" id="xcTableBox">
      <h2>Find a call</h2>
      <div class="xc-filters">
        <select id="xfKind" aria-label="Kind"><option value="">Every kind</option></select>
        <select id="xfOk" aria-label="Outcome"><option value="">OK and errors</option><option value="1">OK only</option><option value="0">Errors only</option></select>
        <input type="text" id="xfCaller" list="xfCallers" placeholder="Caller, e.g. lab" aria-label="Caller" autocomplete="off"><datalist id="xfCallers"></datalist>
        <input type="search" id="xfQ" placeholder="Search path, query, error, caller" aria-label="Search">
      </div>
      <div id="xcTable"></div>
    </div>
    <aside class="xc-detail" id="xcDetail" hidden aria-label="Call detail"></aside>`;
  bind();
  fillTop(); fillChart(); fillKinds(); fillFilters(); fillTable();
}

export function showExt() {
  if (!X.ctx) return;
  X.open = true;
  clearInterval(X.timer);
  X.timer = setInterval(tick, 30000);
  refreshAll();
}
export function hideExt() {
  X.open = false;
  clearInterval(X.timer);
}

// ---------- fills ----------
function fillTop() {
  X.ctx.root.querySelectorAll('[data-xsrc]').forEach((b) => b.classList.toggle('on', b.dataset.xsrc === X.source));
  X.ctx.root.querySelectorAll('[data-xh]').forEach((b) => b.classList.toggle('on', Number(b.dataset.xh) === X.hours));
  $('#xcUpd').textContent = X.updated ? `Updated ${hhmmss(X.updated)}` : '';
  const ex = $('#xcExport');
  if (ex) ex.href = `/api/admin/ext/export${qs({ since: since(), source: X.source })}`;
  const st = X.stats?.store;
  const g = $('#xcGauge');
  if (!st) { g.innerHTML = X.statsErr ? '' : '<span class="note">Loading…</span>'; return; }
  const p = Math.min(100, pct(st.bytes, st.maxBytes));
  g.innerHTML = `<div class="xc-bar${p > 90 ? ' hot' : ''}" role="meter" aria-valuemin="0" aria-valuemax="${st.maxBytes}" aria-valuenow="${st.bytes}" aria-label="Store size"><i style="width:${Math.max(p, 0.5)}%"></i></div>
    <span><b>${fmtBytes(st.bytes)}</b> of ${fmtBytes(st.maxBytes)} · ${fmtN(st.rows)} calls · ${st.oldest ? `oldest ${longAgo(st.oldest)}` : 'empty'}</span>
    <span class="note">The store keeps the last ${st.hours} h and never more than ${fmtBytes(st.maxBytes)}; older calls drop off.</span>`;
}

function slots() {
  const size = BUCKET_MS[BUCKET[X.hours]];
  const count = Math.round((X.hours * 3600e3) / size);
  const end = Math.floor(Date.now() / size) * size;
  const start = end - (count - 1) * size;
  const out = Array.from({ length: count }, (_, i) => ({ t: start + i * size, n: 0, errors: 0, byKind: {}, p50: null, p95: null, bytes: 0 }));
  // the server sends only buckets that had calls; lay them on the full grid so gaps show as gaps
  for (const b of X.stats?.buckets || []) {
    const i = Math.round((Math.floor(b.t / size) * size - start) / size);
    if (i < 0 || i >= count) continue;
    const s = out[i];
    s.n += b.n; s.errors += b.errors || 0; s.bytes += b.bytes || 0; s.p50 = b.p50; s.p95 = b.p95;
    for (const [k, n] of Object.entries(b.byKind || {})) s.byKind[k] = (s.byKind[k] || 0) + n;
  }
  return { out, size };
}

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function fillChart() {
  const box = $('#xcChart'), legend = $('#xcLegend'), totals = $('#xcTotals');
  const s = X.stats;
  if (X.statsErr && !s) {
    totals.textContent = '';
    box.innerHTML = `<div class="xc-state err"><p><b>Couldn't load the external calls.</b> ${esc(X.statsErr)}.</p><p class="note">It tries again every 30 seconds while this tab is open.</p><button class="btn btn-quiet btn-sm" data-xretry>Try again</button></div>`;
    legend.innerHTML = '';
    return;
  }
  if (!s) { box.innerHTML = '<p class="note">Loading…</p>'; legend.innerHTML = ''; totals.textContent = ''; return; }
  // a failed refresh keeps the last numbers on screen and says so
  const stale = X.statsErr ? `<div class="warn">Couldn't refresh: ${esc(X.statsErr)}. Showing what was loaded at ${hhmmss(X.updated)}.</div>` : '';
  const t = s.totals || { n: 0, errors: 0, bytes: 0 };
  const what = X.source ? `${SOURCE_LABEL[X.source]} calls` : 'calls';
  if (!t.n) {
    totals.textContent = '';
    box.innerHTML = `${stale}<div class="xc-state"><p><b>No ${what} in ${rangeWords(X.hours)} yet.</b></p><p class="note">Each request Ink makes to ${X.source === 'duels' ? 'duels.ink' : X.source === 'dreamborn' ? 'Dreamborn' : 'Dreamborn or duels.ink'} shows up here within a few seconds of being made.</p></div>`;
    legend.innerHTML = '';
    return;
  }
  totals.textContent = `· ${fmtN(t.n)} in ${rangeWords(X.hours)} · ${fmtN(t.errors)} error${t.errors === 1 ? '' : 's'} (${fmtPct(pct(t.errors, t.n))}) · ${fmtBytes(t.bytes)}`;

  const { out, size } = slots();
  const kinds = [...new Set(out.flatMap((b) => Object.keys(b.byKind)))].sort(kindOrder);
  const W = Math.max(280, Math.round(box.clientWidth || 720)), H = 190;
  const L = 34, R = 6, T = 14, B = 22;
  const iw = W - L - R, ih = H - T - B;
  const bw = iw / out.length;
  const gap = bw >= 6 ? 2 : bw >= 3 ? 1 : 0;
  const max = niceMax(Math.max(...out.map((b) => b.n)));
  const y = (v) => T + ih - (v / max) * ih;
  const er = Math.min(3.5, Math.max(2, bw * 0.8));   // error dots shrink with the bars so they don't merge on a phone

  const pats = kinds.filter(hatched).map((k, i) => `<pattern id="xh${i}" data-k="${esc(k)}" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)"><rect width="5" height="5" fill="${kindColor(k)}"/><rect width="1.6" height="5" fill="rgba(8,11,31,.45)"/></pattern>`);
  const patId = Object.fromEntries(kinds.filter(hatched).map((k, i) => [k, `url(#xh${i})`]));
  const fill = (k) => patId[k] || kindColor(k);

  let grid = '', bars = '', marks = '', hits = '', xl = '';
  for (const v of [0, max / 2, max]) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="${v ? 'gl' : 'base'}"/><text x="${L - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" class="yl">${fmtN(v)}</text>`;
  }
  out.forEach((b, i) => {
    const x = L + i * bw + gap / 2, w = Math.max(1, bw - gap);
    let acc = 0;
    const present = kinds.filter((k) => b.byKind[k]);
    present.forEach((k, j) => {
      const n = b.byKind[k];
      const y0 = y(acc), y1 = y(acc + n);
      // a 1px panel-coloured gap between stacked kinds, where the segment is tall enough to spare it
      const h = Math.max(0.8, y0 - y1 - (j < present.length - 1 && y0 - y1 > 3 ? 1 : 0));
      bars += `<rect x="${x.toFixed(1)}" y="${(y0 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill(k)}"/>`;
      acc += n;
    });
    if (b.errors) marks += `<circle cx="${(x + w / 2).toFixed(1)}" cy="${(y(b.n) - 6).toFixed(1)}" r="${er}" class="em"/>`;
    hits += `<rect class="hit" data-i="${i}" x="${(L + i * bw).toFixed(1)}" y="${T - 10}" width="${bw.toFixed(2)}" height="${ih + 10}"/>`;
  });
  // time labels, at least ~80px apart, on round times
  const every = Math.max(1, Math.ceil(80 / bw));
  const stepMs = every * size;
  out.forEach((b, i) => {
    if (b.t % stepMs !== 0) return;
    const cx = L + i * bw + bw / 2;
    if (cx < L + 18 || cx > W - R - 18) return;
    xl += `<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle" class="xl">${hhmm(b.t)}</text>`;
  });
  box.innerHTML = `${stale}<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Calls per ${BUCKET[X.hours]} in ${rangeWords(X.hours)}, stacked by kind; red dots mark buckets with errors">
    <defs>${pats.join('')}</defs><g>${grid}</g><g class="hl"></g><g>${bars}</g><g>${marks}</g><g>${xl}</g><g>${hits}</g></svg><div class="xc-tip" hidden></div>`;
  box._slots = { out, kinds, L, bw, T, ih, size };
  legend.innerHTML = kinds.map((k) => `<span>${swatch(k)}${esc(k)}${X.source ? '' : hatched(k) ? ' <span class="note">duels.ink</span>' : ''}</span>`).join('') + '<span><span class="xem"></span>has errors</span>';
}

function showTip(i, clientX) {
  const box = $('#xcChart');
  const d = box._slots;
  const tip = box.querySelector('.xc-tip');
  if (!d || !tip) return;
  const b = d.out[i];
  if (!b) return hideTip();
  if (X.hover !== i) {
    X.hover = i;
    box.querySelector('.hl').innerHTML = `<rect x="${(d.L + i * d.bw).toFixed(1)}" y="${d.T - 10}" width="${d.bw.toFixed(2)}" height="${d.ih + 10}" class="hlr"/>`;
    const rows = d.kinds.filter((k) => b.byKind[k]).reverse();
    tip.innerHTML = `<div class="tt">${hhmm(b.t)}–${hhmm(b.t + d.size)}</div>
      ${b.n ? `<div><b>${fmtN(b.n)}</b> call${b.n === 1 ? '' : 's'}${b.errors ? ` · <span class="bad">${fmtN(b.errors)} error${b.errors === 1 ? '' : 's'}</span>` : ''}</div>
      ${rows.map((k) => `<div class="tk">${swatch(k)}<span>${esc(k)}</span><b>${fmtN(b.byKind[k])}</b></div>`).join('')}
      <div class="note">p50 ${fmtMs(b.p50)} · p95 ${fmtMs(b.p95)} · ${fmtBytes(b.bytes)}</div>` : '<div class="note">No calls</div>'}`;
  }
  tip.hidden = false;
  const r = box.getBoundingClientRect();
  const x = clientX - r.left;
  const w = tip.offsetWidth;
  // beside the pointer, flipping to the other side near the right edge
  const left = x + 14 + w > r.width ? Math.max(0, x - 14 - w) : x + 14;
  tip.style.left = `${left}px`;
}
function hideTip() {
  const box = $('#xcChart');
  X.hover = -1;
  const tip = box.querySelector('.xc-tip'); if (tip) tip.hidden = true;
  const hl = box.querySelector('.hl'); if (hl) hl.innerHTML = '';
}

function fillKinds() {
  const el = $('#xcKinds');
  const ks = [...(X.stats?.kinds || [])].filter((k) => k.n).sort((a, b) => (a.source === b.source ? 0 : a.source === 'dreamborn' ? -1 : 1) || kindOrder(a.kind, b.kind));
  if (!ks.length) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = ks.map((k) => {
    const ep = pct(k.errors, k.n);
    const on = X.f.kind === k.kind;
    return `<button class="xc-kind${on ? ' on' : ''}" data-xkind="${esc(k.kind)}" aria-pressed="${on}" title="${on ? 'Show every kind in the table' : `Show only ${esc(k.kind)} calls in the table`}">
      <div class="xk-top">${swatch(k.kind)}<b>${esc(k.kind)}</b><span class="note">${esc(SOURCE_LABEL[k.source] || k.source)}</span></div>
      <div class="xk-n">${fmtN(k.n)} <span class="note">call${k.n === 1 ? '' : 's'}</span></div>
      <div class="xk-row"><span class="${k.errors ? 'bad' : ''}">${fmtPct(ep)} errors</span><span>${fmtBytes(k.bytes)}</span></div>
      <div class="xk-row"><span>p50 ${fmtMs(k.p50)}</span><span>p95 ${fmtMs(k.p95)}</span></div>
      <div class="xk-row note"><span>last call ${k.last ? longAgo(k.last) : '—'}</span></div>
    </button>`;
  }).join('');
}

function fillFilters() {
  const sel = $('#xfKind');
  const kinds = [...new Set([...(X.stats?.kinds || []).map((k) => k.kind), ...(X.f.kind ? [X.f.kind] : [])])].sort(kindOrder);
  sel.innerHTML = `<option value="">Every kind</option>${kinds.map((k) => `<option value="${esc(k)}" ${k === X.f.kind ? 'selected' : ''}>${esc(k)}</option>`).join('')}`;
  $('#xfOk').value = X.f.ok;
}
function fillCallerList() {
  $('#xfCallers').innerHTML = [...X.callers].sort().map((c) => `<option value="${esc(c)}">`).join('');
}

const filtering = () => !!(X.f.kind || X.f.ok || X.f.caller || X.f.q);
function statusChip(c) {
  if (c.status === 0) return '<span class="xs bad" title="No response: the request failed before an HTTP status came back">network</span>';
  return `<span class="xs ${c.ok ? 'ok' : 'bad'}">${c.status}</span>`;
}
function fillTable() {
  const el = $('#xcTable');
  if (X.callsErr && !X.calls.length) {
    el.innerHTML = `<div class="xc-state err"><p><b>Couldn't load the calls.</b> ${esc(X.callsErr)}.</p><button class="btn btn-quiet btn-sm" data-xretry>Try again</button></div>`;
    return;
  }
  if (!X.pages && X.callsLoading) { el.innerHTML = '<p class="note">Loading…</p>'; return; }
  if (!X.calls.length) {
    el.innerHTML = filtering()
      ? `<div class="xc-state"><p>No calls in ${rangeWords(X.hours)} match these filters.</p><button class="btn btn-quiet btn-sm" data-xclear>Clear the filters</button></div>`
      : `<div class="xc-state"><p>No ${X.source ? `${SOURCE_LABEL[X.source]} ` : ''}calls in ${rangeWords(X.hours)} yet.</p></div>`;
    return;
  }
  const all = !X.source;   // with both sources showing, name the non-Dreamborn one
  el.innerHTML = `<div class="xc-tbl"><table class="users xc-calls"><thead><tr><th>When</th><th>Kind</th><th>Status</th><th>Request</th><th class="r">Time</th><th class="r">Size</th><th>Caller</th></tr></thead><tbody>
    ${X.calls.map((c) => `<tr data-xid="${c.id}" class="${c.id === X.detailId ? 'sel' : ''}" tabindex="0">
      <td class="note nw" title="${esc(fullTime(c.at))}">${hhmmss(c.at)}</td>
      <td class="nw">${swatch(c.kind)}${esc(c.kind)}${all && c.source !== 'dreamborn' ? ` <span class="note">${esc(SOURCE_LABEL[c.source] || c.source)}</span>` : ''}</td>
      <td class="nw">${statusChip(c)}${c.cache === 'hit' ? ' <span class="xs cache" title="Served from Ink\'s own cache, no request made">cache</span>' : ''}</td>
      <td class="req"><code><span class="m">${esc(c.method)}</span> ${esc(c.path)}${c.query ? `<span class="qy">?${esc(c.query)}</span>` : ''}</code>${c.error ? `<div class="bad">${esc(c.error)}</div>` : ''}</td>
      <td class="r nw">${c.cache === 'hit' ? '—' : fmtMs(c.ms)}</td>
      <td class="r nw">${fmtBytes(c.bytes)}${c.has_body ? ' <span class="xs body" title="The response body was kept; open the row to read it">body</span>' : ''}</td>
      <td class="note nw">${esc(c.caller || '')}</td></tr>`).join('')}
  </tbody></table></div>
  <div class="xc-more"><span class="note">${fmtN(X.calls.length)} call${X.calls.length === 1 ? '' : 's'} shown, newest first${X.callsErr ? ` · <span class="bad">${esc(X.callsErr)}</span>` : ''}</span>
    ${X.next ? `<button class="btn btn-quiet btn-sm" data-xmore ${X.callsLoading ? 'disabled' : ''}>${X.callsLoading ? 'Loading…' : 'Load more'}</button>` : '<span class="note">· that\'s all of them</span>'}</div>`;
}

// ---------- detail ----------
const FIELD_ORDER = ['id', 'at', 'source', 'kind', 'method', 'host', 'path', 'query', 'status', 'ok', 'ms', 'bytes', 'cache', 'caller', 'user_id', 'ref', 'error', 'body_type', 'body_bytes', 'body_trunc'];
function fieldValue(k, v) {
  if (v == null || v === '') return '<span class="note">—</span>';
  if (k === 'at') return `${esc(fullTime(v))} <span class="note">(${esc(longAgo(v))} · ${esc(v)})</span>`;
  if (k === 'ok' || k === 'body_trunc') return v ? 'yes' : 'no';
  if (k === 'ms') return `${esc(v)} ms`;
  if (k === 'bytes' || k === 'body_bytes') return `${esc(fmtBytes(v))} <span class="note">(${esc(fmtN(v))} bytes)</span>`;
  if (k === 'status' && Number(v) === 0) return '0 <span class="note">(network error, no response)</span>';
  if (k === 'error') return `<span class="bad">${esc(v)}</span>`;
  if (k === 'source') return esc(SOURCE_LABEL[v] || v);
  return esc(typeof v === 'object' ? JSON.stringify(v) : v);
}
function bodyText(d) {
  if (d.json != null) return JSON.stringify(d.json, null, 2);
  if (d.body == null) return null;
  if (/json/i.test(d.body_type || '')) { try { return JSON.stringify(JSON.parse(d.body), null, 2); } catch { /* show it as it came */ } }
  return String(d.body);
}
function fillDetail() {
  const el = $('#xcDetail');
  if (X.detailId == null) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const head = `<div class="xd-head"><h2>Call #${esc(X.detailId)}</h2><span class="sp"></span><button class="btn btn-quiet btn-sm" data-xclose aria-label="Close the detail">Close</button></div>`;
  if (X.detailErr) { el.innerHTML = `${head}<div class="xc-state err"><p><b>Couldn't load this call.</b> ${esc(X.detailErr)}.</p><p class="note">It may have aged out of the store.</p></div>`; return; }
  const d = X.detail;
  if (!d) { el.innerHTML = `${head}<p class="note">Loading…</p>`; return; }
  const keys = [...FIELD_ORDER.filter((k) => k in d), ...Object.keys(d).filter((k) => !FIELD_ORDER.includes(k) && k !== 'body' && k !== 'json')];
  const url = `${d.host ? `https://${d.host}` : ''}${d.path || ''}${d.query ? `?${d.query}` : ''}`;
  const text = bodyText(d);
  el.innerHTML = `${head}
    <div class="xd-url"><code><span class="m">${esc(d.method || '')}</span> ${esc(url)}</code></div>
    <dl class="xd-fields">${keys.map((k) => `<dt>${esc(k)}</dt><dd>${fieldValue(k, d[k])}</dd>`).join('')}</dl>
    <h3>Response body</h3>
    ${text == null
      ? '<p class="note">No body kept for this call. Only some kinds keep what came back (deck lists, deck pages); sign-in and account calls never do.</p>'
      : `<div class="xd-bodyhead"><span class="note">${esc(d.json != null ? 'JSON' : d.body_type || 'text')} · ${fmtBytes(d.body_bytes ?? text.length)} kept${d.body_trunc ? ' · <span class="bad">cut at 256 KB</span>' : ''}</span><span class="sp"></span><button class="btn btn-quiet btn-sm" data-xcopy>Copy</button></div>
        <pre class="xd-body" id="xdBody">${esc(text)}</pre>`}`;
}
async function openDetail(id) {
  X.detailId = id; X.detail = null; X.detailErr = null;
  X.ctx.root.querySelectorAll('tr[data-xid]').forEach((tr) => tr.classList.toggle('sel', Number(tr.dataset.xid) === id));
  fillDetail();
  $('#xcDetail').scrollTop = 0;
  try { const d = await get(`/api/admin/ext/calls/${id}`); if (X.detailId === id) X.detail = d; }
  catch (e) { if (X.detailId === id) X.detailErr = why(e); }
  if (X.detailId === id) fillDetail();
}
function closeDetail() {
  X.detailId = null; X.detail = null;
  X.ctx.root.querySelectorAll('tr.sel').forEach((tr) => tr.classList.remove('sel'));
  fillDetail();
}

// ---------- events ----------
let debounce = null;
function bind() {
  const root = X.ctx.root;
  root.addEventListener('click', async (e) => {
    const t = e.target;
    const src = t.closest('[data-xsrc]');
    if (src) { X.source = src.dataset.xsrc; X.f.kind = ''; X.stats = null; fillTop(); fillChart(); refreshAll(); return; }
    const h = t.closest('[data-xh]');
    if (h) { X.hours = Number(h.dataset.xh); fillTop(); refreshAll(); return; }
    if (t.closest('#xcRefresh') || t.closest('[data-xretry]')) { refreshAll(); return; }
    const ex = t.closest('#xcExport');
    if (ex && X.ctx.mock) {
      // mock mode: the same NDJSON the server would send, made here
      e.preventDefault();
      if (!X.mock) return;
      const blob = new Blob([X.mock.mockExport({ since: since(), source: X.source })], { type: 'application/x-ndjson' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'extcalls-mock.ndjson'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return;
    }
    const k = t.closest('[data-xkind]');
    if (k) { X.f.kind = X.f.kind === k.dataset.xkind ? '' : k.dataset.xkind; fillKinds(); fillFilters(); loadCalls(); return; }
    if (t.closest('[data-xclear]')) {
      X.f = { kind: '', ok: '', caller: '', q: '' };
      $('#xfCaller').value = ''; $('#xfQ').value = '';
      fillKinds(); fillFilters(); loadCalls(); return;
    }
    if (t.closest('[data-xmore]')) { loadCalls(true); return; }
    if (t.closest('[data-xclose]')) { closeDetail(); return; }
    const cp = t.closest('[data-xcopy]');
    if (cp) {
      const text = $('#xdBody')?.textContent || '';
      try { await navigator.clipboard.writeText(text); cp.textContent = 'Copied'; }
      catch { getSelection().selectAllChildren($('#xdBody')); cp.textContent = 'Selected · copy it now'; }
      setTimeout(() => { cp.textContent = 'Copy'; }, 2000);
      return;
    }
    const tr = t.closest('tr[data-xid]');
    if (tr && !String(getSelection()).trim()) openDetail(Number(tr.dataset.xid));
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches?.('tr[data-xid]')) { e.preventDefault(); openDetail(Number(e.target.dataset.xid)); }
  });
  if (!X.escBound) { X.escBound = true; document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && X.open && X.detailId != null) closeDetail(); }); }
  root.addEventListener('change', (e) => {
    if (e.target.id === 'xfKind') { X.f.kind = e.target.value; fillKinds(); loadCalls(); }
    else if (e.target.id === 'xfOk') { X.f.ok = e.target.value; loadCalls(); }
  });
  // typing waits a moment before asking again
  root.addEventListener('input', (e) => {
    const id = e.target.id;
    if (id !== 'xfCaller' && id !== 'xfQ') return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const v = e.target.value.trim();
      if (id === 'xfCaller' ? X.f.caller === v : X.f.q === v) return;
      if (id === 'xfCaller') X.f.caller = v; else X.f.q = v;
      loadCalls();
    }, 300);
  });
  const chart = $('#xcChart');
  chart.addEventListener('pointermove', (e) => { const hit = e.target.closest?.('[data-i]'); if (hit) showTip(Number(hit.dataset.i), e.clientX); else hideTip(); });
  chart.addEventListener('pointerdown', (e) => { const hit = e.target.closest?.('[data-i]'); if (hit) showTip(Number(hit.dataset.i), e.clientX); });
  chart.addEventListener('pointerleave', hideTip);
  // the chart is drawn to its box's width; redraw when that changes
  let raf = 0, lastW = 0;
  new ResizeObserver(() => {
    const w = chart.clientWidth;
    if (!X.open || !w || Math.abs(w - lastW) < 2) return;
    lastW = w;
    cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { X.hover = -1; fillChart(); });
  }).observe(chart);
}
