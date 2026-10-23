// The generic conditions: a counted noun phrase and what's true of it, read from the board, the turn log or the
// challenge in progress. One rule shape each, so every wording that boils down to "is there such a card / did such
// a card do that / is this card in a challenge" lands in the same class.
//
//   exists      "a Hero character is in play" · "there's a song card in your discard" · "2 or more characters of
//               yours are exerted" · "an opposing character has damage" · "there are 5 or more characters with
//               damage in play" · "one of your Knight characters is at a location" · "you have only 1 character here"
//               { exists: Query, n: { gte?, lte? } }
//   did         "a character of yours quested this turn" · "an opposing character took damage this turn" ·
//               "no other character has quested this turn" · "a character named Buzz Lightyear was banished this turn"
//               { did: act id (phrases/acts.js), of?: Query, self?, n }   — counted in s.turnLog
//   challenging "while challenging a damaged character" · "he's being challenged"
//               { challenging: 'a' | 't', vs?: Query }
import { Condition } from './Condition.js';
import { Query } from '../query.js';
import { ACTS, ACT, actFlagsOk, counted, countOk } from '../phrases/acts.js';
import { tryFilter } from '../phrases/filter.js';
import { parseWith, fromAdjective, ADJECTIVES } from '../classifiers/index.js';

const where = (F, w) => {
  if (!w) return F;
  const m = w.match(/^in (?:your|a player's|any|their|an opponent's) (discard|hand|inkwell)$/i);
  if (m) return { ...F, zone: m[1].toLowerCase(), ...(/your/i.test(w) ? { owner: F.owner || 'you' } : /opponent/i.test(w) ? { owner: 'opp' } : {}) };
  if (/^(?:here|at this location)$/i.test(w)) return { ...F, with: [...(F.with || []), { here: true }] };
  return F;                                                           // "in play"
};
const WHERE = String.raw`(?: (in play|here|at this location|in (?:your|a player's|any|their|an opponent's) (?:discard|hand|inkwell)))?`;
// "is exerted" · "has damage" · "is at a location" · "is damaged" → a classifier on the subject
function predicate(p) {
  let m;
  if ((m = p.match(/^(?:is|are) at a location$/i))) return { atLocation: true };
  if ((m = p.match(new RegExp(String.raw`^(?:is|are) (${ADJECTIVES.join('|')})$`, 'i')))) return fromAdjective(m[1]);
  if ((m = p.match(/^(?:has|have) (?:a card|cards|one or more cards) under (?:it|them|him|her)$/i))) return { under: true };
  if ((m = p.match(/^(?:has|have) (.+)$/i))) { const r = parseWith(m[1]); if (r && r[1] === m[1].length) return r[0]; }
  return null;
}
const PLAYER = { you: 'you', 'an opponent': 'opp', 'each opponent': 'opp', 'chosen opponent': 'opp', 'one or more opponents': 'opp', 'your opponents': 'opp', 'an opposing player': 'opp' };

