// "you have a Hero character or a Villain character in play" — either condition
import { Condition } from './Condition.js';
import { filter } from '../phrases/filter.js';

export class AnyOf extends Condition {
  static key = 'any';
  static rules = [[/^you have (?:a|an) (.+?) or (?:a|an) (.+?) in play$/i, (m, a) => ({ any: [{ have: filter(m[1], a), n: 1 }, { have: filter(m[2], a), n: 1 }] })]];
  static test(rt, s, C, env) { return C.any.some((x) => rt.test(s, x, env.ctl, env.src, env.job)); }
  static say(C, sayOne) { return C.any.map(sayOne).join(' or '); }
}

// "this character is exerted and you have no cards in your hand" — both
export class AllOf extends Condition {
  static key = 'all';
  static rules = [[/^(.+?) and ((?:you|this character|he|she|it|they|an opponent|none|there) .+)$/i, (m, a, parse) => {
    try { return { all: [parse(m[1], a), parse(m[2], a)] }; } catch { return undefined; }
  }]];
  static test(rt, s, C, env) { return C.all.every((x) => rt.test(s, x, env.ctl, env.src, env.job)); }
  static say(C, sayOne) { return C.all.map(sayOne).join(' and '); }
}
