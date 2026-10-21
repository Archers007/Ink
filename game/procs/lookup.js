// Card → proc lookup (backs GET /api/procs/* and public/procs.html).
//
//   search(index, q)   name/title/text/proc-fn search → compact rows
//   card(index, full)  one card: verified text, compiled procs, plain-English read-back, printings
//   stats(index)       coverage + the biggest "why not runnable" buckets (what to build next)

import { describe } from './runtime.js';

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
  if (!ps.length) return 'vanilla';
  if (ps.every((p) => p.exec)) return 'auto';
  if (ps.some((p) => p.exec && RUNS.has(p.kind))) return 'partial';
  return 'manual';
};
const row = (d) => ({
  full: d.full, id: d.id, type: d.type, cost: d.cost, inks: d.inks, status: status(d),
  runnable: (d.procs || []).filter((p) => p.exec).length, abilities: (d.procs || []).length,
});

// q: free text. Prefix filters: fn:draw  kind:static  ev:quest  status:manual  type:item  why:"reveal"
export function search(index, q = '', limit = 40) {
  const defs = canonicalDefs(index);
  const terms = [];
  const filters = [];
  for (const m of String(q).matchAll(/(\w+):("[^"]*"|\S+)|("[^"]*"|\S+)/g)) {
    if (m[1]) filters.push([m[1].toLowerCase(), m[2].replace(/^"|"$/g, '').toLowerCase()]);
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
      case 'why': return ps.some((p) => !p.exec && String(p.why || '').toLowerCase().includes(v));
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
  return { total: scored.length, results: scored.slice(0, limit).map(([, d]) => row(d)) };
}

export function card(index, full) {
  const d = index.byFull.get(full) || canonicalDefs(index).find((x) => x.full.toLowerCase() === String(full).toLowerCase());
  if (!d) return null;
  const printings = [...index.byId.values()].filter((x) => x.full === d.full).map((x) => x.id);
  return {
    ...row(d), title: d.title, name: d.name, str: d.str, wp: d.wp, lore: d.lore, move: d.move, inkable: d.inkable,
    classes: d.classes, kw: d.kw, rulesSource: d.rulesSource, printings,
    abilities: d.abilities.map((a, i) => ({ name: a.name, text: a.text, proc: d.procs?.[i] || null, explain: d.procs?.[i] ? explain(d.procs[i]) : [] })),
  };
}

export function stats(index) {
  const defs = canonicalDefs(index);
  const by = { vanilla: 0, auto: 0, partial: 0, manual: 0 };
  const kinds = {};
  const fns = {};
  const misses = {};
  let abilities = 0;
  let runnable = 0;
  for (const d of defs) {
    by[status(d)]++;
    for (const p of d.procs || []) {
      abilities++;
      kinds[p.kind] = (kinds[p.kind] || 0) + 1;
      if (p.exec) {
        runnable++;
        for (const m of JSON.stringify(p).matchAll(/"fn":"(\w+)"/g)) fns[m[1]] = (fns[m[1]] || 0) + 1;
      } else {
        const k = String(p.why || '?').replace(/"[^"]*"/, (m) => (m.length > 48 ? m.slice(0, 48) + '…"' : m));
        (misses[k] ||= []).push(d.full);
      }
    }
  }
  return {
    cards: defs.length, ...by, abilities, runnable, pct: abilities ? +((100 * runnable) / abilities).toFixed(1) : 0,
    kinds, fns: Object.entries(fns).sort((a, b) => b[1] - a[1]),
    misses: Object.entries(misses).sort((a, b) => b[1].length - a[1].length).slice(0, 30).map(([why, list]) => ({ why, n: list.length, examples: list.slice(0, 4) })),
  };
}

// ---------------------------------------------------------------- plain-English read-back

const STAT = { str: '{strength}', wp: '{willpower}', lore: '{lore}' };
const DUR = { turn: 'this turn', next: 'until the start of your next turn', theirNext: "during its owner's next turn" };
const EV = {
  play: 'you play this card', quest: 'this character quests', challenges: 'this character challenges', challenged: 'this is challenged',
  banished: 'this is banished', banishOther: 'this banishes another character in a challenge', turnStart: 'your turn starts',
  turnEnd: 'your turn ends', playCard: 'you play', oppPlayCard: 'an opponent plays', questAny: 'quests', banishedAny: 'is banished',
  challengesAny: 'challenges', sings: 'this character sings a song', singsAny: 'sings a song', questHere: 'a character quests here',
  banishOtherAny: 'banishes another character in a challenge', inked: 'you put a card into your inkwell', moveHere: 'a character moves here',
};
const amt = (n) => (typeof n === 'number' ? n : n?.stat ? `${n.of === 'self' ? "this card's" : 'their'} ${STAT[n.stat]}` : '?');
function sel(s) {
  if (!s) return '';
  if (s.self) return 'this card';
  if (s.ref) return 'that card';
  if (s.all) return `each ${describe(s.all)}`;
  if (s.chosen) return `${s.upTo ? `up to ${s.upTo} ` : ''}chosen ${describe(s.chosen)}`;
  return '?';
}
function cond(c) {
  if (!c) return '';
  if (c.any) return c.any.map(cond).join(' or ');
  if (c.have) return c.exactly ? `you have exactly ${c.n} ${describe(c.have)}` : `you have ${c.n > 1 ? `${c.n}+ ` : 'a '}${describe(c.have)}`;
  if (c.self) return `this card is ${Object.keys(c.self).join(' & ')}`;
  if (c.hand) return `your hand has ${c.hand.gte != null ? `${c.hand.gte}+` : `≤${c.hand.lte}`} cards`;
  if (c.playedThisTurn) return `you played a ${describe(c.playedThisTurn)} this turn`;
  if ('yourTurn' in c) return c.yourTurn ? "it's your turn" : "it's an opponent's turn";
  if (c.refIs) return `that card is a ${describe(c.refIs)}`;
  return Object.keys(c).join(', ');
}
function step(st) {
  const may = st.may ? 'may ' : '';
  const gate = st.ifDid ? 'if you did, ' : st.otherwise ? 'otherwise, ' : st.linked ? 'then ' : '';
  const pre = (t) => `${gate}${st.cond ? `if ${cond(st.cond)}, ` : ''}${may}${t}`;
  const per = st.per ? ` for each ${describe(st.per.count)}` : '';
  switch (st.fn) {
    case 'draw': return pre(`${st.who === 'each' ? 'each player draws' : st.who === 'opp' ? 'each opponent draws' : 'draw'} ${amt(st.n)}`);
    case 'gainLore': return pre(`gain ${amt(st.n)} lore`);
    case 'loseLore': return pre(`each opponent loses ${amt(st.n)} lore`);
    case 'damage': return pre(`${st.put ? 'put' : 'deal'} ${amt(st.n)} damage ${st.put ? 'on' : 'to'} ${sel(st.sel)}`);
    case 'heal': return pre(`remove up to ${amt(st.n)} damage from ${sel(st.sel)}`);
    case 'moveDamage': return pre(`move ${st.n} damage from ${sel(st.from)} to ${sel(st.to)}`);
    case 'banish': return pre(`banish ${sel(st.sel)}`);
    case 'toHand': return pre(`return ${sel(st.sel)} to its owner's hand`);
    case 'toDeckBottom': return pre(`put ${sel(st.sel)} on the bottom of its deck`);
    case 'shuffleIn': return pre(`shuffle ${sel(st.sel)} into its deck`);
    case 'toInkwell': return pre(`put ${sel(st.sel)} into its inkwell${st.exerted ? ' exerted' : ''}`);
    case 'inkTop': return pre(`put the top card of your deck into your inkwell${st.exerted ? ' exerted' : ''}`);
    case 'mill': return pre(`put the top ${st.n} cards of your deck into your discard`);
    case 'exert': return pre(`exert ${sel(st.sel)}`);
    case 'ready': return pre(`ready ${sel(st.sel)}`);
    case 'mod': return pre(`${sel(st.sel)} gets ${[...(st.mods || []).map((m) => `${m.n > 0 ? '+' : ''}${m.n} ${STAT[m.stat]}`), ...(st.kws || []).map((k) => k.kw + (k.n ? ` +${k.n}` : ''))].join(', ')}${per} ${st.dur ? DUR[st.dur] : '(while in play)'}`);
    case 'discard': return pre(`${st.who === 'opp' ? 'each opponent discards' : st.who === 'each' ? 'each player discards' : 'discard'} ${st.n}${st.random ? ' at random' : ''}${st.filter ? ` ${describe(st.filter)}` : ''}`);
    case 'oppChoose': return pre(`each opponent chooses one of their ${describe(st.filter)} and ${st.act === 'toHand' ? 'returns it to hand' : st.act === 'damage' ? `deals ${st.n} damage to it` : `${st.act}es it`.replace('exertes', 'exerts')}`);
    case 'fromDiscard': return pre(`return ${st.upTo ? 'up to ' : ''}${st.n || 1} ${describe(st.filter)} from your discard to your hand`);
    case 'look': return pre(`look at the top ${st.n} cards${st.pick ? `; ${st.pick.may ? 'may ' : ''}${st.pick.reveal ? 'reveal' : 'take'} ${st.pick.n} ${describe(st.pick.filter)} into hand` : ''}${st.rest ? `; rest to ${st.rest}` : ''}${st.scry ? '; put on top or bottom' : ''}`);
    case 'payInk': return pre(`pay ${amt(st.n)} {ink}`);
    case 'chooseOne': return `choose one: ${st.options.map((o, i) => `(${i + 1}) ${o.map(step).join(', ')}`).join('  ')}`;
    case 'playFree': return pre(`play ${describe(st.filter)} for free`);
    case 'costMod': return pre(`pay ${st.n} {ink} less for ${st.next ? 'the next' : 'each'} ${describe(st.filter)}${st.dur ? ` ${DUR[st.dur]}` : ''}`);
    case 'shuffle': return pre('shuffle your deck');
    case 'selfCost': return `you pay ${st.n} {ink} less to play this${per}`;
    case 'enters': return `enters play ${st.exerted ? 'exerted' : `with ${st.damage} damage`}`;
    default: return pre(st.fn);
  }
}

export function explain(p) {
  const out = [];
  const tag = (k) => (p.exec ? `⚡ ${k}` : `✋ ${k} (manual)`);
  switch (p.kind) {
    case 'keyword': out.push(tag('keyword'), p.kws.map((k) => `${k.kw}${k.n ? ` +${k.n}` : ''}${k.cost ? ` (${k.cost})` : ''}`).join(', ')); break;
    case 'reminder': out.push('reminder text — no rules'); break;
    case 'unparsed': out.push('✋ manual — not compiled', `why: ${p.why}`); break;
    case 'triggered': {
      const when = p.on.map((o) => `${EV[o.ev] || o.ev}${o.filter ? ` (${describe(o.filter)})` : ''}${o.inChallenge ? ' in a challenge' : ''}`).join(' or ');
      out.push(tag('triggered'), `WHEN ${when}${p.during ? ` — during ${p.during === 'yours' ? 'your' : "an opponent's"} turn` : ''}${p.once ? ' — once per turn' : ''}`);
      if (p.cond) out.push(`IF ${cond(p.cond)}`);
      p.do.forEach((st, i) => out.push(`${i + 1}. ${step(st)}`));
      break;
    }
    case 'activated': {
      const c = p.cost;
      out.push(tag('activated'), `COST ${[c.exert && '{exert}', c.ink && `${c.ink} {ink}`, c.banishSelf && 'banish this', c.discard && `discard a ${describe(c.discard)}`].filter(Boolean).join(' + ')}${p.once ? ' — once per turn' : ''}`);
      p.do.forEach((st, i) => out.push(`${i + 1}. ${step(st)}`));
      break;
    }
    case 'static':
      out.push(tag('static'), `${p.cond ? `WHILE ${cond(p.cond)}: ` : 'ALWAYS: '}${step(p.effect)}${p.during ? ` — during ${p.during === 'yours' ? 'your' : "an opponent's"} turn` : ''}`);
      break;
    case 'action':
      out.push(tag('action'));
      if (p.playCost) out.push(`costs ${p.playCost.n} less${p.playCost.cond ? ` if ${cond(p.playCost.cond)}` : ''}`);
      p.do.forEach((st, i) => out.push(`${i + 1}. ${step(st)}`));
      break;
    default: out.push(p.kind);
  }
  if (p.exec === false && p.kind !== 'unparsed' && p.why) out.push(`why manual: ${p.why}`);
  return out;
}
