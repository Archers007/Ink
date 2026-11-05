// /admin — the issue board. Moderators and admins see the repository's open GitHub issues next to the reports filed
// from here and where each one is (queued → issue filed → Claude working), write up new reports (title, what
// happened, a screenshot), and admins hand out roles and flip the two switches. Everything comes from lib/reports.js
// and lib/accounts.js; the work itself happens on the maintainer's machine (tools/issue-worker.mjs).
//
// The page shell (tabs, panes, the report form) is built once. Refreshes and clicks only refill the lists inside it,
// so a report being written keeps its text, screenshot and focus.

import * as account from './account.js';
import { initExt, showExt, hideExt } from './admin-ext.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const STATUS_LABEL = { queued: 'Queued for the worker', creating: 'Filing on GitHub…', issue: 'Issue filed', agent: 'Claude is on it', pr: 'PR open', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const KIND_LABEL = { filed: 'Filed', issue: 'Issue', agent: 'Claude', pr: 'Pull request', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', queued: 'Queued', switch: 'Switch' };

const S = { user: null, data: null, tab: 'issues', users: null, invites: null, newLink: null, activity: null, showClosed: false, open: new Set(), image: null, timer: null, formMsg: null, sending: false, userDecks: {}, openUsers: new Set(), openDecks: new Set() };

