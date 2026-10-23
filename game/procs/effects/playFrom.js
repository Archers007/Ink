// Playing cards from a zone other than the hand (CR 4.3), as a permission:
//   playFrom        static: "While this character is exerted, you may play characters from your discard. If you do,
//                   they enter play exerted."
//   grantPlayFrom   for a duration: "For the rest of this turn, you may play characters from your discard. If you do,
//                   they enter play exerted and you can't play characters with the same name as characters you played
//                   this way this turn." · "This turn, you may play characters from under this item."
//   { zone: 'discard' | 'under', filter, exerted?, sameNameBan? }   — H.play asks Runtime.playFromPerm()
import { Effect } from './Effect.js';
import { Query } from '../query.js';

export const PLAY_FROM = /^(?:you may )?play (characters|items|actions|songs|locations|cards) from (your discard|under this (?:item|character|location))$/i;
const TYPE = { characters: 'character', items: 'item', actions: 'action', songs: 'song', locations: 'location' };
export const playFromOf = (m) => ({ zone: /discard/i.test(m[2]) ? 'discard' : 'under', filter: TYPE[m[1].toLowerCase()] ? { types: [TYPE[m[1].toLowerCase()]] } : {} });
export const PLAY_FROM_TAIL = /^if you do, they enter play exerted( and you can't play characters with the same name as characters you played this way this turn)?$/i;
const say = (st) => `you may play ${Query.describe(st.filter) || 'cards'} from ${st.zone === 'under' ? 'under this card' : 'your discard'}${st.exerted ? ' (they enter play exerted)' : ''}${st.sameNameBan ? ", then can't play others with their names this turn" : ''}`;

export class PlayFrom extends Effect {
  static fn = 'playFrom';
  static staticOnly = true;
  static say(st) { return say(st); }
}
export class GrantPlayFrom extends Effect {
  static fn = 'grantPlayFrom';
  static rules = [[PLAY_FROM, (m, P) => ({ fn: 'grantPlayFrom', ...playFromOf(m), dur: P.dur || 'turn' })]];
  static run(rt, s, job, st) {
    (rt.E.P(s, job.seat).playFrom ||= []).push({ zone: st.zone, filter: st.filter, exerted: !!st.exerted, sameNameBan: !!st.sameNameBan, src: job.src, turn: s.turn });
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)}: ${say(st)} this turn.`, { seat: job.seat, kind: 'effect' });
    return true;
  }
  static say(st) { return `this turn, ${say(st)}`; }
}
