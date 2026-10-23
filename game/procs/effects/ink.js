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
    const n = Amount.value(rt, s, job, st.n);
    if (!n) return false;
    rt.E.P(s, job.seat).costMods.push({ n, filter: st.filter, next: !!st.next, turn: s.turn, src: job.label });
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} pays ${n} ink less for the next ${Query.describe(st.filter)} this turn.`, { seat: job.seat, kind: 'effect' });
    return true;
  }
  static say(st) { return `pay ${Amount.say(st.n)} {ink} less for ${st.next ? 'the next' : 'each'} ${Query.describe(st.filter)}${st.dur ? ` ${Duration.say(st.dur)}` : ''}`; }
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
  static say(st) { return `${st.filter ? `${Query.describe(st.filter)} enter` : 'enters'} play ${st.exerted ? 'exerted' : `with ${st.damage} damage`}`; }
}

// "get 1 ink drop" — an ink drop counter (CR 1.13.1.2): spend it to pay 1 {ink} toward any cost
export class InkDrop extends Effect {
  static fn = 'inkDrop';
  static rules = [
    [/^(?:you )?gets? (\d+|an?|one) ink drops?$/i, (m) => ({ fn: 'inkDrop', n: /^\d+$/.test(m[1]) ? +m[1] : 1 })],
    [/^you and another chosen player each get (\d+|an?) ink drops?$/i, (m) => ({ fn: 'inkDrop', n: /^\d+$/.test(m[1]) ? +m[1] : 1, who: 'youAndOne' })],
    [/^each player gets (\d+|an?) ink drops?$/i, (m) => ({ fn: 'inkDrop', n: /^\d+$/.test(m[1]) ? +m[1] : 1, who: 'each' })],
  ];
  static run(rt, s, job, st) {
    // 2-player: "you and another chosen player" = you and your opponent
    const seats = st.who === 'youAndOne' ? [job.seat, ...rt.E.opponentsOf(s, job.seat).slice(0, 1)] : rt.who(s, job, st.who);
    for (const seat of seats) {
      const p = rt.E.P(s, seat);
      p.inkDrops = (p.inkDrops || 0) + Amount.value(rt, s, job, st.n);
      rt.fire(s, 'gotInkDrop', { seat });                             // "if you got an ink drop this turn"
      rt.log(s, `↳ ${rt.E.nameOf(s, seat)} got ${st.n} ink drop${st.n === 1 ? '' : 's'} (${p.inkDrops} 💧).`, { seat, kind: 'effect' });
    }
    return true;
  }
  static verb(rt, s, job, st) { return `get ${st.n} ink drop${st.n === 1 ? '' : 's'}`; }
  static say(st) { return `${st.who === 'youAndOne' ? 'you and another chosen player each get' : st.who === 'each' ? 'each player gets' : 'get'} ${st.n} ink drop${st.n === 1 ? '' : 's'}`; }
}
// "you may ink an additional card this turn" — one more card into the inkwell this turn
export class ExtraInk extends Effect {
  static fn = 'extraInk';
  static rules = [[/^(?:you may )?(?:ink|put) an additional card(?: into your inkwell)?(?: this turn)?$/i, () => ({ fn: 'extraInk' })]];
  static run(rt, s, job) {
    rt.E.P(s, job.seat).extraInk = (rt.E.P(s, job.seat).extraInk || 0) + 1;
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} may put an additional card into their inkwell this turn.`, { seat: job.seat, kind: 'effect' });
    return true;
  }
  static say() { return 'you may ink an additional card this turn'; }
}
