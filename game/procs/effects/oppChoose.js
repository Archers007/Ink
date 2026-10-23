// "each opponent chooses and banishes / exerts / returns / deals N damage to one of their X"
import { Effect } from './Effect.js';
import { Query } from '../query.js';

const ACT = { banish: 'banishes it', exert: 'exerts it', toHand: 'returns it to hand', damage: null };
export class OppChoose extends Effect {
  static fn = 'oppChoose';
  static harmful = true;
  static rules = [
    [/^each opponent chooses and banishes one of their (.+)$/i, (m, P) => ({ fn: 'oppChoose', act: 'banish', filter: P.filter(m[1]) })],
    [/^each opponent chooses and exerts one of their (.+)$/i, (m, P) => ({ fn: 'oppChoose', act: 'exert', filter: P.filter(m[1]) })],
    [/^each opponent chooses one of their (.+?) and returns (?:that card|it) to their hand$/i, (m, P) => ({ fn: 'oppChoose', act: 'toHand', filter: P.filter(m[1]) })],
    [/^each opponent chooses and returns one of their (.+?) to their hand$/i, (m, P) => ({ fn: 'oppChoose', act: 'toHand', filter: P.filter(m[1]) })],
    [/^each opponent chooses and deals (\d+) damage to one of their (.+)$/i, (m, P) => ({ fn: 'oppChoose', act: 'damage', n: +m[1], filter: P.filter(m[2]) })],
    [/^each opponent chooses one of their (.+?) and deals (\d+) damage to (?:them|it)$/i, (m, P) => ({ fn: 'oppChoose', act: 'damage', n: +m[2], filter: P.filter(m[1]) })],
  ];
  static run(rt, s, job, st, ev) {
    const E = rt.E;
    const T = (job.tmp.opp ||= { queue: E.opponentsOf(s, job.seat), any: false });
    if (job.answer?.key === 'opp') {
      const a = job.answer; job.answer = null;
      const iid = a.target; const c = s.cards[iid]; const lbl = E.cardLabel(E.D(s, c)); const who = E.nameOf(s, c.owner);
      if (st.act === 'banish') E.banish(s, iid, ev, job.label);
      else if (st.act === 'exert') { rt.E.exertCard(s, c); ev.push({ k: 'exert', iid }); rt.log(s, `↳ ${who} exerted ${lbl}.`, { kind: 'effect' }); }
      else if (st.act === 'toHand') { rt.log(s, `↳ ${who} returned ${lbl} to their hand.`, { kind: 'effect' }); E.moveTo(s, iid, 'hand', ev, { reveal: true }); }
      else if (st.act === 'damage') { const n = Math.max(0, st.n - E.kwVal(c, E.D(s, c), 'resist')); rt.log(s, `↳ ${who} dealt ${n} damage to their ${lbl}.`, { kind: 'effect' }); E.dealDamage(s, iid, n, ev, { by: job.src }); }
      T.any = true; T.queue.shift();
    }
    while (T.queue.length) {
      const o = T.queue[0];
      const F = { ...st.filter, owner: 'you' };
      const valid = E.P(s, o).play.filter((iid) => rt.matches(s, F, s.cards[iid], o, null) && (st.act !== 'exert' || !s.cards[iid].exerted));
      if (!valid.length) { rt.log(s, `↳ ${E.nameOf(s, o)} has nothing to choose.`, { kind: 'effect' }); T.queue.shift(); continue; }
      job.waitKey = 'opp';
      return rt.ask(s, job, { seat: o, valid, op: `opp${st.act[0].toUpperCase()}${st.act.slice(1)}Pick`, harmful: true, prompt: `choose one of your ${Query.describe(st.filter)} to ${st.act === 'toHand' ? 'return to your hand' : st.act === 'damage' ? `take ${st.n} damage` : st.act}.` });
    }
    return T.any;
  }
  static say(st) { return `each opponent chooses one of their ${Query.describe(st.filter)} and ${ACT[st.act] || `deals ${st.n} damage to it`}`; }
}
