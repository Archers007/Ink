// Actions and songs: the whole text resolves when played.  { kind:'action', playCost?, do:[step] }
import { Kind } from './Kind.js';

export class Action extends Kind {
  static kind = 'action';
  static parse(t, c) {
    // "If you have X in play, you pay 2 {ink} less to play this action." rides along as a play-cost rule
    let playCost;
    const pc = t.match(/^(?:if (.+?), )?you pay (\d+) \{ink\} less to play this (?:action|song)\.\s*(.*)$/i);
    if (pc) { playCost = { n: +pc[2], ...(pc[1] ? { cond: c.condition(pc[1], t) } : {}) }; t = pc[3]; }
    const pe = !pc && t.match(/^for each (.+?), you pay (\d+) \{ink\} less to play this (?:action|song)\.\s*(.*)$/i);
    if (pe) { playCost = { n: +pe[2], per: c.forEach(pe[1], t) }; t = pe[3]; }
    return { kind: 'action', ...(playCost ? { playCost } : {}), do: c.effects(t) };
  }
  static explain(p, X) {
    return [X.tag('action'), ...(p.playCost ? [`costs ${p.playCost.n} less${p.playCost.per ? ' for each …' : ''}${p.playCost.cond ? ` if ${X.cond(p.playCost.cond)}` : ''}`] : []), ...p.do.map((st, i) => `${i + 1}. ${X.step(st)}`)];
  }
  // runtime: queue every runnable action proc on the card; false → the card is resolved by hand
  static cast(rt, s, seat, c) {
    const procs = rt.procsOf(s, c).filter((p) => p.kind !== 'reminder' && p.kind !== 'keyword');
    if (!procs.length || !procs.every((p) => p.exec && p.kind === 'action')) return false;
    rt.queue(s, seat, c.iid, rt.E.cardLabel(rt.E.D(s, c)), procs.flatMap((p) => p.do));
    return true;
  }
}
