// Thin wrapper around our /api/login etc.

export const Session = {
  uid: null,
  displayName: null,
  collection: null,         // owned-cards JSON, shape: { [cardId]: { base: n, foil: n } } (best-guess)
};

export async function me() {
  const r = await fetch('/api/me');
  const j = await r.json();
  if (j.ok) {
    Session.uid = j.uid;
    Session.displayName = j.displayName;
  }
  return j;
}

export async function login(email, password) {
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'login failed');
  Session.uid = j.uid;
  Session.displayName = j.displayName;
  return j;
}

export async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  Session.uid = null;
  Session.displayName = null;
  Session.collection = null;
}

export async function syncCollection() {
  const r = await fetch('/api/collection');
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'collection fetch failed');
  Session.collection = j.owned || {};
  return Session.collection;
}

export function ownedQty(cardId) {
  if (!Session.collection) return null;
  const e = Session.collection[cardId];
  if (!e) return 0;
  if (typeof e === 'number') return e;
  // common shape: { base: n, foil: n }
  return (e.base || 0) + (e.foil || 0);
}
