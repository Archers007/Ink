// "an opponent has more lore than you" · "you have more lore than each opponent" · "you have 10 or more lore"
import { Condition } from './Condition.js';
import { inRange, sayRange } from '../classifiers/Classifier.js';

export class OppMoreLore extends Condition {
  static key = 'oppMoreLore';
  static rules = [[/^(?:an|each|chosen) opponent has more lore than you$/i, () => ({ oppMoreLore: true })]];
  static test(rt, s, C, env) { const P = rt.E.P; return rt.E.opponentsOf(s, env.ctl).some((o) => P(s, o).lore > P(s, env.ctl).lore); }
  static say() { return 'an opponent has more lore than you'; }
}
export class YouMoreLore extends Condition {
  static key = 'youMoreLore';
  static rules = [[/^you have more lore than (?:each|an|chosen) opponent$/i, () => ({ youMoreLore: true })]];
  static test(rt, s, C, env) { const P = rt.E.P; return rt.E.opponentsOf(s, env.ctl).every((o) => P(s, env.ctl).lore > P(s, o).lore); }
  static say() { return 'you have more lore than each opponent'; }
}
export class LoreAmount extends Condition {
  static key = 'lore';
  static rules = [[/^you have (\d+) or more lore$/i, (m) => ({ lore: { gte: +m[1] } })]];
  static test(rt, s, C, env) { return inRange(rt.E.P(s, env.ctl).lore, C.lore); }
  static say(C) { return `you have ${sayRange(C.lore)} lore`; }
}
