// "exerted character" · "ready character"
import { Classifier } from './Classifier.js';

export class Exerted extends Classifier {
  static id = 'exerted';
  static pre = true;
  static adjectives = ['exerted'];
  static test(x, card) { return !!card.exerted; }
  static say() { return 'exerted'; }
}
export class Ready extends Classifier {
  static id = 'ready';
  static pre = true;
  static adjectives = ['ready'];
  static test(x, card) { return !card.exerted; }
  static say() { return 'ready'; }
}
