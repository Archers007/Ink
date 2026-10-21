// "Hero character", "Seven Dwarfs characters", "Hero or Princess character" — any of the listed classifications.
import { Classifier, cap } from './Classifier.js';

export class Classification extends Classifier {
  static id = 'class';
  static pre = true;
  static test(x, card, def) {
    const mine = (def.classes || []).map((k) => String(k).toLowerCase());
    return x.class.some((k) => mine.includes(k));
  }
  static say(x) { return x.class.map(cap).join('/'); }
  static is(x) { return `is a ${this.say(x)}`; }
}
