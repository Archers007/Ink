// "you have 2 or more Princess characters in play" · "you have no items in play" · "an opponent has a damaged character"
// "you have a character here" · "you have 3 or more cards in your discard"
import { Condition } from './Condition.js';
import { N, NUM } from '../phrases/text.js';
import { filter } from '../phrases/filter.js';
import { Query } from '../query.js';

const at = (F, zone, owner) => Object.assign(F, zone ? { zone } : {}, owner ? { owner } : {});
export class Have extends Condition {
  static key = 'have';
  static rules = [
    [new RegExp(String.raw`^you have ${NUM} or more (.+?) in play$`, 'i'), (m, a) => ({ have: filter(m[2], a), n: N(m[1]) })],
    [/^you have (a|an|another) (.+?) in play$/i, (m, a) => { const F = filter(m[2], a); if (/another/i.test(m[1])) F.other = true; return { have: F, n: 1 }; }],
    [/^you have (?:a|an) (.+?) (here|at this location)$/i, (m, a) => { const F = filter(m[1], a); (F.with ||= []).push({ here: true }); return { have: F, n: 1 }; }],
    [/^you have no (.+?) in play$/i, (m, a) => ({ have: filter(m[1], a), n: 0, exactly: true })],
    [/^(?:an|chosen|each) opponent has (?:a|an) (.+?) in play$/i, (m, a) => ({ have: at(filter(m[1], a), null, 'opp'), n: 1 })],
    [/^(?:an|chosen|each) opponent has (?:a|an) (.+?)$/i, (m, a) => ({ have: at(filter(m[1], a), null, 'opp'), n: 1 })],
    [/^you have (?:a|an) (.+?) in your (discard|hand)$/i, (m, a) => ({ have: at(filter(m[1], a), m[2], 'you'), n: 1 })],
    [new RegExp(String.raw`^you have ${NUM} or more (.+?) in your (discard|hand)$`, 'i'), (m, a) => ({ have: at(filter(m[2], a), m[3], 'you'), n: N(m[1]) })],
    [/^you have (?:a|an|another) (.+?)$/i, (m, a) => ({ have: filter(m[1], a), n: 1 })],
    [/^you have any (.+?) in play( .+)?$/i, (m, a) => ({ have: filter(m[1] + (m[2] || ''), a), n: 1 })],
    [new RegExp(String.raw`^you have ${NUM} or more (other )?(.+?) in play (with .+)$`, 'i'), (m, a) => { const F = filter(`${m[3]} ${m[4]}`, a); if (m[2]) F.other = true; return { have: F, n: N(m[1]) }; }],
    [new RegExp(String.raw`^you have ${NUM} or more (.+?) (?:here|at this location)$`, 'i'), (m, a) => { const F = filter(m[2], a); (F.with ||= []).push({ here: true }); return { have: F, n: N(m[1]) }; }],
    [new RegExp(String.raw`^you have ${NUM} (.+?) in play$`, 'i'), (m, a) => ({ have: filter(m[2], a), n: N(m[1]) })],
  ];
  static test(rt, s, C, env) {
    const F = { ...C.have, owner: C.have.owner || 'you' };
    const n = rt.candidates(s, F, env.ctl, env.src).length;
    return C.exactly ? n === C.n : n >= C.n;
  }
  static say(C) { return C.exactly ? `you have exactly ${C.n} ${Query.describe(C.have)}` : `you have ${C.n > 1 ? `${C.n}+ ` : 'a '}${Query.describe(C.have)}`; }
}
