// Inkwell and location events, plus heads we understand but the engine doesn't raise yet (runs = false).
import { Trigger } from './Trigger.js';

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
  static ev = 'moves';
  static runs = false;
  static rules = [[/^whenever this character moves to a location$/i, () => [{ ev: 'moves' }]]];
  static say() { return 'this character moves to a location'; }
}
export class Readied extends Trigger {
  static ev = 'ready';
  static runs = false;
  static rules = [[/^whenever you ready this character$/i, () => [{ ev: 'ready' }]]];
  static say() { return 'you ready this character'; }
}
export class PutUnder extends Trigger {
  static ev = 'putUnder';
  static runs = false;
  static rules = [[/^whenever you put a card under this character$/i, () => [{ ev: 'putUnder' }]]];
  static say() { return 'you put a card under this'; }
}
export class DealtDamage extends Trigger {
  static ev = 'dealtDamage';
  static runs = false;
  static rules = [[/^whenever this character is dealt damage$/i, () => [{ ev: 'dealtDamage' }]]];
  static say() { return 'this character is dealt damage'; }
}

export const events = {
  inked(rt, s, info, fireOn) { for (const c of rt.inPlay(s, info.seat)) fireOn(c, 'inked'); },
  moveHere(rt, s, info, fireOn) { if (info.at && s.cards[info.at]) fireOn(s.cards[info.at], 'moveHere', null, [info.iid]); },
};
