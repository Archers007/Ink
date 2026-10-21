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
  ];
  static test(rt, s, C, env) { return inRange(rt.E.P(s, env.ctl).hand.length, C.hand); }
  static say(C) { return `your hand has ${sayRange(C.hand)} cards`; }
}
export class MoreCards extends Condition {
  static key = 'moreCardsThanOpp';
  static rules = [[/^you have more cards in your hand than each opponent$/i, () => ({ moreCardsThanOpp: true })]];
  static test(rt, s, C, env) { const P = rt.E.P; return rt.E.opponentsOf(s, env.ctl).every((o) => P(s, env.ctl).hand.length > P(s, o).hand.length); }
  static say() { return 'you have more cards in hand than each opponent'; }
}
