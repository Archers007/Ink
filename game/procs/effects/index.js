// Effect registry. Order = clause parse priority (first rule that matches wins), so the more
// specific phrasings come first: fromDiscard before toHand, inkTop before toInkwell.
import { Draw, DrawUntil } from './draw.js';
import { GainLore, LoseLore } from './lore.js';
import { Damage, Heal, MoveDamage } from './damage.js';
import { Banish, ToHand, ToDeckBottom, ShuffleIn, ToInkwell, FromUnder } from './zones.js';
import { InkTop, Mill, Shuffle, Search } from './deck.js';
import { PlayBan, SelfBan, ShiftAs } from './playBan.js';
import { Exert, Ready } from './exert.js';
import { Mod } from './mod.js';
import { Discard } from './discard.js';
import { OppChoose } from './oppChoose.js';
import { FromDiscard, PlayFree } from './discardZone.js';
import { Look } from './look.js';
import { PayInk, CostMod, SelfCost, Enters, InkDrop, ExtraInk } from './ink.js';
import { ChooseOne } from './chooseOne.js';
import { Reveal, ToDeckTop, ToDiscard, PutInHand, PlayIt, RevealHandDiscard, RevealHand, PeekHand } from './reveal.js';
import { PutUnder, MoveFree, MoveCost } from './board.js';
import { Choose, EachPlayer, Delayed } from './meta.js';
import { ChallengeDamage, TurnStep } from './internal.js';
import { RuleFx, DeckFx } from './rule.js';
import { NameCard } from './name.js';
import { ReplaceFx, GrantReplace } from './replace.js';
import { PlayFrom, GrantPlayFrom } from './playFrom.js';

export const EFFECTS = [
  Choose, EachPlayer, Delayed, Reveal, RevealHandDiscard, RevealHand, PeekHand, PutInHand, PlayIt, PutUnder, MoveFree,
  Draw, GainLore, LoseLore, Damage, Heal, MoveDamage, Banish, FromDiscard, ToHand, ToDeckBottom, ShuffleIn,
  InkTop, Mill, ToDeckTop, ToDiscard, ToInkwell, Exert, Ready, Discard, OppChoose, PlayFree, PayInk, InkDrop, Look, Shuffle, CostMod, Mod,
  Search, DrawUntil, PlayBan, SelfBan, ShiftAs, MoveCost, FromUnder, ChooseOne, SelfCost, Enters, ExtraInk, RuleFx, DeckFx, NameCard, ReplaceFx, GrantReplace, PlayFrom, GrantPlayFrom, ChallengeDamage, TurnStep,
];
export const EFFECT = Object.fromEntries(EFFECTS.map((C) => [C.fn, C]));
export { Look, Mod };
export { kwList } from './mod.js';
