// Stacks and locations: "put the top card of your deck facedown under one of your characters or locations with Boost"
//                       "move a character of yours to a location for free" · "move him to a location for free"
import { Effect } from './Effect.js';
import { Selector } from '../phrases/selector.js';
import { Query } from '../query.js';

const describeQ = (F) => Query.describe(F);

export class PutUnder extends Effect {
  static fn = 'putUnder';
  static rules = [[/^put the top card of your deck facedown under (.+)$/i, (m, P) => ({ fn: 'putUnder', sel: P.sel(m[1]) })]];
  static run(rt, s, job, st, ev) {
    const ids = rt.targets(s, job, st, st.sel);
    if (!ids) return null;
    return rt.each(ids.slice(0, 1), (iid) => { if (rt.E.putUnder(s, job.seat, iid, ev)) rt.log(s, `↳ Put the top card of ${rt.E.nameOf(s, job.seat)}'s deck facedown under ${rt.tl(s, iid)}.`, { seat: job.seat, kind: 'effect' }); });
  }
  static verb() { return 'put the top card of your deck under'; }
  static say(st) { return `put the top card of your deck facedown under ${Selector.say(st.sel)}`; }
}
// "move <who> to <where> for free" — who is one or more movers joined by "and" ("him and one of your other characters",
// "up to 2 characters of yours", "any number of your characters"); where is a location of yours ("a location",
// "a Hyperia City location", "the same location", "that location", "here", "another location"). All movers go to the
// one location picked.
const WHERE = [
  [/^(?:a|one of your|the same|another) locations?$/i, () => ({ chosen: { types: ['location'], owner: 'you' } })],
  [/^(?:this location|here)$/i, () => ({ self: true })],
  [/^that location$/i, () => ({ refLoc: true })],
];
function moverSel(phrase, P) {
  const p = phrase.trim();
  if (/^(?:a|an) /i.test(p)) return { chosen: { ...P.filter(p.replace(/^an? /i, '')), owner: 'you' } };
  if (/^up to \d+ (?:of your )?(?:other )?characters?(?: of yours)?$/i.test(p) || /^any number of /i.test(p)) {
    const n = /^any number/i.test(p) ? 99 : Number(p.match(/\d+/)[0]);
    const F = { types: ['character'], owner: 'you', ...(/other/i.test(p) ? { other: true } : {}) };
    return { chosen: F, upTo: n };
  }
  return P.sel(p);
}
export class MoveFree extends Effect {
  static fn = 'moveFree';
  static rules = [[/^move (.+) to (.+?) for free$/i, (m, P) => {               // the last " to " ("move up to 2 …")
    let to = null;
    for (const [rx, f] of WHERE) if (rx.test(m[2])) { to = f(); break; }
    const cls = !to && m[2].match(/^(?:a|an) (.+) location$/i);       // "a Hyperia City location"
    if (cls) to = { chosen: { ...P.filter(`${cls[1]} location`), owner: 'you' } };
    if (!to) return P.miss(`move to: "${m[2]}"`);
    const movers = m[1].split(/ and (?=(?:up to |one of |any |a |an |him|her|them|this |that ))/i).map((x) => moverSel(x, P));
    return { fn: 'moveFree', sel: movers[0], ...(movers.length > 1 ? { also: movers.slice(1) } : {}), to };
  }]];
  static chooses(st) { return !!(st.sel?.chosen || st.to?.chosen || st.also?.some((x) => x.chosen)); }
  static run(rt, s, job, st, ev) {
    const canMove = (iid) => rt.E.D(s, s.cards[iid]).type === 'character' && !rt.E.hasKw(s.cards[iid], rt.E.D(s, s.cards[iid]), 'cantMove');
    const sels = [st.sel, ...(st.also || [])];
    const movers = [];
    for (let k = 0; k < sels.length; k++) {
      const ids = rt.targets(s, job, st, sels[k], `sel${k || ''}`, { keep: (iid) => canMove(iid) && !movers.includes(iid), verb: 'move' });
      if (!ids) return null;
      movers.push(...ids);
    }
    if (!movers.length) return false;
    let to;
    if (st.to.refLoc) {
      const r = s.cards[(job.ctx.it || [])[0]];
      to = r ? [rt.E.D(s, r).type === 'location' ? r.iid : r.atLocation].filter((x) => x != null && s.cards[x]?.zone === 'play') : [];
    } else {
      to = rt.targets(s, job, st, st.to, 'to', { keep: (iid) => movers.some((m) => s.cards[m].atLocation !== iid), verb: `move ${movers.map((m) => rt.E.cardLabel(rt.E.D(s, s.cards[m]))).join(' and ')} to` });
      if (!to) return null;
    }
    if (!to.length) return false;
    const moved = movers.filter((m) => s.cards[m].atLocation !== to[0]);
    for (const m of moved) {
      rt.log(s, `↳ Moved ${rt.tl(s, m)} to ${rt.E.cardLabel(rt.E.D(s, s.cards[to[0]]))} for free.`, { seat: job.seat, kind: 'effect' });
      rt.E.moveChar(s, m, to[0], ev);
    }
    job.ctx.it = moved;
    return moved.length > 0;
  }
  static say(st) { return `move ${[st.sel, ...(st.also || [])].map(Selector.say).join(' and ')} to ${st.to.refLoc ? 'that location' : Selector.say(st.to)} for free`; }
}

// static-only: what moving costs — "your Pirate characters may move here for free" · "you pay 2 {ink} less to move a
// character of yours here" · "you pay 1 {ink} less to move your characters to a location"
//   { who: Query (the mover), here?: true (only to this location), n: number | 'free' }
export class MoveCost extends Effect {
  static fn = 'moveCost';
  static staticOnly = true;
  static say(st) { return `${st.n === 'free' ? 'free moves' : `moving costs ${st.n} {ink} less`} for ${st.who ? describeQ(st.who) : 'this character'}${st.here ? ' to here' : ''}`; }
}
