// A simple practice opponent (and the search bot's rollout policy). It only uses public information plus its
// own hand (no peeking): ink → play characters/items/locations, and actions/songs when they have something to
// hit (songs sung for free by a character when one can) → profitable challenges → quest → end turn.

import { D, readyInk, playBlocked, shiftCondOk } from './engine.js';
import { cardHabit } from './learn/model.js';
import {
  LORE_TO_WIN, questBlocker, singerBlocker, attackerBlocker, defenderBlocker, challengeDamage,
  effWp, effLore, hasKw, shiftOptions, shiftOntoOk, shiftDiscardOk,
} from '../public/js/play/rules.js';

const cardsIn = (s, ids) => ids.map((id) => s.cards[id]);
const isSpell = (d) => d.type === 'action' || d.type === 'song';
const HARMFUL = new Set(['banish', 'damage', 'toHand', 'toDeckBottom', 'shuffleIn', 'toInkwell', 'exert', 'mod']);
// an action worth casting now: the engine runs it, and anything it aims at the opponent's board has a target there
function spellUseful(s, seat, d) {
  const acts = (d.procs || []).filter((p) => p.kind === 'action');
  if (!acts.length || !acts.every((p) => p.exec)) return false;
  const oppBoard = s.players.some((p) => p.seat !== seat && p.play.length);
  const myBoard = s.players[seat].play.length > 0;
  for (const p of acts) for (const st of p.do || []) {
    const F = st.sel?.chosen || st.sel?.all;
    if (!F || !HARMFUL.has(st.fn)) continue;
    if (F.owner === 'opp' && !oppBoard) return false;
    if (!F.owner && st.fn !== 'mod' && !oppBoard) return false;          // "banish chosen character": wait for one of theirs
    if (F.owner === 'you' && !myBoard) return false;
  }
  return true;
}

// what people do with a card once enough games show it (learn/model.js): share of times they inked it / shipped it
const MIN_HABIT = 15;
function habitShare(d, a, b) {
  const h = cardHabit(d.full);
  return h && h[a] + h[b] >= MIN_HABIT ? h[a] / (h[a] + h[b]) : null;
}

export function chooseMulligan(s, seat) {
  const hand = cardsIn(s, s.players[seat].hand);
  const cheap = hand.filter((c) => D(s, c).cost <= 3).length;
  return hand.filter((c) => {
    const d = D(s, c);
    const ship = habitShare(d, 'shipped', 'kept');
    if (ship != null && (ship >= 0.65 || ship <= 0.2)) return ship >= 0.65;   // people agree on this card
    return d.cost >= 6 || (cheap < 3 && d.cost >= 5) || isSpell(d) && d.cost >= 4;
  }).map((c) => c.iid);
}

