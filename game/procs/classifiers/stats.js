// "with 2 {strength} or less", "with 5 {willpower} or more", "with 2 or more {lore}"
import { Classifier, inRange, sayRange, range } from './Classifier.js';

class Stat extends Classifier {
  static word = '';
  static value(card, def, E) { return 0; }
  static test(x, card, def, env) { return inRange(this.value(card, def, env.E), x[this.id]); }
  static say(x) { return `with ${sayRange(x[this.id])} {${this.word}}`; }
  static is(x) { return `has ${sayRange(x[this.id])} {${this.word}}`; }
  static parseWith(s) {
    const w = this.word;
    const m = s.match(new RegExp(String.raw`^(\d+) \{${w}\} or (less|more)\b`, 'i'))
      || s.match(new RegExp(String.raw`^(\d+) or (less|more) \{?${w}\}?`, 'i'))
      || s.match(new RegExp(String.raw`^(\d+) \{${w}\}(?! or)`, 'i'));
    return m ? [{ [this.id]: range(m[1], m[2]) }, m[0].length] : null;
  }
}
export class Strength extends Stat { static id = 'str'; static word = 'strength'; static value(c, d, E) { return E.effStr(c, d); } }
export class Willpower extends Stat { static id = 'wp'; static word = 'willpower'; static value(c, d, E) { return E.effWp(c, d); } }
export class LoreValue extends Stat { static id = 'lore'; static word = 'lore'; static value(c, d, E) { return E.effLore(c, d); } }
