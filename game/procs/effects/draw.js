import { Effect } from './Effect.js';
import { N, NUM, plural } from '../phrases/text.js';
import { Amount } from '../phrases/amount.js';

const WHO = { each: 'each player draws', opp: 'each opponent draws', refOwner: "that card's player draws" };
export class Draw extends Effect {
  static fn = 'draw';
  static rules = [
    [new RegExp(String.raw`^draw ${NUM} cards?$`, 'i'), (m) => ({ fn: 'draw', n: N(m[1]) })],
    [new RegExp(String.raw`^each player draws ${NUM} cards?$`, 'i'), (m) => ({ fn: 'draw', n: N(m[1]), who: 'each' })],
    [new RegExp(String.raw`^(?:each|chosen) opponent draws ${NUM} cards?$`, 'i'), (m) => ({ fn: 'draw', n: N(m[1]), who: 'opp' })],
    [new RegExp(String.raw`^(?:that player|its player|their player|they) draws? ${NUM} cards?$`, 'i'), (m) => ({ fn: 'draw', n: N(m[1]), who: 'refOwner' })],
    [/^draw cards equal to (?:the damage removed|the amount of damage removed)$/i, () => ({ fn: 'draw', n: { healed: true } })],
    [/^draw a card for each (.+)$/i, (m, P) => ({ fn: 'draw', n: { n: 1, per: Amount.forEach(m[1], P.at) } })],
    [new RegExp(String.raw`^(?:you )?draw cards until you have ${NUM} cards? in your hand$`, 'i'), (m) => ({ fn: 'draw', upTo: N(m[1]) })],
  ];
  static run(rt, s, job, st, ev) {
    for (const seat of rt.who(s, job, st.who)) {
      if (seat == null) continue;
      const n = st.upTo != null ? Math.max(0, st.upTo - rt.E.P(s, seat).hand.length) : Amount.value(rt, s, job, st.n);
      const { names } = rt.E.drawCards(s, seat, n, ev);
      rt.log(s, `↳ ${rt.E.nameOf(s, seat)} drew ${plural(names.length, 'card')}.`, { seat, kind: 'effect', priv: names.length ? { seat, text: `↳ You drew ${names.join(', ')}.` } : undefined });
    }
    return true;
  }
  static verb(rt, s, job, st) { return st.upTo != null ? `draw up to ${st.upTo} cards in hand` : `draw ${plural(Amount.value(rt, s, job, st.n), 'card')}`; }
  static say(st) { return st.upTo != null ? `draw until you have ${st.upTo} cards in hand` : `${WHO[st.who] || 'draw'} ${Amount.say(st.n)}`; }
}