// ?mock=1 on a local dev server: the External calls tab runs on generated sample data (admin-ext-mock.js), and the
// role gate is skipped so the tab can be looked at without a moderator account. Only on localhost, and only that tab
// has anything to show; the other tabs' requests still need a real moderator or admin and fail without one.
const MOCK = new URLSearchParams(location.search).get('mock') === '1' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${path} failed (${r.status})`);
  return j;
}

async function boot() {
  clearInterval(S.timer);
  await account.load();
  S.user = account.user();
  const role = S.user?.role;
  if (MOCK) S.tab = 'ext';
  if (role !== 'moderator' && role !== 'admin') {
    if (!MOCK) return gate();
    S.user = { id: 0, name: 'Mock admin', role: 'admin' };
    S.data = { repo: '', issues: [], closed: [], prsByIssue: {}, reports: [], switches: {}, workerConfigured: true, githubError: 'mock mode without a moderator sign-in' };
    build();
    return;
  }
  try { S.data = await api('/api/admin/issues'); } catch (e) { S.data = { repo: '', issues: [], closed: [], prsByIssue: {}, reports: [], switches: {}, githubError: e.message }; }
  build();
  S.timer = setInterval(tick, 15000);
}

// signed out: the sign-in form right here (as /claim does); signed in without the role: say so and offer a way out
function gate() {
  const app = $('#app');
  if (!S.user) {
    app.innerHTML = `<div class="gate"><h1 class="display">Admin</h1><p class="note">Sign in with a moderator or admin account to use this page.</p>
      <div class="box gate-form">${account.signInForm({ next: '/admin' })}</div>
      <p><a class="btn btn-quiet btn-sm" href="/">Back to the deck builder</a></p></div>`;
    account.bindSignInForm(app, boot);
    return;
  }
  app.innerHTML = `<div class="gate"><h1 class="display">Admin</h1><p class="note">Signed in as ${esc(S.user.name)}, but this page needs the moderator or admin role.</p>
    <p class="gate-acts"><button class="btn btn-quiet btn-sm" id="gateOut">Sign in as someone else</button><a class="btn btn-quiet btn-sm" href="/">Back to the deck builder</a></p></div>`;
  $('#gateOut').onclick = async () => { await account.signOut(); boot(); };
}

// the 15-second refresh: only while someone could be looking at the lists, and never while a report is being
// written — a list growing above the form on a narrow screen would push it out from under the cursor
function tick() {
  if (document.visibilityState !== 'visible' || S.sending) return;
  if (S.tab === 'issues' && formBusy()) return;
  if (S.tab === 'issues' || S.tab === 'history') refresh();
}
function formBusy() {
  const f = $('#reportForm');
  return !!f && (f.contains(document.activeElement) || !!$('#rTitle').value.trim() || !!$('#rBody').value.trim() || !!S.image);
}

async function refresh() {
  try { S.data = await api('/api/admin/issues'); } catch (e) { S.data = { ...S.data, githubError: e.message }; }
  if (S.tab === 'history' || S.activity) { try { S.activity = (await api('/api/admin/activity')).activity; } catch { /* keep what we had */ } }
  fillIssues(); fillHistory(); fillSettings(); fillForm();
}

function build() {
  const tab = (t, label) => `<button data-tab="${t}" class="${S.tab === t ? 'on' : ''}">${label}</button>`;
  $('#app').innerHTML = `
    <div class="adm-top"><h1>Admin</h1><span class="note">${esc(S.user.name)} · ${esc(S.user.role)}</span><span class="sp"></span>
      <a class="btn btn-quiet btn-sm" id="ghLink" href="https://github.com/${esc(S.data.repo)}/issues" target="_blank" rel="noopener">GitHub ↗</a><a class="btn btn-quiet btn-sm" href="/">Builder</a><a class="btn btn-quiet btn-sm" href="/play">Play</a></div>
    <div class="tabs">${tab('issues', 'Issues')}${tab('history', 'History')}${tab('users', 'Users')}${tab('settings', 'Settings')}${tab('ext', 'External calls')}</div>
    <section class="pane" data-pane="issues">
      <div id="issWarn"></div>
      <div class="grid">
        <div><div class="box" id="openBox"></div><div class="box" id="closedBox" style="margin-top:14px"></div></div>
        <div>
          <div class="box form" id="reportForm">
            <h2>Report a problem</h2>
            <label for="rTitle">Title</label><input id="rTitle" type="text" maxlength="140" placeholder="Hard bot passes its turn">
            <label for="rBody">What happened</label><textarea id="rBody" placeholder="What you did, what you expected, what happened instead. Card names help."></textarea>
            <label>Screenshot <span class="note">(optional · PNG/JPEG · up to 6 MB · paste works too)</span></label>
            <div class="drop" id="drop" tabindex="0" role="button"></div><input type="file" id="rFile" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
            <div class="row"><button class="btn btn-gold" id="rSend">File it</button><span class="msg" id="rMsg"></span></div>
          </div>
          <div class="box" id="reportsBox" style="margin-top:14px"></div>
        </div>
      </div>
    </section>
    <section class="pane" data-pane="history"><div class="box" id="histBox"></div></section>
    <section class="pane" data-pane="users"><div id="usersPane"><div class="box"><p class="note">Loading…</p></div></div></section>
    <section class="pane" data-pane="settings"><div class="box" id="settingsBox"></div></section>
    <section class="pane" data-pane="ext"><div id="extPane"></div></section>`;
  initExt({ root: $('#extPane'), api, esc, role: S.user.role, mock: MOCK });
  bindForm();
  showTab(S.tab);
  fillIssues(); fillHistory(); fillSettings(); fillForm();
}

function showTab(t) {
  S.tab = t;
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== t; });
  if (t === 'ext') showExt(); else hideExt();
}

// ---------- lists ----------
function fillIssues() {
  const d = S.data;
  $('#ghLink').href = `https://github.com/${d.repo}/issues`;
  $('#issWarn').innerHTML = `${d.workerConfigured ? '' : '<div class="warn">INK_WORKER_TOKEN isn\'t set on the server, so reports will queue but nothing picks them up. Set it in .env (server and worker) and restart.</div>'}
    ${d.githubError ? `<div class="warn">Couldn't refresh GitHub: ${esc(d.githubError)}. Showing the last list.</div>` : ''}`;
  $('#openBox').innerHTML = `<h2>Open issues · ${esc(d.repo)} <span class="note">(${d.issues.length})</span></h2><div class="issues" id="issues">${issuesHtml()}</div>`;
  $('#closedBox').innerHTML = `<h2 class="toggle" id="closedToggle" role="button" tabindex="0" aria-expanded="${S.showClosed}">${S.showClosed ? '▾' : '▸'} Recently closed <span class="note">(${(d.closed || []).length})</span></h2>${S.showClosed ? `<div class="issues">${closedHtml()}</div>` : ''}`;
  $('#reportsBox').innerHTML = `<h2>Reports <span class="note">(${d.reports.length}) · from here and from <a href="/report" target="_blank" rel="noopener">/report</a></span></h2><div class="issues">${reportsHtml()}</div>`;
}
function fillHistory() {
  $('#histBox').innerHTML = `<h2>History <span class="note">every report, what was done with it, and how it turned out</span></h2>${S.activity ? historyHtml() : '<p class="note">Loading…</p>'}`;
}
function fillSettings() {
  const d = S.data, admin = S.user.role === 'admin';
  $('#settingsBox').innerHTML = `<h2>Switches</h2>
    <div class="switch"><div><b>Accept reports</b><span class="note">The form on the Issues tab and the public /report page. Off: nothing new can be filed from Ink.</span></div><span class="sp"></span><input type="checkbox" data-sw="issues_on" ${d.switches.issues_on ? 'checked' : ''} ${admin ? '' : 'disabled'}></div>
    <div class="switch"><div><b>Public report page</b><span class="note">Anyone can send a bug report or feature request from <a href="/report" target="_blank" rel="noopener">/report</a>, signed in or not. They're filed as GitHub issues (labelled bug or enhancement) and never handed to Claude. Off: the page says reports are closed.</span></div><span class="sp"></span><input type="checkbox" data-sw="public_on" ${d.switches.public_on ? 'checked' : ''} ${admin ? '' : 'disabled'}></div>
    <div class="switch"><div><b>Fix with Claude</b><span class="note">After filing the issue, the worker opens a terminal on the maintainer's machine running Claude on it. Off: the issue is still filed, nobody starts on it.</span></div><span class="sp"></span><input type="checkbox" data-sw="fix_on" ${d.switches.fix_on ? 'checked' : ''} ${admin ? '' : 'disabled'}></div>
    ${admin ? '' : '<p class="note">Only admins change these.</p>'}
    <p class="note">Repository: ${esc(d.repo)} · worker ${d.workerConfigured ? 'configured' : 'not configured'}.</p>`;
}
function fillUsers() {
  const admin = S.user.role === 'admin';
  $('#usersPane').innerHTML = `${admin ? `<div class="box">${invitesHtml()}</div>` : ''}
    <div class="box"${admin ? ' style="margin-top:14px"' : ''}><h2>Accounts <span class="note">(${S.users.length})</span></h2>${usersHtml()}</div>`;
}

