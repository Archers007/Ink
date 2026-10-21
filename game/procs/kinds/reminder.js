import { Kind } from './Kind.js';

// reminder text only ("A character with cost 3 or more can {exert} to sing this song for free.") — no rules
export class Reminder extends Kind {
  static kind = 'reminder';
  static explain() { return ['reminder text — no rules']; }
}
// the compiler couldn't read it — players resolve it by hand
export class Unparsed extends Kind {
  static kind = 'unparsed';
  static explain(p) { return ['✋ manual — not compiled', `why: ${p.why}`]; }
}
