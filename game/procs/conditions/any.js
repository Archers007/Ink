// "you have a Hero character or a Villain character in play" — either condition
import { Condition } from './Condition.js';
import { filter } from '../phrases/filter.js';

export class AnyOf extends Condition {
  static key = 'any';
  static rules = [[/^you have (?:a|an) (.+?) or (?:a|an) (.+?) in play$/i, (m, a) => ({ any: [{ have: filter(m[1], a), n: 1 }, { have: filter(m[2], a), n: 1 }] })]];
  static test(rt, s, C, env) { return C.any.some((x) => rt.test(s, x, env.ctl, env.src, env.job)); }
  static say(C, sayOne) { return C.any.map(sayOne).join(' or '); }
}
