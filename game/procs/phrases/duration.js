// "this turn" · "until the start of your next turn" · "during their next turn"
export const DURATIONS = {
  turn: { until: 'eot', say: 'this turn' },
  next: { until: 'sot', say: 'until the start of your next turn' },
  theirNext: { until: 'theirNext', say: "during its owner's next turn" },
  src: { until: 'src', say: 'while the source is in play' },
  challenge: { until: 'challenge', say: 'during that challenge' },     // "they gain Resist +2 during that challenge"          // "While this item is in play, that character gains Evasive"
  perm: { until: 'perm', say: 'while it is in play' },                // "They gain Rush." — no duration: it lasts while in play
};
const RX = [
  [/ (?:for the rest of|during) this turn$/i, 'turn'],
  [/ this turn$/i, 'turn'],
  [/ until the start of your next turn$/i, 'next'],
  [/ until the end of (?:your|the) turn$/i, 'turn'],
  [/ during (?:their|its owner's|that player's) next turn$/i, 'theirNext'],
  [/ during (?:that|the) challenge$/i, 'challenge'],
];
export class Duration {
  // "<clause> this turn" → [clause, 'turn'];  also "for the rest of this turn, <clause>" / "this turn, <clause>"
  static take(s) {
    for (const [rx, d] of RX) if (rx.test(s)) return [s.replace(rx, ''), d];
    const w = s.match(/^while this (?:item|location|character) is in play,? (.+)$/i);
    if (w) return [w[1], 'src'];
    const m = s.match(/^(?:for the rest of this turn|this turn|until the start of your next turn),? (.+)$/i);
    if (m) return [m[1], /next turn/i.test(s.slice(0, s.length - m[1].length)) ? 'next' : 'turn'];
    return [s, null];
  }
  static say(d) { return DURATIONS[d]?.say || d; }
}
