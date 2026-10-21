// "look at the top N cards of your deck" + its tail sentences (pick / rest / scry), merged into one step by Look.tail()
import { Effect } from './Effect.js';
import { N, NUM, plural } from '../phrases/text.js';
import { filter } from '../phrases/filter.js';
import { Query } from '../query.js';

export class Look extends Effect {
  static fn = 'look';
  static rules = [
    // "of your deck" · "of chosen player's deck" · "of each opponent's deck" [+ "and put them back in any order"]
    [/^look at the top (\d+ cards|card) of (your|chosen player's|each opponent's|an opponent's) deck( and put them back in any order)?$/i, (m) => ({
      fn: 'look', n: m[1] === 'card' ? 1 : parseInt(m[1], 10),
      ...(/^chosen/i.test(m[2]) ? { of: 'chosen' } : /opponent/i.test(m[2]) ? { of: 'opp' } : {}),
      ...(m[3] ? { rest: 'top' } : {}),
    })],
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
    if ((m = t.match(/^put the rest on the (bottom|top) of (?:your|their) deck(?: in any order)?$/i))) { st.rest = m[1]; return true; }
    if ((m = t.match(/^put (one) into your hand and the other into your inkwell facedown and exerted$/i))) { st.pick = { filter: {}, n: 1, to: 'hand' }; st.rest = 'inkwell'; return true; }
    if (/^put the rest (?:in|into) your discard$/i.test(t)) { st.rest = 'discard'; return true; }
    if (/^put (?:it|them) on either the top or the bottom of (?:your|their) deck$/i.test(t) || /^put it on (?:either )?the top or (?:the )?bottom of (?:your|their) deck$/i.test(t)) { st.scry = true; return true; }
    if (/^put one on the top of (?:your|their) deck and the (?:other|rest) on the bottom(?: of (?:your|their) deck)?(?: in any order)?$/i.test(t)) { st.scry = true; return true; }
    if (/^put it on top of (?:your|their) deck or into (?:your|their) discard$/i.test(t)) { st.scry = 'discard'; return true; }
    if (/^put (?:them|those cards) back (?:on top )?in any order$/i.test(t) || /^put them back on (?:the )?top of your deck in any order$/i.test(t)) { st.rest = 'top'; return true; }
    return false;
  }
  static run(rt, s, job, st, ev) {
    const { E } = rt;
    const lbl = (iid) => E.cardLabel(E.D(s, s.cards[iid]));
    // whose deck: yours, an opponent's, or a player you choose
    if (st.of === 'chosen' && job.tmp.lookSeat == null) {
      if (job.answer?.key === 'lookSeat') { job.tmp.lookSeat = s.players[job.answer.option].seat; job.answer = null; }
      else { job.waitKey = 'lookSeat'; return rt.ask(s, job, { op: 'chooseOne', choices: s.players.map((p) => E.nameOf(s, p.seat)), prompt: "choose whose deck to look at." }); }
    }
    if (st.of === 'opp' && !st.pick && !st.rest && !st.scry) {           // "look at the top card of each opponent's deck"
      for (const o of E.opponentsOf(s, job.seat)) {
        const top = E.P(s, o).deck.slice(0, st.n);
        rt.log(s, `↳ ${E.nameOf(s, job.seat)} looked at the top ${plural(top.length, 'card')} of ${E.nameOf(s, o)}'s deck.`, { seat: job.seat, kind: 'effect', priv: { seat: job.seat, text: `↳ Top of ${E.nameOf(s, o)}'s deck: ${top.map(lbl).join(', ') || 'nothing'}.` } });
      }
      return true;
    }
    const seat = st.of === 'chosen' ? job.tmp.lookSeat : st.of === 'opp' ? E.opponentsOf(s, job.seat)[0] : job.seat;
    const whose = seat === job.seat ? 'their' : `${E.nameOf(s, seat)}'s`;
    const p = E.P(s, seat);
    const T = (job.tmp.look ||= { cards: p.deck.slice(0, st.n) });
    if (!T.logged) {
      T.logged = true;
      rt.log(s, `↳ ${E.nameOf(s, job.seat)} looked at the top ${plural(T.cards.length, 'card')} of ${whose} deck.`, { seat: job.seat, kind: 'effect', priv: { seat: job.seat, text: `↳ Top of ${seat === job.seat ? 'your' : whose} deck: ${T.cards.map(lbl).join(', ')}.` } });
    }
    // "put them back in any order": the player picks the new top card, then the next, …
    if (st.rest === 'top' && !st.pick && T.cards.length > 1) {
      T.order ||= [];
      while (T.order.length < T.cards.length - 1) {
        const left = T.cards.filter((iid) => !T.order.includes(iid));
        const k = `order${T.order.length}`;
        const got = rt.pickFrom(s, job, st, k, left, { n: 1, optional: false, prompt: `put them back in any order — choose card ${T.order.length + 1} from the top.` });
        if (!got) return null;
        T.order.push(got[0]);
      }
      const order = [...T.order, ...T.cards.filter((iid) => !T.order.includes(iid))];
      p.deck = [...order, ...p.deck.filter((iid) => !order.includes(iid))];
      rt.log(s, `↳ ${E.nameOf(s, job.seat)} put them back in an order of their choice.`, { kind: 'effect' });
      return true;
    }
    if (st.scry) {
      if (T.cards.length <= 1) {
        if (!T.cards.length) return false;
        if (job.answer?.key === 'scry') {
          const a = job.answer; job.answer = null;
          const where = st.scry === 'discard' ? 'discard' : 'deckBottom';
          if (!a.skip) { E.moveTo(s, T.cards[0], where, ev); rt.log(s, `↳ ${E.nameOf(s, job.seat)} put it ${where === 'discard' ? `into ${whose} discard` : `on the bottom of ${whose} deck`}.`, { kind: 'effect' }); }
          else rt.log(s, `↳ ${E.nameOf(s, job.seat)} left it on top of ${whose} deck.`, { kind: 'effect' });
          return true;
        }
        job.waitKey = 'scry';
        return rt.ask(s, job, { confirm: true, optional: true, op: 'scry', cards: [{ iid: T.cards[0], cardId: s.cards[T.cards[0]].cardId }], prompt: `put ${lbl(T.cards[0])} ${st.scry === 'discard' ? 'into the discard' : 'on the bottom of the deck'}? (No = keep it on top)` });
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
  static verb(rt, s, job, st) { return `look at the top ${plural(st.n, 'card')} of ${st.of ? "a player's" : 'your'} deck`; }
  static say(st) {
    return `look at the top ${plural(st.n, 'card')}${st.of === 'chosen' ? " of chosen player's deck" : st.of === 'opp' ? " of each opponent's deck" : ''}${st.pick ? `; ${st.pick.may ? 'may ' : ''}${st.pick.reveal ? 'reveal' : 'take'} ${st.pick.n} ${Query.describe(st.pick.filter)} into hand` : ''}${st.rest ? `; rest to ${st.rest}` : ''}${st.scry === 'discard' ? '; keep on top or discard' : st.scry ? '; put on top or bottom' : ''}`;
  }
}
