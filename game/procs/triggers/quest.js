import { Trigger, other } from './Trigger.js';
import { Query } from '../query.js';

export class Quest extends Trigger {
  static selfSubject = true;
  static ev = 'quest';
  static rules = [
    [/^whenever (?:this character|he|she|they) quests?$/i, () => [{ ev: 'quest' }]],
    [/^whenever (?:this character|he|she|they) quests while at a location$/i, () => [{ ev: 'quest', whileCond: { self: [{ atLocation: true }] } }]],
  ];
  static say() { return 'this character quests'; }
}
export class QuestAny extends Trigger {
  static ev = 'questAny';
  static rules = [
    [/^whenever one of your (other )?(.+?) quests?$/i, (m, P) => [{ ev: 'questAny', filter: other(P.filter(m[2]), m[1]) }]],
    [/^whenever an? (other )?(.+?) of yours( .+?)? quests?$/i, (m, P) => [{ ev: 'questAny', filter: other(P.filter(`your ${m[2]}${m[3] || ''}`), m[1]) }]],
  ];
  static say(o) { return `your ${Query.describe(o.filter)} quests`; }
}
export class QuestHere extends Trigger {
  static ev = 'questHere';
  static rules = [
    [/^whenever a character quests while here$/i, () => [{ ev: 'questHere' }]],
    [/^whenever an? (.+?) quests while here$/i, (m, P) => [{ ev: 'questHere', filter: P.filter(m[1]) }]],
  ];
  static say(o) { return `a ${o.filter ? Query.describe(o.filter) : 'character'} quests here`; }
}

export const events = {
  quest(rt, s, info, fireOn) {
    const c = s.cards[info.iid];
    fireOn(c, 'quest');
    for (const x of rt.inPlay(s, c.owner)) fireOn(x, 'questAny', (o) => rt.matches(s, o.filter, c, x.owner, x.iid), [c.iid]);
    if (c.atLocation && s.cards[c.atLocation]) fireOn(s.cards[c.atLocation], 'questHere', (o) => !o.filter || rt.matches(s, o.filter, c, c.owner, c.atLocation), [c.iid]);
  },
};
