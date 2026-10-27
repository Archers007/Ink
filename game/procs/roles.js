// What a card does, for the deck builder: role tags read off its compiled procs. Each Effect class answers for its
// own steps (Effect.role, effects/*.js); this walks a card's procs, adds what its keywords and type say, and notes
// which classifications the card pays off ("cares": a filter on Pirate characters, not counting the card's own name).
import { EFFECT } from './effects/index.js';

export const ROLES = {
  removal: 'Removal', draw: 'Card draw', ramp: 'Ramp', lore: 'Lore', protection: 'Protection', recursion: 'Recursion', songs: 'Songs',
};

function walk(x, fn) {
  if (Array.isArray(x)) { for (const y of x) walk(y, fn); return; }
  if (!x || typeof x !== 'object') return;
  fn(x);
  for (const v of Object.values(x)) walk(v, fn);
}

export function cardRoles(def) {
  const roles = new Set();
  const cares = new Set();
  for (const p of def.procs || []) {
    walk(p.do, (st) => {
      const C = st.fn && EFFECT[st.fn];
      const r = C?.role?.(st);
      if (r) roles.add(r);
    });
    walk(p, (o) => {
      for (const c of [].concat(o.class || [])) if (typeof c === 'string' && (p.kind !== 'keyword')) cares.add(c.toLowerCase());
    });
    if ((p.on || []).some((e) => e.ev === 'sing') || JSON.stringify(p.on || []).includes('"song"')) roles.add('songs');
  }
  const kw = def.kw || {};
  if (kw.ward || kw.resist || kw.bodyguard) roles.add('protection');
  if (kw.singer || kw.singTogether || def.type === 'song') roles.add('songs');
  return { roles: [...roles], cares: [...cares] };
}

// { roles: { [printingId]: [...] }, cares: { [printingId]: [...] } } for every card in the index
export function rolesForIndex(index) {
  const roles = {}, cares = {};
  const byFull = new Map();
  for (const d of index.byId.values()) {
    let r = byFull.get(d.full);
    if (!r) { r = cardRoles(d); byFull.set(d.full, r); }
    if (r.roles.length) roles[d.id] = r.roles;
    if (r.cares.length) cares[d.id] = r.cares;
  }
  return { labels: ROLES, roles, cares };
}
