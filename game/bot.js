// A simple practice opponent. It only uses public information plus its own
// hand (no peeking), and only takes actions the engine fully automates:
// ink → play characters/items/locations → profitable challenges → quest → end turn.
// Card abilities and actions/songs are ignored (it inks those instead).

import { D, readyInk } from './engine.js';
import {
  LORE_TO_WIN, questBlocker, attackerBlocker, defenderBlocker, challengeDamage,
  effWp, effLore, hasKw, shiftOptions, shiftTargetOk,
} from '../public/js/play/rules.js';

const cardsIn = (s, ids) => ids.map((id) => s.cards[id]);
const isSpell = (d) => d.type === 'action' || d.type === 'song';

function chooseMulligan(s, seat) {
  const hand = cardsIn(s, s.players[seat].hand);
  const cheap = hand.filter((c) => D(s, c).cost <= 3).length;
  return hand.filter((c) => {
    const d = D(s, c);
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
    if (isSpell(d)) score += 100;                       // the bot can't resolve effects — ink them
    if (d.cost > inkNext + 2) score += 30;              // too expensive for a while
    if (d.cost <= inkNext) score -= 20;                 // castable soon — keep it
    if ((dupes.get(c.cardId) || 0) > 1) score += 8;
    score += d.cost * 0.5;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best?.iid ?? null;
}

function choosePlay(s, seat) {
  const p = s.players[seat];
  const ink = readyInk(s, seat);
  const mine = cardsIn(s, p.play);
  let best = null;
  let bestVal = -Infinity;
  for (const c of cardsIn(s, p.hand)) {
    const d = D(s, c);
    if (isSpell(d)) continue;
    if (d.cost <= ink) {
      const val = d.cost * 10 + (d.type === 'character' ? 5 : 0) + (d.lore || 0);
      if (val > bestVal) { bestVal = val; best = { type: 'play', iid: c.iid, mode: 'ink' }; }
    }
    for (const opt of shiftOptions(d)) {
      if (typeof opt.cost !== 'number' || opt.cost > ink) continue;
      const target = mine.find((t) => shiftTargetOk(opt.kind, d, D(s, t)));
      if (!target) continue;
      const val = d.cost * 10 + 8;
      if (val > bestVal) { bestVal = val; best = { type: 'play', iid: c.iid, mode: 'shift', shiftKind: opt.kind, target: target.iid }; }
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
  if (pend.confirm) return { type: 'choose', confirm: true };
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
