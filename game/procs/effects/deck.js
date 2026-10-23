// The top of your own deck: ink it · mill it · shuffle
import { Effect } from './Effect.js';
import { N, NUM, plural } from '../phrases/text.js';
import { Query } from '../query.js';

export class InkTop extends Effect {
  static fn = 'inkTop';
  static rules = [[/^put the top (card|\d+ cards) of your deck into your inkwell facedown( and exerted)?$/i, (m) => ({ fn: 'inkTop', exerted: !!m[2], ...(m[1] === 'card' ? {} : { n: parseInt(m[1], 10) }) })]];
  static run(rt, s, job, st, ev) {
    const p = rt.E.P(s, job.seat);
    if (!p.deck.length) return false;
    const n = Math.min(st.n || 1, p.deck.length);
    for (let k = 0; k < n; k++) rt.E.moveTo(s, p.deck[0], 'inkwell', ev, { exerted: !!st.exerted });
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} put the top ${plural(n, 'card')} of their deck into their inkwell.`, { seat: job.seat, kind: 'effect' });
    return true;
  }
  static verb(rt, s, job, st) { return `put the top ${plural(st.n || 1, 'card')} of your deck into your inkwell`; }
  static say(st) { return `put the top ${plural(st.n || 1, 'card')} of your deck into your inkwell${st.exerted ? ' exerted' : ''}`; }
}
export class Mill extends Effect {
  static fn = 'mill';
  static rules = [[new RegExp(String.raw`^put the top (?:${NUM} )?cards? of your deck into your discard$`, 'i'), (m) => ({ fn: 'mill', n: N(m[1] || '1') })]];
  static run(rt, s, job, st, ev) {
    const p = rt.E.P(s, job.seat); const names = [];
    for (let k = 0; k < st.n && p.deck.length; k++) { names.push(rt.E.cardLabel(rt.E.D(s, s.cards[p.deck[0]]))); rt.E.moveTo(s, p.deck[0], 'discard', ev); }
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} put ${names.join(', ') || 'nothing'} from the top of their deck into their discard.`, { seat: job.seat, kind: 'effect' });
    if (names.length) rt.fire(s, 'milled', { seat: job.seat });
    return names.length > 0;
  }
  static verb(rt, s, job, st) { return `put the top ${plural(st.n, 'card')} of your deck into your discard`; }
  static say(st) { return `put the top ${plural(st.n, 'card')} of your deck into your discard`; }
}
export class Shuffle extends Effect {
  static fn = 'shuffle';
  static rules = [[/^shuffle (?:your deck|the rest into your deck)$/i, () => ({ fn: 'shuffle' })]];   // the rest were only revealed
  static run(rt, s, job, st, ev) { rt.E.shuffleArr(s, rt.E.P(s, job.seat).deck); ev.push({ k: 'shuffle', seat: job.seat }); return true; }
  static say() { return 'shuffle your deck'; }
}

// "search your deck for a Madrigal character card [and reveal that card to all players][, and put it into your hand]"
export class Search extends Effect {
  static fn = 'search';
  static rules = [[/^search your deck for (.+?)(?:,? and reveal (?:it|that card) to all players|, reveal (?:it|that card)(?: to all players)?)?(?:,? (?:and )?put (?:it|that card) (?:in|into) your hand)?$/i, (m, P) => ({
    fn: 'search', filter: P.filter(m[1]), reveal: /reveal/i.test(m[0]), ...(/put (?:it|that card) (?:in|into) your hand$/i.test(m[0]) ? { to: 'hand' } : {}),
  })]];
  static chooses() { return true; }
  static run(rt, s, job, st, ev) {
    const { E } = rt;
    const p = E.P(s, job.seat);
    const valid = p.deck.filter((iid) => rt.matches(s, { ...st.filter, zone: 'deck' }, s.cards[iid], job.seat, job.src));
    const got = rt.pickFrom(s, job, st, 'search', valid, { n: 1, optional: true, prompt: `search your deck — choose ${Query.describe(st.filter)}.` });
    if (!got) return null;
    if (!got.length) { rt.log(s, `↳ ${E.nameOf(s, job.seat)} searched their deck and found nothing.`, { seat: job.seat, kind: 'effect' }); return false; }
    const iid = got[0];
    job.ctx.it = [iid];
    const name = E.cardLabel(E.D(s, s.cards[iid]));
    if (st.reveal) ev.push({ k: 'reveal', seat: job.seat, iid, cardId: s.cards[iid].cardId });
    if (st.to === 'hand') E.moveTo(s, iid, 'hand', ev, { reveal: !!st.reveal });
    rt.log(s, `↳ ${E.nameOf(s, job.seat)} searched their deck${st.reveal ? ` and revealed ${name}` : ''}${st.to === 'hand' ? `${st.reveal ? ',' : ''} putting ${st.reveal ? 'it' : 'a card'} into their hand` : ''}.`, { seat: job.seat, kind: 'effect', priv: { seat: job.seat, text: `↳ You found ${name}.` } });
    return true;
  }
  static verb(rt, s, job, st) { return `search your deck for ${Query.describe(st.filter)}`; }
  static say(st) { return `search your deck for ${Query.describe(st.filter)}${st.reveal ? ' (revealed)' : ''}${st.to === 'hand' ? ' → hand' : ''}`; }
}
