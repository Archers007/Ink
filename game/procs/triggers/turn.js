import { Trigger } from './Trigger.js';

// "at the start / end of your turn" · "… of each opponent's turn" · "… of each player's turn"   { ev, whose?: 'opp' | 'each' }
const whose = (w) => (!w || /^your$/i.test(w) ? {} : /player/i.test(w) ? { whose: 'each' } : { whose: 'opp' });
const WHOSE = String.raw`(your|each opponent's|an opponent's|each player's|each other player's)`;
export class TurnStart extends Trigger {
  static ev = 'turnStart';
  static rules = [[new RegExp(String.raw`^at the start of ${WHOSE} turns?$`, 'i'), (m) => [{ ev: 'turnStart', ...whose(m[1]) }]]];
  static say(o) { return `${o.whose === 'opp' ? "an opponent's" : o.whose === 'each' ? "each player's" : 'your'} turn starts`; }
}
export class TurnEnd extends Trigger {
  static ev = 'turnEnd';
  static rules = [[new RegExp(String.raw`^at the end of ${WHOSE} turns?$`, 'i'), (m) => [{ ev: 'turnEnd', ...whose(m[1]) }]]];
  static say(o) { return `${o.whose === 'opp' ? "an opponent's" : o.whose === 'each' ? "each player's" : 'your'} turn ends`; }
}
// every card in play hears it; `whose` says whose turn it listens for (none = its owner's)
const each = (rt, s, info, fireOn, ev) => {
  for (const p of s.players) for (const c of rt.inPlay(s, p.seat)) {
    fireOn(c, ev, (o) => (o.whose === 'each' ? true : o.whose === 'opp' ? c.owner !== info.seat : c.owner === info.seat));
  }
};
export const events = {
  turnStart: (rt, s, info, fireOn) => each(rt, s, info, fireOn, 'turnStart'),
  turnEnd: (rt, s, info, fireOn) => each(rt, s, info, fireOn, 'turnEnd'),
};