export class Exists extends Condition {
  static key = 'exists';
  static rules = [
    // "there's a song card in your discard" · "there are 5 or more characters with damage in play"
    [new RegExp(String.raw`^there(?:'s| is| are|'re) (.+?)${WHERE}$`, 'i'), (m, at) => Exists.of(m[1], m[2], at)],
    // "a Hero character is in play" · "a Princess or Queen character is in play"
    [new RegExp(String.raw`^(.+?) (?:is|are) (in play|here|in your discard|in your hand)$`, 'i'), (m, at) => Exists.of(m[1], m[2], at)],
    // "an opponent has 2 or more ready characters in play" · "you have characters named Dewey and Louie in play"
    [new RegExp(String.raw`^(you|an opponent|each opponent|chosen opponent|one or more opponents|your opponents) (?:has|have) (.+?)${WHERE}$`, 'i'), (m, at) => {
      const C = Exists.of(m[2], m[3], at);
      if (!C) return undefined;
      for (const x of C.all || [C]) x.exists.owner = PLAYER[m[1].toLowerCase()];
      return C;
    }],
    // "2 or more characters of yours are exerted" · "an opposing character has damage" · "one of your Knight characters is at a location"
    [/^(.+?) ((?:is|are|has|have) .+)$/i, (m, at) => {
      const w = predicate(m[2]);
      if (!w) return undefined;
      const C = Exists.of(m[1], null, at);
      if (!C) return undefined;
      (C.exists.with ||= []).push(w);
      return C;
    }],
  ];
  static of(np, w, at) {
    let c;
    // "characters named Dewey and Louie" — one of each
    const two = np.match(/^characters named (.+?) and (.+)$/i);
    if (two) return { all: [two[1], two[2]].map((n) => ({ exists: { types: ['character'], with: [{ named: [n] }] }, n: { gte: 1 } })) };
    try { c = counted(np.replace(/^characters\b/i, '1 or more characters'), at); } catch { return undefined; }
    if (c.self || !c.F.types && !c.F.with && !c.F.zone) return undefined;
    return { exists: where(c.F, w), n: c.n };
  }
  static test(rt, s, C, env) { return countOk(C.n, rt.candidates(s, C.exists, env.ctl, env.src).length); }
  static say(C) { return `${C.n.lte === 0 ? 'no' : C.n.gte > 1 ? `${C.n.gte}+` : 'a'} ${Query.describe(C.exists)}`; }
}

const PAST = new RegExp(String.raw`^(.+?) (${ACTS.map((a) => `(?:${a.past})`).join('|')})(?: (?:another|a|an) (.+?))? this turn$`, 'i');
export class Did extends Condition {
  static key = 'did';
  static rules = [
    [PAST, (m, at) => {
      const a = ACTS.find((x) => new RegExp(`^(?:${x.past})$`, 'i').test(m[2]));
      if (!a) return undefined;
      let c;
      try { c = counted(m[1].replace(/^(a|an|any) (\S+) of yours$/i, 'one of your $2s'), at); } catch { return undefined; }
      const vs = m[3] ? tryFilter(m[3]) : null;
      if (m[3] && !vs) return undefined;
      return { did: a.id, ...(c.self ? { self: true } : { of: c.F }), n: c.n, ...(vs ? { vs } : {}) };
    }],
  ];
  static test(rt, s, C, env) {
    const a = ACT[C.did];
    const k = (s.turnLog || []).filter((e) => e.ev === a.ev && e.iid != null && actFlagsOk(a, e)
      && (C.self ? e.iid === env.src : rt.matches(s, C.of, s.cards[e.iid], env.ctl, env.src, { anyZone: true }))
      && (!C.vs || (e.other != null && rt.matches(s, C.vs, s.cards[e.other], env.ctl, env.src, { anyZone: true })))).length;
    return countOk(C.n, k);
  }
  static say(C) { return `this turn: ${C.n.lte === 0 ? 'no' : C.n.gte > 1 ? `${C.n.gte}+` : 'a'} ${C.self ? 'this card' : Query.describe(C.of)} ${C.did}`; }
}

export class Challenging extends Condition {
  static key = 'challenging';
  static rules = [
    [/^(?:(?:this character|he|she|it|they) (?:is|are) |he's |she's |it's |they're )?being challenged$/i, () => ({ challenging: 't' })],
    [/^(?:(?:this character|he|she|it|they) (?:is|are) |he's |she's |they're )?challenging(?: (?:a|an|another) (.+))?$/i, (m) => {
      const vs = m[1] ? tryFilter(m[1]) : null;
      if (m[1] && !vs) return undefined;
      return { challenging: 'a', ...(vs ? { vs } : {}) };
    }],
  ];
  static test(rt, s, C, env) {
    const cx = env.job?.ctx?.cx || s.challenge || s.challengeCtx;
    if (!cx || cx[C.challenging] !== env.src) return false;
    if (!C.vs) return true;
    const t = s.cards[C.challenging === 'a' ? cx.t : cx.a];
    return !!t && rt.matches(s, C.vs, t, env.ctl, env.src);
  }
  static say(C) { return C.challenging === 't' ? 'this character is being challenged' : `this character is challenging${C.vs ? ` ${Query.describe(C.vs)}` : ''}`; }
}
