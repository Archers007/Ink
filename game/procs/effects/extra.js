// The last one-of-a-kind wordings, each a building block other cards can use:
//   peekInkwell   "look at the cards in your inkwell" (private to you; "from there" / "one" = a card in it)
//   gainShift     static: "this card gains Shift 0 {ink}" · "you may put 5 character cards from your discard on the
//                 bottom of your deck … to shift this character for free" — a Shift option (cards.js adds it to def.shifts)
//   freeAbility   static: "you may use this item's Shapeshift ability for free" (CR 6.1.7.1: every cost but {exert})
//   readyLimit    "can't ready more than 1 of your characters at the start of your next turn" — they pick which
//   revealedBest  "put the card with the highest cost revealed this way, or each card tied for highest cost, into its
//                 player's hand" (the cards each player revealed — EachPlayer's tally) · revealedRest "put the rest …"
//   distribute    "choose 3 of your characters and return one of those cards to your hand, put one on the bottom of
//                 your deck, and put one on the top of your deck" — in the order written, as far as they go
//   shiftFrom     "shift a character from your discard for free" (it needs Shift and something to go on top of)
//   revealSame    activated cost: "Reveal 2 cards with the same name in your hand" — "that name" is theirs
import { Effect } from './Effect.js';
import { Query } from '../query.js';
import { namesOf } from '../classifiers/named.js';
import { shiftOptions, shiftTargetOk } from '../../../public/js/play/rules.js';

export class PeekInkwell extends Effect {
  static fn = 'peekInkwell';
  static rules = [[/^look at the cards in your inkwell$/i, () => ({ fn: 'peekInkwell' })]];
  static run(rt, s, job) {
    const ink = rt.E.P(s, job.seat).inkwell;
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} looked at the cards in their inkwell.`, { seat: job.seat, kind: 'effect',
      priv: { seat: job.seat, text: `↳ Your inkwell: ${ink.map((iid) => rt.E.cardLabel(rt.E.D(s, s.cards[iid]))).join(', ') || 'empty'}.` } });
    return true;
  }
  static verb() { return 'look at the cards in your inkwell'; }
  static say() { return 'look at the cards in your inkwell'; }
}

// "… look at the cards in your inkwell and then you may return one to your hand" — one of the cards just looked at
export class ReturnOne extends Effect {
  static fn = 'returnOne';
  static rules = [[/^return one to your hand$/i, () => ({ fn: 'toHand', sel: { chosen: { zone: 'there', owner: 'you' } } })]];
}

export class GainShift extends Effect {
  static fn = 'gainShift';
  static staticOnly = true;
  static say(st) {
    const c = st.spec.cost;
    return `this card gains ${st.spec.temp ? 'temporary ' : ''}${st.spec.label} (${c.ink != null ? `${c.ink} {ink}` : `put ${c.bottomFromDiscard} ${c.type || ''} cards from your discard on the bottom of your deck`})`;
  }
}

export class FreeAbility extends Effect {
  static fn = 'freeAbility';
  static staticOnly = true;
  static say(st) { return `you may use this card's ${st.name} ability for free (still {exert})`; }
}

