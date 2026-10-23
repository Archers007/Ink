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
// "a song card you played this turn"
export class PlayedTurn extends Classifier {
  static id = 'playedTurn';
  static test(x, card, def, env) { return !!env.s && (env.E.P(env.s, env.ctl).playedThisTurn || []).includes(card.iid); }
  static say() { return 'you played this turn'; }
}
// "chosen character who was challenged this turn" — in the turn log
export class WasChallenged extends Classifier {
  static id = 'wasChallenged';
  static test(x, card, def, env) { return !!env.s && (env.s.turnLog || []).some((e) => e.ev === 'challenged' && e.iid === card.iid); }
  static say() { return 'who was challenged this turn'; }
}
