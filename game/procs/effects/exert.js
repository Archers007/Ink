import { Effect } from './Effect.js';
import { Selector } from '../phrases/selector.js';

export class Exert extends Effect {
  static fn = 'exert';
  static harmful = true;
  static rules = [[/^(?:exert|\{exert\}) (.+)$/i, (m, P) => ({ fn: 'exert', sel: P.sel(m[1]) })]];   // "{exert} chosen character here" (a cost)
  static run(rt, s, job, st, ev) {
    // an already exerted character can be chosen (it stays exerted — Magic Broom - Dancing Duster ruling); a cost needs a ready one
    const ids = rt.targets(s, job, st, st.sel, 'sel', { keep: (iid) => (!st.cost || !s.cards[iid].exerted) && rt.E.D(s, s.cards[iid]).type !== 'location' });
    if (!ids) return null;
    job.ctx.it = ids;
    return rt.each(ids, (iid) => { rt.E.exertCard(s, s.cards[iid]); ev.push({ k: 'exert', iid }); rt.log(s, `↳ Exerted ${rt.tl(s, iid)}.`, { seat: job.seat, kind: 'effect' }); });
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
      if (rt.E.hasKw(c, rt.E.D(s, c), 'cantReady')) return;            // "this character can't ready" (not the start-of-turn-only kind)
      const was = c.exerted;
      c.exerted = false;
      if (was) rt.fire(s, 'ready', { iid }); ev.push({ k: 'ready', iid }); rt.log(s, `↳ Readied ${rt.tl(s, iid)}.`, { seat: job.seat, kind: 'effect' });
    });
  }
  static verb() { return 'ready'; }
  static say(st) { return `ready ${Selector.say(st.sel)}`; }
}
