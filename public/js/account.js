// Account + deck storage shared by the builder (/) and the table (/play).
// Signed in (email + password, lib/accounts.js): decks live on the server. Guest: in this browser's
// localStorage as 'ink.deck.<name>' → { name, cards: [[cardId, qty], …] }. On the first sign-in from a
// browser its guest decks move into the account.

const LOCAL = 'ink.deck.';
const state = { loaded: null, user: null, providers: {}, enabled: false, decks: null };
const listeners = new Set();

export const signedIn = () => !!state.user;
export const user = () => state.user;
export const providers = () => state.providers;
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => listeners.forEach((fn) => { try { fn(state.user); } catch (e) { console.error(e); } });

export function signInUrl(provider, next = location.pathname + location.search) {
  return `/auth/${provider}?next=${encodeURIComponent(next.replace(/([?&])signin=\w+&?/, '$1').replace(/[?&]$/, ''))}`;
}

// email + password: sign in, or create the account; then reload so the page picks up the account (and guest decks move in)
export async function passwordSignIn({ email, password, name, create }) {
  const j = await api(create ? '/api/account/register' : '/api/account/login', { method: 'POST', body: JSON.stringify({ email, password, name }) });
  state.user = j.user; state.decks = null; state.loaded = null;
  return j.user;
}

export async function signOut() {
  await fetch('/api/account/logout', { method: 'POST' }).catch(() => {});
  state.user = null; state.decks = null;
  emit();
}

// ---------- guest storage ----------
function localDecks() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(LOCAL)) continue;
    try { const d = JSON.parse(localStorage.getItem(k)); if (d && Array.isArray(d.cards)) out.push({ id: 'local:' + k.slice(LOCAL.length), name: d.name || k.slice(LOCAL.length), cards: d.cards, updated: d.updated || 0 }); }
    catch { /* skip a corrupt entry */ }
  }
  return out;
}

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${path} failed (${r.status})`);
  return j;
}

async function migrateGuestDecks() {
  const guest = localDecks().filter((d) => d.cards.length);
  if (!guest.length) return 0;
  const j = await api('/api/my/decks/import', { method: 'POST', body: JSON.stringify({ decks: guest.map(({ name, cards }) => ({ name, cards })) }) });
  for (const d of guest) localStorage.removeItem(LOCAL + d.id.slice(6));
  state.decks = j.decks;
  return j.added;
}

// Load the account once per page. Returns { user, migrated } — migrated = guest decks just moved in.
export async function load() {
  if (state.loaded) return state.loaded;
  state.loaded = (async () => {
    let migrated = 0;
    try {
      const j = await api('/api/account');
      state.user = j.user; state.providers = j.providers || {}; state.enabled = !!j.enabled;
      if (state.user) {
        try { migrated = await migrateGuestDecks(); } catch (e) { console.warn('[account] guest deck move failed:', e.message); }
      }
    } catch (e) { console.warn('[account] offline:', e.message); }
    const u = new URL(location.href);
    const signin = u.searchParams.get('signin');
    if (signin) { u.searchParams.delete('signin'); history.replaceState(null, '', u); }
    emit();
    return { user: state.user, migrated, signin };
  })();
  return state.loaded;
}

// ---------- decks (whichever store applies) ----------
export async function listDecks({ fresh = false } = {}) {
  await load();
  if (!state.user) return localDecks().sort((a, b) => a.name.localeCompare(b.name));
  if (!state.decks || fresh) state.decks = (await api('/api/my/decks')).decks;
  return [...state.decks].sort((a, b) => a.name.localeCompare(b.name));
}

// by id, or by name (a 'local:<name>' id still finds that deck after it moved into the account)
export async function getDeck(id) {
  const name = String(id).replace(/^local:/, '');
  const all = await listDecks();
  return all.find((d) => d.id === id) || all.find((d) => d.name === name) || null;
}

export async function saveDeck({ id, name, cards }) {
  await load();
  if (!state.user) {
    if (id?.startsWith('local:') && id.slice(6) !== name) localStorage.removeItem(LOCAL + id.slice(6));   // renamed
    localStorage.setItem(LOCAL + name, JSON.stringify({ name, cards, updated: Date.now() }));
    return { id: 'local:' + name, name, cards };
  }
  const j = await api('/api/my/decks', { method: 'POST', body: JSON.stringify({ id: id?.startsWith('local:') ? undefined : id, name, cards }) });
  state.decks = [...(state.decks || []).filter((d) => d.id !== j.deck.id && d.name !== j.deck.name), j.deck];
  return j.deck;
}

export async function deleteDeck(id) {
  await load();
  if (id.startsWith('local:')) { localStorage.removeItem(LOCAL + id.slice(6)); return; }
  await api(`/api/my/decks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (state.decks) state.decks = state.decks.filter((d) => d.id !== id);
}

