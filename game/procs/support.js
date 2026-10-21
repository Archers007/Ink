// What the engine can run — the contract between the compiler and the runtime.
// Derived from the registries: a building block is supported when its class can run it.
// The compiler marks a proc exec:false (with the reason) if it uses anything outside this, so the
// engine never half-runs an ability. Only `kw` is hand-listed: those keywords live in the engine itself.

import { EFFECTS } from './effects/index.js';
import { TRIGGERS } from './triggers/index.js';
import { CONDITIONS } from './conditions/index.js';
import { COST_SUPPORT, STATIC_FNS } from './kinds/index.js';
import { DURATIONS } from './phrases/duration.js';

export const SUPPORT = {
  fn: new Set(EFFECTS.filter((E) => !E.staticOnly && !E.fn.startsWith('_')).map((E) => E.fn)),
  trigger: new Set(TRIGGERS.filter((T) => T.runs).map((T) => T.ev)),
  cost: COST_SUPPORT,
  static: STATIC_FNS,
  cond: new Set(CONDITIONS.filter((C) => C.runs).map((C) => C.key)),
  kw: new Set([
    // keywords the engine (game/engine.js + public/js/play/rules.js) implements
    'evasive', 'ward', 'rush', 'reckless', 'bodyguard', 'support', 'alert', 'challenger', 'resist', 'singer',
    'boost', 'shift', 'puppyShift', 'universalShift', 'classShift', 'singTogether', 'vanish', 'grant',
    // restrictions / grants procs can put on a card
    'cantQuest', 'cantChallenge', 'cantReady', 'skipReady', 'cantBeChallenged', 'cantSing', 'cantMove', 'noDamage', 'noChallengeDamage', 'noDamageChallenging', 'noEffectDamage', 'challengeReady', 'mustQuest', 'adventurous',
  ]),
  dur: new Set(Object.keys(DURATIONS)),
};
