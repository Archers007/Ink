// Engine-internal steps queued behind triggers so the bag resolves first.
import { Effect } from './Effect.js';

// challenge damage happens after the challenge triggers resolve (CR 4.6.5–4.6.6)
export class ChallengeDamage extends Effect {
  static fn = '_challengeDamage';
  static run(rt, s, job, st, ev) { rt.E.challengeDamageStep(s, st.a, st.t, ev); return true; }
}
// the rest of a turn phase, after the triggers its step added resolve (CR 3.2.2.3, 3.4.1 — game/rulebook/turn.js)
export class TurnStep extends Effect {
  static fn = '_turnStep';
  static run(rt, s, job, st, ev) { rt.E.turnPhase(s, st.seat, ev, st.phase, st.at); return true; }
}
