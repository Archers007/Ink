import { Effect } from './Effect.js';
import { N, NUM, plural } from '../phrases/text.js';
import { Query } from '../query.js';

const WHO = { opp: 'each opponent discards', each: 'each player discards' };
export class Discard extends Effect {
  static fn = 'discard';
  static rules = [
    [new RegExp(String.raw`^(?:each|chosen) opponent (?:chooses and )?discards ${NUM} cards?( at random)?$`, 'i'), (m) => ({ fn: 'discard', who: 'opp', n: N(m[1]), random: !!m[2] || undefined })],
    [new RegExp(String.raw`^each player (?:chooses and )?discards ${NUM} cards?( at random)?$`, 'i'), (m) => ({ fn: 'discard', who: 'each', n: N(m[1]), random: !!m[2] || undefined })],
    [new RegExp(String.raw`^(?:choose and )?discard ${NUM} cards?( at random)?$`, 'i'), (m) => ({ fn: 'discard', who: 'you', n: N(m[1]), random: !!m[2] || undefined })],
    [/^(?:choose and )?discard (?:a|an) (.+?)$/i, (m, P) => ({ fn: 'discard', who: 'you', n: 1, filter: P.filter(m[1]) })],
    [/^(?:each|chosen) opponent (?:chooses and )?discards (?:a|an) (.+?)$/i, (m, P) => ({ fn: 'discard', who: 'opp', n: 1, filter: P.filter(m[1]) })],
    [/^discard (?:your hand|all (?:the )?cards in your hand)$/i, () => ({ fn: 'discard', who: 'you', all: true })],
    [/^each (?:player|opponent) discards their hand$/i, (m) => ({ fn: 'discard', who: /player/.test(m[0]) ? 'each' : 'opp', all: true })],
  ];
  static run(rt, s, job, st, ev) {
    const P = rt.E.P;
    const seats = () => (job.tmp.seats ||= rt.who(s, job, st.who).filter((seat) => !rt.discardBlocked(s, seat)));   // CR 6.5
    if (st.all) {
      for (const seat of seats()) {
        const n = P(s, seat).hand.length;
        for (const iid of [...P(s, seat).hand]) rt.E.moveTo(s, iid, 'discard', ev, { reveal: true });
        rt.log(s, `↳ ${rt.E.nameOf(s, seat)} discarded their hand (${plural(n, 'card')}).`, { seat, kind: 'effect' });
      }
      return true;
    }
    if (st.random) {
      for (const seat of seats()) {
        const p = P(s, seat); const gone = [];
        for (let k = 0; k < st.n && p.hand.length; k++) {
          const iid = p.hand[Math.floor(rt.E.rand(s) * p.hand.length)];
          gone.push(rt.E.cardLabel(rt.E.D(s, s.cards[iid]))); rt.E.moveTo(s, iid, 'discard', ev);
        }
        rt.log(s, `↳ ${rt.E.nameOf(s, seat)} discarded ${gone.join(', ') || 'nothing'} at random.`, { seat, kind: 'effect' });
      }
      return true;
    }
    // one pick per card per player; each player chooses their own
    const T = (job.tmp.discard ||= { queue: seats().flatMap((seat) => Array(st.n).fill(seat)), any: false });
    if (job.answer?.key === 'discard') {
      const a = job.answer; job.answer = null;
      const c = s.cards[a.target];
      rt.E.moveTo(s, c.iid, 'discard', ev); T.any = true;
      (T.got ||= []).push(c.iid);
      rt.fire(s, 'discarded', { iid: c.iid, seat: c.owner });
      job.ctx.it = T.got;                                            // "the discarded character" / "… discarded this way"
      rt.log(s, `↳ ${rt.E.nameOf(s, c.owner)} discarded ${rt.E.cardLabel(rt.E.D(s, c))}.`, { seat: c.owner, kind: 'effect' });
      T.queue.shift();
    }
    while (T.queue.length) {
      const seat = T.queue[0];
      const valid = P(s, seat).hand.filter((iid) => !st.filter || rt.matches(s, { ...st.filter, zone: 'hand' }, s.cards[iid], seat, job.src));
      if (!valid.length) { rt.log(s, `↳ ${rt.E.nameOf(s, seat)} has nothing to discard.`, { kind: 'effect' }); T.queue.shift(); continue; }
      job.waitKey = 'discard';
      return rt.ask(s, job, { seat, valid, op: seat === job.seat ? 'selfDiscard' : 'oppDiscardPick', harmful: false, prompt: 'choose a card to discard.' });
    }
    return T.any;
  }
  static verb(rt, s, job, st) { return st.all ? 'discard your hand' : `discard ${plural(st.n, 'card')}`; }
  static say(st) { return `${WHO[st.who] || 'discard'} ${st.all ? 'their hand' : `${st.n}${st.random ? ' at random' : ''}${st.filter ? ` ${Query.describe(st.filter)}` : ''}`}`; }
}
