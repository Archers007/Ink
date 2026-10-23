// Ink Play — server-authoritative Disney Lorcana rules engine.
//
// Pure, synchronous state machine: newGame() builds a state object, applyAction()
// validates + applies one action atomically (illegal actions are fully undone,
// CR 1.7.6), and viewFor() produces the per-seat view that hides private zones
// (hands, decks, inkwells, facedown cards — CR 7.1.3).
//
// What's automated (CR section in brackets):
//   setup + mulligan [2.2] · start of turn: ready / set / draw [3.2] · drying [1.7.5]
//   ink once per turn [4.2] · paying ink [4.3.2.4] · play characters/items/locations/actions [4.3]
//   songs: sing / Sing Together [5.4.4, 8.12] · Shift + Puppy/Universal Shift [8.10]
//   quest + lore [4.5] · challenge incl. Evasive/Alert/Bodyguard/Challenger/Resist/Rush [4.6, 8.x]
//   locations: move cost, start-of-turn lore, challenging locations [4.7, 3.2.2.2, 4.6.8]
//   Support [8.13] · Boost [8.4] · Reckless [8.7] · game state check: 20 lore, banish [1.8]
//   deck-out at end of turn [1.8.1.2] · concede [2.3.3.4]
//
// Card abilities run as compiled procs (game/procs/: text → JSON at build time, executed by
// procs/runtime/Runtime.js): triggered, activated and static abilities, actions and songs, cost
// reductions. They resolve through an effect queue (s.fx) with choices as a pending prompt.
// Anything the compiler couldn't turn into a runnable proc stays manual (logged +
// visible to both players, like a real table). The engine offers primitive "effect" actions (damage,
// lore, exert/ready, move cards between zones, draw, look at top N, stat
// modifiers) so any card can be resolved by hand.

import {
  LORE_TO_WIN, OPENING_HAND, INKS_PER_TURN, KEYWORD_LABEL,
  cardLabel, effStr, effWp, effLore, kwVal, hasKw, effectiveKeywords, singValue,
  questBlocker, attackerBlocker, defenderBlocker, challengeDamage, singerBlocker,
  shiftOptions, shiftOntoOk, shiftOntoCount, shiftDiscardOk, shiftCostLabel, parseActivatedCost, prettyText, setQueryHook,
} from '../public/js/play/rules.js';
import { Query } from './procs/query.js';
import { createRuntime } from './procs/index.js';
import { TURN, runPhase } from './rulebook/turn.js';

export class RuleError extends Error {}
const RE = (msg) => new RuleError(msg);

