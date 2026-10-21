// Effect registry. Order = clause parse priority (first rule that matches wins), so the more
// specific phrasings come first: fromDiscard before toHand, inkTop before toInkwell.
import { Draw } from './draw.js';
import { GainLore, LoseLore } from './lore.js';
import { Damage, Heal, MoveDamage } from './damage.js';
import { Banish, ToHand, ToDeckBottom, ShuffleIn, ToInkwell } from './zones.js';
import { InkTop, Mill, Shuffle } from './deck.js';
import { Exert, Ready } from './exert.js';
import { Mod } from './mod.js';
import { Discard } from './discard.js';
import { OppChoose } from './oppChoose.js';
import { FromDiscard, PlayFree } from './discardZone.js';
import { Look } from './look.js';
import { PayInk, CostMod, SelfCost, Enters, InkDrop } from './ink.js';
import { ChooseOne } from './chooseOne.js';
import { Reveal, ToDeckTop, ToDiscard, PutInHand, PlayIt, RevealHandDiscard, PeekHand } from './reveal.js';
import { PutUnder, MoveFree } from './board.js';
import { ChallengeDamage, EndTurn } from './internal.js';

export const EFFECTS = [
  Reveal, RevealHandDiscard, PeekHand, PutInHand, PlayIt, PutUnder, MoveFree,
  Draw, GainLore, LoseLore, Damage, Heal, MoveDamage, Banish, FromDiscard, ToHand, ToDeckBottom, ShuffleIn,
  InkTop, Mill, ToDeckTop, ToDiscard, ToInkwell, Exert, Ready, Discard, OppChoose, PlayFree, PayInk, InkDrop, Look, Shuffle, CostMod, Mod,
  ChooseOne, SelfCost, Enters, ChallengeDamage, EndTurn,
];
export const EFFECT = Object.fromEntries(EFFECTS.map((C) => [C.fn, C]));
export { Look, Mod };
export { kwList } from './mod.js';
