// "reveal the top card of your deck" (+ "if it's a X, put it into your hand / play it for free; otherwise, put it on the bottom")
// The revealed cards become `it` for the following steps.  Also: reveal / look at an opponent's hand.
import { Effect } from './Effect.js';
import { N, NUM, plural, HAND, DECK } from '../phrases/text.js';
import { Selector } from '../phrases/selector.js';
import { Query } from '../query.js';
import { Amount } from '../phrases/amount.js';

export class Reveal extends Effect {
  static fn = 'reveal';
  static rules = [
    [new RegExp(String.raw`^reveal the top (?:${NUM} )?cards? of your deck$`, 'i'), (m) => ({ fn: 'reveal', n: N(m[1] || '1') })],
    [/^reveal the top card$/i, () => ({ fn: 'reveal', n: 1 })],
    [/^reveal a number of cards from the top of your deck equal to the number of cards under (?:him|her|it|them|this character)$/i, () => ({ fn: 'reveal', n: { n: 1, per: { count: { under: true } } } })],
  ];
  static run(rt, s, job, st, ev) {
    const p = rt.E.P(s, job.seat);
    const top = p.deck.slice(0, Amount.value(rt, s, job, st.n));
    job.ctx.it = top;
    for (const iid of top) ev.push({ k: 'reveal', seat: job.seat, iid, cardId: s.cards[iid].cardId });
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} revealed ${top.map((iid) => rt.E.cardLabel(rt.E.D(s, s.cards[iid]))).join(', ') || 'nothing'} from the top of their deck.`, { seat: job.seat, kind: 'effect' });
    return top.length > 0;
  }
  static verb(rt, s, job, st) { return `reveal the top ${plural(typeof st.n === 'number' ? st.n : 'N', 'card')} of your deck`; }
  static say(st) { return `reveal the top ${plural(typeof st.n === 'number' ? st.n : 'N', 'card')} of your deck`; }
}
// "put it on the top of your deck" (keeps a revealed card where it is) · "put it into your discard"
export class ToDeckTop extends Effect {
  static fn = 'toDeckTop';
  static rules = [
    [new RegExp(String.raw`^put (.+?) on (?:the )?top of ${DECK}$`, 'i'), (m, P) => ({ fn: 'toDeckTop', sel: P.sel(m[1]) })],
    [/^put (?:that card|it) on top of it$/i, () => ({ fn: 'toDeckTop', sel: { ref: true } })],
  ];
  static run(rt, s, job, st, ev) {
    const ids = rt.targets(s, job, st, st.sel);
    if (!ids) return null;
    return rt.each(ids, (iid) => { rt.E.moveTo(s, iid, 'deckTop', ev); rt.log(s, `↳ Put ${rt.tl(s, iid)} on top of their deck.`, { seat: job.seat, kind: 'effect' }); });
  }
  static say(st) { return `put ${Selector.say(st.sel)} on top of its deck`; }
}
export class ToDiscard extends Effect {
  static fn = 'toDiscard';
  static rules = [[/^put (.+?) (?:into|in) (?:your|their|its player's|their player's) discard$/i, (m, P) => ({ fn: 'toDiscard', sel: P.sel(m[1]) })]];
  static run(rt, s, job, st, ev) {
    const ids = rt.targets(s, job, st, st.sel);
    if (!ids) return null;
    return rt.each(ids, (iid) => { rt.E.moveTo(s, iid, 'discard', ev); rt.log(s, `↳ Put ${rt.tl(s, iid)} into their discard.`, { seat: job.seat, kind: 'effect' }); });
  }
  static say(st) { return `put ${Selector.say(st.sel)} into its discard`; }
}
// "put it / them / that card into your hand" (from wherever it is — usually a revealed card)
export class PutInHand extends Effect {
  static fn = 'putInHand';
  static rules = [[new RegExp(String.raw`^put (it|them|that card|those cards|the revealed card|the chosen card) into ${HAND}$`, 'i'), () => ({ fn: 'putInHand', sel: { ref: true } })]];
  static run(rt, s, job, st, ev) {
    const ids = rt.targets(s, job, st, st.sel).filter((iid) => s.cards[iid].zone !== 'hand');
    return rt.each(ids, (iid) => { rt.E.moveTo(s, iid, 'hand', ev, { reveal: true }); rt.log(s, `↳ ${rt.E.nameOf(s, s.cards[iid].owner)} put ${rt.E.cardLabel(rt.E.D(s, s.cards[iid]))} into their hand.`, { kind: 'effect' }); });
  }
  static verb() { return 'put it into your hand'; }
  static say() { return 'put that card into its owner\'s hand'; }
}
// "play it / that character / the revealed card for free [and it enters play exerted]"
export class PlayIt extends Effect {
  static fn = 'playIt';
  static rules = [
    [/^play (it|that character|that item|that song|that action|that card|the revealed card|them) for free(?: and (?:it|they|he|she) enters? play exerted)?$/i, (m) => ({ fn: 'playIt', ...(/exerted$/i.test(m[0]) ? { exerted: true } : {}) })],
    // "play this character for free" · "play him for free" · "play it from your discard for free" · "play that song again from your discard for free"
    [/^play (this character|this card|this item|this location) (?:from your discard )?for free(?: and (?:it|he|she) enters? play exerted)?$/i, (m) => ({ fn: 'playIt', self: true, ...(/exerted$/i.test(m[0]) ? { exerted: true } : {}) })],
    [/^play (him|her) (?:from your discard )?for free$/i, () => ({ fn: 'playIt' })],                        // the card just acted on ("If that character is named Tod, you may play him for free")
    [/^play (it|that character|that card|that song|that item) (?:again )?from your discard for free$/i, () => ({ fn: 'playIt' })],
    // paying its cost (CR 4.3 — "You pay all costs"): "you may play it" · "play it as if it were in your hand" ·
    // "play this character from your discard" · "play her and she enters play exerted"
    [/^play (it|her|him|them|that character|that card|this character|this card)(?: from your discard)?(?: as if it were in your hand)?(?: and (?:it|he|she|they) enters? play exerted)?$/i, (m) => ({
      fn: 'playIt', pay: true, ...(/^this /i.test(m[1]) ? { self: true } : /^(?:her|him)$/i.test(m[1]) ? { pron: true } : {}), ...(/exerted$/i.test(m[0]) ? { exerted: true } : {}) })],
  ];
  static run(rt, s, job, st, ev) {
    const it = job.ctx.it || [];
    const ids = (st.self || (st.pron && !it.length) ? [job.src] : it).filter((iid) => s.cards[iid] && s.cards[iid].zone !== 'play' && s.cards[iid].owner === job.seat);   // "play her" = this card, unless a step picked one
    if (!ids.length) return false;
    return rt.each(ids.slice(0, 1), (iid) => rt.E.playFree(s, job.seat, iid, ev, { pay: !!st.pay, exerted: !!st.exerted, after: st.after }));
  }
  static verb(rt, s, job, st) { return st.pay ? 'play it (paying its cost)' : 'play it for free'; }
  static say(st) { return `play that card${st.pay ? ', paying its cost' : ' for free'}${st.exerted ? ' (enters exerted)' : ''}${st.after === 'deckBottom' ? ', then put it on the bottom of the deck' : ''}`; }
}
// "chosen opponent reveals their hand and discards a non-character card of your choice"
export class RevealHandDiscard extends Effect {
  static fn = 'revealHandDiscard';
  static harmful = true;
  static chooses() { return true; }
  static rules = [
    [/^(?:chosen|each) opponent reveals their hand and discards (?:a|an) (.+?) of your choice$/i, (m, P) => ({ fn: 'revealHandDiscard', filter: P.filter(m[1]) })],
  ];
  static run(rt, s, job, st, ev) {
    const o = rt.E.opponentsOf(s, job.seat)[0];
    if (o == null) return false;
    const hand = rt.E.P(s, o).hand;
    if (!job.tmp.shown) {
      job.tmp.shown = true;
      for (const iid of hand) ev.push({ k: 'reveal', seat: o, iid, cardId: s.cards[iid].cardId });
      rt.log(s, `↳ ${rt.E.nameOf(s, o)} revealed their hand: ${hand.map((iid) => rt.E.cardLabel(rt.E.D(s, s.cards[iid]))).join(', ') || 'empty'}.`, { kind: 'effect' });
    }
    const valid = hand.filter((iid) => rt.matches(s, { ...st.filter, zone: 'hand' }, s.cards[iid], job.seat, job.src));
    if (!valid.length || rt.discardBlocked(s, o)) return false;
    const picked = rt.pickFrom(s, job, st, 'rhd', valid, { n: 1, optional: false, prompt: `choose ${Query.describe(st.filter)} for them to discard.` });
    if (!picked) return null;
    return rt.each(picked, (iid) => { rt.E.moveTo(s, iid, 'discard', ev); rt.log(s, `↳ ${rt.E.nameOf(s, o)} discarded ${rt.E.cardLabel(rt.E.D(s, s.cards[iid]))}.`, { kind: 'effect' }); });
  }
  static say(st) { return `chosen opponent reveals their hand and discards ${Query.describe(st.filter)} of your choice`; }
}
// "look at chosen opponent's hand" — private to you
export class PeekHand extends Effect {
  static fn = 'peekHand';
  static rules = [[/^look at (?:chosen|each|an) opponent's hand$/i, () => ({ fn: 'peekHand' })]];
  static run(rt, s, job) {
    const o = rt.E.opponentsOf(s, job.seat)[0];
    const names = rt.E.P(s, o).hand.map((iid) => rt.E.cardLabel(rt.E.D(s, s.cards[iid])));
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} looked at ${rt.E.nameOf(s, o)}'s hand.`, { seat: job.seat, kind: 'effect', priv: { seat: job.seat, text: `↳ Their hand: ${names.join(', ') || 'empty'}.` } });
    return true;
  }
  static say() { return "look at chosen opponent's hand"; }
}
// "reveal your hand" · "reveal your hand and discard a non-character card of your choice" · "… and discard each
// non-character card revealed this way" — as the player an eachPlayer runs ("chosen opponent reveals their hand")
export class RevealHand extends Effect {
  static fn = 'revealHand';
  static rules = [
    [/^reveal your hand$/i, () => ({ fn: 'revealHand' })],
    [/^reveal your hand and discard (?:a|an) (.+?) of your choice$/i, (m, P) => ({ fn: 'revealHand', discard: { filter: P.filter(m[1]), n: 1 } })],
    [/^reveal your hand and discard each (.+?) revealed this way$/i, (m, P) => ({ fn: 'revealHand', discard: { filter: P.filter(m[1]), each: true } })],
  ];
  static run(rt, s, job, st, ev) {
    const { E } = rt;
    const hand = E.P(s, job.seat).hand;
    if (!job.tmp.shown) {
      job.tmp.shown = true;
      for (const iid of hand) ev.push({ k: 'reveal', seat: job.seat, iid, cardId: s.cards[iid].cardId });
      rt.log(s, `↳ ${E.nameOf(s, job.seat)} revealed their hand: ${hand.map((iid) => E.cardLabel(E.D(s, s.cards[iid]))).join(', ') || 'empty'}.`, { kind: 'effect' });
    }
    if (!st.discard) return true;
    const valid = hand.filter((iid) => rt.matches(s, { ...st.discard.filter, zone: 'hand' }, s.cards[iid], job.seat, job.src));
    if (!valid.length || rt.discardBlocked(s, job.seat)) return false;
    const picked = st.discard.each ? valid : rt.pickFrom(s, job, st, 'rh', valid, { n: 1, optional: false, prompt: `discard ${Query.describe(st.discard.filter)}.` });
    if (!picked) return null;
    for (const iid of picked) { E.moveTo(s, iid, 'discard', ev); rt.fire(s, 'discarded', { iid, seat: job.seat }); }
    rt.log(s, `↳ ${E.nameOf(s, job.seat)} discarded ${picked.map((iid) => E.cardLabel(E.D(s, s.cards[iid]))).join(', ')}.`, { kind: 'effect' });
    return true;
  }
  static say(st) { return `reveal your hand${st.discard ? ` and discard ${st.discard.each ? 'each' : 'a'} ${Query.describe(st.discard.filter)}` : ''}`; }
}