// ---------- rng (seeded, so simulations are reproducible) ----------
function rand(s) {
  s.rng = (s.rng + 0x6D2B79F5) | 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function shuffleArr(s, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand(s) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- small helpers ----------
export const D = (s, c) => s.defs[c.cardId];
const P = (s, seat) => s.players[seat];
const nameOf = (s, seat) => s.players[seat]?.name || `Player ${seat + 1}`;
const clampInt = (v, lo, hi, dflt = 0) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};
const uniq = (a) => [...new Set(a)];
const ZONE_NAME = { deck: 'deck', hand: 'hand', play: 'play', inkwell: 'inkwell', discard: 'discard', under: 'a stack' };
const PUBLIC_ZONES = new Set(['play', 'discard']);   // the discard is public (CR 7.6.1); the inkwell is facedown (CR 7.5.1)

function newCard(iid, cardId, owner) {
  return {
    iid, cardId, owner, zone: 'deck', exerted: false, damage: 0, drying: false, atLocation: null,
    mods: [], under: [], faceDown: false, enteredTurn: 0, boostedTurn: 0, parent: null,
  };
}
// a ready card in play becoming exerted (quest, challenge, sing, {exert} costs, exert effects) — not entering play exerted
function exertCard(s, c) {
  if (c.exerted) return;
  c.exerted = true;
  if (c.zone === 'play') R.fire(s, 'exerts', { iid: c.iid });
}

function resetCard(c) {
  c.exerted = false; c.damage = 0; c.drying = false; c.atLocation = null; c.mods = [];
  c.faceDown = false; c.boostedTurn = 0; c.parent = null; c.under = [];
  c.shifted = false; c.tempShift = null; c.enteredExerted = false;
}

function log(s, text, opt = {}) {
  s.seq += 1;
  s.log.push({ n: s.seq, text, seat: opt.seat ?? null, kind: opt.kind || '', priv: opt.priv || null });
  if (s.log.length > 400) s.log.splice(0, s.log.length - 400);
}

// Can this card be played at all right now? (a reason, or null) — the bot asks before trying
export function playBlocked(s, seat, iid) { return R.playBlocked(s, seat, s.cards[iid]); }
export function readyInk(s, seat) {
  return P(s, seat).inkwell.reduce((n, iid) => n + (s.cards[iid].exerted ? 0 : 1), 0) + (P(s, seat).inkDrops || 0);
}
// Ink drop counters (CR 1.13.1.2) pay 1 ink each; ready inkwell cards are spent first.
// → how many ink drops paid part of it ("if you removed an ink drop to play her")
function payInk(s, seat, n) {
  if (n <= 0) return 0;
  const p = P(s, seat);
  const ready = p.inkwell.filter((iid) => !s.cards[iid].exerted);
  const drops = p.inkDrops || 0;
  if (ready.length + drops < n) throw RE(`Not enough ink — need ${n}, you have ${ready.length + drops} ready.`);
  const cards = Math.min(n, ready.length);
  for (let i = 0; i < cards; i++) s.cards[ready[ready.length - 1 - i]].exerted = true;
  if (n > cards) { p.inkDrops = drops - (n - cards); p.usedDropTurn = s.turn; R.fire(s, 'inkDropUsed', { seat }); }
  return Math.max(0, n - cards);
}

function listOf(s, c) {
  return c.zone === 'under' ? s.cards[c.parent].under : P(s, c.owner)[c.zone];
}
function detach(s, c) {
  const list = listOf(s, c);
  const i = list.indexOf(c.iid);
  if (i >= 0) list.splice(i, 1);
}
export function nextSeat(s, seat) {
  const n = s.players.length;
  for (let k = 1; k <= n; k++) {
    const t = (seat + k) % n;
    if (!s.players[t].out) return t;
  }
  return seat;
}
const opponentsOf = (s, seat) => s.players.map((p, i) => i).filter((i) => i !== seat && !s.players[i].out);

function privateMove(s, iid, from, to, viewerSeat) {
  const c = s.cards[iid];
  return {
    k: 'move', iid, cardId: c.cardId, from, to, privateTo: viewerSeat,
    redacted: { k: 'move', from, to },
  };
}

// Move a top-level card (and its whole stack, CR 5.1.1.7) to a zone.
function moveTo(s, iid, to, ev, opt = {}) {
  const c = s.cards[iid];
  const p = P(s, c.owner);
  const from = c.zone;
  if (from === 'under' && !opt.fromUnder) throw RE('Cards under another card move together with it.');
  const stack = from === 'play' ? [...c.under, iid] : [iid];
  const wasUnder = from === 'play' ? [...c.under] : null;           // "for each card that was under him"
  detach(s, c);
  if (from === 'play' && D(s, c).type === 'location') {
    const here = [];                                                // who was here as it left ("if there was an exerted character here")
    for (const pl of s.players) for (const id of pl.play) if (s.cards[id].atLocation === iid) { here.push(id); s.cards[id].atLocation = null; }
    c.lastHere = here;
  }
  for (const id of stack) {
    const k = s.cards[id];
    const wasFaceDown = k.faceDown;
    k.leftGrants = from === 'play' && id === iid ? k.mods.filter((m) => m.stat === 'grant') : [];
    // last-known stats ("less {strength} than that character" after it was banished — Divebomb + Felicia ruling)
    if (from === 'play' && id === iid && D(s, k).type === 'character') k.lastKnown = { str: effStr(k, D(s, k)), wp: effWp(k, D(s, k)), lore: effLore(k, D(s, k)), at: k.atLocation };
    resetCard(k);
    k.seq = (k.seq || 0) + 1;                                          // a new object in its new zone (an effect following "them" loses it)
    k.zone = to;
    if (to === 'deckTop' || to === 'deckBottom') k.zone = 'deck';
    if (to === 'deckTop') p.deck.unshift(id);
    else if (to === 'deckBottom') p.deck.push(id);
    else if (to === 'inkwell') { k.faceDown = true; k.exerted = !!opt.exerted || !!R.rule(s, 'inkExerted', k.owner); p.inkwell.push(id); }   // "cards enter opponents' inkwells exerted"
    else if (to === 'play') { k.enteredTurn = s.turn; k.drying = D(s, k).type === 'character'; p.play.push(id); }
    else p[to].push(id);
    const fromZ = { seat: c.owner, zone: from === 'play' && id !== iid ? 'play' : from };
    const toZ = { seat: c.owner, zone: k.zone };
    const visibleBefore = PUBLIC_ZONES.has(from) && !wasFaceDown;
    const visibleAfter = PUBLIC_ZONES.has(k.zone);
    if (id === iid && k.zone === 'discard') (s.turnLog ||= []).push({ ev: 'toDiscard', seat: c.owner, iid });
    if (id === iid && from === 'discard' && s.status === 'playing') R.fire(s, 'leavesDiscard', { iid, seat: c.owner });
    // "whenever a card is put into your inkwell" — inked, or put there by an effect (Fishbone Quill, a banish replacement)
    if (id === iid && k.zone === 'inkwell' && from !== 'inkwell' && s.status === 'playing') R.fire(s, 'inked', { seat: c.owner, iid });
    if (id === iid && from === 'discard' && to === 'hand' && s.status === 'playing') R.fire(s, 'returnFromDiscard', { iid });
    if (visibleBefore || visibleAfter || opt.reveal) ev.push({ k: 'move', iid: id, cardId: k.cardId, from: fromZ, to: toZ, parent: id !== iid ? iid : undefined, revealed: (opt.reveal && !visibleBefore && !visibleAfter) || undefined });
    else ev.push(privateMove(s, id, fromZ, toZ, c.owner));
  }
  if (wasUnder) c.lastUnder = wasUnder;
  if (from === 'play' && to !== 'play') R.fire(s, 'leaves', { iid, to });
}

// "put the top card of your deck facedown under X" — Boost (8.4) and effects share this
// Put a card under `iid` (CR 8.4 Boost and the effects that stack cards): the top card of the deck facedown, or
// opt.card from wherever it is (a card in the discard, a character in play — its own stack goes along); opt.faceUp
function putUnder(s, seat, iid, ev, opt = {}) {
  const C = s.cards[iid];
  const p = P(s, seat);
  let top = opt.card;
  let from = 'deck';
  if (top == null) {
    if (!p.deck.length) return false;
    top = p.deck.shift();
  } else {
    const u0 = s.cards[top];
    if (!u0 || u0.iid === C.iid || u0.zone === 'under') return false;
    from = u0.zone;
    const stack = from === 'play' ? [...u0.under] : [];
    detach(s, u0);
    resetCard(u0);
    for (const x of stack) { s.cards[x].parent = C.iid; C.under.push(x); }
    if (from === 'play') R.fire(s, 'leaves', { iid: top, to: 'under' });
  }
  const u = s.cards[top];
  u.zone = 'under'; u.parent = C.iid; u.faceDown = !opt.faceUp;
  C.under.push(top);
  ev.push({ k: 'move', ...(opt.faceUp || from !== 'deck' ? { iid: top, cardId: u.cardId } : {}), from: { seat, zone: from }, to: { seat, zone: 'under' }, parent: C.iid });
  R.fire(s, 'putUnder', { iid: C.iid, seat });
  return true;
}
// a character moves to a location (4.7) — the move action and "move … for free" effects share this
function moveChar(s, iid, loc, ev) {
  const C = s.cards[iid];
  const from = C.atLocation;                                        // "when you move a character here from a location"
  C.atLocation = loc;
  ev.push({ k: 'moveTo', iid, location: loc });
  R.fire(s, 'moves', { iid, at: loc });
  R.fire(s, 'moveHere', { iid, at: loc, ...(from != null ? { from } : {}) });
}

// CR 1.12.1–1.12.2: the top card of your own deck into your hand, one card at a time
function drawCards(s, seat, n, ev, opt = {}) {
  const p = P(s, seat);
  let drawn = 0;
  const names = [];
  for (let i = 0; i < n; i++) {
    if (!p.deck.length) { log(s, `${nameOf(s, seat)} can't draw — their deck is empty!`, { seat, kind: 'warn' }); break; }
    const iid = opt.bottom ? p.deck.pop() : p.deck.shift();         // "draw a card from the bottom of your deck"
    const c = s.cards[iid];
    c.zone = 'hand';
    p.hand.push(iid);
    ev.push(privateMove(s, iid, { seat, zone: 'deck' }, { seat, zone: 'hand' }, seat));
    names.push(cardLabel(D(s, c)));
    drawn++;
    if (s.status === 'playing') R.fire(s, 'draw', { seat, iid });
  }
  return { drawn, names };
}

function gainLore(s, seat, n, ev) {
  if (!n) return;
  if (n > 0 && !R.rule(s, 'gainLore', seat)) { log(s, `${nameOf(s, seat)} can't gain lore right now.`, { seat, kind: 'effect' }); return; }
  if (n < 0 && !R.rule(s, 'loseLore', seat)) { log(s, `${nameOf(s, seat)} can't lose lore right now.`, { seat, kind: 'effect' }); return; }
  const p = P(s, seat);
  const before = p.lore;
  p.lore = Math.max(0, p.lore + n);  // can't go below 0 (1.11.1)
  if (p.lore !== before) ev.push({ k: 'lore', seat, n: p.lore - before, total: p.lore });
}

function win(s, seat, reason, ev) {
  if (s.status === 'over') return;
  s.status = 'over';
  s.winner = seat;
  s.endReason = reason;
  s.pending = null;
  log(s, `🏆 ${nameOf(s, seat)} wins — ${reason}.`, { kind: 'win' });
  ev.push({ k: 'win', seat, reason });
}

// Damage being dealt (CR 1.9.1) — after Resist. Replacement effects (6.5) may prevent it or put it elsewhere as
// counters ("put that many damage counters on this character instead" — counters, not damage: no "is dealt damage").
// → the damage actually dealt to `iid`
function dealDamage(s, iid, n, ev, info = {}) {
  if (!(n > 0)) return 0;
  const e = R.replace(s, { event: 'damage', iid, n }, (r, e) => {
    const by = cardLabel(D(s, s.cards[r.src]));
    if (r.st.do === 'prevent') { log(s, `↳ ${by}: ${cardLabel(D(s, s.cards[e.iid]))} takes no damage instead.`, { kind: 'effect' }); return null; }
    if (r.st.do === 'redirect') {
      const b = s.cards[r.src];
      b.damage += e.n; ev.push({ k: 'damage', iid: b.iid, n: e.n });
      log(s, `↳ ${by} takes ${e.n} damage counter${e.n === 1 ? '' : 's'} instead of ${cardLabel(D(s, s.cards[e.iid]))}.`, { kind: 'effect' });
      return null;
    }
    return undefined;
  });
  if (!e) return 0;
  const c = s.cards[e.iid];
  c.damage += e.n;
  ev.push({ k: 'damage', iid: e.iid, n: e.n });
  R.fire(s, 'damaged', { iid: e.iid, n: e.n, ...info });
  return e.n;
}

function banish(s, iid, ev, why = '') {
  const c = s.cards[iid];
  const d = D(s, c);
  // "If this character would be banished, put them into your inkwell facedown and exerted instead" (CR 6.5)
  const rep = R.replace(s, { event: 'banish', iid }, (r) => {
    if (r.st.do !== 'inkwell') return undefined;
    log(s, `↳ ${cardLabel(d)} goes into ${nameOf(s, c.owner)}'s inkwell instead of being banished.`, { kind: 'effect' });
    moveTo(s, iid, 'inkwell', ev, { exerted: true });
    return null;
  });
  if (!rep) return;
  ev.push({ k: 'banish', iid, cardId: c.cardId });
  log(s, `💥 ${nameOf(s, c.owner)}'s ${cardLabel(d)} was banished${why ? ` (${why})` : ''}.`, { kind: 'banish' });
  const cx = s.challengeCtx;
  const inChallenge = !!cx && (cx.a === iid || cx.t === iid);
  const by = inChallenge ? (cx.a === iid ? cx.t : cx.a) : null;
  const at = c.atLocation;
  moveTo(s, iid, 'discard', ev);
  R.fire(s, 'banished', { iid, at, inChallenge, defending: inChallenge && cx.t === iid, by: by && s.cards[by] && D(s, s.cards[by]).type === 'character' ? by : null });
}

// Game state check (CR 1.8): win at 20 lore, banish anything with lethal damage; repeat until stable.
function gameStateCheck(s, ev, opt = {}) {
  if (s.status !== 'playing') return;
  // in the middle of an ability (a step waiting on a choice, or steps left): the check waits until all of its effects
  // are done (CR 6.7.5, 1.8.5 — Luisa - Confident Climber) — only a challenge checks mid-way (4.6.6.3)
  if (!opt.force && s.fx?.[0] && (s.fx[0].i > 0 || s.pending)) { R.statics(s); return; }
  for (let guard = 0; guard < 50; guard++) {
    R.statics(s);                                                   // "while …, this character gets …"
    const order = [];
    for (let k = 0, seat = s.active; k < s.players.length; k++, seat = nextSeat(s, seat)) if (!order.includes(seat)) order.push(seat);
    for (const seat of order) {
      if (P(s, seat).lore >= R.rule(s, 'winLore', seat)) { win(s, seat, `reached ${P(s, seat).lore} lore`, ev); return; }
    }
    const doomed = [];
    for (const p of s.players) {
      for (const iid of p.play) {
        const c = s.cards[iid];
        const d = D(s, c);
        if ((d.type === 'character' || d.type === 'location') && d.wp != null && c.damage >= effWp(c, d)) doomed.push(iid);
      }
    }
    if (!doomed.length) return;
    // they're banished at the same time (CR 1.8.4): one that banished another still counts while it goes too
    s.leaving = doomed;
    try { for (const iid of doomed) banish(s, iid, ev, `${s.cards[iid].damage} damage`); } finally { delete s.leaving; }
  }
}

// The turn's steps (CR 3). game/rulebook/turn.js holds their order, CR sections, skip rules and where the bag
// resolves; these do the work.
const STEPS = {
  begin(s, seat, ev) {                                              // 1.3.4.1
    s.turn += 1;
    s.active = seat;
    const p = P(s, seat);
    p.inkedThisTurn = 0;
    p.extraInk = 0;
    p.playedThisTurn = [];
    p.costMods = [];
    p.playFrom = []; p.nameBans = [];                               // "this turn, you may play characters from …"
    p.turnsTaken = (p.turnsTaken || 0) + 1;
    s.turnLog = [];
    ev.push({ k: 'turn', seat, turn: s.turn });
    log(s, `── Turn ${s.turn}: ${nameOf(s, seat)} ──`, { kind: 'turn', seat });
  },
  ready(s, seat) {                                                  // 3.2.1
    const p = P(s, seat);
    const readied = [];
    // "can't ready more than 1 of their characters at the start of their next turn" (Marshmallow - Cranky Climber):
    // their characters wait; the player picks which to ready, in the bag
    const limit = p.readyLimit && p.readyLimit.after < s.turn ? p.readyLimit.n : null;
    if (limit != null) delete p.readyLimit;
    const held = [];
    for (const iid of p.play) {
      const c = s.cards[iid];
      if (hasKw(c, D(s, c), 'cantReady') || hasKw(c, D(s, c), 'skipReady') || (hasKw(c, D(s, c), 'skipReadyOffLoc') && !c.atLocation)) continue;
      if (limit != null && D(s, c).type === 'character') { if (c.exerted) held.push(iid); continue; }
      if (c.exerted) readied.push(iid);
      c.exerted = false;
    }
    for (const iid of readied) R.fire(s, 'ready', { iid });
    if (held.length && limit > 0) {
      log(s, `↳ ${nameOf(s, seat)} can ready only ${limit} of their characters this turn.`, { seat, kind: 'effect' });
      R.queue(s, seat, held[0], 'Ready step', [{ fn: 'readyPick', n: limit }], { it: held });
    }
    for (const iid of p.inkwell) s.cards[iid].exerted = false;
    for (const pl of s.players) for (const iid of pl.play) {         // 3.2.1.3 "until the start of your next turn"
      const c = s.cards[iid];
      if (c.mods.length) c.mods = c.mods.filter((m) => !(m.until === 'sot' && m.by === seat));
    }
  },
  set(s, seat, ev) {                                                // 3.2.2: drying ends, locations give lore
    const p = P(s, seat);
    let locLore = 0;
    for (const iid of p.play) {
      const c = s.cards[iid];
      const d = D(s, c);
      if (d.type === 'character') c.drying = false;
      if (d.type === 'location') locLore += Math.max(0, effLore(c, d));
    }
    if (locLore) {
      gainLore(s, seat, locLore, ev);
      log(s, `${nameOf(s, seat)} gained ${locLore} lore from locations (${p.lore}/${R.rule(s, 'winLore', seat)}).`, { seat });
    }
  },
  startTriggers(s, seat) { R.fire(s, 'turnStart', { seat }); },     // 3.2.1.4 — resolve in the Set step (3.2.2.3)
  check(s, seat, ev) { gameStateCheck(s, ev); },
  draw(s, seat, ev) {                                               // 3.2.3.1
    const { names } = drawCards(s, seat, 1, ev);
    if (names.length) log(s, `${nameOf(s, seat)} drew a card.`, { seat, priv: { seat, text: `You drew ${names[0]}.` } });
  },
  endTriggers(s, seat) { R.fire(s, 'turnEnd', { seat }); },         // 3.4.1.1
  cleanup(s, seat, ev) {                                            // 3.4.1.2: "this turn" effects end
    for (const iid of [...P(s, seat).play]) if (s.cards[iid].tempShift != null) { s.cards[iid].tempShift = null; returnTopOnly(s, iid, ev); }
    R.endOfTurnCleanup(s, seat);
  },
  deckOut(s, seat, ev) {                                            // 1.8.1.2
    if (P(s, seat).deck.length) return;
    win(s, opponentsOf(s, seat)[0], `${nameOf(s, seat)} ended their turn with no cards in their deck`, ev);
  },
  pass(s, seat, ev) { turnPhase(s, nextSeat(s, seat), ev, 'start'); },  // 3.4.2
  skipped(s, seat, ev, st, why) {
    log(s, why === 'first' ? `${nameOf(s, seat)} goes first and skips their first draw.` : `${nameOf(s, seat)} skips their ${st.say} step.`, { seat });
  },
};
function turnPhase(s, seat, ev, phase, at = 0) {
  return runPhase(s, seat, ev, phase, at, {
    STEPS,
    rule: (s, id, seat) => R.rule(s, id, seat),
    pending: (s) => (s.fx || []).length,
    queueRest: (s, seat, phase, at) => R.queue(s, seat, null, TURN[phase].say, [{ fn: '_turnStep', seat, phase, at }]),
    stopped: (s) => s.status !== 'playing',
  });
}
const startTurn = (s, seat, ev) => turnPhase(s, seat, ev, 'start');

// ---------- game creation ----------

export function newGame({ players, seed, starting = null }) {
  const s = {
    v: 1,
    rng: (seed ?? Math.floor(Math.random() * 2 ** 31)) | 0,
    status: 'mulligan',
    turn: 0,
    active: 0,
    starting: 0,
    players: [],
    cards: {},
    defs: {},
    pending: null,
    fx: [],
    winner: null,
    endReason: '',
    log: [],
    seq: 0,
  };
  let next = 1;
  const ev = [];
  players.forEach((pl, seat) => {
    const p = {
      seat, name: pl.name || `Player ${seat + 1}`, lore: 0,
      deck: [], hand: [], play: [], inkwell: [], discard: [],
      inkedThisTurn: 0, extraInk: 0, mulligan: { done: false, count: 0 }, peek: [], out: false, playedThisTurn: [], costMods: [],
    };
    // shuffle BEFORE numbering so instance ids can't hint at decklist order
    const defs = shuffleArr(s, [...pl.deck]);
    for (const def of defs) {
      s.defs[def.id] = def;
      const iid = `c${next++}`;
      s.cards[iid] = newCard(iid, def.id, seat);
      p.deck.push(iid);
    }
    s.players.push(p);
  });
  s.starting = starting ?? Math.floor(rand(s) * players.length);
  s.active = s.starting;
  log(s, `🎲 ${nameOf(s, s.starting)} was chosen at random to go first.`, { kind: 'setup' });
  for (const p of s.players) {
    shuffleArr(s, p.deck);
    drawCards(s, p.seat, OPENING_HAND, ev);
  }
  log(s, 'Each player drew 7. Choose any cards to put on the bottom of your deck (you may keep all).', { kind: 'setup' });
  return s;
}

// ---------- guards ----------
function needSeat(s, seat) {
  if (!(Number.isInteger(seat) && seat >= 0 && seat < s.players.length)) throw RE('You are not seated in this game.');
}
function needPlaying(s) {
  if (s.status === 'over') throw RE('The game is over.');
  if (s.status !== 'playing') throw RE('Finish the mulligan first.');
}
function needMain(s, seat) {
  needPlaying(s);
  if (s.active !== seat) throw RE("It's not your turn.");
  if (s.pending) throw RE('Resolve the pending choice first.');
}
function ownCard(s, seat, iid, zone) {
  const c = s.cards[iid];
  if (!c || c.owner !== seat) throw RE("That isn't your card.");
  if (zone && c.zone !== zone) throw RE(`That card isn't in your ${ZONE_NAME[zone] || zone}.`);
  return c;
}
function inPlay(s, iid) {
  const c = s.cards[iid];
  if (!c || c.zone !== 'play') throw RE('That card is not in play.');
  return c;
}
function sideOf(s, seat) {
  return P(s, seat).play.map((id) => ({ card: s.cards[id], def: D(s, s.cards[id]) }));
}

// a Shift option an ability grants only while a condition holds ("If a card left a player's discard this turn, …")
export const shiftCondOk = (s, seat, c, opt) => !opt.spec.cond || R.test(s, opt.spec.cond, seat, c.iid);

// Bodyguard (CR 8.3.2) or "This character may enter play exerted": the player may play it exerted
export function mayEnterExerted(s, c, d) {
  return hasKw(c, d, 'bodyguard') || R.procsOf(s, c).some((p) => p.kind === 'static' && p.exec && p.effect?.fn === 'enterExertedOpt');
}

export function recklessBlockers(s, seat) {
  const out = [];
  for (const iid of P(s, seat).play) {
    const c = s.cards[iid];
    const d = D(s, c);
    if (d.type !== 'character' || !hasKw(c, d, 'reckless') || attackerBlocker(c, d) || hasKw(c, d, 'actCost')) continue;   // RC: a challenge that needs ink paid isn't forced (ruling)
    const canHit = opponentsOf(s, seat).some((o) => sideOf(s, o).some(({ card, def }) => !defenderBlocker(c, d, card, def, sideOf(s, o))));
    if (canHit) out.push(iid);
  }
  return out;
}

// must quest if able / Adventurous (CR 8.16.3): you can't end your turn while one is ready and can quest
export function mustQuestBlockers(s, seat) {
  return P(s, seat).play.filter((iid) => { const c = s.cards[iid], d = D(s, c); return d.type === 'character' && (hasKw(c, d, 'mustQuest') || hasKw(c, d, 'adventurous')) && !questBlocker(c, d); });
}

// ---------- action handlers ----------

const H = {};

H.mulligan = (s, seat, a, ev) => {
  if (s.status !== 'mulligan') throw RE('The mulligan step is over.');
  const p = P(s, seat);
  if (p.mulligan.done) throw RE('You already chose your opening hand.');
  const ids = uniq(Array.isArray(a.iids) ? a.iids : []);
  for (const id of ids) ownCard(s, seat, id, 'hand');
  for (const id of ids) {
    const c = s.cards[id];
    detach(s, c);
    c.zone = 'deck';
    p.deck.push(id);
    ev.push(privateMove(s, id, { seat, zone: 'hand' }, { seat, zone: 'deck' }, seat));
  }
  if (ids.length) {
    drawCards(s, seat, ids.length, ev);
    shuffleArr(s, p.deck);
    ev.push({ k: 'shuffle', seat });
  }
  p.mulligan = { done: true, count: ids.length };
  log(s, ids.length
    ? `${nameOf(s, seat)} put ${ids.length} card${ids.length === 1 ? '' : 's'} on the bottom, drew back to 7 and shuffled.`
    : `${nameOf(s, seat)} kept their opening hand.`, { seat });
  if (s.players.every((pl) => pl.mulligan.done)) {
    s.status = 'playing';
    startTurn(s, s.starting, ev);
  }
};

// CR 4.2 put a card into your inkwell (an ink card, CR 7.5.1)
H.ink = (s, seat, a, ev) => {
  needMain(s, seat);
  const fromDiscard = s.cards[a.iid]?.zone === 'discard' && R.rule(s, 'inkFromDiscard', seat);   // "You can ink cards from your discard"
  const c = ownCard(s, seat, a.iid, fromDiscard ? 'discard' : 'hand');
  const d = D(s, c);
  const p = P(s, seat);
  if (!d.inkable && !(c.zone === 'hand' && R.rule(s, 'handInkable', seat))) throw RE(`${cardLabel(d)} doesn't have the inkwell symbol.`);
  if (p.inkedThisTurn >= R.rule(s, 'inksPerTurn', seat) + p.extraInk) throw RE("You've already put a card into your inkwell this turn.");
  moveTo(s, c.iid, 'inkwell', ev, { reveal: true, exerted: R.rule(s, 'inkExerted', seat) });  // inking reveals the card (4.2.1.1)
  p.inkedThisTurn += 1;
  log(s, `${nameOf(s, seat)} inked ${cardLabel(d)} (${p.inkwell.length} ink).`, { seat });
};


// ---------- automated card abilities (procs) ----------
// The building blocks live in procs/ (see procs/README.md); the engine hands it the primitives it needs.

H.choose = (s, seat, a, ev) => {
  needPlaying(s);
  R.answer(s, seat, a);
};

// Play a card from wherever it is (hand, discard, a revealed card, under a card) outside the turn action — "play X
// for free" or, with pay, paying its cost (CR 4.3: "You pay all costs"). after: 'deckBottom' — an action that goes
// on the bottom of the deck instead of into the discard. → whether it was played
function playFree(s, seat, iid, ev, opt = {}) {
  const c = s.cards[iid];
  const d = D(s, c);
  let how = 'for free';
  // "You can't play this character unless …" holds however it's played — free plays too (CR 1.5.5.3: only the cost changes)
  const banned = R.playBlocked(s, seat, c);
  if (banned) { log(s, `↳ ${banned}`, { seat, kind: 'effect' }); return false; }
  if (opt.pay) {
    const cost = Math.max(0, d.cost + R.costDelta(s, seat, c, false));
    if (readyInk(s, seat) < cost) { log(s, `↳ ${nameOf(s, seat)} can't pay ${cost} ink to play ${cardLabel(d)}.`, { seat, kind: 'effect' }); return false; }
    R.costDelta(s, seat, c, true);
    c.paidDrops = payInk(s, seat, cost);
    how = `for ${cost} ink`;
  }
  P(s, seat).playedThisTurn.push(iid);
  const mv = c.zone === 'under' ? { fromUnder: true } : {};
  if (d.type === 'action' || d.type === 'song') {
    ev.push({ k: 'reveal', seat, iid, cardId: d.id });
    log(s, `${nameOf(s, seat)} played ${cardLabel(d)} ${how}.`, { seat, kind: 'play' });
    castSpell(s, seat, c, ev, mv, opt.after === 'deckBottom' ? 'deckBottom' : 'discard');
    R.fire(s, 'play', { iid });
    return true;
  }
  moveTo(s, iid, 'play', ev, mv);
  R.onEnter(s, c);
  if (opt.exerted) c.exerted = true;
  log(s, `${nameOf(s, seat)} played ${cardLabel(d)} ${how}.`, { seat, kind: 'play' });
  R.fire(s, 'play', { iid });
  R.fire(s, 'entersPlay', { iid });
  return true;
}
// An action is in play while its effect resolves, then goes to the discard (CR 4.3.5 — Everyone Knows Juanita ruling:
// it doesn't count toward "10 or more cards in your discard") — or where the effect that played it says ("then put it
// on the bottom of your deck instead of into your discard": after its effect — Ursula - Deceiver of All ruling)
function castSpell(s, seat, c, ev, mv = {}, after = 'discard') {
  moveTo(s, c.iid, 'play', ev, mv);
  if (R.castAction(s, seat, c)) { s.fx[s.fx.length - 1].steps.push({ fn: 'settle', to: after }); return true; }
  manualActionText(s, D(s, c));
  moveTo(s, c.iid, after === 'deckBottom' ? 'deckBottom' : 'discard', ev);
  return false;
}
function manualActionText(s, d) {
  for (const ab of d.abilities) {
    const text = prettyText(ab.text).replace(/^\s*Sing Together \d+\s*\([^)]*\)\s*/i, '').replace(/^\s*\([^)]*sing this song[^)]*\)\s*/i, '');
    if (text) log(s, `↳ ${text}`, { kind: 'effect' });
  }
}

