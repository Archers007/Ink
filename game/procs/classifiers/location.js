// "at a location" · "here" (at the location this ability is on)
import { Classifier } from './Classifier.js';

export class AtLocation extends Classifier {
  static id = 'atLocation';
  static test(x, card) { return !!card.atLocation; }
  static say() { return 'at a location'; }
}
export class Here extends Classifier {
  static id = 'here';
  static test(x, card, def, env) { return !!env.src && card.atLocation === env.src; }
  static say() { return 'here'; }
}
