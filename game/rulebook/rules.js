// The game's rules as values the engine asks for, instead of constants it hard-codes. Each rule:
//   cr        the Comprehensive Rules section that sets it (game/rulebook/cr.js quotes it)
//   base      its value when no card changes it
//   phrases   card text that changes it → { who, set }   (who: 'you' | 'opp' | 'each', relative to the card's owner)
//
// A static ability whose text matches a phrase compiles to { fn: 'rule', rule, who, set, unless? } (CR 6.4.1: static
// abilities can alter a game rule; 1.2.1: card text supersedes the rule). The engine reads a rule for a player with
// ruleValue(): the base, unless an active static says otherwise. Adding a rule a card can change = one entry here.
const opp = /^(?:opponents|each opponent|each opposing player|opposing players)$/i;
const whoOf = (w) => (!w || /^you$/i.test(w) ? 'you' : opp.test(w) ? 'opp' : 'each');

export const RULES = {
  winLore: {
    cr: '1.8.1.1', base: 20, say: 'lore needed to win',
    phrases: [[/^(opponents|you) need (\d+) lore to win the game$/i, (m) => ({ who: whoOf(m[1]), set: +m[2] })]],
  },
  drawStep: {
    cr: '3.2.3.1', base: true, say: 'draw step',                         // 6.4.3: "skip" a step = it doesn't happen
    phrases: [[/^skip your turn's draw step$/i, () => ({ who: 'you', set: false })]],
  },
  gainLore: {
    cr: '1.11.1', base: true, say: 'can gain lore',
    phrases: [[/^(you|opponents|each opponent|each opposing player) can't gain lore(?: unless (.+))?$/i, (m) => ({ who: whoOf(m[1]), set: false, ...(m[2] ? { unlessText: m[2] } : {}) })]],
  },
  loseLore: {
    cr: '1.11.1', base: true, say: 'can lose lore',
    phrases: [[/^(you|opponents|each opponent) can't lose lore$/i, (m) => ({ who: whoOf(m[1]), set: false })]],
  },
  removeDamage: {
    cr: '1.9.2', base: true, say: 'damage can be removed',
    phrases: [[/^damage counters can't be removed$/i, () => ({ who: 'each', set: false })]],
  },
  challengesPerTurn: {
    cr: '4.6.1', base: Infinity, say: 'challenges per turn',
    phrases: [[/^each turn, only one character can challenge$/i, () => ({ who: 'each', set: 1 })]],
  },
  challengeStat: {
    cr: '4.6.6.1', base: 'str', say: 'challenge damage stat',
    phrases: [[/^during challenges, your characters deal damage with their \{willpower\} instead of their \{strength\}$/i, () => ({ who: 'you', set: 'wp' })]],
  },
  handInkable: {
    cr: '4.2.1.1', base: false, say: 'every card in hand is inkable',
    phrases: [[/^all cards in your hand count as having \{inkable\}$/i, () => ({ who: 'you', set: true })]],
  },
  inkFromDiscard: {
    cr: '4.2.1.1', base: false, say: 'can ink from the discard',
    phrases: [[/^you can ink cards from your discard$/i, () => ({ who: 'you', set: true })]],
  },
  inkExerted: {
    cr: '4.2.1.3', base: false, say: 'cards enter the inkwell exerted',
    phrases: [[/^cards enter (opponents'|your) inkwells? exerted$/i, (m) => ({ who: /opponents/i.test(m[1]) ? 'opp' : 'you', set: true })]],
  },
  inksPerTurn: {
    cr: '4.2.3', base: 1, say: 'cards you may ink each turn',          // 4.2.3: once during your turn — unless a card says
    phrases: [[/^you may ink an additional card$/i, () => ({ who: 'you', add: 1 })]],   // 4.2.3.1: each one adds — two Belles, three cards
  },
  topFaceUp: {
    cr: '7.2.2', base: false, say: 'top card of the deck is face up',      // 7.2.2: the deck stays facedown — unless a card says
    phrases: [[/^(each player|each opponent) plays? with the top card of their deck face ?up$/i, (m) => ({ who: whoOf(/opponent/i.test(m[1]) ? 'opponents' : 'each'), set: true })]],
  },
};

// static text → { rule, who, set, unlessText? } | null
export function parseRule(text) {
  const t = String(text).replace(/\.$/, '').trim();
  for (const [rule, R] of Object.entries(RULES)) for (const [rx, f] of R.phrases) { const m = t.match(rx); if (m) return { rule, ...f(m) }; }
  return null;
}
const applies = (who, owner, seat) => who === 'each' || (who === 'you' ? owner === seat : owner !== seat);

// The value of a rule for `seat` right now: its base, or what the active statics on the board set it to.
//   rt: the proc runtime (for statics, conditions)   s: game state
export function ruleValue(rt, s, rule, seat) {
  const R = RULES[rule];
  let v = R.base;
  for (const p of s.players) for (const iid of p.play) {
    const src = s.cards[iid];
    for (const proc of rt.procsOf(s, src)) {
      if (proc.kind !== 'static' || proc.effect?.fn !== 'rule' || proc.effect.rule !== rule) continue;
      if (!rt.staticActive(s, proc, src.owner, iid)) continue;
      const st = proc.effect;
      if (!applies(st.who, src.owner, seat)) continue;
      if (st.unless && rt.test(s, st.unless, seat, iid)) continue;          // "… unless one of their characters has challenged this turn"
      v = st.add != null ? v + st.add : st.set;
    }
  }
  return v;
}
export const ruleSay = (st) => `${RULES[st.rule]?.say || st.rule}: ${st.add != null ? `+${st.add}` : st.set === Infinity ? 'any' : st.set} for ${st.who === 'you' ? 'you' : st.who === 'opp' ? 'opponents' : 'everyone'}${st.unless ? ' (unless …)' : ''} [CR ${RULES[st.rule]?.cr}]`;