// (free / exertedFx / fromZone are for effects that play a card — never from a player's action)
H.play = (s, seat, a, ev) => { needMain(s, seat); playCard(s, seat, { ...a, free: false, exertedFx: false, fromZone: null }, ev); };
// a.free: an effect plays it for free (Mickey Mouse - Trumpeter: "Play a character for free" may use an ink Shift — ruling)
function playCard(s, seat, a, ev) {
  // from the hand — or from the discard / under a card when an ability allows it (CR 4.3)
  const c0 = s.cards[a.iid];
  const perm = c0 && c0.zone !== 'hand' && c0.zone !== a.fromZone ? R.playFromPerm(s, seat, c0) : null;
  const from = perm ? c0.zone : a.fromZone && c0?.zone === a.fromZone ? a.fromZone : 'hand';   // "shift a character from your discard
  const c = ownCard(s, seat, a.iid, from);
  const d = D(s, c);
  const p = P(s, seat);
  const mode = a.mode || 'ink';
  const adjust = clampInt(a.costAdjust, -20, 20);
  let how = '';
  let shiftTarget = null;                                          // the card(s) it goes on top of
  let shiftOpt = null;
  let paid = null;                                                  // ink paid to play it (for "pay 2 or less to play")
  let sungBy = [];
  const banned = R.playBlocked(s, seat, c);
  if (banned) throw RE(banned);
  c.paidDrops = 0;                                                  // set again below when ink drops pay for it
  c.sungBy = 0; c.singers = [];                                     // "if a character sang this song, … move them"

  if (mode === 'ink') {
    const auto = R.costDelta(s, seat, c, true);                   // "you pay N {ink} less …"
    const cost = Math.max(0, d.cost + auto + adjust);
    c.paidDrops = payInk(s, seat, cost);
    const notes = [auto ? `${auto} from abilities` : '', adjust ? `adjusted ${adjust > 0 ? '+' : ''}${adjust}` : ''].filter(Boolean).join(', ');
    how = `for ${cost} ink${notes ? ` (cost ${d.cost}, ${notes})` : ''}`;
    paid = cost;
  } else if (mode === 'free') {
    how = 'for free';
  } else if (mode === 'shift') {
    // a: { shiftKind? | shift? (option index), target | targets: [iid, iid] (Duo / Combo), discard?: [hand iids] }
    if (d.type !== 'character') throw RE('Only characters can shift.');
    const opts = shiftOptions(d);
    const opt = Number.isInteger(a.shift) ? opts[a.shift] : opts.find((o) => o.kind === a.shiftKind) || opts[0];
    if (!opt) throw RE(`${cardLabel(d)} doesn't have Shift.`);
    if (!shiftCondOk(s, seat, c, opt)) throw RE(`${cardLabel(d)} doesn't have ${opt.label} right now — its condition isn't met.`);   // "If …, this card gains Shift 0"
    const ts = uniq(Array.isArray(a.targets) ? a.targets : [a.target]).map((id) => s.cards[id]);
    const [lo, hi] = shiftOntoCount(opt);
    if (ts.length < lo || ts.length > hi || ts.some((t) => !t || t.owner !== seat || t.zone !== 'play') || !shiftOntoOk(opt, d, ts.map((t) => D(s, t)))) {
      throw RE(`Choose ${lo === 2 ? 'two' : lo === hi ? 'one' : 'one or two'} of your ${opt.spec.onto.by === 'item' ? 'items' : 'characters'} that ${cardLabel(d)} can shift onto (${opt.label}).`);
    }
    const onto = ts.map((t) => cardLabel(D(s, t))).join(' and ');
    const cost = opt.spec.cost;
    if (cost.ink != null) {
      const n = a.free ? 0 : Math.max(0, cost.ink + R.costDelta(s, seat, c, true, 'shift', ts.map((t) => t.iid)) + adjust);   // "you pay 1 {ink} less to shift …"
      c.paidDrops = payInk(s, seat, n);
      how = `by ${opt.label} onto ${onto} ${a.free ? 'for free' : `for ${n} ink`}`;
      paid = n;
    } else if (cost.inkDrops != null) {                              // "Shift Remove 2 ink drops"
      if ((p.inkDrops || 0) < cost.inkDrops) throw RE(`${opt.label}: remove ${cost.inkDrops} ink drops — you have ${p.inkDrops || 0}.`);
      p.inkDrops -= cost.inkDrops; p.usedDropTurn = s.turn; c.paidDrops = cost.inkDrops; R.fire(s, 'inkDropUsed', { seat });
      how = `by ${opt.label} onto ${onto}, removing ${cost.inkDrops} ink drops`;
    } else if (cost.bottomFromDiscard != null) {                     // "put 5 character cards from your discard on the bottom of your deck in any order"
      const bs = uniq(Array.isArray(a.bottom) ? a.bottom : []).map((id) => s.cards[id]);
      if (bs.length !== cost.bottomFromDiscard || bs.some((x) => !x || x.owner !== seat || x.zone !== 'discard' || (cost.type && D(s, x).type !== cost.type))) {
        throw RE(`${opt.label}: choose ${cost.bottomFromDiscard} ${cost.type || ''} cards from your discard, in the order they go to the bottom of your deck.`);
      }
      for (const x of bs) moveTo(s, x.iid, 'deckBottom', ev);
      how = `by ${opt.label} onto ${onto}, putting ${bs.length} cards from the discard on the bottom of the deck`;
    } else {                                                          // "Shift: Discard an action card"
      const ds = uniq(Array.isArray(a.discard) ? a.discard : []).map((id) => s.cards[id]);
      if (ds.some((x) => !x || x.owner !== seat || x.zone !== 'hand' || x.iid === c.iid) || !shiftDiscardOk(opt, ds.map((x) => D(s, x)))) {
        throw RE(`${opt.label}: choose ${shiftCostLabel(cost).replace(/^discard /, '')} from your hand to discard.`);
      }
      for (const x of ds) { moveTo(s, x.iid, 'discard', ev); R.fire(s, 'discarded', { iid: x.iid, seat }); }
      how = `by ${opt.label} onto ${onto}, discarding ${ds.map((x) => cardLabel(D(s, x))).join(' and ')}`;
    }
    shiftTarget = ts;
    shiftOpt = opt;
  } else if (mode === 'sing' || mode === 'singTogether') {
    if (d.type !== 'song') throw RE('Only songs can be sung.');
    const singers = uniq(Array.isArray(a.singers) ? a.singers : []).map((id) => s.cards[id]);
    if (!singers.length || singers.some((x) => !x || x.owner !== seat || x.zone !== 'play')) throw RE('Choose which of your characters will sing.');
    if (mode === 'sing') {
      if (singers.length !== 1) throw RE('One character sings a song — use Sing Together for more.');
      const why = singerBlocker(singers[0], D(s, singers[0]), d);
      if (why) throw RE(why);
    } else {
      const need = d.kw?.singTogether;
      if (!need) throw RE(`${cardLabel(d)} doesn't have Sing Together.`);
      let total = 0;
      for (const x of singers) {
        const why = singerBlocker(x, D(s, x), null);
        if (why) throw RE(`${cardLabel(D(s, x))}: ${why}`);
        total += singValue(x, D(s, x));
      }
      if (total < need) throw RE(`Your singers total cost ${total}; Sing Together needs ${need}.`);
    }
    for (const x of singers) exertCard(s, x);
    how = `— sung by ${singers.map((x) => cardLabel(D(s, x))).join(' + ')}`;
    ev.push({ k: 'sing', singers: singers.map((x) => x.iid), cardId: d.id });
    sungBy = singers.map((x) => x.iid);
    c.sungBy = sungBy.length; c.singers = [...sungBy];
  } else {
    throw RE('Unknown way to play a card.');
  }

  if (d.type === 'action' || d.type === 'song') {
    ev.push({ k: 'reveal', seat, iid: c.iid, cardId: d.id });
    log(s, `${nameOf(s, seat)} played ${cardLabel(d)} ${how}.`, { seat, kind: 'play' });
    p.playedThisTurn.push(c.iid);
    castSpell(s, seat, c, ev, from === 'under' ? { fromUnder: true } : {});
    // each singer "sings the song" (CR 8.12.3); their triggers join the bag after the song's effect
    for (const iid of sungBy) R.fire(s, 'sings', { iid, song: c.iid });
    R.fire(s, 'play', { iid: c.iid, paid, singers: sungBy });
    return;
  }

  detach(s, c);
  c.parent = null;
  c.zone = 'play';
  c.enteredTurn = s.turn;
  c.mods = [];
  c.damage = 0;
  if (shiftTarget) {
    const ts = shiftTarget;
    // a character below: its state carries over; an item (Potato Shift): dry only if it's been in play since the
    // turn began (8.10.4.1). On two (Duo / Combo): exerted or drying if either one is, damage of both (8.10.4.2, 8.10.6)
    const dryingOf = (t) => (D(s, t).type === 'character' ? !!t.drying : t.enteredTurn === s.turn);
    c.exerted = ts.some((t) => t.exerted);       // 8.10.2
    c.drying = ts.some(dryingOf);                // 8.10.4
    c.damage = ts.reduce((n, t) => n + (t.damage || 0), 0);
    c.atLocation = ts[0].atLocation;
    c.mods = ts.flatMap((t) => t.mods || []);    // keeps effects applied to the character (8.10.5)
    if (a.enterExerted && mayEnterExerted(s, c, d)) c.exerted = true;
    c.under = ts.flatMap((t) => [...t.under, t.iid]);
    p.play[p.play.indexOf(ts[0].iid)] = c.iid;
    for (const t of ts.slice(1)) p.play.splice(p.play.indexOf(t.iid), 1);
    for (const t of ts) { t.zone = 'under'; t.parent = c.iid; t.under = []; t.exerted = false; t.damage = 0; t.mods = []; t.atLocation = null; t.drying = false; }
    for (const u of c.under) s.cards[u].parent = c.iid;
    c.shifted = true;
    if (shiftOpt.spec.temp) c.tempShift = s.turn;                     // 8.10.8.5: back to hand at end of turn
    ev.push({ k: 'shift', iid: c.iid, onto: ts[0].iid, ...(ts.length > 1 ? { also: ts.slice(1).map((t) => t.iid) } : {}) });
  } else {
    c.exerted = d.type === 'character' && !!a.enterExerted && mayEnterExerted(s, c, d);  // 8.3.2
    c.drying = d.type === 'character';
    p.play.push(c.iid);
  }
  ev.push({ k: 'move', iid: c.iid, cardId: c.cardId, from: { seat, zone: from }, to: { seat, zone: 'play' } });
  if (!shiftTarget) R.onEnter(s, c);                                // "enters play exerted / with damage"
  if (perm?.exerted || a.exertedFx) c.exerted = true;               // "If you do, they enter play exerted"
  if (perm?.sameNameBan) (p.nameBans ||= []).push({ name: d.name, turn: s.turn });
  c.enteredExerted = !!c.exerted;                                   // for "may enter play exerted to draw a card"
  p.playedThisTurn.push(c.iid);
  log(s, `${nameOf(s, seat)} played ${cardLabel(d)} ${how}${c.exerted ? ' (entered exerted)' : ''}.`, { seat, kind: 'play' });
  R.fire(s, 'play', { iid: c.iid, paid });
  R.fire(s, 'entersPlay', { iid: c.iid });                          // "whenever another character is played / enters play exerted"
  if (shiftTarget) for (const t of shiftTarget) R.fire(s, 'shiftedOnto', { iid: t.iid, by: c.iid });
}

