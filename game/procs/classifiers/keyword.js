// "with Evasive", "with Sing Together", "with Resist +2" — the card has that keyword (printed or granted).
import { Classifier } from './Classifier.js';

// id · printed label · how its number reads: '' none, 'n' a value ("Singer 5"), '+n' a bonus that stacks ("Resist +1")
export const KEYWORDS = [
  ['alert', 'Alert', ''], ['bodyguard', 'Bodyguard', ''], ['boost', 'Boost', 'n'], ['challenger', 'Challenger', '+n'],
  ['evasive', 'Evasive', ''], ['reckless', 'Reckless', ''], ['resist', 'Resist', '+n'], ['rush', 'Rush', ''],
  ['shift', 'Shift', 'n'], ['puppyShift', 'Puppy Shift', 'n'], ['universalShift', 'Universal Shift', 'n'],
  ['singer', 'Singer', 'n'], ['singTogether', 'Sing Together', 'n'], ['support', 'Support', ''],
  ['vanish', 'Vanish', ''], ['ward', 'Ward', ''], ['adventurous', 'Adventurous', ''], ['underdog', 'Underdog', ''],
];
// restrictions/permissions effects can put on a card; they travel as keyword-style mods
export const RESTRICTIONS = {
  cantQuest: "can't quest", cantChallenge: "can't challenge", cantReady: "can't ready", cantMove: "can't move to locations", skipReady: "can't ready at the start of the turn", cantBeChallenged: "can't be challenged",
  cantSing: "can't sing songs", cantMove: "can't move", challengeReady: 'can challenge ready characters',
  mustChallenge: 'must challenge if able', mustQuest: 'must quest if able',
};
const BY_ID = new Map(KEYWORDS.map((k) => [k[0], k]));
const BY_LABEL = new Map(KEYWORDS.map((k) => [k[1].toLowerCase(), k[0]]));
export const keywordId = (label) => BY_LABEL.get(String(label).toLowerCase()) || null;
export const KEYWORD_ALT = [...BY_LABEL.keys()].sort((a, b) => b.length - a.length).join('|');

export function kwLabel(id, n) {
  if (RESTRICTIONS[id]) return RESTRICTIONS[id];
  const k = BY_ID.get(id) || (id === 'classShift' ? ['classShift', 'Shift', 'n'] : null);
  if (!k) return id;
  if (n == null || !k[2]) return k[1];
  return `${k[1]} ${k[2] === '+n' ? '+' : ''}${n}`;
}

const RX = new RegExp(String.raw`^(${KEYWORD_ALT})(?: \+?(\d+))?\b`, 'i');

export class Keyword extends Classifier {
  static id = 'kw';
  static test(x, card, def, env) { return x.n ? env.E.kwVal(card, def, x.kw) >= x.n : env.E.hasKw(card, def, x.kw); }
  static say(x) { return `with ${kwLabel(x.kw, x.n)}`; }
  static is(x) { return `has ${kwLabel(x.kw, x.n)}`; }
  static parseWith(s) {
    const m = s.match(RX);
    return m ? [{ kw: keywordId(m[1]), ...(m[2] ? { n: +m[2] } : {}) }, m[0].length] : null;
  }
}
