// "a card with {inkable}" · "a card without {inkable}" (via Not) — the inkwell symbol (CR 4.2.1.1)
import { Classifier } from './Classifier.js';

export class Inkable extends Classifier {
  static id = 'inkable';
  static parseWith(s) { const m = s.match(/^\{inkable\}/i); return m ? [{ inkable: true }, m[0].length] : null; }
  static test(x, card, def) { return !!def.inkable; }
  static say() { return 'with {inkable}'; }
  static is() { return 'is inkable'; }
}