H.quest = (s, seat, a, ev) => {
  needMain(s, seat);
  const c = ownCard(s, seat, a.iid, 'play');
  const d = D(s, c);
  const why = questBlocker(c, d);
  if (why) throw RE(why);
  payInk(s, seat, kwVal(c, d, 'actCost'));                            // "can't quest or challenge unless you pay 1 {ink}"
  exertCard(s, c);
  const gain = Math.max(0, effLore(c, d));
  gainLore(s, seat, gain, ev);
  ev.push({ k: 'quest', iid: c.iid, lore: gain });
  log(s, `${nameOf(s, seat)} quested with ${cardLabel(d)} for ${gain} lore (${P(s, seat).lore}/${R.rule(s, 'winLore', seat)}).`, { seat, kind: 'quest' });
  R.fire(s, 'quest', { iid: c.iid });
  if (hasKw(c, d, 'support')) {
    const others = P(s, seat).play.some((id) => id !== c.iid && D(s, s.cards[id]).type === 'character');
    if (others) s.pending = { type: 'support', seat, from: c.iid };
    else log(s, `${cardLabel(d)} has Support, but there's no other character to support.`, { seat });
  }
};

H.support = (s, seat, a, ev) => {
  needPlaying(s);
  const pend = s.pending;
  if (!pend || pend.type !== 'support' || pend.seat !== seat) throw RE('There is nothing to Support right now.');
  const from = s.cards[pend.from];
  if (a.target) {
    const t = inPlay(s, a.target);
    const td = D(s, t);
    if (td.type !== 'character' || t.iid === from.iid) throw RE('Support needs another character.');
    if (t.owner !== seat && hasKw(t, td, 'ward')) throw RE("Ward — you can't choose that character.");
    const amt = from.zone === 'play' ? Math.max(0, effStr(from, D(s, from))) : 0;
    t.mods.push({ stat: 'str', delta: amt, until: 'eot', src: 'Support' });
    ev.push({ k: 'mod', iid: t.iid, stat: 'str', delta: amt });
    log(s, `${cardLabel(D(s, from))} supported ${cardLabel(td)} (+${amt} ⚔️ this turn).`, { seat });
    R.fire(s, 'supported', { iid: t.iid, by: from.iid });
  } else {
    log(s, `${nameOf(s, seat)} skipped Support.`, { seat });
  }
  s.pending = null;
};

