// "that isn't a song", "non-character card"
import { Classifier } from './Classifier.js';

export class NotType extends Classifier {
  static id = 'notType';
  static test(x, card, def) { return !x.notType.includes(def.type); }
  static say(x) { return `that isn't a ${x.notType.join(' or ')}`; }
  static is(x) { return `isn't a ${x.notType.join(' or ')}`; }
}
