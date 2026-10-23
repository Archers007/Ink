// Who acts — the player a clause is about: "each opponent chooses and discards a card", "chosen player draws 5
// cards", "that player discards a card at random", "the challenging player chooses and discards a card".
// The clause after it compiles in the 2nd person and runs as that player (effects/meta.js EachPlayer).
//
//   who   'each' · 'opp' · 'chosenPlayer' · 'chosenOpp' · 'refOwner' (the last card's player) · 'challenger'
export const PLAYERS = [
  [String.raw`each player|all players|the player or players`, 'each'],
  [String.raw`each opponent|each opposing player|all opponents|your opponents|opponents`, 'opp'],
  [String.raw`chosen player`, 'chosenPlayer'],
  [String.raw`chosen opponent|an opponent of your choice`, 'chosenOpp'],
  [String.raw`the challenging player|the challenging character's player`, 'challenger'],
  [String.raw`that player|its player|their player|that character's player|its owner|that card's player|that card's owner|the chosen character's player`, 'refOwner'],
];
// "… with more lore than you" · "… with fewer than 3 cards in their hand" · "… with the most cards in their hand(s)"
const IF = String.raw`with more lore than you|with (?:fewer|more) than \d+ cards in (?:their|your) (?:hands?|inkwells?)|with the most cards in (?:their|your) hands?|who has the most cards in (?:their|your) hand`;
export const PLAYER_RX = new RegExp(String.raw`^(?:have )?(${PLAYERS.map(([w]) => w).join('|')})(?: (${IF}))?(?: (may))? (.+)$`, 'i');
export function playerIf(t) {
  if (!t) return null;
  let m;
  if (/more lore than you/i.test(t)) return { moreLore: true };
  if (/the most cards/i.test(t)) return { mostHand: true };
  if ((m = t.match(/(fewer|more) than (\d+) cards in (?:their|your) (hand|inkwell)/i))) return { [m[3].toLowerCase()]: /fewer/i.test(m[1]) ? { lt: +m[2] } : { gt: +m[2] } };
  return null;
}
export function playerPasses(rt, s, seat, ctl, w) {
  const P = (x) => rt.E.P(s, x);
  if (w.moreLore) return P(seat).lore > P(ctl).lore;
  if (w.mostHand) return P(seat).hand.length === Math.max(...s.players.filter((p) => !p.out).map((p) => P(p.seat).hand.length));
  for (const z of ['hand', 'inkwell']) if (w[z]) { const n = P(seat)[z].length; if ((w[z].lt != null && !(n < w[z].lt)) || (w[z].gt != null && !(n > w[z].gt))) return false; }
  return true;
}
export const playerOf = (w) => PLAYERS.find(([rx]) => new RegExp(`^(?:${rx})$`, 'i').test(w))?.[1];
export const PLAYER_SAY = { each: 'each player', opp: 'each opponent', chosenPlayer: 'chosen player', chosenOpp: 'chosen opponent', refOwner: "that card's player", challenger: 'the challenging player', chooser: 'that opponent', you: 'you' };
