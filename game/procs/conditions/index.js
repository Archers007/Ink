// Condition registry — order is parse priority (first rule that matches wins).
import { miss } from '../phrases/text.js';
import { AnyOf, AllOf } from './any.js';
import { Have } from './have.js';
import { SelfIs } from './self.js';
import { HandSize, MoreCards } from './hand.js';
import { OppMoreLore, YouMoreLore, LoreAmount } from './lore.js';
import { YourTurn, PlayedThisTurn } from './turn.js';
import { Shifted, RefIs } from './card.js';
import { History } from './history.js';
import { Inkwell, Compare, FewerInHand, FirstTurnSecond } from './player.js';

export const CONDITIONS = [AnyOf, History, Inkwell, Compare, FewerInHand, FirstTurnSecond, HandSize, MoreCards, OppMoreLore, YouMoreLore, LoreAmount,
  Have, SelfIs, PlayedThisTurn, YourTurn, Shifted, RefIs, AllOf];
const BY_KEY = new Map(CONDITIONS.map((C) => [C.key, C]));

export function conditionOf(C) {
  for (const k of Object.keys(C || {})) if (BY_KEY.has(k)) return BY_KEY.get(k);
  return null;
}
export function parseCondition(phrase, at = phrase) {
  const p = phrase.trim().replace(/^it's /i, 'it is ');
  for (const K of CONDITIONS) for (const [rx, f] of K.rules) {
    const m = p.match(rx);
    if (m) { const c = f(m, at, parseCondition); if (c) return c; }
  }
  miss(`condition: "${p}"`, at);
}
export function sayCondition(C) {
  if (!C) return '';
  const K = conditionOf(C);
  return K ? K.say(C, sayCondition) : Object.keys(C).join(', ');
}
export function testCondition(rt, s, C, env) {
  if (!C) return true;
  const K = conditionOf(C);
  return K ? K.test(rt, s, C, env) : false;
}
