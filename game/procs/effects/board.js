// Stacks and locations: "put the top card of your deck facedown under one of your characters or locations with Boost"
//                       "move a character of yours to a location for free" · "move him to a location for free"
import { Effect } from './Effect.js';
import { Selector } from '../phrases/selector.js';

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
export class MoveFree extends Effect {
  static fn = 'moveFree';
  static rules = [
    [/^move (.+?) to (?:a|one of your) locations? for free$/i, (m, P) => ({ fn: 'moveFree', sel: /^(?:a|an) /i.test(m[1]) ? { chosen: { ...P.filter(m[1].replace(/^an? /i, '')), owner: 'you' } } : P.sel(m[1]), to: { chosen: { types: ['location'], owner: 'you' } } })],
    [/^move (.+?) to (?:this location|here) for free$/i, (m, P) => ({ fn: 'moveFree', sel: /^(?:a|an) /i.test(m[1]) ? { chosen: { ...P.filter(m[1].replace(/^an? /i, '')), owner: 'you' } } : P.sel(m[1]), to: { self: true } })],
  ];
  static chooses(st) { return !!(st.sel?.chosen || st.to?.chosen); }
  static run(rt, s, job, st, ev) {
    const who = rt.targets(s, job, st, st.sel, 'sel', { keep: (iid) => rt.E.D(s, s.cards[iid]).type === 'character' && !rt.E.hasKw(s.cards[iid], rt.E.D(s, s.cards[iid]), 'cantMove'), verb: 'move' });
    if (!who) return null;
    if (!who.length) return false;
    const to = rt.targets(s, job, st, st.to, 'to', { keep: (iid) => s.cards[who[0]].atLocation !== iid, verb: `move ${rt.E.cardLabel(rt.E.D(s, s.cards[who[0]]))} to` });
    if (!to) return null;
    if (!to.length) return false;
    rt.log(s, `↳ Moved ${rt.tl(s, who[0])} to ${rt.E.cardLabel(rt.E.D(s, s.cards[to[0]]))} for free.`, { seat: job.seat, kind: 'effect' });
    rt.E.moveChar(s, who[0], to[0], ev);
    job.ctx.it = [who[0]];
    return true;
  }
  static say(st) { return `move ${Selector.say(st.sel)} to ${Selector.say(st.to)} for free`; }
}
