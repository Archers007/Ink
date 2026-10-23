// Classifier registry. Add a classifier: one file with a Classifier subclass, then list it here.
import { Keyword } from './keyword.js';
import { Classification } from './classification.js';
import { Named, NamedCard } from './named.js';
import { Inkable } from './inkable.js';
import { Cost } from './cost.js';
import { Strength, Willpower, LoreValue } from './stats.js';
import { Damaged, Undamaged, DamageCount } from './damage.js';
import { Exerted, Ready } from './exerted.js';
import { Under, PlayedTurn, WasChallenged } from './under.js';
import { AtLocation, Here } from './location.js';
import { NotType } from './notType.js';
import { Not } from './not.js';
import { Compare, SameName, HighestCost, UniqueName } from './compare.js';

export { KEYWORDS, RESTRICTIONS, KEYWORD_ALT, keywordId, kwLabel } from './keyword.js';

export const CLASSIFIERS = [Keyword, Classification, Named, Cost, Strength, Willpower, LoreValue, DamageCount, Damaged, Undamaged,
  Exerted, Ready, Under, AtLocation, Here, NotType, Not, Compare, SameName, PlayedTurn, NamedCard, Inkable, HighestCost, WasChallenged, UniqueName];
export { Compare };
const BY_ID = new Map(CLASSIFIERS.map((C) => [C.id, C]));

export function classifierOf(x) {
  for (const k of Object.keys(x || {})) if (BY_ID.has(k)) return BY_ID.get(k);
  throw new Error(`unknown classifier ${JSON.stringify(x)}`);
}
export const classify = (x, card, def, env) => classifierOf(x).test(x, card, def, env);
export const sayClassifier = (x) => classifierOf(x).say(x);
export const isClassifier = (x) => classifierOf(x).is(x);
export const preClassifier = (x) => classifierOf(x).pre;

// "with <phrase>" → [classifier, consumed] or null — the first classifier whose phrase starts `s`
export function parseWith(s) {
  for (const C of CLASSIFIERS) { const r = C.parseWith(s); if (r) return r; }
  return null;
}
export function fromAdjective(word) {
  for (const C of CLASSIFIERS) { const r = C.fromAdjective(word); if (r) return r; }
  return null;
}
export const ADJECTIVES = CLASSIFIERS.flatMap((C) => C.adjectives);
Not.reg = { classify, sayClassifier };
