// "without Evasive" · "not named Mor'du" · "non-character" — the inner classifier must fail
import { Classifier } from './Classifier.js';

export class Not extends Classifier {
  static id = 'not';
  static reg = null;                 // set by index.js (avoids a circular import)
  static test(x, card, def, env) { return !Not.reg.classify(x.not, card, def, env); }
  static say(x) { const inner = Not.reg.sayClassifier(x.not); return inner.startsWith('with ') ? `without ${inner.slice(5)}` : `not ${inner}`; }
  static is(x) { return `isn't ${Not.reg.sayClassifier(x.not).replace(/^with /, 'with ')}`; }
}
