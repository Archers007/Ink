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
// "whenever an item is banished" · "whenever an opposing Villain character is banished" · "a character is banished while here"
export class BanishedSome extends Trigger {
  static ev = 'banishedSome';
  static rules = [
    [/^whenever (?:a|an|another) (.+?) is banished( in a challenge)?( while here)?$/i, (m, P) => {
      const F = P.filter(m[1]); if (/^whenever another/i.test(m[0])) F.other = true;
      if (m[3]) (F.with ||= []).push({ here: true });
      return [{ ev: 'banishedSome', filter: F, inChallenge: !!m[2] || undefined }];
    }],
    [/^whenever (?:a|an|another) (.+?) is challenged and banished$/i, (m, P) => [{ ev: 'banishedSome', filter: P.filter(m[1]), inChallenge: true, defending: true }]],
  ];
  static say(o) { return `${Query.describe(o.filter)} is banished${o.inChallenge ? ' in a challenge' : ''}`; }
}
// "when this character leaves play" · "when you play this character and when he leaves play"
export class Leaves extends Trigger {
  static ev = 'leaves';
  static rules = [
    [/^when(?:ever)? this (?:character|item|location) leaves play$/i, () => [{ ev: 'leaves' }]],
    [/^when you play this (?:character|item|location) and when (?:he|she|it|they) leaves? play$/i, () => [{ ev: 'play' }, { ev: 'leaves' }]],
  ];
  static say() { return 'this leaves play'; }
}
export class BanishOther extends Trigger {
  static ev = 'banishOther';
  static rules = [[/^whenever (?:this character|he|she|they) banishes (?:another|a) character in a challenge$/i, () => [{ ev: 'banishOther' }]], [/^whenever a character banishes another character in a challenge while here$/i, () => [{ ev: 'banishOtherHere' }]]];
  static say() { return 'this banishes another character in a challenge'; }
}
export class BanishedAny extends Trigger {
  static ev = 'banishedAny';
  static rules = [[/^whenever one of your (other )?(.+?) is banished( in a challenge)?$/i, (m, P) => [{ ev: 'banishedAny', filter: other(P.filter(m[2]), m[1]), inChallenge: !!m[3] || undefined }]]];
  static say(o) { return `your ${Query.describe(o.filter)} is banished${o.inChallenge ? ' in a challenge' : ''}`; }
}
export class BanishOtherAny extends Trigger {
  static ev = 'banishOtherAny';
  static rules = [[/^whenever one of your (other )?(.+?) banishes (?:another|a) character in a challenge$/i, (m, P) => [{ ev: 'banishOtherAny', filter: other(P.filter(m[2]), m[1]) }]]];
  static say(o) { return `your ${Query.describe(o.filter)} banishes another character in a challenge`; }
}

export const events = {
  leaves(rt, s, info, fireOn) { fireOn(s.cards[info.iid], 'leaves'); },
  banished(rt, s, info, fireOn) {
    const c = s.cards[info.iid];
    fireOn(c, 'banished', (o) => (!o.inChallenge || info.inChallenge) && (!o.defending || info.defending));
    for (const x of rt.inPlay(s, c.owner)) {
      fireOn(x, 'banishedAny', (o) => (!o.inChallenge || info.inChallenge) && rt.matches(s, o.filter, c, x.owner, x.iid, { anyZone: true }), [c.iid]);
    }
    for (const pl of s.players) for (const x of rt.inPlay(s, pl.seat)) {
      fireOn(x, 'banishedSome', (o) => (!o.inChallenge || info.inChallenge) && (!o.defending || info.defending)
        && rt.matches(s, o.filter, c, x.owner, x.iid, { anyZone: true }) && (!(o.filter.with || []).some((w) => w.here) || info.at === x.iid), [c.iid]);
    }
    const killer = info.by && s.cards[info.by];
    if (killer?.zone === 'play') {
      fireOn(killer, 'banishOther', null, [c.iid]);
      if (killer.atLocation && s.cards[killer.atLocation]) fireOn(s.cards[killer.atLocation], 'banishOtherHere', null, [c.iid]);
      for (const x of rt.inPlay(s, killer.owner)) fireOn(x, 'banishOtherAny', (o) => rt.matches(s, o.filter, killer, x.owner, x.iid), [c.iid]);
    }
  },
};
export class BanishOtherHere extends Trigger {
  static ev = 'banishOtherHere';
  static say() { return 'a character here banishes another in a challenge'; }
}
