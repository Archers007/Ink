// Paying and discounting ink: "pay 2 {ink}" · "you pay 1 {ink} less for the next character you play this turn"
import { Effect } from './Effect.js';
import { Amount } from '../phrases/amount.js';
import { Query } from '../query.js';
import { Duration } from '../phrases/duration.js';

export class PayInk extends Effect {
  static fn = 'payInk';
  static rules = [[/^pay (\d+) \{ink\}$/i, (m) => ({ fn: 'payInk', n: +m[1] })]];
  static run(rt, s, job, st) {
    const n = Amount.value(rt, s, job, st.n);
    if (rt.E.readyInk(s, job.seat) < n) { rt.log(s, `↳ ${job.label}: not enough ink to pay ${n}.`, { kind: 'effect' }); return false; }
    rt.E.payInk(s, job.seat, n);
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} paid ${n} ink.`, { seat: job.seat, kind: 'effect' });
    return true;
  }
  static verb(rt, s, job, st) { return `pay ${st.n} ink`; }
  static say(st) { return `pay ${Amount.say(st.n)} {ink}`; }
}
export class CostMod extends Effect {
  static fn = 'costMod';
  static rules = [[/^you pay (\d+) \{ink\} less (?:for the next (.+?) you play|to play (.+?))$/i, (m, P) => ({ fn: 'costMod', n: +m[1], filter: P.filter(m[2] || m[3]), next: !!m[2] || undefined, ...(P.dur ? { dur: P.dur } : {}) })]];
  static run(rt, s, job, st) {
    rt.E.P(s, job.seat).costMods.push({ n: st.n, filter: st.filter, next: !!st.next, turn: s.turn, src: job.label });
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} pays ${st.n} ink less for the next ${Query.describe(st.filter)} this turn.`, { seat: job.seat, kind: 'effect' });
    return true;
  }
  static say(st) { return `pay ${st.n} {ink} less for ${st.next ? 'the next' : 'each'} ${Query.describe(st.filter)}${st.dur ? ` ${Duration.say(st.dur)}` : ''}`; }
}
// static-only: "you pay 2 {ink} less to play this character [for each X]"
export class SelfCost extends Effect {
  static fn = 'selfCost';
  static staticOnly = true;
  static say(st) { return `you pay ${st.n} {ink} less to play this${st.per ? ` for each ${Amount.sayPer(st.per)}` : ''}`; }
}
// static-only: "this character enters play exerted / with 2 damage"
export class Enters extends Effect {
  static fn = 'enters';
  static staticOnly = true;
  static say(st) { return `enters play ${st.exerted ? 'exerted' : `with ${st.damage} damage`}`; }
}
