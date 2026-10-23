// "opponents can't play actions [or items] [with cost 4 or more] [until the start of your next turn]"
//   as an effect: a ban on the player that lasts its duration · as a static: on while the source is in play
import { Effect } from './Effect.js';
import { Query } from '../query.js';

const KINDS = String.raw`(actions|items|characters|songs|locations|cards)(?:,? or (actions|items|characters|songs|locations))?`;
export class PlayBan extends Effect {
  static fn = 'playBan';
  static rules = [[new RegExp(String.raw`^(opponents|your opponents|you) can't play ${KINDS}(.*)$`, 'i'), (m, P) => {
    const types = [m[2], m[3]].filter(Boolean).map((x) => x.toLowerCase().replace(/s$/, ''));
    const F = P.filter(`${types.join(' or ')}${m[4] || ''}`);
    const st = { fn: 'playBan', who: /you$/i.test(m[1]) ? 'you' : 'opp', filter: { ...F, zone: 'hand' } };
    return P.D(st);
  }]];
  static run(rt, s, job, st) {
    const seats = st.who === 'you' ? [job.seat] : rt.E.opponentsOf(s, job.seat);
    for (const seat of seats) (s.playBans ||= []).push({ seat, by: job.seat, src: job.src, filter: st.filter, dur: st.dur || 'turn', turn: s.turn });
    rt.log(s, `↳ ${st.who === 'you' ? 'You' : 'Opponents'} can't play ${Query.describe(st.filter)}s ${st.dur === 'next' ? 'until the start of their next turn' : 'this turn'}.`, { kind: 'effect' });
    return true;
  }
  // is the ban still on? 'turn' = this turn · 'next' = until the start of its controller's next turn
  static live(s, b) { return b.dur === 'turn' ? s.turn === b.turn : !(s.active === b.by && s.turn > b.turn); }
  static say(st) {
    const { zone, ...F } = st.filter;
    return `${st.who === 'you' ? 'you' : 'opponents'} can't play ${Query.describe(F)}${st.dur === 'next' ? ' until the start of your next turn' : st.dur === 'turn' ? ' this turn' : ''}`;
  }
}
// static-only: what this character counts as when another card shifts onto it (public/js/play/rules.js reads it)
//   { names: ['Syndrome'] }  "also counts as being named Syndrome for Shift"
//   { anyName: true }        "play any character with Shift on this character as if this character had any name"
//   { any: true }            "you can shift any character on top of this character" (every Shift variant)
export class ShiftAs extends Effect {
  static fn = 'shiftAs';
  static staticOnly = true;
  static say(st) {
    return st.any ? 'any character can shift onto this character' : st.anyName ? 'characters with Shift can shift onto this character whatever its name'
      : `this character also counts as being named ${st.names.join(' and ')} for Shift`;
  }
}
// static-only: "You can't play this character unless …" (the static's cond is the not-unless)
export class SelfBan extends Effect {
  static fn = 'selfBan';
  static staticOnly = true;
  static say() { return "you can't play this card"; }
}
// static-only: "This character may enter play exerted [to X]." — like Bodyguard (CR 8.3.2), the player decides as they
// play it (Merida - Wisp Conjurer ruling); the "to X" part is a play trigger that needs it to have entered exerted
export class EnterExertedOpt extends Effect {
  static fn = 'enterExertedOpt';
  static staticOnly = true;
  static say() { return 'this card may enter play exerted'; }
}
