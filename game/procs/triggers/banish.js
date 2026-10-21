import { Trigger, other } from './Trigger.js';
import { Query } from '../query.js';

export class Banished extends Trigger {
  static ev = 'banished';
  static rules = [
    [/^when(?:ever)? this (?:character|item|location) is banished$/i, () => [{ ev: 'banished' }]],
    [/^when(?:ever)? this character is banished in a challenge$/i, () => [{ ev: 'banished', inChallenge: true }]],
    [/^when(?:ever)? this character is challenged and banished$/i, () => [{ ev: 'banished', inChallenge: true, defending: true }]],
  ];
  static say(o) { return `this is banished${o.defending ? ' while defending' : o.inChallenge ? ' in a challenge' : ''}`; }
}
export class BanishOther extends Trigger {
  static ev = 'banishOther';
  static rules = [[/^whenever this character banishes another character in a challenge$/i, () => [{ ev: 'banishOther' }]]];
  static say() { return 'this banishes another character in a challenge'; }
}
export class BanishedAny extends Trigger {
  static ev = 'banishedAny';
  static rules = [[/^whenever one of your (other )?(.+?) is banished( in a challenge)?$/i, (m, P) => [{ ev: 'banishedAny', filter: other(P.filter(m[2]), m[1]), inChallenge: !!m[3] || undefined }]]];
  static say(o) { return `your ${Query.describe(o.filter)} is banished${o.inChallenge ? ' in a challenge' : ''}`; }
}
export class BanishOtherAny extends Trigger {
  static ev = 'banishOtherAny';
  static rules = [[/^whenever one of your (other )?(.+?) banishes another character in a challenge$/i, (m, P) => [{ ev: 'banishOtherAny', filter: other(P.filter(m[2]), m[1]) }]]];
  static say(o) { return `your ${Query.describe(o.filter)} banishes another character in a challenge`; }
}

export const events = {
  banished(rt, s, info, fireOn) {
    const c = s.cards[info.iid];
    fireOn(c, 'banished', (o) => (!o.inChallenge || info.inChallenge) && (!o.defending || info.defending));
    for (const x of rt.inPlay(s, c.owner)) {
      fireOn(x, 'banishedAny', (o) => (!o.inChallenge || info.inChallenge) && rt.matches(s, o.filter, c, x.owner, x.iid, { anyZone: true }), [c.iid]);
    }
    const killer = info.by && s.cards[info.by];
    if (killer?.zone === 'play') {
      fireOn(killer, 'banishOther', null, [c.iid]);
      for (const x of rt.inPlay(s, killer.owner)) fireOn(x, 'banishOtherAny', (o) => rt.matches(s, o.filter, killer, x.owner, x.iid), [c.iid]);
    }
  },
};
