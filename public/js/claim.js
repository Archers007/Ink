// /claim?code=… — the page behind a role invite link an admin made on /admin. It shows what the link grants, asks
// the visitor to sign in or create an account if they haven't, then lets them claim the role. One use per link.

import * as account from './account.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const code = new URL(location.href).searchParams.get('code') || '';
const box = () => $('#app .box');

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${path} failed (${r.status})`);
  return j;
}

async function render() {
  if (!code) { box().innerHTML = '<h1>Claim a role</h1><p>This link is missing its code. Ask whoever sent it for a fresh one.</p>'; return; }
  let inv;
  try { inv = await api(`/api/claim/${encodeURIComponent(code)}`); }
  catch (e) { box().innerHTML = `<h1>Claim a role</h1><p class="err">${esc(e.message)}</p>`; return; }
  const role = `<span class="role">${esc(inv.role)}</span>`;
  if (inv.state !== 'ok') {
    const why = { used: 'This link has already been used.', expired: 'This link has expired.', revoked: 'This link was withdrawn.', unknown: "This link isn't valid." }[inv.state] || "This link isn't valid.";
    box().innerHTML = `<h1>Claim a role</h1><p>${why} Ask an admin for a new one.</p><div class="row"><a class="btn" href="/">Go to Ink</a></div>`;
    return;
  }
  await account.load();
  const u = account.user();
  if (!u) {
    box().innerHTML = `<h1>You've been invited</h1><p>This link makes your Ink account a ${role}${inv.label ? ` <span class="note">(for ${esc(inv.label)})</span>` : ''}. Sign in, or create an account, and the role is yours.</p>${account.signInForm({ next: location.pathname + location.search })}`;
    account.bindSignInForm(box(), render);
    return;
  }
  if (u.role === inv.role || (u.role === 'admin' && inv.role === 'moderator')) {
    box().innerHTML = `<h1>Already ${esc(u.role)}</h1><p>Your account (${esc(u.name)}) already has the ${role} role${u.role !== inv.role ? ' or higher' : ''}. Nothing to claim.</p><div class="row"><a class="btn" href="/admin">Open the admin page</a></div>`;
    return;
  }
  box().innerHTML = `<h1>Claim the ${role} role</h1><p>Signed in as <b>${esc(u.name)}</b>${u.email ? ` (${esc(u.email)})` : ''}. Claiming gives this account the ${esc(inv.role)} role on Ink${inv.label ? `; the link was made for ${esc(inv.label)}` : ''}.</p>
    <div class="row"><button class="btn btn-gold" id="claimBtn">Claim it</button><button class="btn btn-quiet" id="otherBtn">Not you? Sign out</button><span class="err" id="err"></span></div>`;
  $('#claimBtn').onclick = async () => {
    $('#claimBtn').disabled = true;
    try {
      const j = await api(`/api/claim/${encodeURIComponent(code)}`, { method: 'POST' });
      box().innerHTML = `<h1>Done</h1><p>${esc(j.user.name)} is now a ${`<span class="role">${esc(j.user.role)}</span>`}. The admin page is yours to use.</p><div class="row"><a class="btn btn-gold" href="/admin">Open the admin page</a><a class="btn btn-quiet" href="/">Back to Ink</a></div>`;
    } catch (e) { $('#err').textContent = e.message; $('#claimBtn').disabled = false; }
  };
  $('#otherBtn').onclick = async () => { await account.signOut(); location.reload(); };
}

render();
