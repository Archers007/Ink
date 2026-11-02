// /admin — the issue board. Moderators and admins see the repository's open GitHub issues next to the reports filed
// from here and where each one is (queued → issue filed → Claude working), write up new reports (title, what
// happened, a screenshot), and admins hand out roles and flip the two switches. Everything comes from lib/reports.js
// and lib/accounts.js; the work itself happens on the maintainer's machine (tools/issue-worker.mjs).

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const STATUS_LABEL = { queued: 'Queued for the worker', creating: 'Filing on GitHub…', issue: 'Issue filed', agent: 'Claude is on it', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

const S = { user: null, data: null, tab: 'issues', users: null, invites: null, newLink: null, open: new Set(), image: null, timer: null };

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${path} failed (${r.status})`);
  return j;
}

async function boot() {
  const acct = await api('/api/account').catch(() => ({ user: null }));
  S.user = acct.user;
  const role = S.user && !S.user.guest ? S.user.role : null;
  if (role !== 'moderator' && role !== 'admin') {
    $('#app').innerHTML = `<div class="gate"><h1>Admin</h1><p class="note">${S.user && !S.user.guest ? `Signed in as ${esc(S.user.name)}, but this page needs the moderator or admin role.` : 'Sign in with a moderator or admin account to use this page.'}</p>
      <p><a class="btn" href="/">Back to the deck builder</a></p></div>`;
    return;
  }
  await refresh();
  S.timer = setInterval(() => { if (S.tab === 'issues' && document.visibilityState === 'visible') refresh(); }, 15000);
}

async function refresh() {
  try { S.data = await api('/api/admin/issues'); } catch (e) { S.data = { ...(S.data || { issues: [], reports: [], switches: {} }), githubError: e.message }; }
  render();
}

function render() {
  const d = S.data;
  const admin = S.user.role === 'admin';
  $('#app').innerHTML = `
    <div class="adm-top"><h1>Admin</h1><span class="note">${esc(S.user.name)} · ${esc(S.user.role)}</span><span class="sp"></span>
      <a class="btn btn-quiet btn-sm" href="https://github.com/${esc(d.repo)}/issues" target="_blank" rel="noopener">GitHub ↗</a><a class="btn btn-quiet btn-sm" href="/">Builder</a><a class="btn btn-quiet btn-sm" href="/play">Play</a></div>
    <div class="tabs"><button data-tab="issues" class="${S.tab === 'issues' ? 'on' : ''}">Issues</button><button data-tab="users" class="${S.tab === 'users' ? 'on' : ''}">Users</button><button data-tab="settings" class="${S.tab === 'settings' ? 'on' : ''}">Settings</button></div>
    <section class="pane" id="paneIssues" ${S.tab === 'issues' ? '' : 'hidden'}>
      ${d.workerConfigured ? '' : '<div class="warn">INK_WORKER_TOKEN isn\'t set on the server, so reports will queue but nothing picks them up. Set it in .env (server and worker) and restart.</div>'}
      ${d.githubError ? `<div class="warn">Couldn't refresh GitHub: ${esc(d.githubError)}. Showing the last list.</div>` : ''}
      <div class="grid">
        <div class="box"><h2>Open issues · ${esc(d.repo)} <span class="note">(${d.issues.length})</span></h2><div class="issues" id="issues">${issuesHtml()}</div></div>
        <div>
          <div class="box form" id="reportForm">
            <h2>Report a problem</h2>
            <label for="rTitle">Title</label><input id="rTitle" type="text" maxlength="140" placeholder="Hard bot passes its turn">
            <label for="rBody">What happened</label><textarea id="rBody" placeholder="What you did, what you expected, what happened instead. Card names help."></textarea>
            <label>Screenshot <span class="note">(optional · PNG/JPEG · up to 6 MB · paste works too)</span></label>
            <div class="drop ${S.image ? 'has' : ''}" id="drop">${S.image ? `<img src="${S.image}" alt=""><span>Click to change · <a href="#" id="dropClear">remove</a></span>` : 'Click to choose, drop a file here, or paste an image'}<input type="file" id="rFile" accept="image/png,image/jpeg,image/gif,image/webp" hidden></div>
            <div class="row"><button class="btn btn-gold" id="rSend" ${d.switches.issues_on ? '' : 'disabled'}>File it</button><span class="msg" id="rMsg">${d.switches.issues_on ? `It becomes a GitHub issue${d.switches.fix_on ? ', and Claude starts on it on the maintainer\'s machine.' : '.'}` : 'Reports are switched off in Settings.'}</span></div>
          </div>
          <div class="box" style="margin-top:14px"><h2>Reports from here <span class="note">(${d.reports.length})</span></h2><div class="issues">${reportsHtml()}</div></div>
        </div>
      </div>
    </section>
    <section class="pane" id="paneUsers" ${S.tab === 'users' ? '' : 'hidden'}><div class="box"><h2>Accounts</h2><div id="users">${S.users ? usersHtml() : '<p class="note">Loading…</p>'}</div></div></section>
    <section class="pane" id="paneSettings" ${S.tab === 'settings' ? '' : 'hidden'}><div class="box"><h2>Switches</h2>
      <div class="switch"><div><b>Accept reports</b><span class="note">The form on the Issues tab. Off: nothing new can be filed from Ink.</span></div><span class="sp"></span><input type="checkbox" data-sw="issues_on" ${d.switches.issues_on ? 'checked' : ''} ${admin ? '' : 'disabled'}></div>
      <div class="switch"><div><b>Fix with Claude</b><span class="note">After filing the issue, the worker opens a terminal on the maintainer's machine running Claude on it. Off: the issue is still filed, nobody starts on it.</span></div><span class="sp"></span><input type="checkbox" data-sw="fix_on" ${d.switches.fix_on ? 'checked' : ''} ${admin ? '' : 'disabled'}></div>
      ${admin ? '' : '<p class="note">Only admins change these.</p>'}
      <p class="note">Repository: ${esc(d.repo)} · worker ${d.workerConfigured ? 'configured' : 'not configured'}.</p></div></section>`;
  bind();
}

function issuesHtml() {
  const d = S.data;
  if (!d.issues.length) return '<p class="note">No open issues.</p>';
  const byNumber = new Map(d.reports.filter((r) => r.issueNumber).map((r) => [r.issueNumber, r]));
  return d.issues.map((i) => {
    const r = byNumber.get(i.number);
    const open = S.open.has(`i${i.number}`);
    return `<div class="iss ${open ? 'open' : ''}" data-open="i${i.number}">
      <div class="num">#${i.number}</div>
      <div><div class="t"><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></div>
        <div class="meta"><span>${esc(i.author)}</span><span>${ago(i.created)}</span>${i.comments ? `<span>${i.comments} comment${i.comments > 1 ? 's' : ''}</span>` : ''}${i.labels.map((l) => `<span class="lbl" style="border-color:#${esc(l.color)};color:#${esc(l.color)}">${esc(l.name)}</span>`).join('')}${r ? `<span class="st ${r.status}" title="${esc(r.note || '')}">${STATUS_LABEL[r.status] || r.status}</span>` : ''}</div>
        ${i.body ? `<div class="body">${esc(i.body)}</div>` : ''}</div>
      <div class="acts"><a class="btn btn-quiet" href="${esc(i.url)}" target="_blank" rel="noopener">Open</a></div></div>`;
  }).join('');
}

function reportsHtml() {
  const d = S.data;
  if (!d.reports.length) return '<p class="note">Nothing filed from here yet.</p>';
  return d.reports.map((r) => {
    const open = S.open.has(`r${r.id}`);
    const retry = ['failed', 'cancelled'].includes(r.status) || (r.status === 'issue' && d.switches.fix_on);
    return `<div class="iss ${open ? 'open' : ''}" data-open="r${r.id}">
      <div class="num">${r.issueNumber ? `#${r.issueNumber}` : `R${r.id}`}</div>
      <div><div class="t">${r.issueUrl ? `<a href="${esc(r.issueUrl)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}</div>
        <div class="meta"><span>${esc(r.author || '')}</span><span>${ago(r.created)}</span><span class="st ${r.status}">${STATUS_LABEL[r.status] || r.status}</span>${r.note ? `<span title="${esc(r.note)}">${esc(r.note.slice(0, 90))}${r.note.length > 90 ? '…' : ''}</span>` : ''}</div>
        <div class="body">${esc(r.body)}</div>${r.imageUrl && open ? `<img class="shot" src="${esc(r.imageUrl)}" alt="">` : ''}</div>
      <div class="acts">${retry ? `<button class="btn btn-quiet" data-rs="${r.id}" data-to="queued" title="Put it back in the queue (the worker files the issue if there isn't one, then starts Claude)">Retry</button>` : ''}
        ${!['done', 'cancelled'].includes(r.status) ? `<button class="btn btn-quiet" data-rs="${r.id}" data-to="done">Done</button>` : ''}
        ${['queued', 'failed'].includes(r.status) ? `<button class="btn btn-quiet" data-rs="${r.id}" data-to="cancelled">Cancel</button>` : ''}</div></div>`;
  }).join('');
}

