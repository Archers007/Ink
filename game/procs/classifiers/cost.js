// "with cost 3 or less", "with cost 2", "with an ink cost of 4 or more"
import { Classifier, inRange, sayRange, range } from './Classifier.js';

const RX = [
  /^(?:a |an )?(?:ink )?cost (\d+) or (less|more)\b/i,
  /^(?:a |an )?(?:ink )?cost of (\d+) or (less|more)\b/i,
  /^(?:a |an )?(?:ink )?cost (?:of )?(\d+)\b(?! or)/i,
];

export class Cost extends Classifier {
  static id = 'cost';
  static test(x, card, def) { return inRange(def.cost, x.cost); }
  static say(x) { return `with cost ${sayRange(x.cost)}`; }
  static is(x) { return `costs ${sayRange(x.cost)}`; }
  static parseWith(s) {
    for (const rx of RX) { const m = s.match(rx); if (m) return [{ cost: range(m[1], m[2]) }, m[0].length]; }
    return null;
  }
}
