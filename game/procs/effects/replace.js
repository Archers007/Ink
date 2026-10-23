// Replacement effects (CR 6.5) — game/rulebook/replace.js holds the phrases, the events and how they resolve.
//   replace        static: "If this character would be banished, put them into your inkwell facedown and exerted instead"
//   grantReplace   a one-shot on a card: "until the start of your next turn, the next time they would be dealt damage
//                  they take no damage instead"
import { Effect } from './Effect.js';
import { Selector } from '../phrases/selector.js';
import { Duration } from '../phrases/duration.js';
import { GRANT_RX, replaceSay } from '../../rulebook/replace.js';

export class ReplaceFx extends Effect {
  static fn = 'replace';
  static staticOnly = true;
  static say(st) { return replaceSay(st); }
}
export class GrantReplace extends Effect {
  static fn = 'grantReplace';
  static rules = [[GRANT_RX, (m, P) => ({ fn: 'grantReplace', sel: P.sel(/^(?:she|he|it|they)$/i.test(m[1]) ? 'them' : m[1]), rep: { event: 'damage', who: 'self', do: 'prevent', once: true }, ...(P.dur ? { dur: P.dur } : {}) })]];
  static run(rt, s, job, st, ev) {
    const ids = rt.targets(s, job, st, st.sel);
    if (!ids) return null;
    return rt.each(ids, (iid) => { rt.addMods(s, job, st, iid, ev); rt.log(s, `↳ ${rt.tl(s, iid)}: ${replaceSay(st.rep)}.`, { seat: job.seat, kind: 'effect' }); });
  }
  static say(st) { return `${Selector.say(st.sel)}: ${replaceSay(st.rep)}${st.dur ? ` ${Duration.say(st.dur)}` : ''}`; }
}