function chooseInk(s, seat) {
  const p = s.players[seat];
  if (p.inkwell.length >= 9) return null;
  const inkNext = p.inkwell.length + 1;
  const hand = cardsIn(s, p.hand).filter((c) => D(s, c).inkable);
  if (!hand.length) return null;
  const dupes = new Map();
  for (const c of cardsIn(s, p.hand)) dupes.set(c.cardId, (dupes.get(c.cardId) || 0) + 1);
  let best = null;
  let bestScore = -Infinity;
  for (const c of hand) {
    const d = D(s, c);
    let score = 0;
    if (isSpell(d)) score += 20;                        // spells do less for a curve than characters
    if (d.cost > inkNext + 2) score += 30;              // too expensive for a while
    if (d.cost <= inkNext) score -= 20;                 // castable soon — keep it
    if ((dupes.get(c.cardId) || 0) > 1) score += 8;
    score += d.cost * 0.5;
    const inks = habitShare(d, 'ink', 'play');                  // people mostly ink it, or mostly play it
    if (inks != null) score += (inks - 0.5) * 30;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best?.iid ?? null;
}

// One legal way to pay this Shift option and the card(s) it goes on top of → the play action's extras, or null.
// Duo / Combo pick a pair, a discard cost gives up the cheapest matching cards in hand.
export function shiftPlan(s, seat, c, d, opt, ink) {
  const p = s.players[seat];
  const cost = opt.spec.cost;
  if (cost.ink != null && cost.ink > ink) return null;
  if (cost.inkDrops != null && (p.inkDrops || 0) < cost.inkDrops) return null;
  if (!shiftCondOk(s, seat, c, opt)) return null;                     // "If …, this card gains Shift 0"
  let discard, bottom;
  if (cost.bottomFromDiscard != null) {                               // the cheapest cards of that type from the discard
    const pool = cardsIn(s, p.discard).filter((x) => !cost.type || D(s, x).type === cost.type).sort((a, b) => D(s, a).cost - D(s, b).cost);
    if (pool.length < cost.bottomFromDiscard) return null;
    bottom = pool.slice(0, cost.bottomFromDiscard).map((x) => x.iid);
  }
  if (cost.discard != null) {
    const pool = cardsIn(s, p.hand).filter((x) => x.iid !== c.iid && shiftDiscardOk({ spec: { cost: { ...cost, discard: 1 } } }, [D(s, x)]))
      .sort((a, b) => D(s, a).cost - D(s, b).cost);
    if (pool.length < cost.discard) return null;
    discard = pool.slice(0, cost.discard).map((x) => x.iid);
  }
  const mine = cardsIn(s, p.play);
  let targets = mine.filter((t) => shiftOntoOk(opt, d, [D(s, t)])).slice(0, 1);
  if (!targets.length && (opt.spec.onto.by === 'duo' || opt.spec.onto.by === 'combo')) {
    for (const a of mine) for (const b of mine) if (!targets.length && a !== b && shiftOntoOk(opt, d, [D(s, a), D(s, b)])) targets = [a, b];
  }
  if (!targets.length) return null;
  return { mode: 'shift', shift: shiftOptions(d).findIndex((o) => o.spec === opt.spec), targets: targets.map((t) => t.iid), ...(discard ? { discard } : {}), ...(bottom ? { bottom } : {}) };
}

function choosePlay(s, seat) {
  const p = s.players[seat];
  const ink = readyInk(s, seat);
  let best = null;
  let bestVal = -Infinity;
  for (const c of cardsIn(s, p.hand)) {
    const d = D(s, c);
    if (playBlocked(s, seat, c.iid)) continue;                         // "You can't play this character unless …"
    if (isSpell(d)) {
      if (!spellUseful(s, seat, d)) continue;
      // a song: sung for free by the cheapest character that can, else paid for
      if (d.type === 'song') {
        const singer = cardsIn(s, p.play).filter((x) => D(s, x).type === 'character' && !singerBlocker(x, D(s, x), d)).sort((a, b) => D(s, a).cost - D(s, b).cost)[0];
        if (singer) { const val = d.cost * 10 + 4; if (val > bestVal) { bestVal = val; best = { type: 'play', iid: c.iid, mode: 'sing', singers: [singer.iid] }; } continue; }
      }
      if (d.cost <= ink) { const val = d.cost * 9; if (val > bestVal) { bestVal = val; best = { type: 'play', iid: c.iid, mode: 'ink' }; } }
      continue;
    }
    if (d.cost <= ink) {
      const val = d.cost * 10 + (d.type === 'character' ? 5 : 0) + (d.lore || 0);
      // "may enter play exerted to draw a card": take the bonus
      const exertFor = (d.procs || []).some((x) => x.kind === 'static' && x.effect?.fn === 'enterExertedOpt' && x.alsoProc);
      if (val > bestVal) { bestVal = val; best = { type: 'play', iid: c.iid, mode: 'ink', ...(exertFor ? { enterExerted: true } : {}) }; }
    }
    for (const opt of shiftOptions(d)) {
      const plan = shiftPlan(s, seat, c, d, opt, ink);
      if (!plan) continue;
      const val = d.cost * 10 + 8 - (plan.discard?.length || 0) * 6 - (opt.spec.temp ? 12 : 0);
      if (val > bestVal) { bestVal = val; best = { type: 'play', iid: c.iid, ...plan }; }
    }
  }
  return best;
}

function chooseChallenge(s, seat) {
  const me = s.players[seat];
  let best = null;
  let bestVal = 0;
  for (const A of cardsIn(s, me.play)) {
    const Ad = D(s, A);
    if (attackerBlocker(A, Ad)) continue;
    const reckless = hasKw(A, Ad, 'reckless');
    for (const opp of s.players) {
      if (opp.seat === seat) continue;
      const side = cardsIn(s, opp.play).map((card) => ({ card, def: D(s, card) }));
      for (const { card: T, def: Td } of side) {
        if (defenderBlocker(A, Ad, T, Td, side)) continue;
        const { toDefender, toAttacker } = challengeDamage(A, Ad, T, Td);
        const kills = T.damage + toDefender >= effWp(T, Td);
        const dies = A.damage + toAttacker >= effWp(A, Ad);
        let val = 0;
        if (Td.type === 'location') val = kills ? 6 + Td.cost + (Td.lore || 0) * 3 : 0;
        else if (kills && !dies) val = 12 + Td.cost + (Td.lore || 0) * 2;
        else if (kills && dies) val = Td.cost + (Td.lore || 0) * 2 - Ad.cost - (Ad.lore || 0) + 2;
        if (reckless) val += 50;   // reckless characters must challenge when able
        if (val > bestVal) { bestVal = val; best = { type: 'challenge', attacker: A.iid, target: T.iid }; }
      }
    }
  }
  return best;
}

function questers(s, seat) {
  return cardsIn(s, s.players[seat].play).filter((c) => !questBlocker(c, D(s, c)));
}

function chooseSupport(s, seat) {
  const pend = s.pending;
  const others = cardsIn(s, s.players[seat].play)
    .filter((c) => c.iid !== pend.from && D(s, c).type === 'character' && !c.exerted);
  if (!others.length) return { type: 'support' };
  return { type: 'support', target: others[0].iid };
}

// Effect targeting: hurt the opponent's best card, help our own best card;
// when forced to pick our own card to lose, give up the cheapest.
function chooseEffect(s, seat) {
  const pend = s.pending;
  if (pend.choices) return { type: 'choose', option: 0 };
  if (pend.confirm) return pend.op === 'scry' ? { type: 'choose', skip: true } : { type: 'choose', confirm: true };
  const cards = pend.valid.map((iid) => s.cards[iid]);
  const value = (c) => D(s, c).cost + (D(s, c).lore || 0);
  let pool;
  if (/Pick$/.test(pend.op) || pend.op === 'selfDiscard') pool = [...cards].sort((a, b) => value(a) - value(b));
  else {
    const want = pend.harmful ? cards.filter((c) => c.owner !== seat) : cards.filter((c) => c.owner === seat);
    if (!want.length) return pend.optional ? { type: 'choose', skip: true } : { type: 'choose', target: [...cards].sort((a, b) => value(a) - value(b))[0].iid };
    pool = want.sort((a, b) => value(b) - value(a));
  }
  return { type: 'choose', target: pool[0].iid };
}

export function botDecide(s, seat) {
  if (s.status === 'over') return null;
  const p = s.players[seat];
  if (s.status === 'mulligan') return p.mulligan.done ? null : { type: 'mulligan', iids: chooseMulligan(s, seat) };
  if (s.pending) {
    if (s.pending.seat !== seat) return null;
    return s.pending.type === 'support' ? chooseSupport(s, seat) : s.pending.type === 'choose' ? chooseEffect(s, seat) : null;
  }
  if (s.active !== seat) return null;

  if (p.inkedThisTurn < 1 + p.extraInk) {
    const iid = chooseInk(s, seat);
    if (iid) return { type: 'ink', iid };
  }
  const play = choosePlay(s, seat);
  if (play) return play;

  // If questing wins the game this turn, just do it.
  const qs = questers(s, seat);
  const potential = qs.reduce((n, c) => n + Math.max(0, effLore(c, D(s, c))), 0);
  if (qs.length && p.lore + potential >= LORE_TO_WIN) return { type: 'quest', iid: qs[0].iid };

  const ch = chooseChallenge(s, seat);
  if (ch) return ch;
  if (qs.length) return { type: 'quest', iid: qs[0].iid };
  return { type: 'endTurn', force: true };
}
