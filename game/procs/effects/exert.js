import { Effect } from './Effect.js';
import { Selector } from '../phrases/selector.js';

export class Exert extends Effect {
  static fn = 'exert';
  static harmful = true;
  static rules = [[/^exert (.+)$/i, (m, P) => ({ fn: 'exert', sel: P.sel(m[1]) })]];
  static run(rt, s, job, st, ev) {
    const ids = rt.targets(s, job, st, st.sel, 'sel', { keep: (iid) => !s.cards[iid].exerted && rt.E.D(s, s.cards[iid]).type !== 'location' });
    if (!ids) return null;
    job.ctx.it = ids;
    return rt.each(ids, (iid) => { s.cards[iid].exerted = true; ev.push({ k: 'exert', iid }); rt.log(s, `↳ Exerted ${rt.tl(s, iid)}.`, { seat: job.seat, kind: 'effect' }); });
  }
  static verb() { return 'exert'; }
  static say(st) { return `exert ${Selector.say(st.sel)}`; }
}
export class Ready extends Effect {
  static fn = 'ready';
  static rules = [[/^ready (.+)$/i, (m, P) => ({ fn: 'ready', sel: P.sel(m[1]) })]];
  static run(rt, s, job, st, ev) {
    const ids = rt.targets(s, job, st, st.sel);
    if (!ids) return null;
    job.ctx.it = ids;
    return rt.each(ids, (iid) => {
      const c = s.cards[iid];
      if (rt.E.hasKw(c, rt.E.D(s, c), 'cantReady')) return;
      c.exerted = false; ev.push({ k: 'ready', iid }); rt.log(s, `↳ Readied ${rt.tl(s, iid)}.`, { seat: job.seat, kind: 'effect' });
    });
  }
  static verb() { return 'ready'; }
  static say(st) { return `ready ${Selector.say(st.sel)}`; }
}
