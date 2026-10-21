// "whenever this character sings a song" · "… sings a song with Sing Together" · "whenever one of your X sings a song"
//
// The song is a Query (`song`), so "with Sing Together" is just a classifier on it. Per CR 8.12.3 every
// character singing with Sing Together "sings the song", so the engine raises `sings` once per singer.
import { Trigger, other, SUBJECT } from './Trigger.js';
import { Query } from '../query.js';

const songQuery = (F) => (F.with || F.owner || F.other ? { song: F } : {});
export class Sings extends Trigger {
  static selfSubject = true;
  static ev = 'sings';
  static rules = [[new RegExp(String.raw`^whenever ${SUBJECT} sings (?:a|an) (.+)$`, 'i'), (m, P) => [{ ev: 'sings', ...songQuery(P.filter(m[1])) }]]];
  static say(o) { return `this character sings ${o.song ? Query.describe(o.song) : 'a song'}`; }
}
export class SingsAny extends Trigger {
  static ev = 'singsAny';
  static rules = [[/^whenever one of your (other )?(.+?) sings (?:a|an) (song.*)$/i, (m, P) => [{ ev: 'singsAny', filter: other(P.filter(m[2]), m[1]), ...songQuery(P.filter(m[3])) }]]];
  static say(o) { return `your ${Query.describe(o.filter)} sings ${o.song ? Query.describe(o.song) : 'a song'}`; }
}

export const events = {
  // info: { iid: the singer, song: the song card }
  sings(rt, s, info, fireOn) {
    const c = s.cards[info.iid];
    const song = s.cards[info.song];
    const songOk = (o) => !o.song || rt.matches(s, o.song, song, c.owner, c.iid, { anyZone: true });
    fireOn(c, 'sings', songOk, [info.song]);
    for (const x of rt.inPlay(s, c.owner)) fireOn(x, 'singsAny', (o) => songOk(o) && rt.matches(s, o.filter, c, x.owner, x.iid), [c.iid]);
  },
};
