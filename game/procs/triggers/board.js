// Inkwell and location events, plus heads we understand but the engine doesn't raise yet (runs = false).
import { Trigger } from './Trigger.js';
import { Query } from '../query.js';

export class Inked extends Trigger {
  static ev = 'inked';
  static rules = [[/^whenever (?:a card is put|you put a card) into your inkwell$/i, () => [{ ev: 'inked' }]]];
  static say() { return 'you put a card into your inkwell'; }
}
export class MoveHere extends Trigger {
  static ev = 'moveHere';
  static rules = [[/^whenever (?:you move a character here|a character moves here)$/i, () => [{ ev: 'moveHere' }]]];
  static say() { return 'a character moves here'; }
}
export class Moves extends Trigger {
  static selfSubject = true;
  static ev = 'moves';
  static rules = [[/^when(?:ever)? (?:this character|he|she|they) moves? to a location$/i, () => [{ ev: 'moves' }]]];
  static say() { return 'this character moves to a location'; }
}
export class Readied extends Trigger {
  static selfSubject = true;
  static ev = 'ready';
  static rules = [[/^whenever you ready this character$/i, () => [{ ev: 'ready' }]]];
  static say() { return 'you ready this character'; }
}
export class PutUnder extends Trigger {
  static selfSubject = true;
  static ev = 'putUnder';
  static rules = [[/^whenever you put a card under this (?:character|location)$/i, () => [{ ev: 'putUnder' }]]];
  static say() { return 'you put a card under this'; }
}
export class PutUnderAny extends Trigger {
  static ev = 'putUnderAny';
  static rules = [[/^whenever you put a card under one of your (other )?(.+)$/i, (m, P) => [{ ev: 'putUnderAny', filter: { ...P.filter(m[2]), ...(m[1] ? { other: true } : {}) } }]]];
  static say(o) { return `you put a card under your ${Query.describe(o.filter)}`; }
}
export class Draws extends Trigger {
  static ev = 'draw';
  static rules = [[/^whenever you draw a card$/i, () => [{ ev: 'draw' }]]];
  static say() { return 'you draw a card'; }
}
export class Healed extends Trigger {
  static ev = 'healed';
  static rules = [[/^whenever you remove (?:1 or more )?damage from (?:one of your|a) (.+)$/i, (m, P) => [{ ev: 'healed', filter: P.filter(m[1]) }]]];
  static say(o) { return `you remove damage from your ${Query.describe(o.filter)}`; }
}
export class DamagedAny extends Trigger {
  static ev = 'damagedAny';
  static rules = [
    [/^whenever (?:a|an|one of your) (.+?) is (?:damaged|dealt damage)$/i, (m, P) => { const F = P.filter(m[1]); if (/one of your/i.test(m[0])) F.owner = 'you'; return [{ ev: 'damagedAny', filter: F }]; }],
  ];
  static say(o) { return `${Query.describe(o.filter)} is dealt damage`; }
}
export class DealtDamage extends Trigger {
  static selfSubject = true;
  static ev = 'dealtDamage';
  static rules = [[/^whenever (?:this character|he|she|they) (?:is|are) dealt damage$/i, () => [{ ev: 'dealtDamage' }]]];
  static say() { return 'this character is dealt damage'; }
}

export const events = {
  inked(rt, s, info, fireOn) { for (const c of rt.inPlay(s, info.seat)) fireOn(c, 'inked'); },
  ready(rt, s, info, fireOn) { fireOn(s.cards[info.iid], 'ready'); },
  moves(rt, s, info, fireOn) { fireOn(s.cards[info.iid], 'moves', null, [info.at]); },
  putUnder(rt, s, info, fireOn) {
    const c = s.cards[info.iid];
    fireOn(c, 'putUnder');
    for (const x of rt.inPlay(s, info.seat)) fireOn(x, 'putUnderAny', (o) => rt.matches(s, { owner: 'you', ...o.filter }, c, x.owner, x.iid), [c.iid]);
  },
  draw(rt, s, info, fireOn) { for (const x of rt.inPlay(s, info.seat)) fireOn(x, 'draw'); },
  healed(rt, s, info, fireOn) {
    const c = s.cards[info.iid];
    for (const x of rt.inPlay(s, info.seat)) fireOn(x, 'healed', (o) => rt.matches(s, { owner: 'you', ...o.filter }, c, x.owner, x.iid), [c.iid]);
  },
  damaged(rt, s, info, fireOn) {
    const c = s.cards[info.iid];
    fireOn(c, 'dealtDamage', null, [info.by].filter(Boolean));
    for (const pl of s.players) for (const x of rt.inPlay(s, pl.seat)) fireOn(x, 'damagedAny', (o) => rt.matches(s, o.filter, c, x.owner, x.iid), [c.iid]);
  },
  moveHere(rt, s, info, fireOn) { if (info.at && s.cards[info.at]) fireOn(s.cards[info.at], 'moveHere', null, [info.iid]); },
};
