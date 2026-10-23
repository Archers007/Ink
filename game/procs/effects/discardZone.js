// Cards out of your discard / hand: "return a character card from your discard to your hand" · "play a song for free"
import { Effect } from './Effect.js';
import { Query } from '../query.js';

export class FromDiscard extends Effect {
  static fn = 'fromDiscard';
  static chooses() { return true; }
  static rules = [[/^return (a|an|up to \d+) (.+?) from your discard (?:to|into) your hand$/i, (m, P) => {
    const F = P.filter(m[2]); F.zone = 'discard'; F.owner = 'you';
    const up = /^up to/.test(m[1]);
    return { fn: 'fromDiscard', filter: F, n: up ? +m[1].split(' ')[2] : 1, upTo: up || undefined };
  }]];
  static run(rt, s, job, st, ev) {
    const valid = rt.E.P(s, job.seat).discard.filter((iid) => rt.matches(s, st.filter, s.cards[iid], job.seat, job.src));
    if (!valid.length) { rt.log(s, `↳ ${job.label}: no ${Query.describe(st.filter)} in the discard.`, { kind: 'effect' }); return false; }
    const picked = rt.pickFrom(s, job, st, 'fromDiscard', valid, { n: st.n, optional: !!st.may || !!st.upTo, prompt: `return ${Query.describe(st.filter)} from your discard to your hand.` });
    if (!picked) return null;
    job.ctx.it = picked;
    return rt.each(picked, (iid) => { rt.E.moveTo(s, iid, 'hand', ev, { reveal: true }); rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} returned ${rt.E.cardLabel(rt.E.D(s, s.cards[iid]))} from their discard to their hand.`, { seat: job.seat, kind: 'effect' }); });
  }
  static verb(rt, s, job, st) { return `return ${Query.describe(st.filter)} from your discard`; }
  static say(st) { return `return ${st.upTo ? 'up to ' : ''}${st.n || 1} ${Query.describe(st.filter)} from your discard to your hand`; }
}
export class PlayFree extends Effect {
  static fn = 'playFree';
  static chooses(st) { return !st?.each; }                // "play those characters" plays them all: a yes/no first
  static rules = [
    [/^play (?:a|an) (.+?) (?:from your (hand|discard) )?for free$/i, (m, P) => {
      const F = P.filter(m[1]); F.zone = m[2] || 'hand'; F.owner = 'you';
      return { fn: 'playFree', filter: F };
    }],
    // "you may play those characters from your discard for free" — the ones that were under this card
    [/^play those (characters|items|cards) from your discard for free$/i, (m) => ({ fn: 'playFree', filter: { ...(m[1] === 'cards' ? {} : { types: [m[1].slice(0, -1)] }), zone: 'discard', owner: 'you' }, fromUnder: true, each: true })],
    // any zone phrase the filter reads ("a location from your hand or discard with cost 4 or less") · ", exerted"
    [/^play (?:a|an) (.+?) for free(,? exerted| and (?:it|they) enters? play exerted)?$/i, (m, P) => {
      const F = { owner: 'you', ...P.filter(m[1]) };
      if (!F.zone && !F.any?.some((G) => G.zone)) F.zone = 'hand';
      return { fn: 'playFree', filter: F, ...(m[2] ? { exerted: true } : {}) };
    }],
  ];
  static run(rt, s, job, st, ev) {
    let valid = rt.candidates(s, st.filter, job.seat, job.src, job.ctx.it)   // "with the same cost or less" reads the card before
      .filter((iid) => !rt.playBlocked(s, job.seat, s.cards[iid]));           // not one its own "can't play unless" forbids
    if (st.fromUnder) valid = valid.filter((iid) => (s.cards[job.src]?.lastUnder || []).includes(iid));
    if (st.each && valid.length) {                                     // all of them, in the order the player likes
      job.ctx.it = valid;
      return rt.each(valid, (iid) => rt.E.playFree(s, job.seat, iid, ev, { exerted: !!st.exerted }));
    }
    if (!valid.length) { rt.log(s, `↳ ${job.label}: nothing to play for free.`, { kind: 'effect' }); return false; }
    const picked = rt.pickFrom(s, job, st, 'playFree', valid, { n: 1, optional: !!st.may, prompt: `play ${Query.describe(st.filter)} for free.` });
    if (!picked) return null;
    job.ctx.it = picked;
    return rt.each(picked, (iid) => rt.E.playFree(s, job.seat, iid, ev, { exerted: !!st.exerted, after: st.after }));
  }
  static verb(rt, s, job, st) { return `play ${Query.describe(st.filter)} for free`; }
  static say(st) { return `play ${Query.describe(st.filter)} for free${st.after === 'deckBottom' ? ', then put it on the bottom of your deck' : ''}`; }
}
