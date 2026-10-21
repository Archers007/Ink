// Moving cards between zones: banish · return to hand · bottom of deck · shuffle in · into the inkwell
import { Effect } from './Effect.js';
import { Selector } from '../phrases/selector.js';
import { HAND, DECK, INKWELL } from '../phrases/text.js';

// one class per destination, all sharing the same "target → move → log" shape
class Move extends Effect {
  static harmful = true;
  static past = '';
  static move(rt, s, iid, ev, st) {}
  static keep() { return null; }
  static run(rt, s, job, st, ev) {
    const ids = rt.targets(s, job, st, st.sel, 'sel', { keep: this.keep(s) });
    if (!ids) return null;
    if (!(this.fn === 'banish' && st.sel?.self)) job.ctx.it = ids;
    return rt.each(ids, (iid) => { rt.log(s, `↳ ${this.past.replace('$', rt.tl(s, iid))}.`, { seat: job.seat, kind: 'effect' }); this.move(rt, s, iid, ev, st); });
  }
}
export class Banish extends Effect {
  static fn = 'banish';
  static harmful = true;
  static rules = [[/^banish (.+)$/i, (m, P) => ({ fn: 'banish', sel: P.sel(m[1]) })]];
  static run(rt, s, job, st, ev) {
    const ids = rt.targets(s, job, st, st.sel);
    if (!ids) return null;
    job.ctx.it = ids;
    return rt.each(ids.filter((iid) => s.cards[iid].zone === 'play'), (iid) => rt.E.banish(s, iid, ev, job.label));
  }
  static verb() { return 'banish'; }
  static say(st) { return `banish ${Selector.say(st.sel)}`; }
}
export class ToHand extends Move {
  static fn = 'toHand';
  static past = 'Returned $ to their hand';
  static rules = [[new RegExp(String.raw`^return (.+?) to ${HAND}$`, 'i'), (m, P) => ({ fn: 'toHand', sel: P.sel(m[1]) })]];
  static move(rt, s, iid, ev) { rt.E.moveTo(s, iid, 'hand', ev, { reveal: true }); }
  static verb() { return 'return to hand'; }
  static say(st) { return `return ${Selector.say(st.sel)} to its owner's hand`; }
}
export class ToDeckBottom extends Move {
  static fn = 'toDeckBottom';
  static past = 'Put $ on the bottom of their deck';
  static rules = [[new RegExp(String.raw`^put (.+?) on the bottom of ${DECK}$`, 'i'), (m, P) => ({ fn: 'toDeckBottom', sel: P.sel(m[1]) })]];
  static move(rt, s, iid, ev) { rt.E.moveTo(s, iid, 'deckBottom', ev); }
  static verb() { return 'put on the bottom of the deck'; }
  static say(st) { return `put ${Selector.say(st.sel)} on the bottom of its deck`; }
}
export class ShuffleIn extends Move {
  static fn = 'shuffleIn';
  static past = 'Shuffled $ into their deck';
  static rules = [[new RegExp(String.raw`^shuffle (.+?) into ${DECK}$`, 'i'), (m, P) => ({ fn: 'shuffleIn', sel: P.sel(m[1]) })]];
  static move(rt, s, iid, ev) {
    const owner = s.cards[iid].owner;
    rt.E.moveTo(s, iid, 'deckBottom', ev); rt.E.shuffleArr(s, rt.E.P(s, owner).deck); ev.push({ k: 'shuffle', seat: owner });
  }
  static verb() { return 'shuffle into the deck'; }
  static say(st) { return `shuffle ${Selector.say(st.sel)} into its deck`; }
}
export class ToInkwell extends Move {
  static fn = 'toInkwell';
  static past = 'Put $ into their inkwell';
  static rules = [[new RegExp(String.raw`^put (.+?) into ${INKWELL} facedown( and exerted)?$`, 'i'), (m, P) => ({ fn: 'toInkwell', sel: P.sel(m[1]), exerted: !!m[2] })]];
  static move(rt, s, iid, ev, st) { rt.E.moveTo(s, iid, 'inkwell', ev, { exerted: !!st.exerted }); }
  static verb() { return 'put into the inkwell'; }
  static say(st) { return `put ${Selector.say(st.sel)} into its inkwell${st.exerted ? ' exerted' : ''}`; }
}

// "put all cards from under her into your hand" · "… from under chosen character, item, or location on the
// bottom of their player's deck in a random order"
export class FromUnder extends Effect {
  static fn = 'fromUnder';
  static rules = [
    [/^put all cards from under (her|him|them|it|this character|this location|this item) into your hand$/i, () => ({ fn: 'fromUnder', sel: { self: true }, to: 'hand' })],
    [/^put all cards from under (.+?) on the bottom of their player's deck in a random order$/i, (m, P) => ({ fn: 'fromUnder', sel: P.sel(m[1]), to: 'deckBottom' })],
  ];
  static run(rt, s, job, st, ev) {
    const ids = rt.targets(s, job, st, st.sel);
    if (!ids) return null;
    let n = 0;
    for (const iid of ids) {
      const c = s.cards[iid];
      const under = rt.E.shuffleArr ? rt.E.shuffleArr(s, [...(c?.under || [])]) : [...(c?.under || [])];
      for (const u of under) { rt.E.moveTo(s, u, st.to, ev, { fromUnder: true }); n++; }
    }
    rt.log(s, `↳ ${n} card${n === 1 ? '' : 's'} from under ${ids.length ? rt.E.cardLabel(rt.E.D(s, s.cards[ids[0]])) : 'it'} went ${st.to === 'hand' ? 'into its owner\'s hand' : "to the bottom of its owner's deck"}.`, { kind: 'effect' });
    return n > 0;
  }
  static say(st, step, X) { return `put all cards from under ${st.sel.self ? 'this card' : 'the chosen card'} ${st.to === 'hand' ? 'into your hand' : "on the bottom of their owner's deck (random order)"}`; }
}
