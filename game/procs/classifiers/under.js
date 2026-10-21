// "with a card under them" — something is stacked under this card (Shift, Boost, "put under")
import { Classifier } from './Classifier.js';

export class Under extends Classifier {
  static id = 'under';
  static test(x, card) { return (card.under || []).length > 0; }
  static say() { return 'with a card under them'; }
  static is() { return 'has a card under it'; }
  static parseWith(s) {
    const m = s.match(/^(?:a |one or more )?cards? under (?:them|him|her|it|this character)\b/i);
    return m ? [{ under: true }, m[0].length] : null;
  }
}
