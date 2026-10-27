// One recorded game for deck analysis: the tested deck (seat `me`) against an opponent deck, both piloted by the
// same bot ('quick' = bot.js heuristics, 'smart' = the search bot). Records what an analysis needs, from the
// tested seat's side only: opening hand and mulligan, per own turn the hand size, ink, cards inked and played,
// unused ink, lore, which of its cards were on the board together, and the result.
//
// onFrame (optional): called after every action with a fair view of the game (the tested seat's), for a live
// preview; with paceMs the game waits that long between actions so a person can follow it.
import { newGame, applyAction, viewFor, readyInk, D } from '../engine.js';
import { botDecide } from '../bot.js';
import { createSearchBot } from '../searchbot.js';

const MAX_STEPS = 3000;

function fallback(s, seat) {
  if (s.pending?.seat === seat) {
    let r = applyAction(s, seat, s.pending.type === 'support' ? { type: 'support' } : { type: 'choose', skip: true });
    if (!r.ok && s.pending?.valid?.length) r = applyAction(s, seat, { type: 'choose', target: s.pending.valid[0] });
    return r;
  }
  return applyAction(s, seat, { type: 'endTurn', force: true });
}

export async function playGame({ deck, oppDeck, me, seed, pilot = 'quick', budgetMs = 120, onFrame = null, paceMs = 0 }) {
  const s = newGame({ seed, players: me === 0 ? [{ name: 'Tested deck', deck }, { name: 'Opponent', deck: oppDeck }] : [{ name: 'Opponent', deck: oppDeck }, { name: 'Tested deck', deck }] });
  const opp = 1 - me;
  const search = pilot === 'smart' ? createSearchBot({ budgetMs }) : null;
  const memory = [{}, {}];
  const decide = (seat) => (search ? search.decide(s, seat, memory[seat]) : botDecide(s, seat));
  const name = (iid) => D(s, s.cards[iid]).full;

  const rec = { first: s.starting === me, opening: [], shipped: [], turns: [], win: false, endTurn: 0, lore: [0, 0], endHand: [], reason: '' };
  let cur = null;                 // the tested seat's current turn
  const closeTurn = () => {
    if (!cur) return;
    const p = s.players[me];
    const inkNow = new Set(p.inkwell);
    cur.inked = [...inkNow].filter((iid) => !cur.inkBefore.has(iid)).map(name);
    cur.played = p.playedThisTurn.filter((iid) => s.cards[iid]).map(name);
    cur.unusedInk = readyInk(s, me);
    cur.loreEnd = p.lore;
    cur.oppLore = s.players[opp].lore;
    const board = [...new Set(p.play.map(name))];
    cur.board = board;
    cur.oppBoard = s.players[opp].play.filter((iid) => D(s, s.cards[iid]).type === 'character').length;
    delete cur.inkBefore;
    rec.turns.push(cur);
    cur = null;
  };

  let steps = 0, lastTurn = -1;
  while (s.status !== 'over' && steps++ < MAX_STEPS) {
    if (s.status === 'playing' && s.turn !== lastTurn) {
      if (cur && s.active !== me) closeTurn();
      lastTurn = s.turn;
      if (s.active === me) {
        const p = s.players[me];
        cur = { n: rec.turns.length + 1, hand: p.hand.length, ink: p.inkwell.length, inkBefore: new Set(p.inkwell), hadInkable: p.hand.some((iid) => D(s, s.cards[iid]).inkable), quests: 0, challenges: 0 };
        if (rec.turns.length === 0 && !rec.opening.length) rec.opening = p.hand.map(name);
      }
    }
    let acted = false;
    for (const seat of [0, 1]) {
      const a = decide(seat);
      if (!a) continue;
      if (seat === me && a.type === 'mulligan') {
        const ids = new Set(a.iids);
        rec.shipped = s.players[me].hand.filter((iid) => ids.has(iid)).map(name);
      }
      if (seat === me && cur && a.type === 'endTurn') closeTurn();
      let r = applyAction(s, seat, a);
      if (r.ok && seat === me && cur) { if (a.type === 'quest') cur.quests++; if (a.type === 'challenge') cur.challenges++; }
      if (!r.ok) r = fallback(s, seat);
      acted = r.ok;
      if (onFrame) {
        const v = viewFor(s, me);
        onFrame({
          turn: v.turn, active: v.active === me ? 'you' : 'opp', status: v.status,
          me: { lore: v.players[me].lore, hand: (v.players[me].hand || []).map((c) => c.cardId), ink: v.players[me].inkTotal, play: v.players[me].play.map((c) => ({ cardId: c.cardId, exerted: c.exerted, damage: c.damage })) },
          opp: { lore: v.players[opp].lore, hand: v.players[opp].handCount, ink: v.players[opp].inkTotal, play: v.players[opp].play.map((c) => ({ cardId: c.cardId, exerted: c.exerted, damage: c.damage })) },
          log: v.log.slice(-6).map((l) => l.text),
        });
        if (paceMs) await new Promise((res) => setTimeout(res, paceMs));
      }
      break;
    }
    if (!acted && s.status !== 'over') break;
  }
  if (cur) closeTurn();
  if (!rec.opening.length) rec.opening = [];
  rec.win = s.winner === me;
  rec.draw = s.winner == null;
  rec.endTurn = rec.turns.length;
  rec.lore = [s.players[me].lore, s.players[opp].lore];
  rec.endHand = s.players[me].hand.map(name);
  rec.reason = s.endReason || (s.status === 'over' ? '' : 'unfinished');
  return rec;
}