H.challenge = (s, seat, a, ev) => {
  needMain(s, seat);
  const A = ownCard(s, seat, a.attacker, 'play');
  const Ad = D(s, A);
  let why = attackerBlocker(A, Ad);
  if (why) throw RE(why);
  const T = s.cards[a.target];
  if (!T || T.zone !== 'play' || T.owner === seat) throw RE('Choose an opposing character or location to challenge.');
  const limit = R.rule(s, 'challengesPerTurn', seat);
  if ((s.turnLog || []).filter((e) => e.ev === 'challenges').length >= limit) throw RE(`Only ${limit} challenge${limit === 1 ? '' : 's'} can happen each turn.`);
  const Td = D(s, T);
  why = defenderBlocker(A, Ad, T, Td, sideOf(s, T.owner));
  if (why) throw RE(why);
  payInk(s, seat, kwVal(A, Ad, 'actCost'));
  exertCard(s, A);
  log(s, `⚔️ ${nameOf(s, seat)}'s ${cardLabel(Ad)} challenged ${cardLabel(Td)}.`, { seat, kind: 'challenge' });
  // "whenever this character challenges / is challenged" resolve first, then challenge damage (CR 4.6.5–4.6.6).
  // s.challenge names both sides until the damage resolves ("the challenging player", "while challenging …")
  s.challenge = { a: A.iid, t: T.iid };
  R.fire(s, 'challenges', { iid: A.iid, other: T.iid });
  R.fire(s, 'challenged', { iid: T.iid, other: A.iid });
  R.queue(s, seat, A.iid, 'Challenge', [{ fn: '_challengeDamage', a: A.iid, t: T.iid }]);
};
function challengeDamageStep(s, a, t, ev) {
  const A = s.cards[a]; const T = s.cards[t];
  if (!A || !T || A.zone !== 'play' || T.zone !== 'play') { s.challenge = null; log(s, '↳ The challenge ended — a character left play.', { kind: 'effect' }); return; }
  const Ad = D(s, A); const Td = D(s, T);
  const { toDefender, toAttacker } = challengeDamage(A, Ad, T, Td, { attStat: R.rule(s, 'challengeStat', A.owner), defStat: R.rule(s, 'challengeStat', T.owner) });
  ev.push({ k: 'challenge', a: A.iid, t: T.iid, toA: toAttacker, toT: toDefender });
  log(s, `↳ ${cardLabel(Ad)} dealt ${toDefender}, took ${toAttacker}.`, { kind: 'challenge' });
  dealDamage(s, T.iid, toDefender, ev, { inChallenge: true, by: A.iid });   // dealt at the same time (4.6.6.2)
  dealDamage(s, A.iid, toAttacker, ev, { inChallenge: true, by: T.iid });
  s.challengeCtx = { a, t };
  try { gameStateCheck(s, ev, { force: true }); } finally {
    s.challengeCtx = null; s.challenge = null;
    for (const x of [A, T]) if (x.mods?.length) x.mods = x.mods.filter((m) => m.until !== 'challenge');   // "during that challenge"
  }
  R.fire(s, 'challengeEnd', { iid: a, other: t });                    // "… after the challenge"
}

