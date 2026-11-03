// Card → proc lookup (backs GET /api/procs/* and public/procs.html).
//
//   search(index, q, limit, { engine })  name/title/text search → compact rows; engine (admins) adds the proc filters
//                                        and each row's automation status
//   card(index, full)        one card: verified text, compiled procs, plain-English read-back, printings (admins)
//   publicCard(index, full)  the same card as players see it on /rules: text, keywords, which abilities Ink runs
//   stats(index)             coverage + the biggest "why not runnable" buckets (what to build next; admins)

import { explain } from './explain.js';
import { Query } from './query.js';
import { sayClassifier } from './classifiers/index.js';

const RUNS = new Set(['triggered', 'activated', 'static', 'action']);
const norm = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9{} ]+/g, ' ').replace(/\s+/g, ' ').trim();

function canonicalDefs(index) {
  if (index._procCanon) return index._procCanon;
  const seen = new Map();
  for (const d of index.byFull.values()) if (!seen.has(d.full)) seen.set(d.full, d);
  index._procCanon = [...seen.values()].sort((a, b) => a.full.localeCompare(b.full));
  return index._procCanon;
}
const status = (d) => {
  const ps = d.procs || [];
  if (!ps.length) return 'auto';                                   // vanilla: the base proc is the whole card
  if (ps.every((p) => p.exec)) return 'auto';
  if (ps.some((p) => p.exec && RUNS.has(p.kind))) return 'partial';
  return 'manual';
};
const row = (d) => ({
  full: d.full, id: d.id, type: d.type, cost: d.cost, inks: d.inks, status: status(d),
  runnable: (d.procs || []).filter((p) => p.exec).length, abilities: (d.procs || []).length,
});

// what an ability's keyword is called in a filter: kw:singtogether, kw:sing-together and kw:"sing together" all work
const kwKey = (k) => String(k).toLowerCase().replace(/[^a-z]/g, '');
const PUBLIC_FILTERS = new Set(['type', 'ink', 'kw', 'cost']);

// q: free text. Prefix filters: type:item  ink:amber  kw:evasive  cost:3 — and for the engine view also
// fn:draw  kind:static  ev:quest  status:manual  why:"reveal"  with:singTogether  source:disney
export function search(index, q = '', limit = 40, { engine = true } = {}) {
  const defs = canonicalDefs(index);
  const terms = [];
  const filters = [];
  for (const m of String(q).matchAll(/(\w+):("[^"]*"|\S+)|("[^"]*"|\S+)/g)) {
    if (m[1] && (engine || PUBLIC_FILTERS.has(m[1].toLowerCase()))) filters.push([m[1].toLowerCase(), m[2].replace(/^"|"$/g, '').toLowerCase()]);
    else if (m[1]) continue;                                       // an engine filter on the public page: ignored
    else terms.push(norm(m[3].replace(/^"|"$/g, '')));
  }
  const fnsOf = (d) => JSON.stringify(d.procs || []).toLowerCase();
  const hit = (d) => filters.every(([k, v]) => {
    const ps = d.procs || [];
    switch (k) {
      case 'fn': return fnsOf(d).includes(`"fn":"${v}`);
      case 'kind': return ps.some((p) => p.kind.toLowerCase() === v);
      case 'ev': case 'trigger': return ps.some((p) => (p.on || []).some((o) => o.ev.toLowerCase() === v));
      case 'status': return status(d) === v;
      case 'type': return d.type === v;
      case 'ink': return (d.inks || []).includes(v);
      case 'kw': return Object.keys(d.kw || {}).some((k) => kwKey(k) === kwKey(v));
      case 'cost': return String(d.cost) === v || (v.endsWith('+') && d.cost >= Number(v.slice(0, -1)));
      case 'why': return ps.some((p) => !p.exec && String(p.why || '').toLowerCase().includes(v));
      case 'with': return Query.classifiersIn(ps).some((x) => sayClassifier(x).toLowerCase().replace(/\s+/g, '').includes(v.replace(/\s+/g, '')) || Object.values(x).some((y) => JSON.stringify(y).toLowerCase().includes(v)));
      case 'source': return String(d.rulesSource || '').toLowerCase() === v;
      default: return true;
    }
  });
  const scored = [];
  for (const d of defs) {
    if (!hit(d)) continue;
    const name = norm(d.full);
    const text = norm(d.abilities.map((a) => `${a.name} ${a.text}`).join(' '));
    let score = 0;
    let ok = true;
    for (const t of terms) {
      if (!t) continue;
      if (name.startsWith(t)) score += 30;
      else if (name.split(' ').some((w) => w.startsWith(t))) score += 15;
      else if (name.includes(t)) score += 10;
      else if (text.includes(t)) score += 2;
      else { ok = false; break; }
    }
    if (ok) scored.push([score, d]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].full.localeCompare(b[1].full));
  const out = engine ? row : publicRow;
  return { total: scored.length, results: scored.slice(0, limit).map(([, d]) => out(d)) };
}

