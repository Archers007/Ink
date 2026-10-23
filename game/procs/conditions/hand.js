// "you have 3 or more cards in your hand" · "no cards in your hand" · "more cards in your hand than each opponent"
import { Condition } from './Condition.js';
import { N, NUM } from '../phrases/text.js';
import { inRange, sayRange } from '../classifiers/Classifier.js';

export class HandSize extends Condition {
  static key = 'hand';
  static rules = [
    [new RegExp(String.raw`^you have ${NUM} or more cards in your hand$`, 'i'), (m) => ({ hand: { gte: N(m[1]) } })],
    [new RegExp(String.raw`^you have ${NUM} or fewer cards in your hand$`, 'i'), (m) => ({ hand: { lte: N(m[1]) } })],
    [/^you have no cards in your hand$/i, () => ({ hand: { lte: 0 } })],
    [/^(?:an|each|chosen) opponent has no cards in (?:their|his|her) hand$/i, (m) => ({ hand: { lte: 0 }, who: /^each/i.test(m[0]) ? 'eachOpp' : 'opp' })],
  ];
  static test(rt, s, C, env) {
    if (!C.who) return inRange(rt.E.P(s, env.ctl).hand.length, C.hand);
    const r = rt.E.opponentsOf(s, env.ctl).map((o) => inRange(rt.E.P(s, o).hand.length, C.hand));
    return C.who === 'eachOpp' ? r.every(Boolean) : r.some(Boolean);
  }
  static say(C) { return `your hand has ${sayRange(C.hand)} cards`; }
}
export class MoreCards extends Condition {
  static key = 'moreCardsThanOpp';
  static rules = [[/^you have more cards in your hand than each opponent$/i, () => ({ moreCardsThanOpp: true })]];
  static test(rt, s, C, env) { const P = rt.E.P; return rt.E.opponentsOf(s, env.ctl).every((o) => P(s, env.ctl).hand.length > P(s, o).hand.length); }
  static say() { return 'you have more cards in hand than each opponent'; }
}
// "chosen opponent has more cards in their hand than you" (2-player: any opponent with more)
export class OppMoreCards extends Condition {
  static key = 'oppMoreCards';
  static rules = [[/^(?:chosen|an) opponent has more cards in their hand than you$/i, () => ({ oppMoreCards: true })]];
  static test(rt, s, C, env) { const P = rt.E.P; return rt.E.opponentsOf(s, env.ctl).some((o) => P(s, o).hand.length > P(s, env.ctl).hand.length); }
  static say() { return 'an opponent has more cards in hand than you'; }
}