// Issue bodies are GitHub markdown, often with pasted screenshots as <img …> tags or ![](…). Show each as a small
// "image" chip in the text, and the pictures themselves once the row is opened.
const IMG_RE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>|!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gi;
function bodyParts(text) {
  const src = String(text || '');
  const imgs = [];
  let html = '', last = 0;
  for (const m of src.matchAll(IMG_RE)) {
    html += esc(src.slice(last, m.index));
    const url = m[1] || m[2];
    if (/^https?:\/\//i.test(url)) imgs.push(url);
    html += '<span class="imgchip">image</span>';
    last = m.index + m[0].length;
  }
  html += esc(src.slice(last));
  return { html: html.replace(/\n{3,}/g, '\n\n').trim(), imgs };
}
const shotsHtml = (urls) => (urls.length ? `<div class="shots">${urls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img class="shot" loading="lazy" src="${esc(u)}" alt="Screenshot"></a>`).join('')}</div>` : '');
// the ▸/▾ toggle, for rows that have more to show
const chev = (key, open) => `<button class="chev" data-chev="${key}" aria-expanded="${open}" aria-label="${open ? 'Show less' : 'Show more'}">${open ? '▾' : '▸'}</button>`;

// a pull request that names the issue: the fix is on its way (open), landed (merged — the issue closes when it reaches
// the default branch), or was dropped (closed)
function prChips(number) {
  return ((S.data.prsByIssue || {})[number] || []).map((p) => `<a class="st ${p.state === 'merged' ? 'done' : p.state === 'open' ? 'pr' : 'failed'}" href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.title)}">${p.state === 'merged' ? 'Fix merged' : p.state === 'open' ? 'PR open' : 'PR closed'} · #${p.number}</a>`).join('');
}
function issueRow(i, r, extra = '') {
  const key = `i${i.number}`;
  const open = S.open.has(key);
  const b = bodyParts(i.body);
  const more = !!(b.html || b.imgs.length);
  return `<div class="iss ${open ? 'open' : ''} ${i.closed ? 'closed' : ''}" ${more ? `data-open="${key}"` : ''}>
    <div class="num">${more ? chev(key, open) : ''}#${i.number}</div>
    <div><div class="t"><a href="${esc(i.url)}" target="_blank" rel="noopener" title="Open on GitHub">${esc(i.title)}&nbsp;<span class="ext">↗</span></a></div>
      <div class="meta"><span>${esc(i.author)}</span><span>${i.closed ? `closed ${ago(i.closed)}${i.stateReason === 'not_planned' ? ' as not planned' : ''}` : ago(i.created)}</span>${i.comments ? `<span>${i.comments} comment${i.comments > 1 ? 's' : ''}</span>` : ''}${i.labels.map((l) => `<span class="lbl" style="border-color:#${esc(l.color)};color:#${esc(l.color)}">${esc(l.name)}</span>`).join('')}${prChips(i.number)}${r ? `<span class="st ${r.status}" title="${esc(r.note || '')}">${STATUS_LABEL[r.status] || r.status}</span>` : ''}${extra}</div>
      ${b.html ? `<div class="body">${b.html}</div>` : ''}${shotsHtml(b.imgs)}</div></div>`;
}
function issuesHtml() {
  const d = S.data;
  if (!d.issues.length) return '<p class="note">No open issues.</p>';
  const byNumber = new Map(d.reports.filter((r) => r.issueNumber).map((r) => [r.issueNumber, r]));
  return d.issues.map((i) => issueRow(i, byNumber.get(i.number))).join('');
}
function closedHtml() {
  const d = S.data;
  if (!(d.closed || []).length) return '<p class="note">Nothing closed recently.</p>';
  const byNumber = new Map(d.reports.filter((r) => r.issueNumber).map((r) => [r.issueNumber, r]));
  return d.closed.map((i) => issueRow(i, byNumber.get(i.number), `<span class="st ${i.stateReason === 'not_planned' ? 'cancelled' : 'done'}">${i.stateReason === 'not_planned' ? 'Not planned' : 'Fixed'}</span>`)).join('');
}
function historyHtml() {
  const list = S.activity || [];
  if (!list.length) return '<p class="note">Nothing yet. Filing a report, the worker\'s steps, GitHub\'s verdicts and the switches all land here.</p>';
  const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<table class="users hist"><thead><tr><th>When</th><th>Who</th><th>What</th><th></th></tr></thead><tbody>
    ${list.map((a) => `<tr><td class="note">${when(a.at)}</td><td>${esc(a.actor)}</td><td><span class="st ${a.kind === 'switch' ? 'issue' : a.kind}">${KIND_LABEL[a.kind] || a.kind}</span> ${esc(a.detail || '')}</td><td>${a.url ? `<a class="btn btn-quiet btn-sm" href="${esc(a.url)}" target="_blank" rel="noopener">${a.issue_number ? `#${a.issue_number}` : 'Open'}</a>` : ''}</td></tr>`).join('')}
  </tbody></table>`;
}

function reportsHtml() {
  const d = S.data;
  if (!d.reports.length) return '<p class="note">Nothing filed from here yet.</p>';
  return d.reports.map((r) => {
    const key = `r${r.id}`;
    const open = S.open.has(key);
    const b = bodyParts(r.body);
    const imgs = [...(r.imageUrls || (r.imageUrl ? [r.imageUrl] : [])), ...b.imgs];
    const more = !!(b.html || imgs.length);
    // public reports are filed and left for a person; Retry on one only files it again
    const retry = ['failed', 'cancelled'].includes(r.status) || (r.status === 'issue' && d.switches.fix_on && r.autofix);
    const from = r.source === 'public' ? `<span class="src ${r.kind}">${r.kind === 'feature' ? 'Feature request' : 'Bug report'} · public</span>` : '';
    return `<div class="iss ${open ? 'open' : ''}" ${more ? `data-open="${key}"` : ''}>
      <div class="num">${more ? chev(key, open) : ''}${r.issueNumber ? `#${r.issueNumber}` : `R${r.id}`}</div>
      <div><div class="t">${r.issueUrl ? `<a href="${esc(r.issueUrl)}" target="_blank" rel="noopener" title="Open on GitHub">${esc(r.title)}&nbsp;<span class="ext">↗</span></a>` : esc(r.title)}</div>
        <div class="meta">${from}<span>${esc(r.author || (r.source === 'public' ? 'no account' : ''))}</span><span>${ago(r.created)}</span><span class="st ${r.status}">${STATUS_LABEL[r.status] || r.status}</span>${r.prUrl ? `<a class="st pr" href="${esc(r.prUrl)}" target="_blank" rel="noopener">pull request</a>` : ''}${r.note ? `<span title="${esc(r.note)}">${esc(r.note.slice(0, 90))}${r.note.length > 90 ? '…' : ''}</span>` : ''}${imgs.length ? `<span class="imgchip">${imgs.length > 1 ? `${imgs.length} images` : 'image'}</span>` : ''}</div>
        ${b.html ? `<div class="body">${b.html}</div>` : ''}${shotsHtml(imgs)}</div>
      <div class="acts">${retry ? `<button class="btn btn-quiet" data-rs="${r.id}" data-to="queued" title="Put it back in the queue (the worker files the issue if there isn't one, then starts Claude)">Retry</button>` : ''}
        ${!['done', 'cancelled'].includes(r.status) ? `<button class="btn btn-quiet" data-rs="${r.id}" data-to="done">Done</button>` : ''}
        ${['queued', 'failed'].includes(r.status) ? `<button class="btn btn-quiet" data-rs="${r.id}" data-to="cancelled">Cancel</button>` : ''}</div></div>`;
  }).join('');
}

function usersHtml() {
  const admin = S.user.role === 'admin';
  const cols = admin ? 5 : 4;
  // admins open a player's decks from the count, private ones included
  const deckCell = (u) => admin && u.decks > 0
    ? `<button class="btn btn-quiet btn-sm" data-udecks="${u.id}" aria-expanded="${S.openUsers.has(u.id)}" title="See ${esc(u.name)}'s decks">${u.decks} ${S.openUsers.has(u.id) ? '▴' : '▾'}</button>`
    : u.decks;
  return `<table class="users"><thead><tr><th>Name</th>${admin ? '<th>Email</th>' : ''}<th>Role</th><th>Decks</th><th>Joined</th></tr></thead><tbody>
    ${S.users.map((u) => `<tr><td>${esc(u.name)}</td>${admin ? `<td class="note">${esc(u.email || '')}</td>` : ''}<td>${admin && u.id !== S.user.id
      ? `<select data-role="${u.id}">${['user', 'moderator', 'admin'].map((r) => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>` : esc(u.role)}</td><td>${deckCell(u)}</td><td class="note">${new Date(u.created).toLocaleDateString()}</td></tr>
      ${S.openUsers.has(u.id) ? `<tr class="udecks"><td colspan="${cols}">${userDecksHtml(u.id)}</td></tr>` : ''}`).join('')}
  </tbody></table>`;
}
function userDecksHtml(uid) {
  const got = S.userDecks[uid];
  if (!got) return '<p class="note">Loading decks…</p>';
  if (got.error) return `<p class="note">Couldn't load the decks: ${esc(got.error)}</p>`;
  if (!got.decks.length) return '<p class="note">No decks.</p>';
  return `<div class="udeck-list">${got.decks.map((d) => {
    const open = S.openDecks.has(d.id);
    const list = [...(d.list || [])].sort((a, b) => (a.cost ?? 99) - (b.cost ?? 99) || a.name.localeCompare(b.name));
    return `<div class="udeck ${open ? 'open' : ''}">
      <div class="udeck-head" data-udeck="${esc(d.id)}" role="button" tabindex="0" aria-expanded="${open}">
        <span class="inks">${(d.inks || []).map((c) => `<span class="inkdot ink-${esc(c)}" title="${esc(c)}"></span>`).join('')}</span>
        <b>${esc(d.name)}</b>
        <span class="vis ${d.shared ? 'shared' : 'private'}">${d.shared ? 'Shared' : 'Private'}</span>
        <span class="note">${d.size ?? '?'} cards${d.legal === false ? ' · not legal' : ''} · ${new Date(d.updated).toLocaleDateString()}</span>
        <span class="spacer"></span>
        <a class="btn btn-quiet btn-sm" href="/?adminDeck=${encodeURIComponent(d.id)}" target="_blank" rel="noopener" title="Opens an unsaved copy in the deck builder; their deck isn't changed">Open copy in builder ↗</a>
      </div>
      ${open ? `<ul class="udeck-cards">${list.map((c) => `<li><span class="q">${c.qty}×</span> ${esc(c.name)} <span class="note">${c.cost ?? '?'}◆ · ${esc((c.inks || []).join('/'))}</span></li>`).join('')}</ul>` : ''}
    </div>`;
  }).join('')}</div>`;
}
async function toggleUserDecks(uid) {
  if (S.openUsers.has(uid)) { S.openUsers.delete(uid); fillUsers(); return; }
  S.openUsers.add(uid); fillUsers();
  try { S.userDecks[uid] = await api(`/api/admin/users/${uid}/decks`); }
  catch (x) { S.userDecks[uid] = { error: x.message }; }
  fillUsers();
}

// invite links: make one for a role, send it; whoever opens it signs in or creates an account and claims the role
function invitesHtml() {
  const list = S.invites || [];
  const when = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const STATE = { ok: 'Waiting to be claimed', used: 'Claimed', expired: 'Expired', revoked: 'Withdrawn' };
  return `<h2>Invite to a role</h2>
    <div class="invite"><select id="invRole"><option value="moderator">Moderator</option><option value="admin">Admin</option></select>
      <input type="text" id="invLabel" maxlength="60" placeholder="Who it's for (optional, e.g. Adam)"><button class="btn btn-gold" id="invMake">Create link</button>
      <span class="note">Links work once and expire in 7 days.</span></div>
    ${S.newLink ? `<div class="linkout"><span>Send this to them:</span><code id="invUrl">${esc(S.newLink)}</code><button class="btn btn-sm" id="invCopy">Copy</button></div>` : ''}
    ${list.length ? `<table class="users"><thead><tr><th>Role</th><th>For</th><th>Status</th><th>Made</th><th>Expires</th><th></th></tr></thead><tbody>
      ${list.map((i) => `<tr><td>${esc(i.role)}</td><td>${esc(i.label || '—')}</td><td>${i.state === 'used' ? `Claimed by <b>${esc(i.claimant || '?')}</b> ${when(i.usedAt)}` : STATE[i.state]}</td><td class="note">${when(i.created)}${i.creator ? ` by ${esc(i.creator)}` : ''}</td><td class="note">${when(i.expires)}</td><td>${i.state === 'ok' ? `<button class="btn btn-quiet btn-sm" data-revoke="${i.id}">Withdraw</button>` : ''}</td></tr>`).join('')}
    </tbody></table>` : '<p class="note">No invite links yet.</p>'}`;
}
async function loadUsersTab() {
  S.users = (await api('/api/admin/users')).users;
  S.userDecks = {};
  for (const uid of S.openUsers) api(`/api/admin/users/${uid}/decks`).then((j) => { S.userDecks[uid] = j; }, (x) => { S.userDecks[uid] = { error: x.message }; }).then(() => { if (S.users) fillUsers(); });
  if (S.user.role === 'admin') S.invites = (await api('/api/admin/invites')).invites;
  fillUsers();
}

// ---------- events: delegated once on #app, so refilled lists need no rebinding ----------
function toggleRow(key) {
  const el = document.querySelector(`.iss[data-open="${key}"]`);
  if (!el) return;
  const open = !S.open.has(key);
  open ? S.open.add(key) : S.open.delete(key);
  el.classList.toggle('open', open);
  const c = el.querySelector('.chev');
  if (c) { c.textContent = open ? '▾' : '▸'; c.setAttribute('aria-expanded', open); c.setAttribute('aria-label', open ? 'Show less' : 'Show more'); }
}

const app = $('#app');
app.addEventListener('click', async (e) => {
  const t = e.target;
  const tabBtn = t.closest('[data-tab]');
  if (tabBtn) {
    showTab(tabBtn.dataset.tab);
    if (S.tab === 'users' && !S.users) { try { await loadUsersTab(); } catch (x) { alert(x.message); } }
    if (S.tab === 'history') { try { S.activity = (await api('/api/admin/activity')).activity; fillHistory(); } catch (x) { alert(x.message); } }
    return;
  }
  if (t.closest('#closedToggle')) { S.showClosed = !S.showClosed; fillIssues(); return; }
  const chevBtn = t.closest('[data-chev]');
  if (chevBtn) { toggleRow(chevBtn.dataset.chev); return; }
  const rs = t.closest('[data-rs]');
  if (rs) {
    try { await api(`/api/admin/reports/${rs.dataset.rs}/status`, { method: 'POST', body: JSON.stringify({ status: rs.dataset.to }) }); await refresh(); } catch (x) { alert(x.message); }
    return;
  }
  const mk = t.closest('#invMake');
  if (mk) {
    mk.disabled = true;
    try { const j = await api('/api/admin/invites', { method: 'POST', body: JSON.stringify({ role: $('#invRole').value, label: $('#invLabel').value }) }); S.newLink = j.invite.url; await loadUsersTab(); }
    catch (x) { alert(x.message); mk.disabled = false; }
    return;
  }
  const cp = t.closest('#invCopy');
  if (cp) { try { await navigator.clipboard.writeText(S.newLink); cp.textContent = 'Copied'; } catch { window.prompt('Copy the link:', S.newLink); } return; }
  const ud = t.closest('[data-udecks]');
  if (ud) { toggleUserDecks(Number(ud.dataset.udecks)); return; }
  const dk = t.closest('[data-udeck]');
  if (dk && !t.closest('a')) { const id = dk.dataset.udeck; if (S.openDecks.has(id)) S.openDecks.delete(id); else S.openDecks.add(id); fillUsers(); return; }
  const rv = t.closest('[data-revoke]');
  if (rv) { try { await api(`/api/admin/invites/${rv.dataset.revoke}/revoke`, { method: 'POST' }); await loadUsersTab(); } catch (x) { alert(x.message); } return; }
  // anywhere else on an expandable row opens or closes it — but not links, buttons, or a drag to select text
  const row = t.closest('.iss[data-open]');
  if (row && !t.closest('a,button,select,input') && !String(getSelection()).trim()) toggleRow(row.dataset.open);
});
app.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && (e.target.id === 'closedToggle' || e.target.matches?.('[data-udeck]'))) { e.preventDefault(); e.target.click(); }
});
app.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-role]');
  if (sel) {
    try { await api(`/api/admin/users/${sel.dataset.role}/role`, { method: 'POST', body: JSON.stringify({ role: sel.value }) }); } catch (x) { alert(x.message); }
    try { await loadUsersTab(); } catch { /* keep the table */ }
    return;
  }
  const sw = e.target.closest('[data-sw]');
  if (sw) {
    try { S.data.switches = (await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ key: sw.dataset.sw, value: sw.checked }) })).switches; fillSettings(); fillIssues(); fillForm(); }
    catch (x) { alert(x.message); refresh(); }
  }
});

