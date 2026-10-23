// "this turn" questions, answered from the per-turn event log (s.turnLog, filled by Runtime.fire + moveTo):
//   "2 or more cards were put into your discard this turn" · "none of your characters challenged this turn"
//   "a character was banished in a challenge this turn" · "you've played 2 or more actions this turn" · …
import { Condition } from './Condition.js';
import { N, NUM } from '../phrases/text.js';
import { filter } from '../phrases/filter.js';
import { Query } from '../query.js';

// { history: { ev, n?:{gte|lte}, mine?:bool, opp?:bool, inChallenge?, of?:Query } }
const H = (ev, o = {}) => ({ history: { ev, ...o } });
export class History extends Condition {
  static key = 'history';
  static rules = [
    [new RegExp(String.raw`^${NUM} or more cards were put into your discard this turn$`, 'i'), (m) => H('toDiscard', { mine: true, n: { gte: N(m[1]) } })],
    [new RegExp(String.raw`^${NUM} or more other cards were put into your discard this turn$`, 'i'), (m) => H('toDiscard', { mine: true, n: { gte: N(m[1]) }, notSelf: true })],
    [/^it is the (second|third) challenge this turn$/i, (m) => H('challenges', { n: { gte: m[1] === 'second' ? 2 : 3, lte: m[1] === 'second' ? 2 : 3 } })],
    [/^it is the (second|third) card you've put into your inkwell this turn$/i, (m) => H('inked', { mine: true, n: { gte: m[1] === 'second' ? 2 : 3, lte: m[1] === 'second' ? 2 : 3 } })],
    [new RegExp(String.raw`^(?:a card|${NUM} or more cards) (?:has |have )?left a player's discard this turn$`, 'i'), (m) => H('leavesDiscard', { n: { gte: m[1] ? N(m[1]) : 1 } })],
    [/^none of your characters challenged this turn$/i, () => H('challenges', { mine: true, n: { lte: 0 } })],
    [/^(?:one of )?your characters? challenged this turn$/i, () => H('challenges', { mine: true })],
    [/^an? (opposing )?character was banished( in a challenge)? this turn$/i, (m) => H('banished', { ...(m[1] ? { opp: true } : {}), ...(m[2] ? { inChallenge: true } : {}), of: { types: ['character'] } })],
    [/^one of your characters (?:was (?:damaged|dealt damage)|took damage) this turn$/i, () => H('damaged', { mine: true })],
    [/^you (?:removed damage from a character|removed 1 or more damage from one of your characters) this turn$/i, () => H('healed', { mine: true })],
    [/^you(?:'ve)? discarded a card this turn$/i, () => H('discarded', { mine: true })],
    [/^you(?:'ve)? got(?:ten)? (?:an|one or more) ink drops? this turn$/i, () => H('gotInkDrop', { mine: true })],
    [/^you didn't put any cards into your inkwell this turn$/i, () => H('inked', { mine: true, n: { lte: 0 } })],
    [new RegExp(String.raw`^you(?:'ve)? played ${NUM} or more (.+?) this turn$`, 'i'), (m, a) => H('play', { mine: true, n: { gte: N(m[1]) }, ...(/^cards?$/i.test(m[2]) ? {} : { of: filter(m[2], a) }) })],
    [/^you didn't play (?:a|an) (.+?) this turn$/i, (m, a) => H('play', { mine: true, n: { lte: 0 }, of: filter(m[1], a) })],
    [/^you(?:'ve)? put a card under one of your characters or locations this turn$/i, () => H('putUnder', { mine: true })],
    [/^you(?:'ve)? put a card under (?:him|her|it|them|this character) this turn$/i, () => H('putUnder', { mine: true, onSelf: true })],
  ];
  static test(rt, s, C, env) {
    const h = C.history;
    const n = (s.turnLog || []).filter((e) => e.ev === h.ev && (!h.notSelf || e.iid !== env.src) && (!h.onSelf || e.iid === env.src)
      && (!h.mine || e.seat === env.ctl) && (!h.opp || e.seat !== env.ctl) && (!h.inChallenge || e.inChallenge)
      && (!h.of || (e.iid && rt.matches(s, h.of, s.cards[e.iid], env.ctl, env.src, { anyZone: true })))).length;
    const r = h.n || { gte: 1 };
    return (r.gte == null || n >= r.gte) && (r.lte == null || n <= r.lte);
  }
  static say(C) {
    const h = C.history;
    const r = h.n || { gte: 1 };
    const n = r.lte === 0 && r.gte == null ? 'no' : r.gte != null && r.lte != null ? (r.gte === r.lte ? `exactly ${r.gte}` : `${r.gte}–${r.lte}`) : r.lte != null ? `≤${r.lte}` : `${r.gte}+`;
    const what = h.of ? Query.describe(h.of) : 'card';
    // whose: mine = by/for you, opp = an opponent's, else anyone's
    const who = h.mine ? 'yours' : h.opp ? "an opponent's" : "anyone's";
    const S = {
      toDiscard: `${n} cards put into the discard`, discarded: `${n} cards discarded`, challenges: `${n} challenges`, damaged: `${n} characters damaged`,
      healed: `${n} heals`, inked: `${n} cards inked`, putUnder: `${n} cards put under${h.onSelf ? ' this card' : ''}`,
      play: `${n} ${what}s played`, banished: `${n} ${what}s banished${h.inChallenge ? ' in a challenge' : ''}`,
    };
    return `this turn: ${S[h.ev] || `${n} ${h.ev}`} (${who}${h.notSelf ? ', not counting this card' : ''})`;
  }
}
