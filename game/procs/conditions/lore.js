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
  // "you have 10 or more lore" · "an opponent has 10 or more lore" · "an opponent has 0 lore" · "… 3 or less lore"
  static rules = [[/^(you|an opponent|chosen opponent|each opponent) (?:has|have) (\d+)( or more| or less| or fewer)? lore$/i, (m) => ({
    lore: m[3] ? (/more/i.test(m[3]) ? { gte: +m[2] } : { lte: +m[2] }) : { gte: +m[2], lte: +m[2] },
    ...(/^you$/i.test(m[1]) ? {} : { who: /^each/i.test(m[1]) ? 'eachOpp' : 'opp' }),
  })]];
  static test(rt, s, C, env) {
    if (!C.who) return inRange(rt.E.P(s, env.ctl).lore, C.lore);
    const opp = rt.E.opponentsOf(s, env.ctl).map((o) => inRange(rt.E.P(s, o).lore, C.lore));
    return C.who === 'eachOpp' ? opp.every(Boolean) : opp.some(Boolean);
  }
  static say(C) { return `${C.who ? 'an opponent has' : 'you have'} ${sayRange(C.lore)} lore`; }
}
