// /rules — the card rules page (public/procs.html). Search every card, then read it the way a player needs it: the
// rules text, what each keyword on it means (Comprehensive Rules 2.3.0, section 8), Ravensburger's FAQ for it, and for
// each ability whether Ink runs it for you or the players resolve it by hand.
//
// Admins get an "Engine view" switch that brings back what this page used to be: each ability's compiled proc and its
// plain-English read-back, the proc filters in search (fn:, kind:, ev:, status:, why:, with:), and the coverage
// numbers. The server only sends those to admins (/api/procs/*, server.js).
//
//   /rules?card=Mirabel Madrigal - Family Guardian · /rules?kw=evasive · /rules?stats (engine view)

import * as account from '/js/account.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IMG = (id) => `https://cdn.dreamborn.ink/images/en/cards/${id}`;
const ICON = { ink: ['⬡', 'ink'], strength: ['⚔️', 'strength'], willpower: ['🛡️', 'willpower'], lore: ['◆', 'lore'], exert: ['⟳', 'exert'], inkable: ['◉', 'inkable'] };
const icons = (t) => esc(t).replace(/\{(\w+)\}/g, (m, k) => (ICON[k] ? `<i class="ico" role="img" aria-label="${ICON[k][1]}" title="${ICON[k][1]}">${ICON[k][0]}</i>` : m));
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
const STATUS = { auto: 'runs itself', partial: 'partly automated', manual: 'manual', vanilla: 'no abilities' };
const PAGE = 80;

// Comprehensive Rules 2.3.0 section 8, in plain words. key = the card's kw key
const KEYWORDS = {
  alert: { name: 'Alert', cr: '8.2', say: () => 'Can challenge characters with Evasive as if it had Evasive. It doesn’t gain Evasive itself.' },
  bodyguard: { name: 'Bodyguard', cr: '8.3', say: () => 'May enter play exerted. While it’s in play, an opponent choosing one of your characters to challenge must choose a Bodyguard character if they can.' },
  boost: { name: 'Boost', cr: '8.4', say: (n) => `Once during your turn, you may pay ${n ?? 'N'} ⬡ to put the top card of your deck facedown under this card. Nobody can look at cards put under it.` },
  challenger: { name: 'Challenger', cr: '8.5', say: (n) => `Gets +${n ?? 'N'} ⚔️ while it’s challenging (not while it’s being challenged). Stacks with other Challenger.` },
  evasive: { name: 'Evasive', cr: '8.6', say: () => 'Can only be challenged by characters with Evasive (or Alert).' },
  reckless: { name: 'Reckless', cr: '8.7', say: () => 'Can’t quest, and you can’t end your turn while it’s ready and able to challenge. It can still be exerted to sing or use abilities.' },
  resist: { name: 'Resist', cr: '8.8', say: (n) => `Damage dealt to it is reduced by ${n ?? 'N'}. Damage that’s put or moved onto it isn’t reduced. Stacks with other Resist.` },
  rush: { name: 'Rush', cr: '8.9', say: () => 'Can challenge the turn it’s played, as though it had been in play since the start of your turn.' },
  shift: { name: 'Shift', cr: '8.10', say: (n) => `Instead of its ink cost, you may pay ${typeof n === 'number' ? `${n} ⬡` : n ? esc(n) : 'its Shift cost'} to play it on top of one of your characters with the same name. It keeps that character’s damage and lasting effects, and if that character was dry it can quest, challenge and sing straight away. If the one underneath was exerted, it enters exerted.` },
  singer: { name: 'Singer', cr: '8.11', say: (n) => `Counts as cost ${n ?? 'N'} when it exerts to sing a song. Its ink cost doesn’t change.` },
  singTogether: { name: 'Sing Together', cr: '8.12', say: (n) => `Any number of your ready characters with a total cost of ${n ?? 'N'} or more can exert together to sing this song for free.` },
  support: { name: 'Support', cr: '8.13', say: () => 'Whenever it quests, you may add its ⚔️ to another chosen character’s ⚔️ this turn.' },
  vanish: { name: 'Vanish', cr: '8.14', say: () => 'When an opponent chooses it for an action’s effect, it’s banished after that effect resolves.' },
  ward: { name: 'Ward', cr: '8.15', say: () => 'Opponents can’t choose it when resolving an effect. Effects that don’t choose still affect it.' },
  adventurous: { name: 'Adventurous', cr: '8.16', say: () => 'Can’t challenge, and you can’t end your turn while it’s ready and able to quest. It can still be exerted to sing or use abilities.' },
};
const kwKey = (k) => String(k).toLowerCase().replace(/[^a-z]/g, '');
const KW_BY = Object.fromEntries(Object.entries(KEYWORDS).map(([k, v]) => [kwKey(k), { key: k, ...v }]));

