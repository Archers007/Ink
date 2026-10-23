// Inkwell and location events, plus heads we understand but the engine doesn't raise yet (runs = false).
import { Trigger } from './Trigger.js';
import { Query } from '../query.js';

export class Inked extends Trigger {
  static ev = 'inked';
  static rules = [[/^when(?:ever)? (?:a card is put|you put a card) into your inkwell$/i, () => [{ ev: 'inked' }]]];
  static say() { return 'you put a card into your inkwell'; }
}
export class MoveHere extends Trigger {
  static ev = 'moveHere';
  static rules = [
    [/^whenever (?:you move a character here|a character moves here)$/i, () => [{ ev: 'moveHere' }]],
    [/^whenever you move an? (.+) here$/i, (m, P) => [{ ev: 'moveHere', filter: P.filter(m[1]) }]],
  ];
  static say(o) { return `a ${o.filter ? Query.describe(o.filter) : 'character'} moves here`; }
}
export class Moves extends Trigger {
  static selfSubject = true;
  static ev = 'moves';
  static rules = [[/^when(?:ever)? (?:this character|he|she|they) moves? to a location$/i, () => [{ ev: 'moves' }]]];
  static say() { return 'this character moves to a location'; }
}
export class DealsDamage extends Trigger {
  static selfSubject = true;
  static ev = 'dealsDamage';
  static rules = [[/^whenever (?:this character|he|she) deals damage to another character in a challenge$/i, () => [{ ev: 'dealsDamage' }]]];
  static say() { return 'this character deals damage in a challenge'; }
}
export class SupportedAny extends Trigger {
  static ev = 'supportedAny';
  static rules = [[/^whenever one of your (.+?) is chosen for support$/i, (m, P) => [{ ev: 'supportedAny', filter: P.filter(m[1]) }]]];
  static say(o) { return `your ${Query.describe(o.filter)} is chosen for Support`; }
}
export class ShiftedOnto extends Trigger {
  static ev = 'shiftedOnto';
  static rules = [
    [/^when(?:ever)? you shift a character on(?: top of)? (?:this (?:character|card)|her|him|them|it)$/i, () => [{ ev: 'shiftedOnto' }]],
    [/^when(?:ever)? you play an? (.+?) on (?:top of )?this (?:character|card)$/i, (m, P) => [{ ev: 'shiftedOnto', filter: P.filter(m[1]) }]],
  ];
  static say(o) { return `you shift ${o.filter ? Query.describe(o.filter) : 'a character'} onto this`; }
}
export class ChosenByOpp extends Trigger {
  static selfSubject = true;
  static ev = 'chosenByOpp';
  static rules = [[/^whenever an opponent chooses this (?:character|item|location) for an action or ability$/i, () => [{ ev: 'chosenByOpp' }]]];
  static say() { return "an opponent's action or ability chooses this"; }
}
export class InkDropUsed extends Trigger {
  static ev = 'inkDropUsed';
  static rules = [[/^whenever you remove an ink drop$/i, () => [{ ev: 'inkDropUsed' }]]];
  static say() { return 'you remove an ink drop'; }
}
export class LeavesDiscard extends Trigger {
  static ev = 'leavesDiscard';
  static rules = [[/^whenever a card leaves your discard$/i, () => [{ ev: 'leavesDiscard' }]]];
  static say() { return 'a card leaves your discard'; }
}
export class DiscardSelf extends Trigger {
  static ev = 'discardSelf';
  static rules = [[/^when(?:ever)? you discard this card$/i, () => [{ ev: 'discardSelf' }]]];
  static say() { return 'you discard this card'; }
}
export class YouDiscard extends Trigger {
  static ev = 'youDiscard';
  static rules = [[/^whenever you discard an? (.+)$/i, (m, P) => [{ ev: 'youDiscard', filter: P.filter(m[1]) }]]];
  static say(o) { return `you discard ${Query.describe(o.filter)}`; }
}
export class Exerts extends Trigger {
  static selfSubject = true;
  static ev = 'exerts';
  static rules = [[/^whenever (?:this character|he|she) (?:exerts|becomes exerted|is exerted)$/i, () => [{ ev: 'exerts' }]]];
  static say() { return 'this character becomes exerted'; }
}
export class OppExerts extends Trigger {
  static ev = 'oppExerts';
  static rules = [[/^whenever an opposing (.+?) (?:exerts|becomes exerted|is exerted)$/i, (m, P) => [{ ev: 'oppExerts', filter: P.filter(m[1]) }]]];
  static say(o) { return `an opposing ${Query.describe(o.filter)} becomes exerted`; }
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
// "Whenever you use the Boost ability of a character" — them = that character
export class Boosted extends Trigger {
  static ev = 'boostAny';
  static rules = [[/^whenever you use the boost ability of a character$/i, () => [{ ev: 'boostAny' }]]];
  static say() { return 'you use Boost'; }
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
    [/^whenever (?:a|an|one of your) (.+?) (?:is (?:damaged|dealt damage)|takes damage)$/i, (m, P) => { const F = P.filter(m[1]); if (/one of your/i.test(m[0])) F.owner = 'you'; return [{ ev: 'damagedAny', filter: F }]; }],
  ];
  static say(o) { return `${Query.describe(o.filter)} is dealt damage`; }
}
export class DealtDamage extends Trigger {
  static selfSubject = true;
  static ev = 'dealtDamage';
  static rules = [[/^whenever (?:this character|he|she|they) (?:(?:is|are) dealt damage|takes? damage)$/i, () => [{ ev: 'dealtDamage' }]]];
  static say() { return 'this character is dealt damage'; }
}

