// Cards out of your discard / hand: "return a character card from your discard to your hand" · "play a song for free"
import { Effect } from './Effect.js';
import { Query } from '../query.js';
import { freeShifts } from './extra.js';

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
    // "play or shift a Robot character … for free" — a free play may use Shift anyway (run below), so it's the same play
    [/^play or shift (?:a|an) (.+?) for free$/i, (m, P) => ({ fn: 'playFree', filter: { ...P.filter(m[1]), zone: 'hand', owner: 'you' }, orShift: true })],
    [/^play (?:a|an) (.+?) (?:from (?:your (hand|discard)|(there)) )?for free$/i, (m, P) => {
      const F = P.filter(m[1]); F.zone = m[2] || m[3] || 'hand'; F.owner = 'you';   // "from there": the zone the step before looked at
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
    // "play a character for free" from the hand — or from where an ability lets you play it (Remember Me + Just in Time ruling)
    if (st.filter.zone === 'hand' && !st.fromUnder && !job.tmp.playFree) {
      const P = rt.E.P(s, job.seat);
      for (const iid of [...P.discard, ...P.play.flatMap((x) => s.cards[x].under || [])]) {
        const c = s.cards[iid];
        if (!valid.includes(iid) && rt.playFromPerm(s, job.seat, c) && rt.matches(s, { ...st.filter, zone: c.zone }, c, job.seat, job.src, { anyZone: true }) && !rt.playBlocked(s, job.seat, c)) valid.push(iid);
      }
    }
    if (st.each && valid.length) {                                     // all of them, in the order the player likes
      job.ctx.it = valid;
      return rt.each(valid, (iid) => rt.E.playFree(s, job.seat, iid, ev, { exerted: !!st.exerted }));
    }
    if (!valid.length) { rt.log(s, `↳ ${job.label}: nothing to play for free.`, { kind: 'effect' }); return false; }
    const picked = rt.pickFrom(s, job, st, 'playFree', valid, { n: 1, optional: !!st.may, prompt: `play ${Query.describe(st.filter)} for free.` });
    if (!picked) return null;
    job.ctx.it = picked;
    const [iid] = picked;
    if (!iid) return false;
    const c = s.cards[iid]; const d = rt.E.D(s, c);
    const viaPlay = (a) => { try { rt.E.playCard(s, job.seat, { iid, free: true, exertedFx: !!st.exerted, ...a }, ev); return true; } catch (e) { rt.log(s, `↳ ${e.message}`, { kind: 'effect' }); return false; } };
    if (c.zone !== 'hand' && st.filter.zone === 'hand') return viaPlay({ mode: 'free' });   // a permission's card: it says how it enters (exerted, same-name ban)
    // a free play may use an ink-cost Shift (the Shift cost is what's waived — Mickey Mouse - Trumpeter ruling)
    if (d.type === 'character' && !st.after) {
      const shifts = freeShifts(rt, s, job.seat, iid);
      if (shifts.length) {
        if (job.answer?.key !== 'freeShift') {
          job.waitKey = 'freeShift';
          return rt.ask(s, job, { op: 'freeShift', choices: ['Play it normally', ...shifts.map((x) => `Shift onto ${rt.tl(s, x.t)}`)], prompt: `play ${rt.tl(s, iid)} for free — normally or with Shift?` });
        }
        const o = job.answer.option ?? 0; job.answer = null;
        if (o > 0) return viaPlay({ mode: 'shift', shift: shifts[o - 1].k, target: shifts[o - 1].t });
      }
    }
    return rt.E.playFree(s, job.seat, iid, ev, { exerted: !!st.exerted, after: st.after });
  }
  static verb(rt, s, job, st) { return `play ${Query.describe(st.filter)} for free`; }
  static say(st) { return `${st.orShift ? 'play or shift' : 'play'} ${st.each ? 'each ' : ''}${Query.describe(st.filter)}${st.fromUnder ? ' that was under this card' : ''} for free${st.exerted ? ' (enters exerted)' : ''}${st.after === 'deckBottom' ? ', then put it on the bottom of your deck' : ''}`; }
}
