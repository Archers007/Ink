// "this character is damaged / exerted / at a location" · "has no damage" · "has 5 {strength} or more" · "has a card under them"
// Reuses the classifiers: { self: [classifier…] } is true when the card the ability is on passes them all.
import { Condition } from './Condition.js';
import { SUBJ, OBJ } from '../phrases/text.js';
import { parseWith, fromAdjective, isClassifier, classify } from '../classifiers/index.js';

function adjective(w) { const x = fromAdjective(w); return x ? [x] : undefined; }
function having(rest) { const r = parseWith(rest); return r && r[1] === rest.length ? [r[0]] : undefined; }

export class SelfIs extends Condition {
  static key = 'self';
  static rules = [
    [new RegExp(String.raw`^${SUBJ} (?:is|are) (\w+)$`, 'i'), (m) => adjective(m[1])],
    [new RegExp(String.raw`^${SUBJ} (?:is|are) at a location$`, 'i'), () => [{ atLocation: true }]],
    [new RegExp(String.raw`^${SUBJ} (?:has|have) (.+)$`, 'i'), (m) => having(m[1])],
    [new RegExp(String.raw`^there's a card under ${OBJ}$`, 'i'), () => [{ under: true }]],
  ].map(([rx, f]) => [rx, (m) => { const w = f(m); return w ? { self: w } : undefined; }]);
  static test(rt, s, C, env) {
    const me = s.cards[env.src];
    if (!me) return false;
    const d = rt.E.D(s, me);
    return C.self.every((x) => classify(x, me, d, { E: rt.E, ctl: env.ctl, src: env.src }));
  }
  static say(C) { return `this card ${C.self.map(isClassifier).join(' and ')}`; }
}
