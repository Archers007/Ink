// Noun phrase → Query  ("damaged Villain characters of yours with cost 3 or less", "a song with Sing Together").
//
//   [adjectives] [Classifications] <type nouns> [suffixes…]
//
// Adjectives and "with …" suffixes come from the classifier registry, so a new classifier teaches
// every phrase in the card pool at once. Owner/zone words stay on the Query itself.

import { Miss, miss } from './text.js';
import { parseWith, fromAdjective, ADJECTIVES } from '../classifiers/index.js';

const TYPE = '(?:character|item|location|action|song|card)s?';
const TYPES = new RegExp(String.raw`^${TYPE}(?:(?:,|,? or|,? and) ${TYPE})*(?: cards?)?\b`, 'i');
const OWNER_ADJ = /^(other|another|opposing|your|their|its|chosen opponent's|an opponent's|each opponent's|opponent's)\s+/i;
const ADJ = new RegExp(String.raw`^(${ADJECTIVES.join('|')})\s+`, 'i');
const CLASSES = new RegExp(String.raw`^((?:[A-Z][\w'.-]*)(?:(?: |, |,? or |,? and )(?!${TYPE}\b)[A-Z][\w'.-]*)*) (?=${TYPE}\b)`);
const NAME_WORD = String.raw`(?:[\p{Lu}0-9][\p{L}\p{N}'.!-]*|of|the|and|de|la|in|a)`;
const NAMED = new RegExp(String.raw`^named (${NAME_WORD}(?: ${NAME_WORD})*?)(?= or | (?:in|of|with|from|at|this|to|you|they|that|and|is|are|gets?|gains?)\b|$|\s*[,.])\s*`, 'u');

export function filter(phrase, at = phrase) {
  phrase = phrase.trim().replace(/^(?:a|an) (?=\S)/i, '');
  // "a character card with Singer or a song card" — either query
  const alt = phrase.match(/^(.+?),? or (?:a|an) (.+)$/i);
  if (alt) {
    const A = tryFilter(alt[1]); const B = tryFilter(alt[2]);
    if (A && B) {
      const shared = {};
      for (const k of ['zone', 'owner', 'other']) if (A[k] != null || B[k] != null) { shared[k] = A[k] ?? B[k]; delete A[k]; delete B[k]; }
      return { ...shared, any: [A, B] };
    }
  }
  return filter1(phrase, at);
}

