// "damaged character" / "character with damage" · "undamaged character" / "character with no damage"
import { Classifier } from './Classifier.js';

export class Damaged extends Classifier {
  static id = 'damaged';
  static pre = true;
  static adjectives = ['damaged'];
  static test(x, card) { return card.damage > 0; }
  static say() { return 'damaged'; }
  static parseWith(s) { const m = s.match(/^damage\b/i); return m ? [{ damaged: true }, m[0].length] : null; }
}
export class Undamaged extends Classifier {
  static id = 'undamaged';
  static adjectives = ['undamaged'];
  static test(x, card) { return !card.damage; }
  static say() { return 'with no damage'; }
  static is() { return 'has no damage'; }
  static parseWith(s) { const m = s.match(/^no damage\b/i); return m ? [{ undamaged: true }, m[0].length] : null; }
}
// "this character has 3 or more damage" · "a character with 2 or more damage"
export class DamageCount extends Classifier {
  static id = 'dmg';
  static test(x, card) { return (card.damage || 0) >= x.dmg.gte; }
  static say(x) { return `with ${x.dmg.gte} or more damage`; }
  static is(x) { return `has ${x.dmg.gte} or more damage`; }
  static parseWith(s) { const m = s.match(/^(\d+) (?:or more damage|damage or more)\b/i); return m ? [{ dmg: { gte: +m[1] } }, m[0].length] : null; }
}
