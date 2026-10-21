import { Trigger, other, SUBJECT } from './Trigger.js';
import { Query } from '../query.js';

export class Challenges extends Trigger {
  static selfSubject = true;
  static ev = 'challenges';
  static rules = [
    [new RegExp(String.raw`^whenever ${SUBJECT} challenges(?: another character| a character)?$`, 'i'), () => [{ ev: 'challenges' }]],
    [new RegExp(String.raw`^whenever ${SUBJECT} challenges (?:a|an|another) (.+)$`, 'i'), (m, P) => [{ ev: 'challenges', filter: P.filter(m[1]) }]],
  ];
  static say(o) { return `this character challenges${o.filter ? ` ${Query.describe(o.filter)}` : ''}`; }
}
export class Challenged extends Trigger {
  static selfSubject = true;
  static ev = 'challenged';
  static rules = [
    [/^whenever (?:this (?:character|location)|he|she|they) (?:is|are) challenged$/i, () => [{ ev: 'challenged' }]],
    [/^whenever a character is challenged while here$/i, () => [{ ev: 'challengedHere' }]],
  ];
  static say() { return 'this is challenged'; }
}
export class ChallengesAny extends Trigger {
  static ev = 'challengesAny';
  static rules = [[/^whenever one of your (other )?(.+?) challenges(?: (?:another|a) character)?$/i, (m, P) => [{ ev: 'challengesAny', filter: other(P.filter(m[2]), m[1]) }]]];
  static say(o) { return `your ${Query.describe(o.filter)} challenges`; }
}

export const events = {
  challenges(rt, s, info, fireOn) {
    const c = s.cards[info.iid];
    const def = s.cards[info.other];
    fireOn(c, 'challenges', (o) => !o.filter || rt.matches(s, o.filter, def, c.owner, c.iid), [info.other]);
    for (const x of rt.inPlay(s, c.owner)) fireOn(x, 'challengesAny', (o) => rt.matches(s, o.filter, c, x.owner, x.iid), [c.iid]);
  },
  challenged(rt, s, info, fireOn) {
    const c = s.cards[info.iid];
    fireOn(c, 'challenged', null, [info.other]);
    if (c.atLocation && s.cards[c.atLocation]) fireOn(s.cards[c.atLocation], 'challengedHere', null, [c.iid]);
  },
};
export class ChallengedHere extends Trigger {
  static ev = 'challengedHere';
  static say() { return 'a character here is challenged'; }
}