// The sign-in buttons, for any page. Providers the server hasn't configured are left out.
const DISCORD_SVG = '<svg width="20" height="15" viewBox="0 0 22 16" aria-hidden="true"><path fill="currentColor" d="M18.6 1.4A17.5 17.5 0 0 0 14.3 0l-.5 1a16 16 0 0 0-4.6 0L8.7 0a17.5 17.5 0 0 0-4.3 1.4C1.6 5.5.9 9.5 1.2 13.5A17.7 17.7 0 0 0 6.5 16l1.1-1.6a11 11 0 0 1-1.8-.9l.4-.3a12.5 12.5 0 0 0 10.6 0l.4.3c-.6.4-1.2.6-1.8.9l1.1 1.6a17.6 17.6 0 0 0 5.3-2.5c.4-4.6-.7-8.6-3.2-12.1ZM7.8 11c-1 0-1.9-1-1.9-2.1S6.7 6.8 7.8 6.8s1.9 1 1.9 2.1S8.9 11 7.8 11Zm6.4 0c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1Z"/></svg>';
const GOOGLE_SVG = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.7H9v3.3h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5Z"/><path fill="#34A853" d="M9 18c2.4 0 4.5-.8 5.9-2.2L12 13.6c-.8.5-1.8.9-3 .9-2.3 0-4.3-1.6-5-3.7H1v2.3A9 9 0 0 0 9 18Z"/><path fill="#FBBC05" d="M4 10.7a5.4 5.4 0 0 1 0-3.4V5H1a9 9 0 0 0 0 8l3-2.3Z"/><path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3L15 2.4A9 9 0 0 0 1 5l3 2.3c.7-2.1 2.7-3.7 5-3.7Z"/></svg>';
export function signInButtons(next) {
  const p = state.providers;
  const out = [];
  if (p.discord) out.push(`<a class="btn btn-discord" href="${signInUrl('discord', next)}">${DISCORD_SVG}Continue with Discord</a>`);
  if (p.google) out.push(`<a class="btn btn-google" href="${signInUrl('google', next)}">${GOOGLE_SVG}Continue with Google</a>`);
  return out.join('');
}
export const anyProvider = () => Object.values(state.providers).some(Boolean);

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The email + password form (with any enabled provider buttons above it). Bind it with bindSignInForm.
export function signInForm({ next, name = '' } = {}) {
  const buttons = signInButtons(next);
  return `<form class="signin-form" novalidate>
    ${buttons ? `<div class="side-signin">${buttons}</div><div class="or"><span>or</span></div>` : ''}
    <div class="sf-tabs" role="tablist"><button type="button" class="on" data-mode="in" role="tab" aria-selected="true">Sign in</button><button type="button" data-mode="up" role="tab" aria-selected="false">Create account</button></div>
    <label class="field sf-name" hidden>Name at the table <input class="field-in" name="name" maxlength="24" autocomplete="nickname" value="${esc(name)}"></label>
    <label class="field">Email <input class="field-in" name="email" type="email" autocomplete="email" required></label>
    <label class="field">Password <input class="field-in" name="password" type="password" autocomplete="current-password" minlength="8" required></label>
    <div class="sf-err warn small" role="alert"></div>
    <button class="btn btn-gold" type="submit">Sign in</button>
  </form>`;
}
export function bindSignInForm(root, onDone) {
  const f = root.querySelector('.signin-form');
  if (!f) return;
  let create = false;
  const setMode = (up) => {
    create = up;
    f.querySelectorAll('[data-mode]').forEach((b) => { const on = (b.dataset.mode === 'up') === up; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    f.querySelector('.sf-name').hidden = !up;
    f.password.autocomplete = up ? 'new-password' : 'current-password';
    f.querySelector('[type=submit]').textContent = up ? 'Create account' : 'Sign in';
    f.querySelector('.sf-err').textContent = '';
  };
  f.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => setMode(b.dataset.mode === 'up'));
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('.sf-err');
    const btn = f.querySelector('[type=submit]');
    err.textContent = '';
    if (create && f.password.value.length < 8) { err.textContent = 'Use a password of at least 8 characters.'; return; }
    btn.disabled = true;
    try {
      await passwordSignIn({ email: f.email.value, password: f.password.value, name: f.name.value, create });
      onDone?.();
    } catch (x) { err.textContent = x.message; btn.disabled = false; }
  };
}