H.move = (s, seat, a, ev) => {
  needMain(s, seat);
  const C = ownCard(s, seat, a.iid, 'play');
  const Cd = D(s, C);
  if (Cd.type !== 'character') throw RE('Only characters can move to locations.');
  if (hasKw(C, Cd, 'cantMove')) throw RE(`${cardLabel(Cd)} can't move to locations.`);
  const L = s.cards[a.location];
  if (!L || L.owner !== seat || L.zone !== 'play' || D(s, L).type !== 'location') throw RE('Choose one of your locations.');
  const Ld = D(s, L);
  if (C.atLocation === L.iid) throw RE(`${cardLabel(Cd)} is already at ${cardLabel(Ld)}.`);
  const md = R.moveDelta(s, seat, C, L);                            // "may move here for free" · "pay 1 {ink} less to move"
  const cost = md.free ? 0 : Math.max(0, (Ld.move ?? 0) + md.delta + clampInt(a.costAdjust, -20, 20));
  payInk(s, seat, cost);
  for (const u of md.used || []) s.cards[u].onceMove = s.turn;       // "once during your turn, you may pay 1 {ink} less to move …"
  log(s, `${nameOf(s, seat)} moved ${cardLabel(Cd)} to ${cardLabel(Ld)} for ${cost} ink.`, { seat });
  moveChar(s, C.iid, L.iid, ev);
};

H.boost = (s, seat, a, ev) => {
  needMain(s, seat);
  const C = ownCard(s, seat, a.iid, 'play');
  const Cd = D(s, C);
  const n = Cd.kw?.boost;
  if (typeof n !== 'number') throw RE(`${cardLabel(Cd)} doesn't have Boost.`);
  if (C.boostedTurn === s.turn) throw RE('Boost can only be used once per turn.');
  const p = P(s, seat);
  if (!p.deck.length) throw RE('Your deck is empty.');
  payInk(s, seat, n);
  C.boostedTurn = s.turn;
  putUnder(s, seat, C.iid, ev);
  log(s, `${nameOf(s, seat)} used Boost ${n} on ${cardLabel(Cd)} — the top card of their deck went facedown under it.`, { seat });
  R.fire(s, 'boosted', { iid: C.iid, seat });                       // "whenever you use the Boost ability of a character"
};

// CR 4.4: use an activated ability — pay its cost, then its effect resolves (an {exert} cost needs a dry character, 4.4.2)
H.useAbility = (s, seat, a, ev) => {
  needMain(s, seat);
  // "you may <cost> to play this character for free" — an ability used from the hand
  if (s.cards[a.iid]?.zone === 'hand') {
    const C = ownCard(s, seat, a.iid, 'hand');
    if (R.activate(s, seat, C, clampInt(a.index, 0, 50, -1), ev)) return;
    throw RE('No such ability.');
  }
  const C = ownCard(s, seat, a.iid, 'play');
  const Cd = D(s, C);
  if (R.activate(s, seat, C, clampInt(a.index, 0, 50, -1), ev)) return;      // own or granted ability
  const ab = Cd.abilities[clampInt(a.index, 0, 50, -1)];
  if (!ab) throw RE('No such ability.');
  const cost = parseActivatedCost(ab.text);
  const paid = [];
  if (cost) {
    if (cost.exert) {
      if (Cd.type === 'location') throw RE("Locations can't exert.");
      if (C.exerted) throw RE('It is exerted — this ability costs ⟳.');
      if (Cd.type === 'character' && C.drying) throw RE("Characters can't ⟳ the turn they're played (drying).");
    }
    payInk(s, seat, cost.ink);
    if (cost.exert) { exertCard(s, C); paid.push('⟳'); }
    if (cost.ink) paid.push(`${cost.ink} ink`);
  }
  log(s, `${nameOf(s, seat)} used ${cardLabel(Cd)}'s ${ab.name || 'ability'}${paid.length ? ` (paid ${paid.join(' + ')})` : ''}.`, { seat, kind: 'play' });
  log(s, `↳ ${prettyText(cost ? cost.effect : ab.text)}`, { kind: 'effect' });
  ev.push({ k: 'ability', iid: C.iid, index: a.index });
};

H.endTurn = (s, seat, a, ev) => {
  needPlaying(s);
  if (s.active !== seat) throw RE("It's not your turn.");
  if (s.pending) throw RE('Resolve the pending choice first.');
  if (!a.force) {
    const r = recklessBlockers(s, seat);
    if (r.length) throw RE(`Reckless: ${r.map((id) => cardLabel(D(s, s.cards[id]))).join(', ')} must challenge if able. (Force end turn to override.)`);
    const q = mustQuestBlockers(s, seat);
    if (q.length) throw RE(`${q.map((id) => cardLabel(D(s, s.cards[id]))).join(', ')} must quest if able. (Force end turn to override.)`);
  }
  log(s, `${nameOf(s, seat)} ended their turn.`, { seat });
  turnPhase(s, seat, ev, 'end');                                   // 3.4
};
// Temporary Shift (8.10.8.5): remove all damage and return only the top card — the one under it stays in play
function returnTopOnly(s, iid, ev) {
  const c = s.cards[iid];
  const p = P(s, c.owner);
  const under = c.under; c.under = []; c.damage = 0;
  const prev = under.pop();
  if (prev != null) {
    const t = s.cards[prev];
    t.zone = 'play'; t.parent = null; t.under = under; t.exerted = c.exerted; t.atLocation = c.atLocation; t.drying = false; t.damage = 0; t.mods = [];
    for (const u of under) s.cards[u].parent = t.iid;
    p.play.splice(p.play.indexOf(iid) + 1, 0, t.iid);
    ev.push({ k: 'move', iid: t.iid, cardId: t.cardId, from: { seat: c.owner, zone: 'under' }, to: { seat: c.owner, zone: 'play' } });
  }
  log(s, `↳ Temporary Shift: ${cardLabel(D(s, c))} returned to ${nameOf(s, c.owner)}'s hand.`, { kind: 'effect' });
  moveTo(s, iid, 'hand', ev);
}