export const events = {
  inked(rt, s, info, fireOn) { for (const c of rt.inPlay(s, info.seat)) fireOn(c, 'inked'); },
  ready(rt, s, info, fireOn) { fireOn(s.cards[info.iid], 'ready'); },
  exerts(rt, s, info, fireOn) {
    const c = s.cards[info.iid];
    fireOn(c, 'exerts');
    for (const o of rt.E.opponentsOf(s, c.owner)) for (const x of rt.inPlay(s, o)) fireOn(x, 'oppExerts', (on) => rt.matches(s, on.filter, c, x.owner, x.iid), [c.iid]);
  },
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
    if (info.inChallenge && info.by && s.cards[info.by]) fireOn(s.cards[info.by], 'dealsDamage', null, [c.iid]);
    fireOn(c, 'dealtDamage', null, [info.by].filter(Boolean));
    for (const pl of s.players) for (const x of rt.inPlay(s, pl.seat)) fireOn(x, 'damagedAny', (o) => rt.matches(s, o.filter, c, x.owner, x.iid), [c.iid]);
  },
  moveHere(rt, s, info, fireOn) { if (info.at && s.cards[info.at]) fireOn(s.cards[info.at], 'moveHere', (o) => !o.filter || rt.matches(s, o.filter, s.cards[info.iid], s.cards[info.at].owner, info.at), [info.iid]); },
  supported(rt, s, info, fireOn) { const t = s.cards[info.iid]; for (const x of rt.inPlay(s, t.owner)) fireOn(x, 'supportedAny', (o) => rt.matches(s, o.filter, t, x.owner, x.iid), [t.iid]); },
  shiftedOnto(rt, s, info, fireOn) { fireOn(s.cards[info.iid], 'shiftedOnto', (o) => !o.filter || rt.matches(s, o.filter, s.cards[info.by], s.cards[info.by].owner, info.iid, { anyZone: true }), [info.by]); },
  chosenByOpp(rt, s, info, fireOn) { fireOn(s.cards[info.iid], 'chosenByOpp'); },
  boosted(rt, s, info, fireOn) { for (const x of rt.inPlay(s, info.seat)) fireOn(x, 'boostAny', null, [info.iid]); },
  inkDropUsed(rt, s, info, fireOn) { for (const x of rt.inPlay(s, info.seat)) fireOn(x, 'inkDropUsed'); },
  leavesDiscard(rt, s, info, fireOn) { for (const x of rt.inPlay(s, info.seat)) fireOn(x, 'leavesDiscard', null, [info.iid]); },
  discarded(rt, s, info, fireOn) {
    const c = s.cards[info.iid];
    fireOn(c, 'discardSelf');
    for (const x of rt.inPlay(s, c.owner)) fireOn(x, 'youDiscard', (o) => rt.matches(s, o.filter, c, x.owner, x.iid, { anyZone: true }), [c.iid]);
  },
};
