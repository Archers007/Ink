// "look at the top N cards of your deck" + its tail sentences (pick / rest / scry), merged into one step by Look.tail()
//
// Tails the fixed sentences below don't cover are read by one grammar — a distribution: the looked-at cards are handed
// out slot by slot, each slot a count, a filter and a destination, then the rest go to `rest`:
//   "Put one into your inkwell facedown and exerted and the other on the top of your deck."
//   "You may reveal up to 1 character card and up to 1 item card and put them into your hand."
//   "You may reveal an action card with cost 6 or less and play it for free."
//   "Put any number of them on the top or the bottom of your deck in any order."
//   st.slots: [{ n: number | 'any' | 'each', filter, may?, to: hand|top|bottom|inkwell|discard|play|either, reveal? }]
import { Effect } from './Effect.js';
import { N, NUM, plural } from '../phrases/text.js';
import { filter, tryFilter } from '../phrases/filter.js';
import { Query } from '../query.js';
import { Amount } from '../phrases/amount.js';

export class Look extends Effect {
  static fn = 'look';
  static rules = [
    // "look at a number of cards from the top of your deck equal to the number of cards under him"
    [/^look at a number of cards from the top of your deck equal to the number of cards under (?:him|her|it|them|this character)$/i, () => ({ fn: 'look', n: { n: 1, per: { count: { under: true } } } })],
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
    const t = sentence.replace(/\.$/, '').replace(/ and put the (rest|other) /i, ' and the $1 ');   // "Put one into your hand and put the rest on the bottom …"
    if ((m = t.match(new RegExp(String.raw`^you may reveal (?:(a|an|up to ${NUM}) )?(.+?) and put (?:it|them) into your hand$`, 'i')))) {
      const f = tryFilter(m[3]);                                       // else "up to 1 X and up to 1 Y" / "any number of X": the distribution
      if (f) { st.pick = { filter: f, n: m[2] ? N(m[2]) : 1, may: true, to: 'hand', reveal: true }; return true; }
    }
    if ((m = t.match(/^put (one|\d+) (?:of them )?into your hand$/i))) { st.pick = { filter: {}, n: N(m[1]), to: 'hand' }; return true; }
    if ((m = t.match(/^put (one|\d+) (?:of them )?into your hand and the (?:other|rest) on the (bottom|top) of your deck(?: in any order)?$/i))) { st.pick = { filter: {}, n: N(m[1]), to: 'hand' }; st.rest = m[2]; return true; }
    if ((m = t.match(/^put the rest on the (bottom|top) of (?:your|their) deck(?: in any order)?$/i))) { st.rest = m[1]; return true; }
    if ((m = t.match(/^put (one) into your hand and the other into your inkwell facedown and exerted$/i))) { st.pick = { filter: {}, n: 1, to: 'hand' }; st.rest = 'inkwell'; return true; }
    if (/^put the rest (?:in|into) your discard$/i.test(t)) { st.rest = 'discard'; return true; }
    if (/^put (?:it|them) on either the top or the bottom of (?:your|their) deck$/i.test(t) || /^put it on (?:either )?the top or (?:the )?bottom of (?:your|their) deck$/i.test(t)) { st.scry = true; return true; }
    if (/^put one on the top of (?:your|their) deck and the (?:other|rest) on the bottom(?: of (?:your|their) deck)?(?: in any order)?$/i.test(t)) { st.scry = true; return true; }
    if (/^put it on (?:either )?(?:the )?top of (?:your|their) deck or into (?:your|their) discard$/i.test(t)) { st.scry = 'discard'; return true; }
    if (/^put (?:them|those cards) back (?:on top )?in any order$/i.test(t) || /^put them back on (?:the )?top of your deck in any order$/i.test(t)) { st.rest = 'top'; return true; }
    return Look.distribute(t, st, at);                                  // anything else: the distribution grammar
  }
  // the distribution grammar — tried before the fixed sentences only when it reads the whole sentence
  static distribute(t, st, at) {
    if (st.pick || st.scry) return false;
    let s = t.trim();
    let may = false, m;
    if ((m = s.match(/^you may (.+)$/i))) { may = true; s = m[1]; }
    const slots = [];
    // "reveal <picks> and put them into your hand" · "reveal <pick> and play it for free"
    if ((m = s.match(/^reveal (.+?) and (put (?:it|them) (?:into|in) your hand|play (?:it|them) for free)$/i))) {
      const to = /^play/i.test(m[2]) ? 'play' : 'hand';
      for (const part of m[1].split(/ and (?=up to |a |an |any |each )/i)) {
        const k = Look.count(part, at);
        if (!k) return false;
        slots.push({ ...k, to, reveal: true, ...(may ? { may } : {}) });
      }
    } else if ((m = s.match(/^put (.+)$/i))) {
      // "one into your hand and the other on …" · "1 on the top of your deck and the rest on the bottom in any order"
      const parts = m[1].split(/,? and (?=(?:the other|the rest|one|\d+|any|each|all)\b)|, (?=(?:one|the other|the rest|\d+)\b)/i);
      for (const part of parts) {
        const pm = part.match(/^(.+?) (into your hand|in your hand|on (?:the )?top of your deck|on the bottom(?: of your deck)?|into your inkwell facedown and exerted|into your discard|on (?:either )?the top or (?:the )?bottom of your deck)(?: in any order)?$/i);
        if (!pm) return false;
        const to = /hand/i.test(pm[2]) ? 'hand' : /either|top or/i.test(pm[2]) ? 'either' : /top/i.test(pm[2]) ? 'top' : /bottom/i.test(pm[2]) ? 'bottom' : /inkwell/i.test(pm[2]) ? 'inkwell' : 'discard';
        if (/^the (?:other|rest)$/i.test(pm[1])) { st.rest = to; continue; }
        const k = /^(?:it|them|that card)$/i.test(pm[1]) ? { n: 'each', filter: {} } : Look.count(pm[1], at);
        if (!k) return false;
        slots.push({ ...k, to, ...(may ? { may } : {}) });
      }
    } else return false;
    if (!slots.length && !st.rest) return false;
    st.slots = [...(st.slots || []), ...slots];
    return true;
  }
  // "one" · "1" · "up to 2 character cards with Singer" · "any number of Pirate character cards" · "each character card
  //  with cost 2 or less" · "revealed character cards" · "a song card with cost 9 or less" · "any number of them"
  static count(p, at) {
    let m;
    const F = (x) => { const f = x ? tryFilter(x.replace(/^revealed /i, '')) : {}; return f; };
    if ((m = p.match(new RegExp(String.raw`^${NUM}$`, 'i')))) return { n: N(m[1]), filter: {} };
    if ((m = p.match(/^any number(?: of them| of (.+))?$/i))) { const f = F(m[1]); return f ? { n: 'any', filter: f } : null; }
    if ((m = p.match(new RegExp(String.raw`^up to ${NUM} (.+)$`, 'i')))) { const f = F(m[2]); return f ? { n: N(m[1]), filter: f, upTo: true } : null; }
    if ((m = p.match(/^(?:each|all|revealed) (.+)$/i)) || (m = p.match(/^(.+ cards)$/i))) { const f = F(m[1]); return f ? { n: 'each', filter: f } : null; }
    if ((m = p.match(/^(?:a|an|one) (.+)$/i))) { const f = F(m[1]); return f ? { n: 1, filter: f } : null; }
    return null;
  }
  // run the slots: each takes its cards from what's left, then the rest go to st.rest (or stay on top)
  static runSlots(rt, s, job, st, ev, T, p, whose) {
    const { E } = rt;
    const lbl = (iid) => E.cardLabel(E.D(s, s.cards[iid]));
    T.done ||= [];
    T.slot ||= 0;
    const left = () => T.cards.filter((iid) => s.cards[iid].zone === 'deck' && !T.done.includes(iid));
    for (; T.slot < st.slots.length; T.slot++) {
      const sl = st.slots[T.slot];
      const valid = left().filter((iid) => rt.matches(s, { ...sl.filter, zone: 'deck' }, s.cards[iid], job.seat, job.src));
      if (!valid.length) continue;
      let got;
      // "on either the top or the bottom": a counted slot picks its card(s), then each goes where the player says;
      // an each / any-number slot picks the ones for the bottom, the rest stay on top
      if (sl.to === 'either') {
        if (sl.n === 'each' || sl.n === 'any') {
          got = rt.pickFrom(s, job, st, `slot${T.slot}`, valid, { n: valid.length, optional: true, prompt: 'choose the cards to put on the bottom of the deck (the rest stay on top).' });
          if (!got) return null;
          T.done.push(...valid);
          for (const iid of got) E.moveTo(s, iid, 'deckBottom', ev);
          continue;
        }
        const n = Math.min(sl.n, valid.length);
        const pick = valid.length <= n ? valid : rt.pickFrom(s, job, st, `slot${T.slot}`, valid, { n, optional: false, prompt: `choose ${n > 1 ? `${n} cards` : 'a card'} to put on the top or the bottom.` });
        if (!pick) return null;
        T.eitherQ ||= [...pick];
        while (T.eitherQ.length) {
          const iid = T.eitherQ[0];
          if (job.answer?.key === `either${iid}`) {
            const bottom = !job.answer.skip; job.answer = null;
            if (bottom) E.moveTo(s, iid, 'deckBottom', ev);
            T.done.push(iid); T.eitherQ.shift();
            continue;
          }
          job.waitKey = `either${iid}`;
          return rt.ask(s, job, { confirm: true, optional: true, op: 'scry', cards: [{ iid, cardId: s.cards[iid].cardId }], prompt: `put ${lbl(iid)} on the bottom of the deck? (No = on top)` });
        }
        T.eitherQ = null;
        continue;
      }
      if (sl.n === 'each' && !sl.may) got = valid;
      // "You may put each character card with cost 2 or less into your hand" — all of them or none (Lucky - The 15th Puppy ruling)
      else if (sl.n === 'each') {
        if (job.answer?.key !== `each${T.slot}`) {
          job.waitKey = `each${T.slot}`;
          return rt.ask(s, job, { confirm: true, optional: true, op: 'lookEach', cards: valid.map((iid) => ({ iid, cardId: s.cards[iid].cardId })), prompt: `put ${valid.map(lbl).join(', ')} ${sl.to === 'hand' ? 'into your hand' : `→ ${sl.to}`}? (all of them, or none)` });
        }
        got = job.answer.skip ? [] : valid; job.answer = null;
      } else {
        const n = sl.n === 'any' || sl.n === 'each' ? valid.length : sl.n;
        const optional = !!sl.may || sl.n === 'any' || !!sl.upTo;
        if (!optional && valid.length <= n) got = valid;
        else {
          const dest = { hand: 'into your hand', top: 'on top of the deck', bottom: 'on the bottom of the deck', inkwell: 'into your inkwell', discard: 'into the discard', play: 'to play for free', either: 'to put on the bottom (the rest stay on top)' }[sl.to];
          got = rt.pickFrom(s, job, st, `slot${T.slot}`, valid, { n, optional, prompt: `choose ${sl.n === 'any' ? 'any number' : n > 1 ? `up to ${n}` : 'a card'}${sl.filter && Object.keys(sl.filter).length ? ` (${Query.describe(sl.filter)})` : ''} ${dest}.` });
          if (!got) return null;
        }
      }
      T.done.push(...got);
      for (const iid of got) {
        if (sl.to === 'hand') { E.moveTo(s, iid, 'hand', ev, { reveal: !!sl.reveal }); rt.log(s, `↳ ${E.nameOf(s, job.seat)} put ${sl.reveal ? lbl(iid) : 'a card'} into their hand.`, { seat: job.seat, kind: 'effect', priv: { seat: job.seat, text: `↳ You put ${lbl(iid)} into your hand.` } }); }
        else if (sl.to === 'play') E.playFree(s, job.seat, iid, ev);
        else if (sl.to === 'bottom' || sl.to === 'either') E.moveTo(s, iid, 'deckBottom', ev);
        else if (sl.to === 'inkwell') E.moveTo(s, iid, 'inkwell', ev, { exerted: true });
        else if (sl.to === 'discard') E.moveTo(s, iid, 'discard', ev);
        // 'top': it stays where it is
      }
      if (got.length) job.ctx.it = got;
    }
    const rest = left();
    if (st.rest === 'bottom') for (const iid of rest) E.moveTo(s, iid, 'deckBottom', ev);
    if (st.rest === 'discard') for (const iid of rest) E.moveTo(s, iid, 'discard', ev);
    if (st.rest === 'inkwell') for (const iid of rest) E.moveTo(s, iid, 'inkwell', ev, { exerted: true });
    if (st.rest === 'hand') for (const iid of rest) E.moveTo(s, iid, 'hand', ev);
    rt.log(s, `↳ ${E.nameOf(s, job.seat)} sorted the top of ${whose} deck.`, { seat: job.seat, kind: 'effect' });
    return true;
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
        const top = E.P(s, o).deck.slice(0, Amount.value(rt, s, job, st.n));
        rt.log(s, `↳ ${E.nameOf(s, job.seat)} looked at the top ${plural(top.length, 'card')} of ${E.nameOf(s, o)}'s deck.`, { seat: job.seat, kind: 'effect', priv: { seat: job.seat, text: `↳ Top of ${E.nameOf(s, o)}'s deck: ${top.map(lbl).join(', ') || 'nothing'}.` } });
      }
      return true;
    }
    const seat = st.of === 'chosen' ? job.tmp.lookSeat : st.of === 'opp' ? E.opponentsOf(s, job.seat)[0] : job.seat;
    const whose = seat === job.seat ? 'their' : `${E.nameOf(s, seat)}'s`;
    const p = E.P(s, seat);
    const T = (job.tmp.look ||= { cards: p.deck.slice(0, Amount.value(rt, s, job, st.n)) });
    if (!T.logged) {
      T.logged = true;
      if (st.reveal) for (const iid of T.cards) ev.push({ k: 'reveal', seat, iid, cardId: s.cards[iid].cardId });
      rt.log(s, `↳ ${E.nameOf(s, job.seat)} ${st.reveal ? `revealed ${T.cards.map(lbl).join(', ') || 'nothing'} from` : `looked at`} the top ${plural(T.cards.length, 'card')} of ${whose} deck.`, { seat: job.seat, kind: 'effect', ...(st.reveal ? {} : { priv: { seat: job.seat, text: `↳ Top of ${seat === job.seat ? 'your' : whose} deck: ${T.cards.map(lbl).join(', ')}.` } }) });
    }
    if (st.slots) return Look.runSlots(rt, s, job, st, ev, T, p, whose);
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
  static verb(rt, s, job, st) { return `look at the top ${plural(typeof st.n === 'number' ? st.n : 'N', 'card')} of ${st.of ? "a player's" : 'your'} deck`; }
  static say(st) {
    if (st.slots) return `${st.reveal ? 'reveal' : 'look at'} the top ${plural(typeof st.n === 'number' ? st.n : 'N', 'card')}; ${st.slots.map((x) => `${x.may ? 'may ' : ''}${x.reveal ? 'reveal ' : ''}${x.n === 'any' ? 'any number of' : x.n === 'each' ? 'each' : x.upTo ? `up to ${x.n}` : x.n} ${Object.keys(x.filter || {}).length ? Query.describe(x.filter) : 'card'} → ${x.to}`).join('; ')}${st.rest ? `; rest → ${st.rest}` : ''}`;
    return `look at the top ${plural(typeof st.n === 'number' ? st.n : 'N', 'card')}${st.of === 'chosen' ? " of chosen player's deck" : st.of === 'opp' ? " of each opponent's deck" : ''}${st.pick ? `; ${st.pick.may ? 'may ' : ''}${st.pick.reveal ? 'reveal' : 'take'} ${st.pick.n} ${Query.describe(st.pick.filter)} into hand` : ''}${st.rest ? `; rest to ${st.rest}` : ''}${st.scry === 'discard' ? '; keep on top or discard' : st.scry ? '; put on top or bottom' : ''}`;
  }
}
