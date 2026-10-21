// "you used Shift to play him" · "it's a Villain character" / "a Princess was chosen" (about the card just acted on)
import { Condition } from './Condition.js';
import { filter } from '../phrases/filter.js';
import { Query } from '../query.js';

export class Shifted extends Condition {
  static key = 'shifted';
  static rules = [[/^you used shift to play (?:him|her|it|them|this character)$/i, () => ({ shifted: true })]];
  static test(rt, s, C, env) { return !!s.cards[env.src]?.shifted; }
  static say() { return 'you used Shift to play it'; }
}
export class RefIs extends Condition {
  static key = 'refIs';
  static rules = [
    [/^(?:a|an) (.+?) (?:was|is) chosen$/i, (m, a) => ({ refIs: filter(m[1], a) })],
    [/^(?:it is|that card is|that character is|the chosen character is) (?:a|an) (.+?)$/i, (m, a) => ({ refIs: filter(m[1], a) })],
  ];
  static test(rt, s, C, env) {
    const id = (env.job?.ctx.it || [])[0];
    return !!id && rt.matches(s, C.refIs, s.cards[id], env.ctl, env.src, { anyZone: true });
  }
  static say(C) { return `that card is a ${Query.describe(C.refIs)}`; }
}
