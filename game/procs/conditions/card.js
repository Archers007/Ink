// "you used Shift to play him" · "it's a Villain character" / "a Princess was chosen" (about the card just acted on)
import { Condition } from './Condition.js';
import { filter, tryFilter } from '../phrases/filter.js';
import { Query } from '../query.js';
import { predicate } from './exists.js';
import { counted, countOk } from '../phrases/acts.js';

// the card(s) the last step acted on: "it", "that character", "the banished item", "the chosen character", …
const REF = String.raw`(?:it|that card|that character|that item|that location|that song|the chosen (?:character|card|item)|the banished (?:character|item|card|location|[A-Z][\w'-]*)|the moved character|the challenging character|the revealed card|the discarded card|they|he|she)`;
const PAST_THIS_WAY = String.raw`discarded|returned|banished|revealed|put|moved|exerted|readied|chose|played`;

export class Shifted extends Condition {
  static key = 'shifted';
  static rules = [[/^you used shift to play (?:him|her|it|them|this character)$/i, () => ({ shifted: true })]];
  static test(rt, s, C, env) { return !!s.cards[env.src]?.shifted; }
  static say() { return 'you used Shift to play it'; }
}
// "if you removed an ink drop to play her / this action" — ink drops paid part of this card's cost (engine: c.paidDrops)
export class PaidWithDrop extends Condition {
  static key = 'paidDrop';
  static rules = [[/^you removed (?:an|one or more|\d+) ink drops? to play (?:him|her|it|them|this character|this action|this card|this item|this song)$/i, () => ({ paidDrop: true })]];
  static test(rt, s, C, env) { return (s.cards[env.src]?.paidDrops || 0) > 0; }
  static say() { return 'an ink drop paid for this card'; }
}
// "if a character sang this song" · "if 2 or more characters sang this song" (engine: c.sungBy)
export class Sang extends Condition {
  static key = 'sang';
  static rules = [[/^(?:a character|(\d+) or more characters) sang this song$/i, (m) => ({ sang: { gte: m[1] ? +m[1] : 1 } })]];
  static test(rt, s, C, env) { return (s.cards[env.src]?.sungBy || 0) >= C.sang.gte; }
  static say(C) { return `${C.sang.gte > 1 ? `${C.sang.gte}+ characters` : 'a character'} sang this song`; }
}
// "if you removed damage this way" — the heal before it removed some
export class HealedThisWay extends Condition {
  static key = 'healedWay';
  static rules = [[/^you removed (?:any )?damage this way$/i, () => ({ healedWay: true })]];
  static test(rt, s, C, env) { return (env.job?.ctx.healed || 0) > 0; }
  static say() { return 'damage was removed this way'; }
}
export class RefIs extends Condition {
  static key = 'refIs';
  static rules = [
    [/^(?:a|an) (.+?) (?:was|is) chosen$/i, (m, a) => ({ refIs: filter(m[1], a) })],
    [/^(?:it is|it's|that card is|that character is|the chosen character is|they're|he's|she's|they are|he is|she is|the moved character is) (?:a|an) (.+?)$/i, (m, a) => ({ refIs: filter(m[1], a) })],
    // "its card type is: • character" (a chooseOne-style list collapsed to one type)
    [/^its card type is:? •? ?(character|item|location|action|song)$/i, (m) => ({ refIs: { types: [m[1].toLowerCase()] } })],
    // "you discarded a Pirate character card this way" · "an Illusion character card is discarded this way"
    [new RegExp(String.raw`^you (?:${PAST_THIS_WAY}) (.+?)(?: this way)?$`, 'i'), (m, a) => RefIs.counted(m[1], a)],
    [new RegExp(String.raw`^(.+?) (?:is|was|were|are) (?:${PAST_THIS_WAY}) this way$`, 'i'), (m, a) => RefIs.counted(m[1], a)],
    // "that character had a card under them" · "the banished item is named Maurice's Machine" · "it has 3 {strength} or more"
    [new RegExp(String.raw`^${REF} ((?:is|are|was|were|has|have|had) .+)$`, 'i'), (m, a) => {
      const named = m[1].match(/^(?:is|was) named (.+)$/i);
      if (named) return { refIs: { with: [{ named: [named[1].trim()] }] } };
      const w = predicate(m[1].replace(/^had /i, 'has ').replace(/^(?:was|were) /i, 'is '));
      if (w) return { refIs: { with: [w] } };
      const F = m[1].match(/^(?:is|are|was|were) (?:a|an) (.+)$/i) && tryFilter(m[1].replace(/^\w+ (?:a|an) /i, ''));
      return F ? { refIs: F } : undefined;
    }],
    [/^there(?:'s| is) a card under (?:that character|that location|it|them|him|her)$/i, () => ({ refIs: { with: [{ under: true }] } })],
    [/^(?:the chosen character|that character|the moved character|the challenging character|that item) is named (.+)$/i, (m) => ({ refIs: { with: [{ named: [m[1].trim()] }] } })],
    [/^(?:that character|the chosen character|they) (?:has|have) damage$/i, () => ({ refIs: { with: [{ damaged: true }] } })],
    [/^(?:that item|that card|it) costs (\d+) or less$/i, (m) => ({ refIs: { with: [{ cost: { lte: +m[1] } }] } })],
    [/^(?:the challenging character|that character) has (\d+) \{strength\} or more$/i, (m) => ({ refIs: { with: [{ str: { gte: +m[1] } }] } })],
  ];
  static counted(np, at) {
    let c;
    try { c = counted(np.replace(/ cards?$/i, (x) => x), at); } catch { return undefined; }
    if (c.self) return undefined;
    return { refIs: c.F, n: c.n };
  }
  static test(rt, s, C, env) {
    const it = (env.job?.ctx.it || []).filter((id) => s.cards[id]);
    if (C.n) return countOk(C.n, it.filter((id) => rt.matches(s, C.refIs, s.cards[id], env.ctl, env.src, { anyZone: true })).length);
    const id = it[0];
    return !!id && rt.matches(s, C.refIs, s.cards[id], env.ctl, env.src, { anyZone: true });
  }
  static say(C) { return `that card is a ${Query.describe(C.refIs)}`; }
}
