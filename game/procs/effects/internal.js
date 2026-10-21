// Engine-internal steps queued behind triggers so the bag resolves first.
import { Effect } from './Effect.js';

// challenge damage happens after the challenge triggers resolve (CR 4.6.5–4.6.6)
export class ChallengeDamage extends Effect {
  static fn = '_challengeDamage';
  static run(rt, s, job, st, ev) { rt.E.challengeDamageStep(s, st.a, st.t, ev); return true; }
}
// the turn passes after "at the end of your turn" triggers resolve
export class EndTurn extends Effect {
  static fn = '_endTurn';
  static run(rt, s, job, st, ev) { rt.E.finishEndTurn(s, st.seat, ev); return true; }
}
