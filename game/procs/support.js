// What game/procs/runtime.js can execute. The compiler marks a proc `exec:false` (with the reason)
// when it uses anything not listed here, so the engine never half-runs an ability.
// Add a name here only together with its implementation in runtime.js (scripts/test-procs.mjs checks).

export const SUPPORT = {
  fn: new Set([
    'draw', 'gainLore', 'loseLore', 'damage', 'heal', 'moveDamage', 'banish', 'toHand', 'toDeckBottom', 'shuffleIn',
    'toInkwell', 'inkTop', 'exert', 'ready', 'discard', 'oppChoose', 'fromDiscard', 'look', 'mod', 'payInk',
    'chooseOne', 'playFree', 'costMod', 'shuffle', 'mill',
  ]),
  trigger: new Set([
    'play', 'quest', 'challenges', 'challenged', 'banished', 'banishOther', 'turnStart', 'turnEnd',
    'playCard', 'oppPlayCard', 'questAny', 'banishedAny', 'challengesAny', 'sings', 'singsAny', 'questHere',
    'banishOtherAny', 'inked', 'moveHere',
  ]),
  cost: new Set(['exert', 'ink', 'banishSelf', 'discard']),
  static: new Set(['mod', 'selfCost', 'costMod', 'enters']),
  cond: new Set(['have', 'self', 'hand', 'moreCardsThanOpp', 'oppMoreLore', 'youMoreLore', 'playedThisTurn', 'yourTurn', 'shifted', 'refIs', 'any', 'count', 'under', 'damageOnSelf']),
  kw: new Set([
    // keyword lines the engine already handles
    'evasive', 'ward', 'rush', 'reckless', 'bodyguard', 'support', 'alert', 'challenger', 'resist', 'singer',
    'boost', 'shift', 'puppyShift', 'universalShift', 'singTogether',
    // restrictions / grants procs can put on a card
    'cantQuest', 'cantChallenge', 'cantReady', 'cantBeChallenged', 'cantSing', 'challengeReady',
  ]),
  dur: new Set(['turn', 'next', 'theirNext']),
};
