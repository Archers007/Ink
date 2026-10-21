// The top of your own deck: ink it · mill it · shuffle
import { Effect } from './Effect.js';
import { N, NUM, plural } from '../phrases/text.js';

export class InkTop extends Effect {
  static fn = 'inkTop';
  static rules = [[/^put the top card of your deck into your inkwell facedown( and exerted)?$/i, (m) => ({ fn: 'inkTop', exerted: !!m[1] })]];
  static run(rt, s, job, st, ev) {
    const p = rt.E.P(s, job.seat);
    if (!p.deck.length) return false;
    rt.E.moveTo(s, p.deck[0], 'inkwell', ev, { exerted: !!st.exerted });
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} put the top card of their deck into their inkwell.`, { seat: job.seat, kind: 'effect' });
    return true;
  }
  static verb() { return 'put the top card of your deck into your inkwell'; }
  static say(st) { return `put the top card of your deck into your inkwell${st.exerted ? ' exerted' : ''}`; }
}
export class Mill extends Effect {
  static fn = 'mill';
  static rules = [[new RegExp(String.raw`^put the top (?:${NUM} )?cards? of your deck into your discard$`, 'i'), (m) => ({ fn: 'mill', n: N(m[1] || '1') })]];
  static run(rt, s, job, st, ev) {
    const p = rt.E.P(s, job.seat); const names = [];
    for (let k = 0; k < st.n && p.deck.length; k++) { names.push(rt.E.cardLabel(rt.E.D(s, s.cards[p.deck[0]]))); rt.E.moveTo(s, p.deck[0], 'discard', ev); }
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} put ${names.join(', ') || 'nothing'} from the top of their deck into their discard.`, { seat: job.seat, kind: 'effect' });
    return names.length > 0;
  }
  static verb(rt, s, job, st) { return `put the top ${plural(st.n, 'card')} of your deck into your discard`; }
  static say(st) { return `put the top ${plural(st.n, 'card')} of your deck into your discard`; }
}
export class Shuffle extends Effect {
  static fn = 'shuffle';
  static rules = [[/^shuffle your deck$/i, () => ({ fn: 'shuffle' })]];
  static run(rt, s, job, st, ev) { rt.E.shuffleArr(s, rt.E.P(s, job.seat).deck); ev.push({ k: 'shuffle', seat: job.seat }); return true; }
  static say() { return 'shuffle your deck'; }
}
