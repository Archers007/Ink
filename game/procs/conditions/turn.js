// "it's your turn" · "it's an opponent's turn" · "you've played a song this turn"
import { Condition } from './Condition.js';
import { filter } from '../phrases/filter.js';
import { Query } from '../query.js';

export class YourTurn extends Condition {
  static key = 'yourTurn';
  static rules = [
    [/^it is your turn$/i, () => ({ yourTurn: true })],
    [/^it is (?:an|your) opponent's turn$/i, () => ({ yourTurn: false })],
  ];
  static test(rt, s, C, env) { return (s.active === env.ctl) === C.yourTurn; }
  static say(C) { return C.yourTurn ? "it's your turn" : "it's an opponent's turn"; }
}
export class PlayedThisTurn extends Condition {
  static key = 'playedThisTurn';
  static rules = [[/^you(?:'ve)? played (?:a|an|another) (.+?) this turn$/i, (m, a) => ({ playedThisTurn: filter(m[1], a) })]];
  static test(rt, s, C, env) {
    return (rt.E.P(s, env.ctl).playedThisTurn || []).some((iid) => iid !== env.src && rt.matches(s, C.playedThisTurn, s.cards[iid], env.ctl, env.src, { anyZone: true }));
  }
  static say(C) { return `you played a ${Query.describe(C.playedThisTurn)} this turn`; }
}
