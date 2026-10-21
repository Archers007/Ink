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
    [/^(?:it is|it's|that card is|that character is|the chosen character is|they're|he's|she's|the moved character is) (?:a|an) (.+?)$/i, (m, a) => ({ refIs: filter(m[1], a) })],
    [/^(?:the chosen character|that character|the moved character|the challenging character|that item) is named (.+)$/i, (m) => ({ refIs: { with: [{ named: [m[1].trim()] }] } })],
    [/^(?:that character|the chosen character|they) (?:has|have) damage$/i, () => ({ refIs: { with: [{ damaged: true }] } })],
    [/^(?:that item|that card|it) costs (\d+) or less$/i, (m) => ({ refIs: { with: [{ cost: { lte: +m[1] } }] } })],
    [/^(?:the challenging character|that character) has (\d+) \{strength\} or more$/i, (m) => ({ refIs: { with: [{ str: { gte: +m[1] } }] } })],
  ];
  static test(rt, s, C, env) {
    const id = (env.job?.ctx.it || [])[0];
    return !!id && rt.matches(s, C.refIs, s.cards[id], env.ctl, env.src, { anyZone: true });
  }
  static say(C) { return `that card is a ${Query.describe(C.refIs)}`; }
}
