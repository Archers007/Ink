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
import { PayInk, CostMod, SelfCost, Enters } from './ink.js';
import { ChooseOne } from './chooseOne.js';
import { ChallengeDamage, EndTurn } from './internal.js';

export const EFFECTS = [
  Draw, GainLore, LoseLore, Damage, Heal, MoveDamage, Banish, FromDiscard, ToHand, ToDeckBottom, ShuffleIn,
  InkTop, Mill, ToInkwell, Exert, Ready, Discard, OppChoose, PlayFree, PayInk, Look, Shuffle, CostMod, Mod,
  ChooseOne, SelfCost, Enters, ChallengeDamage, EndTurn,
];
export const EFFECT = Object.fromEntries(EFFECTS.map((C) => [C.fn, C]));
export { Look, Mod };
export { kwList } from './mod.js';
