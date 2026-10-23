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
// "if any of the cards that were under them are character cards" — this card's last stack, now in the discard
export class WasUnder extends Condition {
  static key = 'wasUnder';
  static rules = [];                                                   // read by RefIs's table (same wording family)
  static test(rt, s, C, env) {
    return (s.cards[env.src]?.lastUnder || []).some((id) => s.cards[id]?.zone === 'discard' && rt.matches(s, C.wasUnder, s.cards[id], env.ctl, env.src, { anyZone: true }));
  }
  static say(C) { return `a ${C.wasUnder.types.join('/')} card was under it`; }
}
// "if it has the same name as the chosen card" (the card picked first) · "… as a card in your discard" (another one)
export class SameNameAs extends Condition {
  static key = 'sameNameAs';
  static rules = [
    [/^it has the same name as the chosen card$/i, () => ({ sameNameAs: 'chosen' })],
    [/^it has the same name as a card in your discard$/i, () => ({ sameNameAs: 'discard' })],
  ];
  static test(rt, s, C, env) {
    const ctx = env.job?.ctx || {};
    const id = (ctx.it || [])[0] ?? (ctx.trigIt || [])[0];
    const c = id != null && s.cards[id];
    if (!c) return false;
    const name = rt.E.D(s, c).name;
    if (C.sameNameAs === 'chosen') {
      const first = Object.values(ctx.byFn || {}).flat().find((x) => x !== id && s.cards[x]);
      return !!first && rt.E.D(s, s.cards[first]).name === name;
    }
    return rt.E.P(s, env.ctl).discard.some((x) => x !== id && rt.E.D(s, s.cards[x]).name === name);
  }
  static say(C) { return C.sameNameAs === 'chosen' ? 'it has the same name as the chosen card' : 'it has the same name as a card in your discard'; }
}
export class RefIs extends Condition {
  static key = 'refIs';
  static rules = [
    // "If the moved character is a Knight" — the card the trigger was about, even after a step picked another
    [/^the moved character is (?:a|an) (.+?)$/i, (m, a) => ({ refIs: filter(m[1], a), trig: true })],
    [/^the (item|character|location) you played has a different name than each other (item|character|location) you have in play$/i, (m) => ({ refIs: { types: [m[1].toLowerCase()], with: [{ uniqueName: { types: [m[2].toLowerCase()] } }] }, trig: true })],
    [/^(?:a|an) (.+?) (?:was|is) chosen$/i, (m, a) => ({ refIs: filter(m[1], a) })],
    [/^(?:it is|it's|that card is|that character is|the chosen character is|they're|he's|she's|they are|he is|she is|the moved character is) (?:a|an) (.+?)$/i, (m, a) => ({ refIs: filter(m[1], a) })],
    // "its card type is: • character" (a chooseOne-style list collapsed to one type)
    [/^(?:it is|it's|that card is) the named card$/i, () => ({ refIs: { with: [{ namedCard: true }] } })],   // CR 5.2.6 — after "Name a card"
    [/^its card type is:? •? ?(character|item|location|action|song)$/i, (m) => ({ refIs: { types: [m[1].toLowerCase()] } })],
    // "you discarded a Pirate character card this way" · "an Illusion character card is discarded this way"
    // "you discarded a Pirate character card" reads the discarded cards even when a later step chose another
    [new RegExp(String.raw`^you (${PAST_THIS_WAY}) (.+?)(?: this way)?$`, 'i'), (m, a) => RefIs.counted(m[2], a, m[1].toLowerCase() === 'discarded' ? 'discarded' : undefined)],
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
    // "if any of the cards that were under them are character cards" (it left play — what was under it then)
    [/^any of the cards that were under (?:them|him|her|it) are (character|item|action|song|location) cards$/i, (m) => ({ wasUnder: { types: [m[1].toLowerCase()] } })],
    [/^there(?:'s| is) a card under (?:that character|that location|it|them|him|her)$/i, () => ({ refIs: { with: [{ under: true }] } })],
    [/^(?:the chosen character|that character|the moved character|the challenging character|that item) is named (.+)$/i, (m) => ({ refIs: { with: [{ named: [m[1].trim()] }] } })],
    [/^(?:that character|the chosen character|they) (?:has|have) damage$/i, () => ({ refIs: { with: [{ damaged: true }] } })],
    // "If one of them is cost 3 or less" — any of the cards just chosen
    [/^(?:one|any|either) of them (?:is cost|costs|has cost) (\d+) or (less|more)$/i, (m) => ({ refIs: { with: [{ cost: m[2] === 'less' ? { lte: +m[1] } : { gte: +m[1] } }] }, n: { gte: 1 } })],
    [/^(?:that item|that card|it) costs (\d+) or less$/i, (m) => ({ refIs: { with: [{ cost: { lte: +m[1] } }] } })],
    [/^(?:the challenging character|that character) has (\d+) \{strength\} or more$/i, (m) => ({ refIs: { with: [{ str: { gte: +m[1] } }] } })],
  ];
  static counted(np, at, of) {
    let c;
    try { c = counted(np.replace(/ cards?$/i, (x) => x), at); } catch { return undefined; }
    if (c.self) return undefined;
    return { refIs: c.F, n: c.n, ...(of ? { of } : {}) };
  }
  static test(rt, s, C, env) {
    const ctx = env.job?.ctx;
    const it = ((C.trig ? ctx?.trigIt : C.of ? ctx?.[C.of] ?? ctx?.it : ctx?.it) || []).filter((id) => s.cards[id]);
    if (C.n) return countOk(C.n, it.filter((id) => rt.matches(s, C.refIs, s.cards[id], env.ctl, env.src, { anyZone: true })).length);
    const id = it[0];
    return !!id && rt.matches(s, C.refIs, s.cards[id], env.ctl, env.src, { anyZone: true });
  }
  static say(C) { return `that card is a ${Query.describe(C.refIs)}`; }
}
// "The challenging player may choose and discard a card. If they don't, you gain 2 lore." — another player declined
// (or couldn't do) the "may" they were offered (effects/meta.js EachPlayer keeps the tally)
export class TheyDont extends Condition {
  static key = 'didnt';
  static rules = [[/^(?:they|he|she|that player) (?:don't|doesn't|didn't|do not|does not)$/i, () => ({ didnt: true })]];
  static test(rt, s, C, env) { return (env.job?.ctx.tally?.didnt.length || 0) > 0; }
  static say() { return "they didn't"; }
}
// "if it's the second card they've drawn this turn" — the active player's draws, counted in the turn log
export class NthDraw extends Condition {
  static key = 'nthDraw';
  static rules = [[/^it is the (second|third) card (?:they've|they have|you've|you have) drawn this turn$/i, (m) => ({ nthDraw: m[1].toLowerCase() === 'second' ? 2 : 3 })]];
  static test(rt, s, C) { return (s.turnLog || []).filter((e) => e.ev === 'draw' && e.seat === s.active).length === C.nthDraw; }
  static say(C) { return `it's draw #${C.nthDraw} this turn`; }
}
