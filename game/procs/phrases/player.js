// Who acts — the player a clause is about: "each opponent chooses and discards a card", "chosen player draws 5
// cards", "that player discards a card at random", "the challenging player chooses and discards a card".
// The clause after it compiles in the 2nd person and runs as that player (effects/meta.js EachPlayer).
//
//   who   'each' · 'opp' · 'chosenPlayer' · 'chosenOpp' · 'refOwner' (the last card's player) · 'challenger'
export const PLAYERS = [
  [String.raw`each player|all players`, 'each'],
  [String.raw`each opponent|each opposing player|all opponents|your opponents|opponents`, 'opp'],
  [String.raw`chosen player`, 'chosenPlayer'],
  [String.raw`chosen opponent|an opponent of your choice`, 'chosenOpp'],
  [String.raw`the challenging player|the challenging character's player`, 'challenger'],
  [String.raw`that player|its player|their player|that character's player|its owner|that card's player|that card's owner|the chosen character's player`, 'refOwner'],
];
export const PLAYER_RX = new RegExp(String.raw`^(?:have )?(${PLAYERS.map(([w]) => w).join('|')})(?: (may))? (.+)$`, 'i');
export const playerOf = (w) => PLAYERS.find(([rx]) => new RegExp(`^(?:${rx})$`, 'i').test(w))?.[1];
export const PLAYER_SAY = { each: 'each player', opp: 'each opponent', chosenPlayer: 'chosen player', chosenOpp: 'chosen opponent', refOwner: "that card's player", challenger: 'the challenging player', you: 'you' };