H.concede = (s, seat, a, ev) => {
  if (s.status === 'over') throw RE('The game is already over.');
  const others = opponentsOf(s, seat);
  log(s, `${nameOf(s, seat)} conceded.`, { seat });
  if (s.status === 'mulligan') s.status = 'playing';
  win(s, others[0], `${nameOf(s, seat)} conceded`, ev);
};

// ----- manual "effect" tools (anyone can use them; everything is logged) -----

H.damage = (s, seat, a, ev) => {
  needPlaying(s);
  const c = inPlay(s, a.iid);
  const d = D(s, c);
  if (d.type !== 'character' && d.type !== 'location') throw RE('Only characters and locations take damage.');
  const delta = clampInt(a.delta, -20, 20);
  if (!delta) return;
  const before = c.damage;
  c.damage = Math.max(0, c.damage + delta);
  const n = c.damage - before;
  if (!n) return;
  ev.push({ k: 'damage', iid: c.iid, n });
  log(s, `${nameOf(s, seat)} ${n > 0 ? 'put' : 'removed'} ${Math.abs(n)} damage ${n > 0 ? 'on' : 'from'} ${cardLabel(d)} (now ${c.damage}/${effWp(c, d)}).`, { seat, kind: 'manual' });
};

H.lore = (s, seat, a, ev) => {
  needPlaying(s);
  const target = a.seat == null ? seat : clampInt(a.seat, 0, s.players.length - 1);
  const delta = clampInt(a.delta, -20, 20);
  const before = P(s, target).lore;
  gainLore(s, target, delta, ev);
  const now = P(s, target).lore;
  if (now === before) return;
  log(s, `${nameOf(s, seat)} ${now > before ? 'added' : 'removed'} ${Math.abs(now - before)} lore ${target === seat ? '' : `${now > before ? 'to' : 'from'} ${nameOf(s, target)} `}(${nameOf(s, target)}: ${now}/${R.rule(s, 'winLore', target)}).`, { seat, kind: 'manual' });
};

H.exert = (s, seat, a, ev) => {
  needPlaying(s);
  const c = inPlay(s, a.iid);
  const d = D(s, c);
  if (d.type === 'location') throw RE("Locations can't be exerted or readied.");
  const want = !!a.exerted;
  if (c.exerted === want) return;
  c.exerted = want;
  log(s, `${nameOf(s, seat)} ${want ? 'exerted' : 'readied'} ${cardLabel(d)}.`, { seat, kind: 'manual' });
};

H.inkPay = (s, seat, a, ev) => {      // exert (pay) or ready ink cards by hand
  needPlaying(s);
  const p = P(s, seat);
  const n = clampInt(a.delta, -20, 20);
  if (n > 0) {
    payInk(s, seat, n);
    log(s, `${nameOf(s, seat)} paid ${n} ink.`, { seat, kind: 'manual' });
  } else if (n < 0) {
    let k = 0;
    for (const iid of p.inkwell) { if (k >= -n) break; if (s.cards[iid].exerted) { s.cards[iid].exerted = false; k++; } }
    if (k) log(s, `${nameOf(s, seat)} readied ${k} ink.`, { seat, kind: 'manual' });
  }
};

H.extraInk = (s, seat, a, ev) => {
  needMain(s, seat);
  P(s, seat).extraInk += 1;
  log(s, `${nameOf(s, seat)} may put an additional card into their inkwell this turn.`, { seat, kind: 'manual' });
};

H.draw = (s, seat, a, ev) => {
  needPlaying(s);
  const n = clampInt(a.n, 1, 10, 1);
  const { drawn, names } = drawCards(s, seat, n, ev);
  if (drawn) log(s, `${nameOf(s, seat)} drew ${drawn} card${drawn === 1 ? '' : 's'}.`, { seat, kind: 'manual', priv: { seat, text: `You drew ${names.join(', ')}.` } });
};