const params = new URLSearchParams(location.search);
const S = {
  q: '', inks: new Set(), type: '', kw: params.get('kw') || '', limit: PAGE,
  sel: null, card: null, printing: null, admin: false,
  engine: (() => { try { return localStorage.getItem('ink.rules.engine') === '1'; } catch { return false; } })(),
};

const api = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); };
const engineOn = () => S.admin && S.engine;

// ---------- search ----------
function query() {
  const parts = [S.q];
  if (S.type) parts.push(`type:${S.type}`);
  if (S.kw) parts.push(`kw:${S.kw}`);
  return parts.filter(Boolean).join(' ');
}
let seq = 0;
async function runSearch() {
  const my = ++seq;
  // the inks are OR'd on the client: the server's filters are AND'd, and two inks on one card is rare enough to ask for
  const inks = [...S.inks];
  const want = inks.length ? 400 : S.limit;
  let res;
  try { res = await api(`/api/procs/search?q=${encodeURIComponent(query())}&limit=${want}${engineOn() ? '&engine=1' : ''}`); }
  catch (e) { $('#meta').textContent = e.message; return; }
  if (my !== seq) return;
  let rows = res.results, total = res.total;
  if (inks.length) { rows = rows.filter((r) => (r.inks || []).some((i) => S.inks.has(i))); total = rows.length + (res.total > res.results.length ? '+' : ''); rows = rows.slice(0, S.limit); }
  $('#meta').textContent = `${total} card${total === 1 ? '' : 's'}${rows.length < parseInt(total) ? ` · showing ${rows.length}` : ''}`;
  $('#list').innerHTML = rows.map((r) => `<div class="r ${r.full === S.sel ? 'sel' : ''}" role="option" aria-selected="${r.full === S.sel}" data-full="${esc(r.full)}" tabindex="-1">
      <img src="${IMG(r.id)}" alt="" loading="lazy" decoding="async">
      <span class="nm"><b>${esc(r.full.split(' - ')[0])}</b><span>${esc(r.full.split(' - ').slice(1).join(' - ') || cap(r.type))}</span></span>
      <span class="side">${engineOn() && r.status ? `<span class="dot s-${r.status}" title="${esc(STATUS[r.status])} · ${r.runnable}/${r.abilities}"></span>` : ''}${(r.inks || []).map((i) => `<span class="dot ${i}" title="${cap(i)}"></span>`).join('')}<span class="cost" title="Cost ${r.cost}">${r.cost}</span></span></div>`).join('')
    + (rows.length < parseInt(total) ? '<button class="btn btn-quiet more" id="moreBtn">Show more</button>' : '');
  $('#moreBtn')?.addEventListener('click', () => { S.limit += PAGE; runSearch(); });
  $('#kwChip').hidden = !S.kw;
  if (S.kw) $('#kwChip').innerHTML = `Keyword: <b>${esc(KW_BY[kwKey(S.kw)]?.name || S.kw)}</b><button id="kwClear" aria-label="Clear the keyword filter">✕ clear</button>`;
  $('#kwClear')?.addEventListener('click', () => { S.kw = ''; S.limit = PAGE; syncUrl(); runSearch(); });
}
let timer = 0;
$('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { S.q = $('#q').value.trim(); S.limit = PAGE; runSearch(); }, 140); });
$('#q').addEventListener('keydown', (e) => {
  const rows = [...document.querySelectorAll('.r')];
  if (e.key === 'Enter' && rows[0]) { e.preventDefault(); show(rows[0].dataset.full); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const i = rows.findIndex((r) => r.dataset.full === S.sel);
  const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
  if (n) { show(n.dataset.full, { keepFocus: true }); n.scrollIntoView({ block: 'nearest' }); }
});
$('#list').addEventListener('click', (e) => { const r = e.target.closest('.r'); if (r) show(r.dataset.full); });
document.querySelectorAll('.ink').forEach((b) => b.addEventListener('click', () => {
  S.inks.has(b.dataset.ink) ? S.inks.delete(b.dataset.ink) : S.inks.add(b.dataset.ink);
  b.setAttribute('aria-pressed', String(S.inks.has(b.dataset.ink)));
  S.limit = PAGE; runSearch();
}));
$('#type').addEventListener('change', () => { S.type = $('#type').value; S.limit = PAGE; runSearch(); });

function syncUrl() {
  const u = new URL(location.href);
  u.search = '';
  if (S.sel) u.searchParams.set('card', S.sel);
  else if (S.kw) u.searchParams.set('kw', S.kw);
  history.replaceState(null, '', u);
}

// ---------- one card ----------
async function show(full, { keepFocus = false } = {}) {
  S.sel = full;
  document.querySelectorAll('.r').forEach((el) => { const on = el.dataset.full === full; el.classList.toggle('sel', on); el.setAttribute('aria-selected', String(on)); });
  syncUrl();
  let c;
  try { c = await api(`/api/procs/card?full=${encodeURIComponent(full)}`); }
  catch (e) { $('#detail').innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  if (S.sel !== full) return;
  S.card = c; S.printing = c.id;
  document.body.classList.add('viewing');
  renderCard();
  if (!keepFocus) { $('#detail').scrollTop = 0; if (matchMedia('(max-width: 860px)').matches) window.scrollTo(0, 0); }
}

function renderCard() {
  const c = S.card, eng = engineOn() ? c.engine : null;
  const sub = c.full.split(' - ').slice(1).join(' - ');
  const facts = [
    `<span class="fact">${(c.inks || []).map((i) => `<span class="dot ${i}"></span>`).join('')}<b>${esc((c.inks || []).map(cap).join(' / '))}</b></span>`,
    `<span class="fact"><b>${cap(c.type)}</b></span>`,
    `<span class="fact">${c.inkable ? '◉ <b>Inkable</b>' : 'Not inkable'}</span>`,
    ...(c.classes || []).map((k) => `<span class="fact">${esc(k.split(' ').map(cap).join(' '))}</span>`),
  ].join('');
  const stats = c.type === 'character' ? [['⚔️', c.str, 'Strength'], ['🛡️', c.wp, 'Willpower'], ['◆', c.lore, 'Lore']]
    : c.type === 'location' ? [['🛡️', c.wp, 'Willpower'], ['◆', c.lore, 'Lore'], ['⇢', c.move, 'Move cost']] : [];
  const kws = Object.entries(c.kw || {}).map(([k, v]) => ({ k: KW_BY[kwKey(k)], v })).filter((x) => x.k);
  const prints = c.printings || [];
  $('#detail').innerHTML = `
    <button class="btn btn-quiet btn-sm back" id="backBtn">← Results</button>
    <article class="card">
      <div class="art">
        <img id="artImg" src="${IMG(S.printing)}" alt="${esc(c.full)}" title="Click for full size">
        ${prints.length > 1 ? `<div class="prints" role="group" aria-label="Printings">${prints.map((p) => `<button data-print="${esc(p.id)}" aria-pressed="${p.id === S.printing}" title="Set ${esc(p.set)} · #${esc(p.num)}${p.rarity ? ` · ${esc(p.rarity)}` : ''}"><img src="${IMG(p.id)}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}
        <div class="cap">${c.printed ? `Text from ${esc(c.printed)}` : ''}${prints.length > 1 ? `${c.printed ? ' · ' : ''}${prints.length} printings` : ''}</div>
      </div>
      <div>
        <div class="head"><span class="cost big" title="Ink cost">${c.cost}</span><div><h1>${esc(c.full.split(' - ')[0])}</h1>${sub ? `<div class="ttl">${esc(sub)}</div>` : ''}</div></div>
        <div class="facts">${facts}</div>
        ${stats.length ? `<div class="stats">${stats.map(([i, n, l]) => `<div class="stat"><b>${n ?? '–'} <span aria-hidden="true">${i}</span></b><span>${l}</span></div>`).join('')}</div>` : ''}
        ${eng ? `<div style="margin-top:12px"><span class="pill s-${eng.status}">${STATUS[eng.status]} · ${eng.abilities.length ? `${eng.runnable}/${eng.abilities.length}` : 'base proc'}</span><span class="pill" title="Where the rules text came from (tools/card-scan)">text: ${esc(eng.rulesSource || 'db')}</span></div>` : ''}

        <h2 class="sec">Rules text</h2>
        ${c.abilities.length ? c.abilities.map((a, i) => abilityHtml(a, eng?.abilities?.[i], i)).join('') : `<div class="ab"><span class="empty">No rules text. This card is just its cost${stats.length ? ' and stats' : ''}.</span></div>`}
        ${eng?.base ? `<div class="ab"><div class="txt"><b class="an">Printed card</b><span class="hint">what every copy does before its abilities</span></div><div class="eng"><div class="rb">${eng.baseExplain.map((l) => icons(l)).join('\n')}</div><details><summary>proc JSON</summary><pre class="json">${highlight(eng.base)}</pre></details></div></div>` : ''}

        ${kws.length ? `<h2 class="sec">Keywords</h2><dl class="kw">${kws.map(({ k, v }) => `<dt>${esc(k.name)}${typeof v === 'number' ? ` ${k.key === 'challenger' || k.key === 'resist' ? '+' : ''}${v}` : ''}</dt><dd>${k.say(typeof v === 'boolean' ? null : v)} <span class="cr">CR ${k.cr}</span></dd>`).join('')}</dl>` : ''}

        ${c.faq?.length ? `<h2 class="sec">Official FAQ</h2><div class="faq">${c.faq.map((f) => `<div class="qa">${f.q ? `<div class="q">${icons(f.q)}</div>` : ''}<div class="a">${icons(f.a)}</div></div>`).join('')}</div>` : ''}

        ${c.flavor ? `<p class="flavor">${esc(c.flavor)}</p>` : ''}
        <div class="foot">
          <a class="btn btn-quiet btn-sm" href="/report?kind=bug&from=${encodeURIComponent(location.href)}" title="Ink plays this card wrong, or its text here is off">🐞 Report a problem with this card</a>
          ${c.franchise ? `<span class="hint" style="align-self:center">${esc(c.franchise)}</span>` : ''}
        </div>
      </div>
    </article>`;
  $('#backBtn').onclick = () => { document.body.classList.remove('viewing'); S.sel = null; syncUrl(); document.querySelector('.r.sel')?.scrollIntoView({ block: 'center' }); };
  $('#artImg').onclick = () => zoom(IMG(S.printing), c.full);
  document.querySelectorAll('[data-print]').forEach((b) => { b.onclick = () => { S.printing = b.dataset.print; renderCard(); }; });
  document.querySelectorAll('button.copy').forEach((b) => { b.onclick = () => { navigator.clipboard.writeText(JSON.stringify(eng.abilities[+b.dataset.i].proc, null, 2)); b.textContent = 'copied'; }; });
}

function abilityHtml(a, e, i) {
  const how = a.keyword ? (a.auto ? '<span class="how auto">⚡ Ink enforces this</span>' : '<span class="how hand">✋ Players keep track of this</span>')
    : a.auto ? '<span class="how auto">⚡ Ink does this for you</span>' : '<span class="how hand">✋ You resolve this by hand at the table</span>';
  return `<div class="ab"><div class="txt">${a.name ? `<b class="an">${esc(a.name)}</b>` : ''}${icons(a.text)}</div>${how}
    ${e ? `<div class="eng"><span class="lbl">Engine</span><div class="rb">${e.explain.map((l) => (/^why/.test(l) ? `<span class="why">${icons(l)}</span>` : icons(l))).join('\n')}</div>
      <details><summary>proc JSON</summary><button class="copy" data-i="${i}">copy</button><pre class="json">${highlight(e.proc)}</pre></details></div>` : ''}</div>`;
}

function highlight(obj) {
  return esc(JSON.stringify(obj, null, 2))
    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)/g, '<span class="k">$1</span>$2')
    .replace(/(:\s*|\[\s*|,\s*)(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, '$1<span class="s">$2</span>')
    .replace(/\b(-?\d+(?:\.\d+)?)\b(?![^<]*<\/span>)/g, '<span class="nm">$1</span>')
    .replace(/\b(true|false|null)\b/g, '<span class="b">$1</span>');
}

function zoom(src, alt) {
  const z = $('#zoom');
  z.innerHTML = `<img src="${esc(src)}" alt="${esc(alt)}">`;
  z.hidden = false;
  const close = () => { z.hidden = true; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  z.onclick = close;
  document.addEventListener('keydown', onKey);
}

// ---------- the page with no card open: what's here, and the keywords ----------
function landing() {
  S.sel = null; S.card = null;
  document.body.classList.remove('viewing');
  $('#detail').innerHTML = `<div class="landing">
    <h1>Card rules</h1>
    <p class="lede">Look up any card to read its rules text, what its keywords mean, and Ravensburger’s official FAQ for it. Each ability also says whether Ink plays it for you or you resolve it at the table.</p>
    ${engineOn() ? '<p><button class="btn btn-quiet btn-sm" id="covBtn">🔧 Engine coverage</button></p>' : ''}
    <h2 class="sec">Keywords</h2>
    <div class="glossary">${Object.entries(KEYWORDS).map(([k, v]) => `<button class="gk" data-kw="${k}"><b>${v.name}</b><span>${v.say(null)}</span><em>CR ${v.cr} · show cards with ${v.name}</em></button>`).join('')}</div>
  </div>`;
  document.querySelectorAll('[data-kw]').forEach((b) => { b.onclick = () => { S.kw = b.dataset.kw; S.limit = PAGE; syncUrl(); runSearch(); $('#q').focus(); }; });
  $('#covBtn')?.addEventListener('click', showStats);
}

// ---------- engine view (admins) ----------
async function showStats() {
  S.sel = null;
  history.replaceState(null, '', '?stats');
  let s;
  try { s = await api('/api/procs/stats'); } catch (e) { $('#detail').innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  const seg = (k, n) => `<div class="${k}" style="width:${(100 * n) / s.cards}%" title="${STATUS[k]}: ${n}"></div>`;
  document.body.classList.add('viewing');
  $('#detail').innerHTML = `<button class="btn btn-quiet btn-sm back" id="backBtn">← Results</button><div class="cov landing">
    <h1>Engine coverage</h1>
    <p class="lede">${s.runnable}/${s.abilities} abilities run automatically (${s.pct}%) across ${s.cards} unique cards.</p>
    <div class="bar">${seg('auto', s.auto)}${seg('partial', s.partial)}${seg('manual', s.manual)}</div>
    <p class="hint"><span class="dot s-auto"></span> ${s.auto} fully automatic · <span class="dot s-partial"></span> ${s.partial} partial · <span class="dot s-manual"></span> ${s.manual} manual (incl. ${s.vanilla} vanilla, just the base proc)</p>
    <p class="hint">Search filters here: <code>fn:draw</code> <code>kind:static</code> <code>ev:quest</code> <code>status:manual</code> <code>why:"reveal"</code> <code>with:singTogether</code> <code>source:disney</code></p>
    <h2 class="sec">Why abilities stay manual (biggest first: build these next)</h2>
    <table>${s.misses.map((m) => `<tr class="miss" data-q='why:"${esc(m.why.replace(/"/g, '').slice(0, 40))}"'><td class="n">${m.n}</td><td>${esc(m.why)}<div class="ex">${esc(m.examples.join(' · '))}</div></td></tr>`).join('')}</table>
    <h2 class="sec">Proc kinds</h2><table>${Object.entries(s.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><td class="n">${n}</td><td>${esc(k)}</td></tr>`).join('')}</table>
    <h2 class="sec">Building blocks in use</h2><table>${s.fns.map(([k, n]) => `<tr class="miss" data-q="fn:${esc(k)}"><td class="n">${n}</td><td>${esc(k)}</td></tr>`).join('')}</table>
  </div>`;
  $('#backBtn').onclick = () => landing();
  document.querySelectorAll('.miss').forEach((el) => { el.onclick = () => { $('#q').value = el.dataset.q; S.q = el.dataset.q; S.limit = PAGE; document.body.classList.remove('viewing'); runSearch(); }; });
}

function setEngine(on) {
  S.engine = on;
  try { localStorage.setItem('ink.rules.engine', on ? '1' : '0'); } catch { /* private window */ }
  const b = $('#engineBtn');
  b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  $('#q').placeholder = engineOn() ? 'Search… (fn:draw · kind:static · ev:quest · status:manual · why:"reveal")' : 'Search by name or rules text';
  runSearch();
  if (S.card) renderCard(); else landing();
}
$('#engineBtn').onclick = () => setEngine(!S.engine);

// ---------- account, as on the builder's top bar ----------
async function boot() {
  try { await account.load(); } catch { /* signed out */ }
  const u = account.user();
  S.admin = u?.role === 'admin';
  $('#acct').innerHTML = u
    ? `<a class="who" href="/play" title="Signed in">${u.avatar ? `<img class="avatar" src="${esc(u.avatar)}" alt="">` : `<span class="avatar">${esc(u.name.slice(0, 1).toUpperCase())}</span>`}<span>${esc(u.name)}</span></a>`
    : '<button class="btn btn-sm" id="signInBtn">Sign in</button>';
  $('#signInBtn')?.addEventListener('click', () => {
    $('#signInBody').innerHTML = account.signInForm({ next: location.pathname + location.search });
    account.bindSignInForm($('#signInBody'), () => location.reload());
    $('#signIn').showModal();
  });
  $('#engineBtn').hidden = !S.admin;
  if (S.admin) { $('#engineBtn').classList.toggle('on', S.engine); $('#engineBtn').setAttribute('aria-pressed', String(S.engine)); }
  if (engineOn()) $('#q').placeholder = 'Search… (fn:draw · kind:static · ev:quest · status:manual · why:"reveal")';

  await runSearch();
  if (params.has('card')) show(params.get('card'));
  else if (params.has('stats') && engineOn()) showStats();
  else landing();
}
$('[data-close-dlg]').onclick = () => $('#signIn').close();
boot();
