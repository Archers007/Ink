import { Trigger, other } from './Trigger.js';
import { Query } from '../query.js';

export class Play extends Trigger {
  static ev = 'play';
  static rules = [
    [/^when you play this (?:character|item|location) and whenever (?:he|she|it|they|this character) quests?$/i, () => [{ ev: 'play' }, { ev: 'quest' }]],
    [/^when you play this (?:character|item|location)$/i, () => [{ ev: 'play' }]],
    [/^whenever you play this character or another (.+)$/i, (m, P) => [{ ev: 'play' }, { ev: 'playCard', filter: other(P.filter(m[1]), true) }]],
  ];
  static say() { return 'you play this card'; }
}
export class PlayCard extends Trigger {
  static ev = 'playCard';
  static rules = [
    [/^whenever you play a song$/i, () => [{ ev: 'playCard', filter: { types: ['song'] } }]],
    [/^whenever you play (a|an|another) (.+)$/i, (m, P) => [{ ev: 'playCard', filter: other(P.filter(m[2]), m[1].toLowerCase() === 'another') }]],
  ];
  static say(o) { return `you play ${Query.describe(o.filter)}`; }
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
    for (const x of rt.inPlay(s, c.owner)) fireOn(x, 'playCard', (o) => rt.matches(s, o.filter, c, x.owner, x.iid, { anyZone: true }), [c.iid]);
    for (const o of rt.E.opponentsOf(s, c.owner)) for (const x of rt.inPlay(s, o)) {
      fireOn(x, 'oppPlayCard', (on) => rt.matches(s, on.filter, c, c.owner, x.iid, { anyZone: true }), [c.iid]);
    }
  },
};
