// Who did what — one verb table for every "<somebody> <does something>" in the card pool.
//
// A trigger ("Whenever one of your Pirate characters quests"), a turn-history condition ("if a character of yours
// quested this turn") and an event filter all ask the same question of an engine event (Runtime.fire), so they
// share this table instead of each spelling out its own sentences:
//
//   act      { id, ev, now, past, obj?, flags? }
//     ev     the engine event it watches (R.fire(s, ev, info) — info.iid is the card that did it)
//     now    the verb in "whenever X <now>"        past   the verb in "X <past> this turn"
//     obj    "challenges a damaged character" — the other card (info.other) is queried too
//     flags  info fields that must hold (banished in a challenge → inChallenge)
//
// Subjects are noun phrases relative to the card listening: "one of your other Floodborn characters",
// "an opposing character", "a character here", "this character or one of your characters named Mickey Mouse".

import { filter } from './filter.js';
import { N, NUM } from './text.js';

export const ACTS = [
  { id: 'challengedBanished', ev: 'banished', now: String.raw`(?:is|are) challenged and banished`, past: String.raw`(?:was|were) challenged and banished`, flags: { defending: true } },
  { id: 'challengesBanished', ev: 'banished', now: String.raw`challenges? and (?:is|are) banished`, past: String.raw`challenged and (?:was|were) banished`, flags: { inChallenge: true, defending: false } },
  { id: 'banishedChallenge', ev: 'banished', now: String.raw`(?:is|are) banished in a challenge`, past: String.raw`(?:was|were) banished in a challenge`, flags: { inChallenge: true } },
  { id: 'banished', ev: 'banished', now: String.raw`(?:is|are) banished`, past: String.raw`(?:was|were|(?:has|have) been) banished` },
  { id: 'challenged', ev: 'challenged', now: String.raw`(?:is|are) challenged`, past: String.raw`(?:was|were|(?:has|have) been) challenged` },
  { id: 'challenges', ev: 'challenges', now: String.raw`challenges?`, past: String.raw`(?:has |have )?challenged`, obj: true },
  { id: 'quests', ev: 'quest', now: String.raw`quests?`, past: String.raw`(?:has |have )?quested` },
  { id: 'damaged', ev: 'damaged', now: String.raw`(?:is|are) dealt damage|takes? damage|(?:is|are) damaged`, past: String.raw`(?:was|were) dealt damage|took damage|(?:was|were) damaged` },
  { id: 'sings', ev: 'sings', now: String.raw`sings? (?:a )?songs?|sings?`, past: String.raw`sang (?:a )?songs?|sang` },
  { id: 'moves', ev: 'moves', now: String.raw`moves? to a location|moves?`, past: String.raw`moved to a location|moved` },
  { id: 'readied', ev: 'ready', now: String.raw`(?:is|are) readied|read(?:y|ies)`, past: String.raw`(?:was|were) readied|readied` },
  { id: 'exerted', ev: 'exerts', now: String.raw`(?:is|are) exerted|exerts?`, past: String.raw`(?:was|were) exerted|exerted` },
  { id: 'played', ev: 'play', now: String.raw`(?:is|are) played|enters? play`, past: String.raw`(?:was|were) played|entered play` },
  { id: 'returned', ev: 'leaves', now: String.raw`(?:is|are) returned to (?:your|their|its owner's|its player's) hands?(?: from play)?`, past: String.raw`(?:was|were) returned to (?:your|their) hands?(?: from play)?`, flags: { to: 'hand' } },
];
export const ACT = Object.fromEntries(ACTS.map((a) => [a.id, a]));
export const ACT_EVENTS = new Set(ACTS.map((a) => a.ev));
export const VERB_NOW = ACTS.map((a) => a.now).join('|');

// Does the event's info satisfy the act's flags?
export const actFlagsOk = (a, info) => Object.entries(a.flags || {}).every(([k, v]) => (k === 'to' ? info.to === v : !!info[k] === v));

// "one of your other Floodborn characters" → { F } · "this character or one of your X" → { self: true, F } · "they" → { self }
const SELF = /^(?:this (?:character|item|location|card)|he|she|it|they)$/i;
export function subject(np, at = np) {
  let p = np.trim();
  if (SELF.test(p)) return { self: true };
  let self = false;
  let m;
  if ((m = p.match(/^this character or (.+)$/i))) { self = true; p = m[1]; }
  let own = null;
  if ((m = p.match(/^one of (your opponents'|an opponent's|your|their) (.+)$/i))) { own = /^your$/i.test(m[1]) ? 'you' : 'opp'; p = m[2]; }
  else if ((m = p.match(/^(?:a|an|any) (.+?) of (yours|theirs)$/i))) { own = m[2] === 'yours' ? 'you' : 'opp'; p = m[1]; }
  else if ((m = p.match(/^(?:a|an|any) (.+)$/i))) p = m[1];
  const F = filter(p, at);
  if (own) F.owner = own;
  return { ...(self ? { self } : {}), F };
}

// Counted noun phrase: "2 or more characters of yours", "no other character", "a Hero character", "only 1 character"
//   → { F, n: { gte?, lte? } }
export function counted(np, at = np) {
  let p = np.trim();
  let n = { gte: 1 };
  let m;
  if ((m = p.match(new RegExp(String.raw`^${NUM} or more (.+)$`, 'i')))) { n = { gte: N(m[1]) }; p = m[2]; }
  else if ((m = p.match(new RegExp(String.raw`^${NUM} or (?:fewer|less) (.+)$`, 'i')))) { n = { lte: N(m[1]) }; p = m[2]; }
  else if ((m = p.match(new RegExp(String.raw`^(?:only|exactly) ${NUM} (.+)$`, 'i')))) { n = { gte: N(m[1]), lte: N(m[1]) }; p = m[2]; }
  else if ((m = p.match(/^(?:no|none of the|none of your) (.+)$/i))) { n = { lte: 0 }; p = /^none of your/i.test(p) ? `your ${m[1]}` : m[1]; }
  else if ((m = p.match(new RegExp(String.raw`^(\d+) (.+)$`, 'i')))) { n = { gte: N(m[1]) }; p = m[2]; }
  const s = subject(p.replace(/^(?=other |another )/i, ''), at);
  if (s.self) return { self: true, n };
  if (/^another\b/i.test(np.trim())) s.F.other = true;
  return { F: s.F, n };
}
export const countOk = (n, k) => (n.gte == null || k >= n.gte) && (n.lte == null || k <= n.lte);
