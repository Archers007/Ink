// static-only: a card that changes a game rule — "Opponents need 25 lore to win the game", "Skip your turn's Draw step",
// "Each turn, only one character can challenge". The rule and its base value live in game/rulebook/rules.js.
import { Effect } from './Effect.js';
import { ruleSay } from '../../rulebook/rules.js';

export class RuleFx extends Effect {
  static fn = 'rule';
  static staticOnly = true;
  static say(st) { return ruleSay(st); }
}