export class ReadyLimit extends Effect {
  static fn = 'readyLimit';
  static rules = [[/^(?:you )?can't ready more than (\d+) of your characters at the start of your next turn$/i, (m) => ({ fn: 'readyLimit', n: +m[1] })]];
  static run(rt, s, job, st) {
    const p = rt.E.P(s, job.seat);
    p.readyLimit = { n: Math.min(p.readyLimit?.n ?? Infinity, st.n), after: s.turn };   // two of them: the lower limit
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} can't ready more than ${st.n} of their characters at the start of their next turn.`, { seat: job.seat, kind: 'effect' });
    return true;
  }
  static say(st) { return `can't ready more than ${st.n} of your characters at the start of your next turn`; }
}

// the ready step under a readyLimit: ready up to n of the held characters (job.ctx.it) — engine-made, no wording
export class ReadyPick extends Effect {
  static fn = 'readyPick';
  static chooses() { return true; }
  static run(rt, s, job, st, ev) {
    const pool = (job.ctx.it || []).filter((iid) => s.cards[iid]?.zone === 'play' && s.cards[iid].exerted);
    const got = pool.length <= st.n ? pool : rt.pickFrom(s, job, st, 'rp', pool, { n: st.n, optional: true, prompt: `choose up to ${st.n} character${st.n > 1 ? 's' : ''} to ready.` });
    if (!got) return null;
    for (const iid of got) { s.cards[iid].exerted = false; ev.push({ k: 'ready', iid }); rt.fire(s, 'ready', { iid }); rt.log(s, `↳ Readied ${rt.tl(s, iid)}.`, { seat: job.seat, kind: 'effect' }); }
    return got.length > 0;
  }
  static say(st) { return `ready up to ${st.n} of them`; }
}

// the cards each player revealed in the EachPlayer step before (Reveal adds them to the shared tally)
const pool = (s, job) => (job.ctx.tally?.revealed || []).filter((iid) => s.cards[iid]?.zone === 'deck');
export class RevealedBest extends Effect {
  static fn = 'revealedBest';
  static rules = [[/^put the card with the highest cost revealed this way, or each card tied for highest cost, into its player's hand$/i, () => ({ fn: 'revealedBest' })]];
  static run(rt, s, job, st, ev) {
    const cards = pool(s, job);
    if (!cards.length) return false;
    const top = Math.max(...cards.map((iid) => rt.E.D(s, s.cards[iid]).cost ?? 0));
    const best = cards.filter((iid) => (rt.E.D(s, s.cards[iid]).cost ?? 0) === top);
    for (const iid of best) { rt.E.moveTo(s, iid, 'hand', ev, { reveal: true }); rt.log(s, `↳ ${rt.tl(s, iid)} (cost ${top}) went into its player's hand.`, { seat: job.seat, kind: 'effect' }); }
    job.ctx.it = best;
    return true;
  }
  static say() { return "put the highest-cost card revealed this way (each one tied for it) into its player's hand"; }
}
export class RevealedRest extends Effect {
  static fn = 'revealedRest';
  static rules = [[/^put the rest on the bottom of their players' decks$/i, () => ({ fn: 'revealedRest' })]];
  static run(rt, s, job, st, ev) {
    const cards = pool(s, job);
    for (const iid of cards) rt.E.moveTo(s, iid, 'deckBottom', ev);
    if (cards.length) rt.log(s, `↳ Put the other revealed cards on the bottom of their players' decks.`, { seat: job.seat, kind: 'effect' });
    return cards.length > 0;
  }
  static say() { return "put the other revealed cards on the bottom of their players' decks"; }
}

const SLOT = { hand: 'return one of those cards to your hand', bottom: 'put one on the bottom of your deck', top: 'put one on the top of your deck' };
export class Distribute extends Effect {
  static fn = 'distribute';
  static chooses() { return true; }
  static rules = [[/^choose (\d+) of your (.+?) and (return one of those cards to your hand|put one on the (?:bottom|top) of your deck), (return one|put one) (?:of those cards )?(to your hand|on the (?:bottom|top) of your deck),? and (return one|put one) (?:of those cards )?(to your hand|on the (?:bottom|top) of your deck)$/i, (m, P) => {
    const where = (t) => (/hand/i.test(t) ? 'hand' : /bottom/i.test(t) ? 'bottom' : 'top');
    return { fn: 'distribute', sel: { chosen: P.filter(`your ${m[2]}`), upTo: +m[1], exactly: true }, slots: [where(m[3]), where(m[5]), where(m[7])] };
  }]];
  static run(rt, s, job, st, ev) {
    const T = (job.tmp.dist ||= { left: null, slot: 0 });
    if (!T.left) {
      const ids = rt.targets(s, job, st, st.sel);
      if (!ids) return null;
      T.left = [...ids];
      job.ctx.it = [...ids];
    }
    for (; T.slot < st.slots.length && T.left.length; T.slot++) {
      let iid = T.left.length === 1 ? T.left[0] : null;
      if (!iid) {
        const got = rt.pickFrom(s, job, st, `slot${T.slot}`, T.left, { n: 1, optional: false, prompt: `${SLOT[st.slots[T.slot]].replace(' of those cards', '')}: choose which.` });
        if (!got) return null;
        [iid] = got;
      }
      T.left = T.left.filter((x) => x !== iid);
      const to = st.slots[T.slot];
      rt.E.moveTo(s, iid, to === 'hand' ? 'hand' : to === 'bottom' ? 'deckBottom' : 'deckTop', ev, { reveal: to === 'hand' });
      rt.log(s, `↳ ${rt.tl(s, iid)} → ${to === 'hand' ? 'their hand' : `the ${to} of their deck`}.`, { seat: job.seat, kind: 'effect' });
    }
    return true;
  }
  static say(st) { return `choose ${st.sel.exactly ? '' : 'up to '}${st.sel.upTo} ${Query.describe(st.sel.chosen)} (as many as they have); ${st.slots.map((x) => (x === 'hand' ? 'one → hand' : `one → ${x} of deck`)).join(', ')}`; }
}

// a Shift (ink cost) this card could use right now: [{ k: option index, t: target iid }]
export function freeShifts(rt, s, seat, iid) {
  const d = rt.E.D(s, s.cards[iid]);
  if (d.type !== 'character') return [];
  return shiftOptions(d).flatMap((opt, k) => (opt.spec.cost.ink == null || opt.spec.cond || opt.spec.onto.by === 'duo' || opt.spec.onto.by === 'combo' ? []
    : rt.E.P(s, seat).play.filter((t) => t !== iid && shiftTargetOk(opt, d, rt.E.D(s, s.cards[t]))).map((t) => ({ k, t }))));
}
export class ShiftFrom extends Effect {
  static fn = 'shiftFrom';
  static chooses() { return true; }
  static rules = [[/^shift (?:a|an) (.+?) from your discard for free$/i, (m, P) => ({ fn: 'shiftFrom', filter: { ...P.filter(m[1]), zone: 'discard', owner: 'you' } })]];
  static run(rt, s, job, st, ev) {
    // only a card with Shift and something of yours to go on top of (Metamorphosis ruling)
    const valid = rt.candidates(s, st.filter, job.seat, job.src).filter((iid) => freeShifts(rt, s, job.seat, iid).length);
    if (!valid.length) { rt.log(s, `↳ ${job.label}: nothing in the discard can shift onto your characters.`, { kind: 'effect' }); return false; }
    const picked = rt.pickFrom(s, job, st, 'sf', valid, { n: 1, optional: !!st.may, prompt: `shift ${Query.describe(st.filter)} for free.` });
    if (!picked) return null;
    const [iid] = picked;
    if (!iid) return false;
    const opts = freeShifts(rt, s, job.seat, iid);
    let o = 0;
    if (opts.length > 1) {
      if (job.answer?.key !== 'sfOnto') { job.waitKey = 'sfOnto'; return rt.ask(s, job, { op: 'shiftFrom', choices: opts.map((x) => `onto ${rt.tl(s, x.t)}`), prompt: `shift ${rt.tl(s, iid)} onto which?` }); }
      o = job.answer.option ?? 0; job.answer = null;
    }
    job.ctx.it = [iid];
    try { rt.E.playCard(s, job.seat, { iid, mode: 'shift', shift: opts[o].k, target: opts[o].t, free: true, fromZone: 'discard' }, ev); return true; } catch (e) { rt.log(s, `↳ ${e.message}`, { kind: 'effect' }); return false; }
  }
  static say(st) { return `shift ${Query.describe(st.filter)} for free`; }
}

// cost step: "Reveal 2 cards with the same name in your hand" — "that name" is the name(s) they share (a Winnie the
// Pooh & Piglet and a Piglet share Piglet — Merlin's Wand ruling)
export function sameNamePairs(rt, s, seat, n) {
  const hand = rt.E.P(s, seat).hand;
  return hand.filter((iid) => hand.filter((x) => x !== iid && namesOf(rt.E.D(s, s.cards[x])).some((nm) => namesOf(rt.E.D(s, s.cards[iid])).includes(nm))).length >= n - 1);
}
export class RevealSame extends Effect {
  static fn = 'revealSame';
  static chooses() { return true; }
  static run(rt, s, job, st, ev) {
    const T = (job.tmp.rs ||= { got: [] });
    const p = rt.E.P(s, job.seat);
    const names = () => T.got.reduce((acc, iid) => acc.filter((nm) => namesOf(rt.E.D(s, s.cards[iid])).includes(nm)), namesOf(rt.E.D(s, s.cards[T.got[0]])));
    while (T.got.length < st.n) {
      const valid = T.got.length ? p.hand.filter((iid) => !T.got.includes(iid) && namesOf(rt.E.D(s, s.cards[iid])).some((nm) => names().includes(nm))) : sameNamePairs(rt, s, job.seat, st.n);
      if (!valid.length) return false;
      const got = rt.pickFrom(s, job, st, `rs${T.got.length}`, valid, { n: 1, optional: false, prompt: `reveal ${T.got.length ? 'another card with the same name' : 'a card'} from your hand.` });
      if (!got) return null;
      T.got.push(got[0]);
    }
    for (const iid of T.got) ev.push({ k: 'reveal', seat: job.seat, iid, cardId: s.cards[iid].cardId });
    const shared = names();
    s.named = { name: shared[0], names: shared, seat: job.seat };
    job.ctx.named = shared[0];
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} revealed ${T.got.map((iid) => rt.tl(s, iid)).join(' and ')}.`, { seat: job.seat, kind: 'effect' });
    return true;
  }
  static say(st) { return `reveal ${st.n} cards with the same name from your hand`; }
}

// engine-made last step of a played action: it leaves play for the discard (or the deck bottom) once its effect is done
export class Settle extends Effect {
  static fn = 'settle';
  static run(rt, s, job, st, ev) {
    const c = s.cards[job.src];
    if (!c || c.zone !== 'play') return false;
    rt.E.moveTo(s, c.iid, st.to === 'deckBottom' ? 'deckBottom' : 'discard', ev);
    return true;
  }
  static say(st) { return `it goes to ${st.to === 'deckBottom' ? 'the bottom of the deck' : 'the discard'}`; }
}
