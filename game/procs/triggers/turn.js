import { Trigger } from './Trigger.js';

export class TurnStart extends Trigger {
  static ev = 'turnStart';
  static rules = [[/^at the start of your turn$/i, () => [{ ev: 'turnStart' }]]];
  static say() { return 'your turn starts'; }
}
export class TurnEnd extends Trigger {
  static ev = 'turnEnd';
  static rules = [[/^at the end of your turn$/i, () => [{ ev: 'turnEnd' }]]];
  static say() { return 'your turn ends'; }
}
const each = (rt, s, info, fireOn, ev) => { for (const c of rt.inPlay(s, info.seat)) fireOn(c, ev); };
export const events = {
  turnStart: (rt, s, info, fireOn) => each(rt, s, info, fireOn, 'turnStart'),
  turnEnd: (rt, s, info, fireOn) => each(rt, s, info, fireOn, 'turnEnd'),
};