export function card(index, full) {
  const d = index.byFull.get(full) || canonicalDefs(index).find((x) => x.full.toLowerCase() === String(full).toLowerCase());
  if (!d) return null;
  const printings = [...index.byId.values()].filter((x) => x.full === d.full).map((x) => x.id);
  return {
    ...row(d), title: d.title, name: d.name, str: d.str, wp: d.wp, lore: d.lore, move: d.move, inkable: d.inkable,
    classes: d.classes, kw: d.kw, rulesSource: d.rulesSource, printings,
    base: d.base || null, baseExplain: d.base ? explain(d.base) : [],
    abilities: d.abilities.map((a, i) => ({ name: a.name, text: a.text, proc: d.procs?.[i] || null, explain: d.procs?.[i] ? explain(d.procs[i]) : [] })),
  };
}

const publicRow = (d) => ({ full: d.full, id: d.id, type: d.type, cost: d.cost, inks: d.inks });

// what /rules shows everyone: the card as printed, its keywords, and for each ability whether Ink runs it or the
// players resolve it by hand — no procs. faq/printed/flavor come from the caller (sanitized.db's rules table).
export function publicCard(index, full) {
  const d = index.byFull.get(full) || canonicalDefs(index).find((x) => x.full.toLowerCase() === String(full).toLowerCase());
  if (!d) return null;
  const printings = [...index.byId.values()].filter((x) => x.full === d.full).map((x) => ({ id: x.id, set: x.set, num: x.num, rarity: x.rarity }));
  return {
    ...publicRow(d), name: d.name, title: d.title, str: d.str, wp: d.wp, lore: d.lore, move: d.move, inkable: d.inkable,
    classes: d.classes, kw: d.kw || {}, flavor: d.flavor || '', franchise: d.franchise || '', printings,
    // keywords and reminder text (singing a song) are rules the engine enforces; d.auto only counts abilities that do
    // something on their own
    abilities: d.abilities.map((a, i) => { const p = d.procs?.[i]; const keyword = p?.kind === 'keyword' || p?.kind === 'reminder'; return { name: a.name, text: a.text, keyword, auto: keyword ? !!p.exec : !!d.auto?.[i] }; }),
  };
}

export function stats(index) {
  const defs = canonicalDefs(index);
  const by = { vanilla: 0, auto: 0, partial: 0, manual: 0 };
  const kinds = {};
  const fns = {};
  const misses = {};
  const classifiers = {};
  let abilities = 0;
  let runnable = 0;
  for (const d of defs) {
    by[status(d)]++;
    if (!(d.procs || []).length) by.vanilla++;                       // counted in auto too (base proc only)
    for (const p of d.procs || []) {
      abilities++;
      kinds[p.kind] = (kinds[p.kind] || 0) + 1;
      if (p.exec) {
        runnable++;
        for (const m of JSON.stringify(p).matchAll(/"fn":"(\w+)"/g)) fns[m[1]] = (fns[m[1]] || 0) + 1;
        for (const x of Query.classifiersIn(p)) { const k = sayClassifier(x); classifiers[k] = (classifiers[k] || 0) + 1; }
      } else {
        const k = String(p.why || '?').replace(/"[^"]*"/, (m) => (m.length > 48 ? m.slice(0, 48) + '…"' : m));
        (misses[k] ||= []).push(d.full);
      }
    }
  }
  return {
    cards: defs.length, ...by, abilities, runnable, pct: abilities ? +((100 * runnable) / abilities).toFixed(1) : 0,
    kinds, fns: Object.entries(fns).sort((a, b) => b[1] - a[1]),
    classifiers: Object.entries(classifiers).sort((a, b) => b[1] - a[1]),
    misses: Object.entries(misses).sort((a, b) => b[1].length - a[1].length).slice(0, 30).map(([why, list]) => ({ why, n: list.length, examples: list.slice(0, 4) })),
  };
}

export { explain };