H.mill = (s, seat, a, ev) => {
  needPlaying(s);
  const target = a.seat == null ? seat : clampInt(a.seat, 0, s.players.length - 1);
  const n = clampInt(a.n, 1, 20, 1);
  const p = P(s, target);
  const names = [];
  for (let i = 0; i < n && p.deck.length; i++) {
    const iid = p.deck[0];
    names.push(cardLabel(D(s, s.cards[iid])));
    moveTo(s, iid, 'discard', ev);
  }
  if (names.length) log(s, `${nameOf(s, seat)} put the top ${names.length} card${names.length === 1 ? '' : 's'} of ${target === seat ? 'their' : `${nameOf(s, target)}'s`} deck into the discard: ${names.join(', ')}.`, { seat, kind: 'manual' });
};

H.shuffle = (s, seat, a, ev) => {
  needPlaying(s);
  shuffleArr(s, P(s, seat).deck);
  P(s, seat).peek = [];
  ev.push({ k: 'shuffle', seat });
  log(s, `${nameOf(s, seat)} shuffled their deck.`, { seat, kind: 'manual' });
};

const MOVE_TARGETS = new Set(['hand', 'discard', 'deckTop', 'deckBottom', 'inkwell', 'play']);
H.moveCard = (s, seat, a, ev) => {
  needPlaying(s);
  const c = s.cards[a.iid];
  if (!c) throw RE('No such card.');
  const to = String(a.to || '');
  if (!MOVE_TARGETS.has(to)) throw RE('Unknown destination.');
  const p = P(s, c.owner);
  const fromPublic = PUBLIC_ZONES.has(c.zone);
  if (c.zone === 'under') throw RE('Cards under another card move together with it.');
  if (c.zone === 'inkwell') throw RE("Cards in an inkwell can't be looked at — move them with a specific effect.");
  if (!fromPublic && c.owner !== seat) throw RE("You can only move your own hidden cards.");
  if (c.zone === 'deck' && !p.peek.includes(c.iid)) throw RE('Cards can only leave your deck through an effect (Draw / Look at top).');
  if (to === 'play' && c.owner !== seat) throw RE("You can't put cards into another player's play area.");
  const d = D(s, c);
  if (to === 'play' && (d.type === 'action' || d.type === 'song')) throw RE('Actions resolve and go to the discard — play them from your hand instead.');
  const from = c.zone;
  const wasPublic = fromPublic;
  moveTo(s, c.iid, to, ev, { exerted: !!a.exerted });
  p.peek = p.peek.filter((x) => x !== c.iid);
  const dest = { hand: 'hand', discard: 'discard', deckTop: 'top of deck', deckBottom: 'bottom of deck', inkwell: 'inkwell (facedown)', play: 'play' }[to];
  const owner = c.owner === seat ? 'their' : `${nameOf(s, c.owner)}'s`;
  const shown = wasPublic || PUBLIC_ZONES.has(to) ? cardLabel(d) : 'a card';
  log(s, `${nameOf(s, seat)} moved ${shown} from ${owner} ${ZONE_NAME[from]} to ${dest}.`, {
    seat, kind: 'manual', priv: shown === 'a card' ? { seat, text: `You moved ${cardLabel(d)} from your ${ZONE_NAME[from]} to ${dest}.` } : null,
  });
};

H.reveal = (s, seat, a, ev) => {
  needPlaying(s);
  const c = ownCard(s, seat, a.iid, 'hand');
  ev.push({ k: 'reveal', seat, iid: c.iid, cardId: c.cardId });
  log(s, `${nameOf(s, seat)} revealed ${cardLabel(D(s, c))} from their hand.`, { seat, kind: 'manual' });
};

H.revealHand = (s, seat, a, ev) => {
  needPlaying(s);
  const names = P(s, seat).hand.map((id) => cardLabel(D(s, s.cards[id])));
  log(s, `${nameOf(s, seat)} revealed their hand: ${names.join(', ') || '(empty)'}.`, { seat, kind: 'manual' });
};

H.peek = (s, seat, a, ev) => {
  needPlaying(s);
  const p = P(s, seat);
  const n = clampInt(a.n, 1, 10, 1);
  p.peek = p.deck.slice(0, n);
  log(s, `${nameOf(s, seat)} looked at the top ${p.peek.length} card${p.peek.length === 1 ? '' : 's'} of their deck.`, { seat, kind: 'manual' });
};

// placements: [{ iid, to: 'top'|'bottom'|'hand'|'discard'|'inkwell' }] — "top" entries in order, first = top.
H.resolvePeek = (s, seat, a, ev) => {
  needPlaying(s);
  const p = P(s, seat);
  const places = Array.isArray(a.placements) ? a.placements : [];
  const valid = places.filter((x) => p.peek.includes(x.iid) && p.deck.includes(x.iid));
  const tops = [];
  const counts = { top: 0, bottom: 0, hand: 0, discard: 0, inkwell: 0 };
  const shown = [];
  for (const x of valid) {
    const to = ['top', 'bottom', 'hand', 'discard', 'inkwell'].includes(x.to) ? x.to : 'top';
    const c = s.cards[x.iid];
    counts[to]++;
    if (to === 'top') { tops.push(x.iid); continue; }
    if (to === 'discard') shown.push(cardLabel(D(s, c)));
    moveTo(s, x.iid, to === 'bottom' ? 'deckBottom' : to, ev);
  }
  for (const iid of tops) p.deck.splice(p.deck.indexOf(iid), 1);
  p.deck.unshift(...tops);
  p.peek = [];
  const parts = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k === 'top' ? 'on top' : k === 'bottom' ? 'on the bottom' : `into ${k === 'hand' ? 'hand' : k}`}`);
  log(s, `${nameOf(s, seat)} put ${parts.join(', ') || 'nothing'}${shown.length ? ` (discarded ${shown.join(', ')})` : ''}.`, { seat, kind: 'manual' });
};

const MOD_STATS = new Set(['str', 'wp', 'lore', 'sing', 'kw', 'class']);
H.mod = (s, seat, a, ev) => {
  needPlaying(s);
  const c = inPlay(s, a.iid);
  const d = D(s, c);
  const stat = String(a.stat || '');
  if (!MOD_STATS.has(stat)) throw RE('Unknown stat.');
  if (stat === 'kw' && !KEYWORD_LABEL[a.kw]) throw RE('Unknown keyword.');
  const delta = clampInt(a.delta, -20, 20);
  if (!delta) return;
  const until = a.until === 'perm' ? 'perm' : 'eot';
  c.mods.push({ stat, delta, until, kw: stat === 'kw' ? a.kw : undefined, src: 'manual' });
  ev.push({ k: 'mod', iid: c.iid, stat, delta });
  const what = stat === 'kw' ? `${delta > 0 ? 'gains' : 'loses'} ${KEYWORD_LABEL[a.kw]}${Math.abs(delta) > 1 ? ` ${Math.abs(delta)}` : ''}`
    : `${delta > 0 ? '+' : ''}${delta} ${{ str: '⚔️', wp: '🛡️', lore: '◆', sing: 'sing cost' }[stat]}`;
  log(s, `${nameOf(s, seat)}: ${cardLabel(d)} ${what} ${until === 'eot' ? 'this turn' : 'while in play'}.`, { seat, kind: 'manual' });
};

H.clearMods = (s, seat, a, ev) => {
  needPlaying(s);
  const c = inPlay(s, a.iid);
  if (!c.mods.length) return;
  c.mods = [];
  log(s, `${nameOf(s, seat)} cleared all modifiers on ${cardLabel(D(s, c))}.`, { seat, kind: 'manual' });
};

// ---------- proc runtime ----------

export const ENGINE = {
  D, P, nameOf, log, cardLabel, prettyText, KEYWORD_LABEL, LORE_TO_WIN, RE,
  effStr, effWp, effLore, kwVal, hasKw, rand, shuffleArr, readyInk, payInk, opponentsOf,
  moveTo, banish, dealDamage, drawCards, gainLore, gameStateCheck, playFree, playCard, challengeDamageStep, turnPhase, putUnder, moveChar, exertCard,
};
const R = createRuntime(ENGINE);
// restrictions that name a query ("can't be challenged by characters with cost 3 or less") — see rules.js
setQueryHook((F, card, def, ctl) => Query.matches(F, card, def, { E: ENGINE, s: null, ctl, src: null }, { anyZone: true }));

// ---------- public API ----------

export function applyAction(s, seat, a) {
  try {
    needSeat(s, seat);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const handler = a && typeof a.type === 'string' && Object.hasOwn(H, a.type) ? H[a.type] : null;
  if (!handler) return { ok: false, error: `Unknown action: ${a?.type}` };
  const backup = structuredClone(s);
  const ev = [];
  try {
    handler(s, seat, a, ev);
    gameStateCheck(s, ev);
    R.pump(s, ev);
    gameStateCheck(s, ev);
    return { ok: true, events: ev };
  } catch (e) {
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, backup);
    if (e instanceof RuleError) return { ok: false, error: e.message };
    console.error('[engine] action crashed', a, e);
    return { ok: false, error: 'Internal error: ' + e.message };
  }
}

function publicCard(s, c) {
  const d = D(s, c);
  const isUnit = d.type === 'character' || d.type === 'location';
  return {
    iid: c.iid,
    cardId: c.cardId,
    owner: c.owner,
    exerted: c.exerted,
    damage: c.damage,
    drying: c.drying,
    atLocation: c.atLocation,
    enteredTurn: c.enteredTurn,
    boostedTurn: c.boostedTurn,
    mods: c.mods.filter((m) => m.stat !== 'grant').map((m) => ({ stat: m.stat, delta: m.delta, until: m.until, kw: m.kw, src: m.src })),
    // abilities other cards gave it; `index` is what useAbility takes (after the card's own abilities)
    granted: c.mods.filter((m) => m.stat === 'grant').map((m, k) => ({ text: m.proc.text, kind: m.proc.kind, src: m.src, until: m.until, index: (d.procs || []).length + k })),
    under: c.under.map((u) => (s.cards[u].faceDown ? { faceDown: true } : { iid: u, cardId: s.cards[u].cardId })),
    eff: isUnit ? { str: d.type === 'character' ? effStr(c, d) : null, wp: effWp(c, d), lore: effLore(c, d) } : null,
    kw: effectiveKeywords(c, d),
  };
}

// The game as one seat is allowed to see it (seat -1 = spectator).
export function viewFor(s, seat) {
  return {
    you: seat,
    status: s.status,
    turn: s.turn,
    active: s.active,
    starting: s.starting,
    winner: s.winner,
    endReason: s.endReason,
    pending: s.pending ? { ...s.pending, valid: s.pending.seat === seat ? s.pending.valid : undefined, cards: s.pending.seat === seat ? s.pending.cards : undefined } : null,
    players: s.players.map((p, i) => ({
      seat: i,
      name: p.name,
      lore: p.lore,
      deckCount: p.deck.length,
      deckTop: p.deck.length && R.rule(s, 'topFaceUp', p.seat) ? { iid: p.deck[0], cardId: s.cards[p.deck[0]].cardId } : null,   // "plays with the top card of their deck face up"
      handCount: p.hand.length,
      hand: i === seat ? p.hand.map((iid) => ({ iid, cardId: s.cards[iid].cardId })) : null,
      inkTotal: p.inkwell.length,
      inkReady: readyInk(s, p.seat),
      inkDrops: p.inkDrops || 0,
      inkedThisTurn: p.inkedThisTurn,
      inkLimit: R.rule(s, 'inksPerTurn', p.seat) + p.extraInk,
      rules: { winLore: R.rule(s, 'winLore', p.seat), handInkable: R.rule(s, 'handInkable', p.seat), inkFromDiscard: R.rule(s, 'inkFromDiscard', p.seat) },
      // cards outside the hand an ability lets this player play right now ("you may play characters from your discard")
      playableFrom: i === seat && s.status === 'playing' && s.active === seat
        ? [...p.discard, ...p.play.flatMap((id) => s.cards[id].under)].filter((iid) => R.playFromPerm(s, seat, s.cards[iid])) : [],
      mulliganDone: p.mulligan.done,
      mulliganCount: p.mulligan.done ? p.mulligan.count : null,
      discard: p.discard.map((iid) => ({ iid, cardId: s.cards[iid].cardId })),
      play: p.play.map((iid) => publicCard(s, s.cards[iid])),
      peek: i === seat ? p.peek.map((iid) => ({ iid, cardId: s.cards[iid].cardId })) : null,
    })),
    log: s.log.slice(-150).map((l) => ({ n: l.n, kind: l.kind, seat: l.seat, text: l.priv && l.priv.seat === seat ? l.priv.text : l.text })),
  };
}

// Strip private details from engine events for one viewer.
export function eventsFor(events, seat) {
  const out = [];
  for (const e of events || []) {
    if (!('privateTo' in e)) { out.push(e); continue; }
    if (e.privateTo === seat) {
      const { privateTo, redacted, ...rest } = e;
      out.push(rest);
    } else if (e.redacted) {
      out.push(e.redacted);
    }
  }
  return out;
}

// Card defs a given view references (so the client can render them).
export function defsInView(s, view) {
  const ids = new Set();
  for (const p of view.players) {
    for (const c of p.hand || []) ids.add(c.cardId);
    for (const c of p.discard) ids.add(c.cardId);
    for (const c of p.peek || []) ids.add(c.cardId);
    if (p.deckTop) ids.add(p.deckTop.cardId);
    for (const c of p.play) { ids.add(c.cardId); for (const u of c.under) if (u.cardId) ids.add(u.cardId); }
  }
  return ids;
}

// Sanity check used by tests: every card is in exactly one place.
export function checkInvariants(s) {
  const seen = new Map();
  const mark = (iid, where) => {
    if (seen.has(iid)) throw new Error(`card ${iid} in two places: ${seen.get(iid)} and ${where}`);
    seen.set(iid, where);
  };
  for (const p of s.players) {
    for (const z of ['deck', 'hand', 'play', 'inkwell', 'discard']) {
      for (const iid of p[z]) {
        mark(iid, `${p.seat}:${z}`);
        const c = s.cards[iid];
        if (c.zone !== z) throw new Error(`card ${iid} zone mismatch ${c.zone} vs ${z}`);
        if (c.owner !== p.seat) throw new Error(`card ${iid} owner mismatch`);
        if (z === 'play') for (const u of c.under) {
          mark(u, `${p.seat}:under:${iid}`);
          if (s.cards[u].zone !== 'under' || s.cards[u].parent !== iid) throw new Error(`under card ${u} bad link`);
        }
      }
    }
    if (p.lore < 0) throw new Error('negative lore');
  }
  const total = Object.keys(s.cards).length;
  if (seen.size !== total) throw new Error(`card count mismatch: ${seen.size} placed vs ${total}`);
  return true;
}
