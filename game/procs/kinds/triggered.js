// "<trigger>, [if <cond>,] effect"   { kind:'triggered', on:[{ev,…}], once?, during?, cond?, do:[step] }
import { Kind, sayDuring } from './Kind.js';
import { parseTrigger, sayTrigger } from '../triggers/index.js';

export class Triggered extends Kind {
  static kind = 'triggered';
  static parse(t, c, mods) {
    const ci = t.indexOf(', ');
    if (ci <= 0) return null;
    const head = t.slice(0, ci);
    const on = parseTrigger(head, c.P(t));
    if (!on) {
      if (/^(when|whenever|at the) /i.test(head)) c.miss(`trigger: "${head}"`, t);
      return null;
    }
    let body = t.slice(ci + 2);
    let cond;
    const m = body.match(/^if (.+?), (.+)$/i);
    if (m && !/^if you do/i.test(body)) { cond = c.condition(m[1], t); body = m[2]; }
    return { kind: 'triggered', on, ...mods, ...(cond ? { cond } : {}), do: c.effects(body, { refIsSelf: true }) };
  }
  static check(p, missing, S) { for (const o of p.on) if (!S.trigger.has(o.ev)) missing.add(`trigger ${o.ev}`); }
  static explain(p, X) {
    const when = p.on.map((o) => `${sayTrigger(o)}${o.whileCond ? ` while ${X.cond(o.whileCond)}` : ''}`).join(' or ');
    return [X.tag('triggered'), `WHEN ${when}${sayDuring(p)}`, ...(p.cond ? [`IF ${X.cond(p.cond)}`] : []), ...p.do.map((st, i) => `${i + 1}. ${X.step(st)}`)];
  }

  // runtime: queue every trigger on card `c` listening for `ev` that passes `pass` (into the bag)
  static fire(rt, s, c, ev, pass, it) {
    rt.procsOf(s, c).forEach((proc, k) => {
      if (proc.kind !== 'triggered') return;
      const on = proc.on.find((o) => o.ev === ev && (!pass || pass(o)));
      if (!on) return;
      const label = rt.labelOf(s, c, proc);
      if (!proc.exec) { rt.log(s, `↳ ${label}: ${rt.E.prettyText(proc.text)}`, { kind: 'effect' }); return; }
      if (!rt.duringOk(s, proc, c.owner)) return;
      if (on.whileCond && !rt.test(s, on.whileCond, c.owner, c.iid)) return;
      if (proc.once) {
        c.once ||= {};
        if (c.once[k] === s.turn) return;
        c.once[k] = s.turn;
      }
      rt.queue(s, c.owner, c.iid, label, proc.do, { it: it || [] }, { cond: proc.cond || null });
    });
  }
}
