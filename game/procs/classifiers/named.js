// "named Ariel", "named Flotsam or Jetsam"
import { Classifier } from './Classifier.js';

export class Named extends Classifier {
  static id = 'named';
  static test(x, card, def) { return x.named.some((n) => n.toLowerCase() === String(def.name).toLowerCase()); }
  static say(x) { return `named ${x.named.join(' or ')}`; }
  static is(x) { return `is ${this.say(x)}`; }
}
