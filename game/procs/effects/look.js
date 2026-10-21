// "look at the top N cards of your deck" + its tail sentences (pick / rest / scry), merged into one step by Look.tail()
import { Effect } from './Effect.js';
import { N, NUM, plural } from '../phrases/text.js';
import { filter } from '../phrases/filter.js';
import { Query } from '../query.js';

export class Look extends Effect {
  static fn = 'look';
  static rules = [
    [/^look at the top (\d+|card) cards? of your deck$/i, (m) => ({ fn: 'look', n: m[1] === 'card' ? 1 : +m[1] })],
    [/^look at the top card of your deck$/i, () => ({ fn: 'look', n: 1 })],
  ];
  // a following sentence that belongs to this look ("Put one into your hand and the rest on the bottom…")
  static tail(sentence, st, at) {
    let m;
    const t = sentence.replace(/\.$/, '');
    if ((m = t.match(new RegExp(String.raw`^you may reveal (?:(a|an|up to ${NUM}) )?(.+?) and put (?:it|them) into your hand$`, 'i')))) {
      st.pick = { filter: filter(m[3], at), n: m[2] ? N(m[2]) : 1, may: true, to: 'hand', reveal: true }; return true;
    }
    if ((m = t.match(/^put (one|\d+) (?:of them )?into your hand$/i))) { st.pick = { filter: {}, n: N(m[1]), to: 'hand' }; return true; }
    if ((m = t.match(/^put (one|\d+) (?:of them )?into your hand and the (?:other|rest) on the (bottom|top) of your deck(?: in any order)?$/i))) { st.pick = { filter: {}, n: N(m[1]), to: 'hand' }; st.rest = m[2]; return true; }
    if ((m = t.match(/^put the rest on the (bottom|top) of your deck(?: in any order)?$/i))) { st.rest = m[1]; return true; }
    if ((m = t.match(/^put (one) into your hand and the other into your inkwell facedown and exerted$/i))) { st.pick = { filter: {}, n: 1, to: 'hand' }; st.rest = 'inkwell'; return true; }
    if (/^put the rest (?:in|into) your discard$/i.test(t)) { st.rest = 'discard'; return true; }
    if (/^put (?:it|them) on either the top or the bottom of your deck$/i.test(t) || /^put it on (?:either )?the top or (?:the )?bottom of your deck$/i.test(t)) { st.scry = true; return true; }
    if (/^put one on the top of your deck and the other on the bottom$/i.test(t)) { st.scry = true; return true; }
    if (/^put (?:them|those cards) back (?:on top )?in any order$/i.test(t) || /^put them back on (?:the )?top of your deck in any order$/i.test(t)) { st.rest = 'top'; return true; }
    return false;
  }
  static run(rt, s, job, st, ev) {
    const { E } = rt;
    const p = E.P(s, job.seat);
    const T = (job.tmp.look ||= { cards: p.deck.slice(0, st.n) });
    const lbl = (iid) => E.cardLabel(E.D(s, s.cards[iid]));
    if (!T.logged) {
      T.logged = true;
      rt.log(s, `↳ ${E.nameOf(s, job.seat)} looked at the top ${plural(T.cards.length, 'card')} of their deck.`, { seat: job.seat, kind: 'effect', priv: { seat: job.seat, text: `↳ Top of your deck: ${T.cards.map(lbl).join(', ')}.` } });
    }
    if (st.scry) {
      if (T.cards.length <= 1) {
        if (!T.cards.length) return false;
        if (job.answer?.key === 'scry') {
          const a = job.answer; job.answer = null;
          if (!a.skip) { E.moveTo(s, T.cards[0], 'deckBottom', ev); rt.log(s, `↳ ${E.nameOf(s, job.seat)} put it on the bottom of their deck.`, { kind: 'effect' }); }
          else rt.log(s, `↳ ${E.nameOf(s, job.seat)} left it on top of their deck.`, { kind: 'effect' });
          return true;
        }
        job.waitKey = 'scry';
        return rt.ask(s, job, { confirm: true, optional: true, op: 'scry', cards: [{ iid: T.cards[0], cardId: s.cards[T.cards[0]].cardId }], prompt: `put ${lbl(T.cards[0])} on the bottom of your deck? (No = keep it on top)` });
      }
      const top = rt.pickFrom(s, job, st, 'scryTop', T.cards, { n: 1, optional: false, prompt: 'choose the card to keep on top (the other goes to the bottom).' });
      if (!top) return null;
      for (const iid of T.cards) if (!top.includes(iid)) E.moveTo(s, iid, 'deckBottom', ev);
      return true;
    }
    let picked = [];
    if (st.pick) {
      const valid = T.cards.filter((iid) => s.cards[iid].zone === 'deck' && rt.matches(s, { ...st.pick.filter, zone: 'deck' }, s.cards[iid], job.seat, job.src));
      picked = rt.pickFrom(s, job, st, 'lookPick', valid, { n: st.pick.n, optional: !!st.pick.may, prompt: `put ${st.pick.n > 1 ? `up to ${st.pick.n}` : 'a'} ${Query.describe(st.pick.filter)} into your hand.` });
      if (!picked) return null;
      for (const iid of picked) {
        E.moveTo(s, iid, 'hand', ev, { reveal: !!st.pick.reveal });
        rt.log(s, `↳ ${E.nameOf(s, job.seat)} put ${st.pick.reveal ? lbl(iid) : 'a card'} into their hand.`, { seat: job.seat, kind: 'effect', priv: { seat: job.seat, text: `↳ You put ${lbl(iid)} into your hand.` } });
      }
    }
    const rest = T.cards.filter((iid) => !picked.includes(iid) && s.cards[iid].zone === 'deck');
    if (st.rest === 'bottom') for (const iid of rest) E.moveTo(s, iid, 'deckBottom', ev);
    if (st.rest === 'discard') for (const iid of rest) E.moveTo(s, iid, 'discard', ev);
    if (st.rest === 'inkwell') for (const iid of rest) E.moveTo(s, iid, 'inkwell', ev, { exerted: true });
    job.ctx.it = picked;
    return picked.length > 0 || !st.pick;
  }
  static verb(rt, s, job, st) { return `look at the top ${plural(st.n, 'card')} of your deck`; }
  static say(st) {
    return `look at the top ${plural(st.n, 'card')}${st.pick ? `; ${st.pick.may ? 'may ' : ''}${st.pick.reveal ? 'reveal' : 'take'} ${st.pick.n} ${Query.describe(st.pick.filter)} into hand` : ''}${st.rest ? `; rest to ${st.rest}` : ''}${st.scry ? '; put on top or bottom' : ''}`;
  }
}