// ---------- the report form: built once, only its screenshot box, button and message are ever updated ----------
function fillForm() {
  const sw = S.data.switches;
  const drop = $('#drop');
  drop.classList.toggle('has', !!S.image);
  drop.innerHTML = S.image ? `<img src="${S.image}" alt=""><span>Click to change · <a href="#" id="dropClear">remove</a></span>` : 'Click to choose, drop a file here, or paste an image';
  $('#rSend').disabled = S.sending || !sw.issues_on;
  const m = $('#rMsg');
  const def = sw.issues_on ? `It becomes a GitHub issue${sw.fix_on ? ', and Claude starts on it on the maintainer\'s machine.' : '.'}` : 'Reports are switched off in Settings.';
  m.textContent = S.formMsg?.text ?? def;
  m.classList.toggle('err', !!S.formMsg?.err);
}
function bindForm() {
  const drop = $('#drop'), file = $('#rFile');
  drop.onclick = (e) => { if (e.target.id === 'dropClear') { e.preventDefault(); S.image = null; fillForm(); return; } file.click(); };
  drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } };
  file.onchange = () => { if (file.files[0]) takeImage(file.files[0]); file.value = ''; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('has'); };
  drop.ondragleave = () => drop.classList.toggle('has', !!S.image);
  drop.ondrop = (e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) takeImage(f); };
  document.onpaste = (e) => { const f = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith('image/'))?.getAsFile(); if (f && S.tab === 'issues') takeImage(f); };
  // typing clears an old "Queued." or error, so the line goes back to saying what filing will do
  $('#rTitle').oninput = $('#rBody').oninput = () => { if (S.formMsg) { S.formMsg = null; fillForm(); } };
  $('#rSend').onclick = sendReport;
}

