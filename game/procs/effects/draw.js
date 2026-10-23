import { Effect } from './Effect.js';
import { N, NUM, plural } from '../phrases/text.js';
import { Amount } from '../phrases/amount.js';

const WHO = { each: 'each player draws', opp: 'each opponent draws', refOwner: "that card's player draws", youAndOne: 'you and another chosen player each draw' };
export class Draw extends Effect {
  static fn = 'draw';
  static rules = [
    [new RegExp(String.raw`^draw ${NUM} cards?$`, 'i'), (m) => ({ fn: 'draw', n: N(m[1]) })],
    [new RegExp(String.raw`^each player draws ${NUM} cards?$`, 'i'), (m) => ({ fn: 'draw', n: N(m[1]), who: 'each' })],
    [new RegExp(String.raw`^(?:each|chosen) opponent draws ${NUM} cards?$`, 'i'), (m) => ({ fn: 'draw', n: N(m[1]), who: 'opp' })],
    [new RegExp(String.raw`^(?:that player|its player|their player|they) draws? ${NUM} cards?$`, 'i'), (m) => ({ fn: 'draw', n: N(m[1]), who: 'refOwner' })],
    [new RegExp(String.raw`^you and another chosen player each draw ${NUM} cards?$`, 'i'), (m) => ({ fn: 'draw', n: N(m[1]), who: 'youAndOne' })],
    [/^draw cards equal to (?:the damage removed|the amount of damage removed)$/i, () => ({ fn: 'draw', n: { healed: true } })],
    // "If you do, draw that number of cards plus 1" — as many as the last step moved
    [/^draw (?:that many|that number of) cards(?: plus (\d+))?$/i, (m) => ({ fn: 'draw', n: { itCount: true, ...(m[1] ? { plus: +m[1] } : {}) } })],
    [/^draw a card from the bottom of your deck$/i, () => ({ fn: 'draw', n: 1, bottom: true })],
    [/^draw a card for each (.+)$/i, (m, P) => ({ fn: 'draw', n: { n: 1, per: Amount.forEach(m[1], P.at) } })],
    // "Chosen player draws a card for each different ink type of characters you have in play" — counted on your side
    [/^chosen player draws a card for each (.+)$/i, (m, P) => ({ fn: 'eachPlayer', who: 'chosenPlayer', do: [{ fn: 'draw', n: { n: 1, per: { ...Amount.forEach(m[1], P.at), byCtl: true } } }] })],
    [new RegExp(String.raw`^(?:you )?draw cards until you have ${NUM} cards? in your hand$`, 'i'), (m) => ({ fn: 'draw', upTo: N(m[1]) })],
  ];
  static run(rt, s, job, st, ev) {
    for (const seat of rt.who(s, job, st.who)) {
      if (seat == null) continue;
      const n = st.upTo != null ? Math.max(0, st.upTo - rt.E.P(s, seat).hand.length) : Amount.value(rt, s, job, st.n);
      const { names } = rt.E.drawCards(s, seat, n, ev, { bottom: st.bottom });
      if (seat === job.seat) job.ctx.n = names.length;                // "then choose and discard that many cards"
      rt.log(s, `↳ ${rt.E.nameOf(s, seat)} drew ${plural(names.length, 'card')}.`, { seat, kind: 'effect', priv: names.length ? { seat, text: `↳ You drew ${names.join(', ')}.` } : undefined });
    }
    return true;
  }
  static verb(rt, s, job, st) { return st.upTo != null ? `draw up to ${st.upTo} cards in hand` : `draw ${plural(Amount.value(rt, s, job, st.n), 'card')}`; }
  static say(st) { return st.upTo != null ? `draw until you have ${st.upTo} cards in hand` : `${WHO[st.who] || 'draw'} ${Amount.say(st.n)}${st.bottom ? ' from the bottom of the deck' : ''}`; }
}

// "draw cards until you have the same number" (as the opponent with the most cards in hand)
export class DrawUntil extends Effect {
  static fn = 'drawUntil';
  static rules = [
    [/^draw cards until you have the same number(?: of cards in your hand as (?:that|chosen) opponent)?$/i, () => ({ fn: 'drawUntil' })],
    [/^draw (?:cards )?until you have (\d+)(?: cards?)?(?: in your hand)?$/i, (m) => ({ fn: 'drawUntil', to: +m[1] })],   // "draw until you have 3 cards in your hand"
  ];
  static run(rt, s, job, st, ev) {
    const { E } = rt;
    const most = st.to ?? Math.max(0, ...E.opponentsOf(s, job.seat).map((o) => E.P(s, o).hand.length));
    const n = most - E.P(s, job.seat).hand.length;
    if (n <= 0) return false;
    E.drawCards(s, job.seat, n, ev);
    rt.log(s, `↳ ${E.nameOf(s, job.seat)} drew ${plural(n, 'card')} to match.`, { kind: 'effect' });
    return true;
  }
  static say(st) { return st.to != null ? `draw until you have ${st.to} cards in your hand` : "draw until your hand matches the opponent's"; }
}
