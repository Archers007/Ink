// Player-state questions: inkwell size, hand size vs opponents, first turn, items vs opponents
import { Condition } from './Condition.js';
import { N, NUM } from '../phrases/text.js';
import { filter } from '../phrases/filter.js';
import { Query } from '../query.js';

const cmp = (a, b, op) => (op === 'more' ? a > b : a < b);
export class Inkwell extends Condition {
  static key = 'inkwell';
  static rules = [
    [new RegExp(String.raw`^you have ${NUM} or more cards in your inkwell$`, 'i'), (m) => ({ inkwell: { gte: N(m[1]) } })],
    [/^all cards in your inkwell are exerted$/i, () => ({ inkwell: { readyLte: 0 } })],
  ];
  static test(rt, s, C, env) {
    const p = rt.E.P(s, env.ctl);
    if (C.inkwell.readyLte != null) return p.inkwell.filter((iid) => !s.cards[iid].exerted).length <= C.inkwell.readyLte;
    return p.inkwell.length >= C.inkwell.gte;
  }
  static say(C) { return C.inkwell.readyLte != null ? (C.inkwell.readyLte === 0 ? 'all your ink is exerted' : `you have ${C.inkwell.readyLte} or fewer ready ink`) : `you have ${C.inkwell.gte}+ cards in your inkwell`; }
}
// "an opponent has more cards in their hand than you" · "you have more cards in your inkwell than each opposing player"
export class Compare extends Condition {
  static key = 'compare';
  static rules = [
    [/^(?:an|chosen|each) opponent has (more|fewer) cards in their (hand|inkwell) than you$/i, (m) => ({ compare: { zone: m[2], op: m[1] === 'more' ? 'more' : 'less', oppVsYou: true } })],
    [/^you have (more|fewer) cards in your (hand|inkwell) than each (?:opponent|opposing player)$/i, (m) => ({ compare: { zone: m[2], op: m[1] === 'more' ? 'more' : 'less' } })],
    [/^you have (more|fewer) (.+?) in play than each opponent$/i, (m, a) => ({ compare: { query: filter(m[2], a), op: m[1] === 'more' ? 'more' : 'less' } })],
  ];
  static test(rt, s, C, env) {
    const c = C.compare;
    const size = (seat) => (c.query ? rt.candidates(s, { ...c.query, owner: seat === env.ctl ? 'you' : 'opp' }, env.ctl, env.src).filter((iid) => s.cards[iid].owner === seat).length : rt.E.P(s, seat)[c.zone].length);
    const me = size(env.ctl);
    const opps = rt.E.opponentsOf(s, env.ctl).map(size);
    return c.oppVsYou ? opps.some((o) => cmp(o, me, c.op)) : opps.every((o) => cmp(me, o, c.op));
  }
  static say(C) { const c = C.compare; return c.oppVsYou ? `an opponent has ${c.op === 'more' ? 'more' : 'fewer'} cards in ${c.zone} than you` : `you have ${c.op === 'more' ? 'more' : 'fewer'} ${c.query ? Query.describe(c.query) : `cards in ${c.zone}`} than each opponent`; }
}
export class FewerInHand extends Condition {
  static key = 'handLt';
  static rules = [[new RegExp(String.raw`^you have fewer than ${NUM} cards in your hand$`, 'i'), (m) => ({ handLt: N(m[1]) })]];
  static test(rt, s, C, env) { return rt.E.P(s, env.ctl).hand.length < C.handLt; }
  static say(C) { return `you have fewer than ${C.handLt} cards in hand`; }
}
export class FirstTurnSecond extends Condition {
  static key = 'firstTurnSecond';
  static rules = [[/^this is your first turn and you're not the first player$/i, () => ({ firstTurnSecond: true })]];
  static test(rt, s, C, env) { return s.starting !== env.ctl && (rt.E.P(s, env.ctl).turnsTaken || 0) === 1 && s.active === env.ctl; }
  static say() { return "it's your first turn and you went second"; }
}
export class HasInkDrop extends Condition {
  static key = 'inkDrop';
  static rules = [[/^you have an ink drop$/i, () => ({ inkDrop: true })]];
  static test(rt, s, C, env) { return (rt.E.P(s, env.ctl).inkDrops || 0) > 0; }
  static say() { return 'you have an ink drop'; }
}