function takeImage(f) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { msg('PNG, JPEG, GIF or WebP only.', true); return; }
  if (f.size > 6 * 1024 * 1024) { msg('That image is over 6 MB.', true); return; }
  const rd = new FileReader();
  rd.onload = () => { S.image = rd.result; S.formMsg = null; fillForm(); };
  rd.readAsDataURL(f);
}
const msg = (text, err = false) => { S.formMsg = { text, err }; fillForm(); };

async function sendReport() {
  const title = $('#rTitle').value.trim(), body = $('#rBody').value.trim();
  if (title.length < 4) return msg('Give it a title.', true);
  if (body.length < 10) return msg('Describe what happened.', true);
  S.sending = true; msg('Filing…');
  try {
    const context = { page: location.href, browser: navigator.userAgent, screen: `${screen.width}×${screen.height}`, filedBy: S.user.name, at: new Date().toISOString() };
    const j = await api('/api/admin/reports', { method: 'POST', body: JSON.stringify({ title, body, image: S.image, context }) });
    $('#rTitle').value = ''; $('#rBody').value = ''; S.image = null;
    S.sending = false;
    S.formMsg = { text: j.workerConfigured ? 'Queued. The worker files it on GitHub in a few seconds.' : 'Queued, but no worker is configured to pick it up.' };
    await refresh();
  } catch (e) { S.sending = false; msg(e.message, true); }
}

boot();