function filter1(phrase, at) {
  let s = phrase.trim().replace(/ each$/i, '');                  // "with cost 2 or less each"

  const F = {};
  const W = [];
  for (let guard = 0; guard < 8; guard++) {
    let m;
    if ((m = s.match(OWNER_ADJ))) {
      const w = m[1].toLowerCase();
      if (w === 'other' || w === 'another') F.other = true;
      else if (w === 'opposing' || /opponent's$/.test(w)) F.owner = 'opp';
      else if (w === 'your') F.owner = 'you';
    } else if ((m = s.match(ADJ))) W.push(fromAdjective(m[1]));
    else if ((m = s.match(/^non-(character|item|location|action|song)\s+/i))) W.push({ notType: [m[1].toLowerCase()] });
    else if ((m = s.match(/^(?:any|all)\s+/i))) { /* "any character" */ }
    else break;
    s = s.slice(m[0].length);
  }
  const cm = s.match(CLASSES);
  if (cm) { W.push({ class: cm[1].split(/,? or |,? and |, /).map((x) => x.trim().toLowerCase()) }); s = s.slice(cm[0].length); }
  const tm = s.match(TYPES);
  if (!tm) miss('filter: no card type', at);
  const real = [...tm[0].toLowerCase().matchAll(/(character|item|location|action|song|card)/g)].map((x) => x[1]).filter((t) => t !== 'card');
  if (real.length) F.types = [...new Set(real)];
  s = s.slice(tm[0].length).trim();
  for (let guard = 0; guard < 8 && s; guard++) {
    let m;
    if ((m = s.match(/^(?:of yours|you have in play|you have|you control|of your own|in play you have)\b\s*/i))) F.owner = 'you';
    else if ((m = s.match(/^(?:opponents have in play|your opponents have in play|of theirs)\b\s*/i))) F.owner = 'opp';
    else if ((m = s.match(/^(?:in|from|into) (your|their|an opponent's|chosen opponent's|chosen player's|any|a player's) (discard|hand|inkwell)s?\b\s*/i))) {
      F.zone = m[2].toLowerCase();
      const o = m[1].toLowerCase();
      if (o === 'your') F.owner = 'you'; else if (/opponent/.test(o)) F.owner = 'opp';
    }
    else if ((m = s.match(/^(?:at|in) (?:a |any )?locations?\b\s*/i))) W.push({ atLocation: true });
    else if ((m = s.match(/^(?:that|who) (?:has|have) (?:a card|one or more cards) under (?:it|them|him|her)\b\s*/i))) W.push({ under: true });
    else if ((m = s.match(/^without (?:an? )?/i))) {
      const r = parseWith(s.slice(m[0].length));
      if (!r) miss(`filter: "${s}"`, at);
      W.push({ not: r[0] }); m[0] += s.slice(m[0].length, m[0].length + r[1]);
    }
    else if ((m = s.match(new RegExp(String.raw`^not ${NAMED.source.slice(1)}`, 'u')))) W.push({ not: { named: [m[1].trim()] } });
    else if ((m = s.match(/^in play\b\s*/i))) { /* default zone */ }
    else if ((m = s.match(/^(?:in|from) (your|their|an opponent's|chosen opponent's) (discard|hand)\b\s*/i))) {
      F.zone = m[2].toLowerCase();
      const o = m[1].toLowerCase();
      if (o === 'your') F.owner = 'you'; else if (o !== 'their') F.owner = 'opp';
    } else if ((m = s.match(/^(?:here|at this location)\b\s*/i))) W.push({ here: true });
    else if ((m = s.match(/^at a location\b\s*/i))) W.push({ atLocation: true });
    else if ((m = s.match(/^that (?:isn't|is not) (?:a|an) (character|item|location|action|song)\b\s*/i))) W.push({ notType: [m[1].toLowerCase()] });
    else if ((m = s.match(NAMED))) {
      const names = [m[1].trim()];
      const more = s.slice(m[0].length).match(/^or (?:named )?((?:[A-Z][\w'.-]*)(?: [A-Z][\w'.-]*)*)\s*/);
      if (more) { names.push(more[1]); m[0] += more[0]; }
      W.push({ named: names });
    } else if ((m = s.match(/^with (?:an? )?/i))) {
      // "with X", "with X and Y", "with X or more"…  — every X is a classifier
      let rest = s.slice(m[0].length);
      for (let k = 0; k < 4; k++) {
        const r = parseWith(rest);
        if (!r) miss(`filter: "${s}"`, at);
        W.push(r[0]);
        m[0] += rest.slice(0, r[1]);
        rest = rest.slice(r[1]);
        const and = rest.match(/^,? and (?:an? )?/i);          // "with Evasive and cost 3 or less"
        if (!and || !parseWith(rest.slice(and[0].length))) break;
        m[0] += and[0]; rest = rest.slice(and[0].length);
      }
      const ws = rest.match(/^\s*/); m[0] += ws[0];
    } else if ((m = s.match(/^and (?=with |named |in )/i))) { /* "with cost 2 or less and named X" */ }
    else miss(`filter: "${s}"`, at);
    s = s.slice(m[0].length).trim();
  }
  if (W.length) F.with = W;
  return F;
}

// filter() or null (for parsers that try a phrase speculatively)
export function tryFilter(phrase) {
  try { return filter(phrase); } catch (e) { if (e instanceof Miss) return null; throw e; }
}
