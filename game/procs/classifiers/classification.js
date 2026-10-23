// "Hero character", "Seven Dwarfs characters", "Hero or Princess character" — any of the listed classifications.
import { Classifier, cap } from './Classifier.js';

const INKS = new Set(['amber', 'amethyst', 'emerald', 'ruby', 'sapphire', 'steel']);
export class Classification extends Classifier {
  static id = 'class';
  static pre = true;
  static test(x, card, def) {
    const mine = [...(def.classes || []), ...(card.mods || []).filter((m) => m.stat === 'class').map((m) => m.cls)].map((k) => String(k).toLowerCase());
    // "your other Sapphire characters" — an ink type reads like a classification
    const inks = (def.inks || []).map((k) => String(k).toLowerCase());
    return x.class.some((k) => mine.includes(k) || (INKS.has(k) && inks.includes(k)));
  }
  static say(x) { return x.class.map(cap).join('/'); }
  static is(x) { return `is a ${this.say(x)}`; }
}