function usersHtml() {
  const admin = S.user.role === 'admin';
  return `${admin ? invitesHtml() : ''}<h2 style="margin-top:18px">Accounts</h2><table class="users"><thead><tr><th>Name</th>${admin ? '<th>Email</th>' : ''}<th>Role</th><th>Decks</th><th>Joined</th></tr></thead><tbody>
    ${S.users.map((u) => `<tr><td>${esc(u.name)}</td>${admin ? `<td class="note">${esc(u.email || '')}</td>` : ''}<td>${admin && u.id !== S.user.id
      ? `<select data-role="${u.id}">${['user', 'moderator', 'admin'].map((r) => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>` : esc(u.role)}</td><td>${u.decks}</td><td class="note">${new Date(u.created).toLocaleDateString()}</td></tr>`).join('')}
  </tbody></table>`;
}

// invite links: make one for a role, send it; whoever opens it signs in or creates an account and claims the role
function invitesHtml() {
  const list = S.invites || [];
  const when = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const STATE = { ok: 'Waiting to be claimed', used: 'Claimed', expired: 'Expired', revoked: 'Withdrawn' };
  return `<h2>Invite someone to a role</h2>
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
  if (S.user.role === 'admin') S.invites = (await api('/api/admin/invites')).invites;
}

function bind() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = async () => { S.tab = b.dataset.tab; if (S.tab === 'users' && !S.users) await loadUsersTab(); render(); });
  const mk = $('#invMake');
  if (mk) mk.onclick = async () => {
    mk.disabled = true;
    try { const j = await api('/api/admin/invites', { method: 'POST', body: JSON.stringify({ role: $('#invRole').value, label: $('#invLabel').value }) }); S.newLink = j.invite.url; await loadUsersTab(); render(); }
    catch (e) { alert(e.message); mk.disabled = false; }
  };
  const cp = $('#invCopy');
  if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText(S.newLink); cp.textContent = 'Copied'; } catch { window.prompt('Copy the link:', S.newLink); } };
  document.querySelectorAll('[data-revoke]').forEach((b) => b.onclick = async () => {
    try { await api(`/api/admin/invites/${b.dataset.revoke}/revoke`, { method: 'POST' }); await loadUsersTab(); render(); } catch (e) { alert(e.message); }
  });
  document.querySelectorAll('.iss[data-open]').forEach((el) => el.onclick = (e) => { if (e.target.closest('a,button,select')) return; const k = el.dataset.open; S.open.has(k) ? S.open.delete(k) : S.open.add(k); render(); });
  document.querySelectorAll('[data-rs]').forEach((b) => b.onclick = async () => {
    try { await api(`/api/admin/reports/${b.dataset.rs}/status`, { method: 'POST', body: JSON.stringify({ status: b.dataset.to }) }); await refresh(); } catch (e) { alert(e.message); }
  });
  document.querySelectorAll('[data-role]').forEach((sel) => sel.onchange = async () => {
    try { await api(`/api/admin/users/${sel.dataset.role}/role`, { method: 'POST', body: JSON.stringify({ role: sel.value }) }); await loadUsersTab(); render(); }
    catch (e) { alert(e.message); await loadUsersTab(); render(); }
  });
  document.querySelectorAll('[data-sw]').forEach((c) => c.onchange = async () => {
    try { S.data.switches = (await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ key: c.dataset.sw, value: c.checked }) })).switches; render(); } catch (e) { alert(e.message); refresh(); }
  });
  // the report form
  const drop = $('#drop'), file = $('#rFile');
  if (drop) {
    drop.onclick = (e) => { if (e.target.id === 'dropClear') { e.preventDefault(); S.image = null; render(); return; } file.click(); };
    file.onchange = () => file.files[0] && takeImage(file.files[0]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('has'); };
    drop.ondragleave = () => drop.classList.toggle('has', !!S.image);
    drop.ondrop = (e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) takeImage(f); };
    document.onpaste = (e) => { const f = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith('image/'))?.getAsFile(); if (f && S.tab === 'issues') takeImage(f); };
    $('#rSend').onclick = sendReport;
  }
}

function takeImage(f) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { msg('PNG, JPEG, GIF or WebP only.', true); return; }
  if (f.size > 6 * 1024 * 1024) { msg('That image is over 6 MB.', true); return; }
  const rd = new FileReader();
  rd.onload = () => { S.image = rd.result; const t = $('#rTitle').value, b = $('#rBody').value; render(); $('#rTitle').value = t; $('#rBody').value = b; };
  rd.readAsDataURL(f);
}
const msg = (t, err = false) => { const el = $('#rMsg'); if (el) { el.textContent = t; el.classList.toggle('err', err); } };

async function sendReport() {
  const title = $('#rTitle').value.trim(), body = $('#rBody').value.trim();
  if (title.length < 4) return msg('Give it a title.', true);
  if (body.length < 10) return msg('Describe what happened.', true);
  $('#rSend').disabled = true; msg('Filing…');
  try {
    const context = { page: location.href, browser: navigator.userAgent, screen: `${screen.width}×${screen.height}`, filedBy: S.user.name, at: new Date().toISOString() };
    const j = await api('/api/admin/reports', { method: 'POST', body: JSON.stringify({ title, body, image: S.image, context }) });
    S.image = null;
    await refresh();
    msg(j.workerConfigured ? 'Queued. The worker files it on GitHub in a few seconds.' : 'Queued, but no worker is configured to pick it up.');
  } catch (e) { msg(e.message, true); $('#rSend').disabled = false; }
}

boot();
