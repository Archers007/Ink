// The coach's opening-hand advice (admins, coach on). For every choice of cards to put on the bottom, it plays your
// first four turns alone many times — redraws and draws dealt at random from what's left in your deck (only its
// contents: the order is hidden, so the coach never peeks at it) — and scores how the hand develops: lore quested by
// the end of turn 4, ink spent, ink drops made, and whether you have a play by turn 2. Ranked options come back with a
// plain reason per card. Pure: runs in the bot worker (game/botworker.js).
//
//   adviseMulligan(state, seat) → { first, samples, options: [{ bottom: [iid], label, score, lore, spent, drops, early, keepAll }],
//                                    cards: [{ iid, verdict: 'keep'|'bottom', why }] }
//
// It's a goldfish: no opponent, no card text beyond Shift. Abilities like "play a character for free" are ignored,
// so it leans towards a clean curve; the habits of real players (learn/model.js) nudge cards people agree on.

import { D } from '../engine.js';
import { cardHabit } from '../learn/model.js';
import { namesOf } from '../../public/js/play/rules.js';

const TURNS = 4;
const SAMPLES = 300;
const MIN_HABIT = 15;

function rng(seed) {                                   // mulberry32: the same hand gives the same advice every time
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (str) => { let h = 2166136261; for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
const isSpell = (d) => d.type === 'action' || d.type === 'song';
const shiftCost = (d) => (typeof d.kw?.shift === 'number' ? d.kw.shift : (d.shifts || []).find((x) => x.onto?.by === 'name' && typeof x.cost?.ink === 'number')?.cost.ink ?? null);
// a cheaper character with a name the Shift card can go onto
const isShiftBase = (base, d) => d.type === 'character' && base.type === 'character' && base.cost < d.cost && shiftCost(d) != null
  && [...namesOf(base)].some((n) => namesOf(d).has(n));
const shareOf = (d) => { const h = cardHabit(d.full); return h && h.shipped + h.kept >= MIN_HABIT ? h.shipped / (h.shipped + h.kept) : null; };

// which card to ink on turn t (the bot's own rule of thumb, game/bot.js chooseInk): spells, cards too dear to play
// soon and spare copies go first; cards you can play now stay in hand
function pickInk(hand, t) {
  let best = -1, bestScore = -Infinity;
  const count = new Map();
  for (const d of hand) count.set(d.id, (count.get(d.id) || 0) + 1);
  hand.forEach((d, i) => {
    if (!d.inkable) return;
    let sc = d.cost * 0.5;
    if (isSpell(d)) sc += 20;
    if (d.cost > t + 2) sc += 30;
    if (d.cost <= t) sc -= 20;
    if (count.get(d.id) > 1) sc += 8;
    if (sc > bestScore) { bestScore = sc; best = i; }
  });
  return best;
}

// your first TURNS turns with no opponent: ink one card a turn, spend as much ink as you can (Shift onto a character
// already in play when it's cheaper), quest with every dry character
function goldfish(start, draws, first) {
  const hand = start.slice();
  const board = [];                                    // { d, turn } — turn it arrived (a shifted character keeps the old one's)
  let di = 0, ink = 0, spent = 0, lore = 0, missed = 0, firstPlay = 0;
  for (let t = 1; t <= TURNS; t++) {
    if (!(t === 1 && first) && di < draws.length) hand.push(draws[di++]);
    const ii = pickInk(hand, t);
    if (ii >= 0) { hand.splice(ii, 1); ink++; } else missed++;
    let avail = ink;
    for (;;) {
      let pick = -1, pickCost = 0, onto = -1, pickVal = -1;
      hand.forEach((d, i) => {
        let cost = d.cost, base = -1;
        const sc = d.type === 'character' ? shiftCost(d) : null;
        if (sc != null && sc < cost) {
          const names = namesOf(d);
          base = board.findIndex((b) => b.d.type === 'character' && [...namesOf(b.d)].some((n) => names.has(n)));
          if (base >= 0) cost = sc;
        }
        if (cost > avail) return;
        const val = cost + (d.type === 'character' ? 0.5 : 0) + (base >= 0 ? 1 : 0);   // spend the most ink; bodies first
        if (val > pickVal) { pick = i; pickCost = cost; onto = cost === d.cost ? -1 : base; pickVal = val; }
      });
      if (pick < 0) break;
      const d = hand.splice(pick, 1)[0];
      avail -= pickCost; spent += pickCost;
      if (!firstPlay) firstPlay = t;
      if (onto >= 0) board[onto] = { d, turn: board[onto].turn };
      else if (d.type === 'character' || d.type === 'location') board.push({ d, turn: t });
    }
    for (const b of board) if (b.turn < t) lore += b.d.lore || 0;   // dry characters quest; locations pay at the start of turn
  }
  return { lore, spent, missed, firstPlay };
}

function partialShuffle(n, k, R) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < Math.min(k, n - 1); i++) { const j = i + Math.floor(R() * (n - i)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k);
}

export function adviseMulligan(s, seat, { samples = SAMPLES } = {}) {
  const p = s.players[seat];
  const hand = p.hand.map((id) => ({ iid: id, d: D(s, s.cards[id]) }));
  // contents only, sorted, so the hidden order can't change the advice
  const deck = p.deck.map((id) => D(s, s.cards[id])).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const first = s.starting === seat;
  const n = hand.length;
  const R = rng(hash(`${seat}:${p.hand.join(',')}`));
  const perms = Array.from({ length: samples }, () => partialShuffle(deck.length, n + TURNS, R));   // the same draws for every option

  const options = [];
  const byKey = new Map();
  for (let mask = 0; mask < 1 << n; mask++) {
    const out = hand.filter((_, i) => mask & (1 << i));
    const key = out.map((h) => h.d.id).sort().join('|');      // two copies of a card: bottoming either is the same choice
    if (byKey.has(key)) continue;
    const kept = hand.filter((_, i) => !(mask & (1 << i))).map((h) => h.d);
    let lore = 0, spent = 0, drops = 0, early = 0;
    for (const perm of perms) {
      const start = kept.concat(perm.slice(0, out.length).map((i) => deck[i]));
      const r = goldfish(start, perm.slice(out.length, out.length + TURNS).map((i) => deck[i]), first);
      lore += r.lore; spent += r.spent; drops += r.missed ? 0 : 1; early += r.firstPlay && r.firstPlay <= 2 ? 1 : 0;
    }
    lore /= samples; spent /= samples; drops /= samples; early /= samples;
    // judgement on top of the goldfish, which can't see card text: a known card you can play early is worth more than
    // a random redraw, a Shift base for a card you keep stays, players' habits nudge, one big card for later is fine
    let judge = 0;
    for (const h of out) {
      judge -= h.d.cost <= 2 ? 1 : h.d.cost <= 4 ? 0.6 : 0.1;
      judge += 0.03 * h.d.cost;                                // between two bricks, the dearer one goes
      if (kept.some((k) => isShiftBase(h.d, k))) judge -= 0.8;
      if (kept.some((k) => isShiftBase(k, h.d))) judge -= 0.4;   // a Shift card whose base you keep
      const sh = shareOf(h.d); if (sh != null) judge += (sh - 0.4) * 1.5;
    }
    const big = kept.filter((d) => d.cost >= 5).map((d) => d.cost).sort((a, b) => a - b)[0];
    if (big) judge += Math.max(0.2, 0.8 - 0.1 * (big - 5));
    const score = 0.5 * lore + 0.5 * spent + 2 * drops + early + judge;
    const opt = { mask, bottom: out.map((h) => h.iid), names: out.map((h) => h.d.name), score, lore, spent, drops, early, keepAll: !out.length };
    byKey.set(key, opt);
    options.push(opt);
  }
  options.sort((a, b) => b.score - a.score);
  const best = options[0];

  const cards = hand.map((h, i) => {
    const bottom = !!(best.mask & (1 << i));
    const d = h.d;
    const sh = shareOf(d);
    const sc = d.type === 'character' ? shiftCost(d) : null;
    const keptOthers = hand.filter((o, j) => j !== i && !(best.mask & (1 << j)));
    const base = sc != null && keptOthers.some((o) => isShiftBase(o.d, d));
    const shiftsOnto = keptOthers.find((o) => isShiftBase(d, o.d));
    const why = [];
    if (bottom) {
      if (sc != null && !base) why.push(`Shift ${sc} needs another ${d.name} in play, and there's none in your hand`);
      else if (sc != null) why.push(`Even shifted onto the ${d.name} in your hand it waits until turn ${sc}`);
      else if (d.cost >= 5) why.push(`Costs ${d.cost}, so it does nothing before turn ${d.cost}`);
      else if (isSpell(d)) why.push('An action with nothing to hit early on');
      else why.push('A redraw is more likely to give you an earlier play');
      if (sh != null && sh >= 0.5) why.push(`players bottom it ${Math.round(sh * 100)}% of the time`);
    } else {
      if (base) why.push(`Shifts onto the ${d.name} in your hand for ${sc}`);
      else if (shiftsOnto) why.push(`${shiftsOnto.d.full} can Shift onto it`);
      else if (isSpell(d)) why.push(`An action you can cast from turn ${Math.max(1, d.cost)}`);
      else if (d.cost <= 2) why.push(`A turn-${Math.max(1, d.cost)} play`);
      else if (d.cost <= 4) why.push(`Your turn-${d.cost} play`);
      else why.push('Your one big card for later');
      if (sh != null && sh <= 0.25) why.push(`players keep it ${Math.round((1 - sh) * 100)}% of the time`);
      if (!d.inkable) why.push("can't be inked");
    }
    const t = why.join('; ');
    return { iid: h.iid, verdict: bottom ? 'bottom' : 'keep', why: t.charAt(0).toUpperCase() + t.slice(1) + '.' };
  });

  const shown = options.slice(0, 3);
  if (!shown.some((o) => o.keepAll)) shown.push(options.find((o) => o.keepAll));
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    first, samples, cards,
    options: shown.map((o) => ({
      bottom: o.bottom, keepAll: o.keepAll,
      label: o.keepAll ? `Keep all ${n}` : `Bottom ${o.names.join(' + ')}`,   // some names have commas ("Besties, Assemble!")
      score: r1(o.score - best.score), lore: r1(o.lore), spent: r1(o.spent),
      drops: Math.round(o.drops * 100), early: Math.round(o.early * 100),
    })),
  };
}
