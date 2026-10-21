// "at a location" · "here" (at the location this ability is on)
import { Classifier } from './Classifier.js';

export class AtLocation extends Classifier {
  static id = 'atLocation';
  static test(x, card) { return !!card.atLocation; }
  static say() { return 'at a location'; }
}
export class Here extends Classifier {
  static id = 'here';
  // on a location: characters at it · on a character: characters at the same location as it
  static test(x, card, def, env) {
    if (!env.src) return false;
    const S = env.s?.cards[env.src];
    const loc = S && env.E.D(env.s, S).type !== 'location' ? S.atLocation : env.src;
    return !!loc && card.atLocation === loc;
  }
  static say() { return 'here'; }
}
