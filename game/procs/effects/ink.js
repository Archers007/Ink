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
  static rules = [
    [/^(?:you )?pay (\d+) \{ink\} less (?:for the next (.+?) you play|to play (.+?))$/i, (m, P) => ({ fn: 'costMod', n: +m[1], filter: P.filter(m[2] || m[3]), next: !!m[2] || undefined, ...(P.dur ? { dur: P.dur } : {}) })],
    [/^(?:you )?pay that amount of \{ink\} less for the next (.+?) you play$/i, (m, P) => ({ fn: 'costMod', n: { last: true }, filter: P.filter(m[1]), next: true, ...(P.dur ? { dur: P.dur } : {}) })],
    [/^(?:you )?pay (\d+) \{ink\} less for the next (.+?) you shift$/i, (m, P) => ({ fn: 'costMod', n: +m[1], filter: P.filter(m[2]), next: true, shift: true, ...(P.dur ? { dur: P.dur } : {}) })],
  ];
  static run(rt, s, job, st) {
    const n = Amount.value(rt, s, job, st.n);
    if (!n) return false;
    rt.E.P(s, job.seat).costMods.push({ n, filter: st.filter, next: !!st.next, ...(st.shift ? { shift: true } : {}), turn: s.turn, src: job.label });
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} pays ${n} ink less for the next ${Query.describe(st.filter)} this turn.`, { seat: job.seat, kind: 'effect' });
    return true;
  }
  static say(st) {
    if (st.who === 'each') return `each player pays ${-st.n} {ink} more to play ${Query.describe(st.filter)}`;
    return `pay ${st.free ? 'nothing' : `${Amount.say(st.n)} {ink} less`} ${st.shift ? 'to shift' : 'for'} ${st.first ? 'the first' : st.next ? 'the next' : 'each'} ${Query.describe(st.filter)}${st.onto ? ' onto this character' : ''}${st.per ? ` (for each ${Amount.sayPer(st.per)})` : ''}${st.dur ? ` ${Duration.say(st.dur)}` : ''}`;
  }
}
// static-only: "you pay 2 {ink} less to play this character [for each X]"
export class SelfCost extends Effect {
  static fn = 'selfCost';
  static staticOnly = true;
  static say(st) { return `${st.free ? 'you may play this for free' : `you pay ${Amount.say(st.n)} {ink} less to play this${st.per ? ` for each ${Amount.sayPer(st.per)}` : ''}`}${st.shift ? ' (when shifting it)' : ''}`; }
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
  static run(rt, s, job, st, ev) {
    // 2-player: "you and another chosen player" = you and your opponent
    const seats = st.who === 'youAndOne' ? [job.seat, ...rt.E.opponentsOf(s, job.seat).slice(0, 1)] : rt.who(s, job, st.who);
    const T = (job.tmp.drop ||= { i: 0, k: 0, got: 0 });
    for (; T.i < seats.length; T.i++, T.k = 0, T.got = 0, T.n = undefined) {
      const seat = seats[T.i];
      const p = rt.E.P(s, seat);
      T.n ??= Amount.value(rt, s, job, st.n);
      // each drop is its own "would get an ink drop", so a replacement applies once per drop:
      // "If you would get an ink drop, you may put the top card of your deck into your inkwell facedown and exerted instead" (CR 6.5)
      for (; T.k < T.n; T.k++) {
        let ask = false;
        const e = rt.replace(s, { event: 'inkDrop', seat }, (r) => {
          if (r.st.do !== 'deckToInk' || !p.deck.length) return undefined;
          if (r.st.may) {
            if (job.answer?.key !== 'inkDropInstead') { ask = true; return undefined; }
            const no = job.answer.skip; job.answer = null;
            if (no) return undefined;
          }
          rt.log(s, `↳ ${rt.E.nameOf(s, seat)} put the top card of their deck into their inkwell instead of getting an ink drop.`, { seat, kind: 'effect' });
          rt.E.moveTo(s, p.deck[0], 'inkwell', ev, { exerted: true });
          return null;
        });
        if (ask) {
          job.waitKey = 'inkDropInstead';
          const of = T.n > 1 ? ` (ink drop ${T.k + 1} of ${T.n})` : '';
          return rt.ask(s, job, { seat, confirm: true, optional: true, op: 'inkDropInstead', prompt: `put the top card of your deck into your inkwell, exerted, instead of getting an ink drop?${of}` });
        }
        if (e) T.got++;
      }
      if (!T.got) continue;
      p.inkDrops = (p.inkDrops || 0) + T.got;
      rt.fire(s, 'gotInkDrop', { seat });                             // "if you got an ink drop this turn"
      rt.log(s, `↳ ${rt.E.nameOf(s, seat)} got ${T.got} ink drop${T.got === 1 ? '' : 's'} (${p.inkDrops} 💧).`, { seat, kind: 'effect' });
    }
    return true;
  }
  static verb(rt, s, job, st) { return `get ${st.n} ink drop${st.n === 1 ? '' : 's'}`; }
  static say(st) { return `${st.who === 'youAndOne' ? 'you and another chosen player each get' : st.who === 'each' ? 'each player gets' : 'get'} ${Amount.say(st.n)} ink drop${st.n === 1 ? '' : 's'}`; }
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

// "Each player exerts all the cards in their inkwell" · "returns cards at random from their inkwell to their hand until they
// have 3 cards in their inkwell" (Ink Geyser)
export class InkwellFx extends Effect {
  static fn = 'inkwell';
  static rules = [
    [/^exert all the cards in your inkwell$/i, () => ({ fn: 'inkwell', exert: true })],   // ("all cards in your inkwell" is a plain exert)
    [/^return cards at random from your inkwell to your hand until you have (\d+) cards? in your inkwell$/i, (m) => ({ fn: 'inkwell', keep: +m[1] })],
  ];
  static run(rt, s, job, st, ev) {
    const p = rt.E.P(s, job.seat);
    if (st.exert) {
      for (const iid of p.inkwell) s.cards[iid].exerted = true;
      rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} exerted all the cards in their inkwell.`, { seat: job.seat, kind: 'effect' });
      return true;
    }
    let n = 0;
    while (p.inkwell.length > st.keep) {
      const iid = p.inkwell[Math.floor(rt.E.rand(s) * p.inkwell.length)];
      rt.E.moveTo(s, iid, 'hand', ev); n++;
    }
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} returned ${n} card${n === 1 ? '' : 's'} at random from their inkwell to their hand.`, { seat: job.seat, kind: 'effect' });
    return n > 0;
  }
  static say(st) { return st.exert ? 'exert all the cards in your inkwell' : `return cards at random from your inkwell until you have ${st.keep}`; }
}
