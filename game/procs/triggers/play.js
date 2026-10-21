import { Trigger, other } from './Trigger.js';
import { Query } from '../query.js';

export class Play extends Trigger {
  static selfSubject = true;
  static ev = 'play';
  static rules = [
    [/^when you play this (?:character|item|location) and whenever (?:he|she|it|they|this character) quests?$/i, () => [{ ev: 'play' }, { ev: 'quest' }]],
    [/^when you play this (?:character|item|location)$/i, () => [{ ev: 'play' }]],
    [/^whenever you play this (?:character )?or another (.+)$/i, (m, P) => [{ ev: 'play' }, { ev: 'playCard', filter: other(P.filter(m[1]), true) }]],
  ];
  static say() { return 'you play this card'; }
}
export class PlayCard extends Trigger {
  static ev = 'playCard';
  static rules = [
    [/^whenever you play a song$/i, () => [{ ev: 'playCard', filter: { types: ['song'] } }]],
    [/^whenever you play an? (second|third|fourth) (.+?)(?: in a turn| this turn)?$/i, (m, P) => [{ ev: 'playCard', filter: P.filter(m[2]), nth: { second: 2, third: 3, fourth: 4 }[m[1].toLowerCase()] }]],
    [/^whenever you play (a|an|another) (.+)$/i, (m, P) => [{ ev: 'playCard', filter: other(P.filter(m[2]), m[1].toLowerCase() === 'another') }]],
  ];
  static say(o) { return `you play ${o.nth ? `your ${['', '', '2nd', '3rd', '4th'][o.nth]} ` : ''}${Query.describe(o.filter)}${o.nth ? ' this turn' : ''}`; }
}
export class OppPlayCard extends Trigger {
  static ev = 'oppPlayCard';
  static rules = [[/^whenever an opponent plays (?:a|an) (.+)$/i, (m, P) => [{ ev: 'oppPlayCard', filter: P.filter(m[1]) }]]];
  static say(o) { return `an opponent plays ${Query.describe(o.filter)}`; }
}

export const events = {
  play(rt, s, info, fireOn) {
    const c = s.cards[info.iid];
    if (c.zone === 'play') fireOn(c, 'play');
    const nth = (o) => (s.turnLog || []).filter((e) => e.ev === 'play' && e.seat === c.owner && s.cards[e.iid] && rt.matches(s, o.filter, s.cards[e.iid], c.owner, null, { anyZone: true })).length === o.nth;
    for (const x of rt.inPlay(s, c.owner)) fireOn(x, 'playCard', (o) => rt.matches(s, o.filter, c, x.owner, x.iid, { anyZone: true }) && (!o.nth || nth(o)), [c.iid]);
    for (const o of rt.E.opponentsOf(s, c.owner)) for (const x of rt.inPlay(s, o)) {
      fireOn(x, 'oppPlayCard', (on) => rt.matches(s, on.filter, c, c.owner, x.iid, { anyZone: true }), [c.iid]);
    }
  },
};
