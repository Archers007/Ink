// Ability text → proc (a small JSON program the engine runs). Deterministic, no AI.
//
//   L0  normalize.js       canonical spelling
//   L1  compileAbility()   split into  keyword line | cost — effect | trigger, effect | static | action
//   L2  phrase parsers     selector · filter · amount · duration · condition (each returns a fragment)
//   L3  clause()/effects() compose fragments into steps; "you may", "then", "if you do", "Choose one"
//
// Every parser either returns a value or throws Miss(reason, clause). An ability compiles all-or-nothing:
// one clause we don't understand → { kind:'unparsed', why, at } and the engine leaves it manual.
//
// Proc shapes (see docs in game/procs/README.md):
//   { kind:'keyword',   kws:[{kw,n?,cost?}] }
//   { kind:'triggered', on:[{ev, filter?}], once?, during?, cond?, do:[step] }
//   { kind:'activated', cost:{exert?,ink?,banishSelf?,discard?}, once?, do:[step] }
//   { kind:'static',    during?, cond?, effect:step }
//   { kind:'action',    do:[step] }
//   { kind:'reminder' }                       song "sing for free" reminder etc.
// step: { fn, ...args, may?, linked?, cond?, ifDid? }
// sel:  { self:true } | { ref:true } | { chosen:F, upTo? } | { all:F }
// F:    { types?, owner?:'you'|'opp', other?, damaged?, undamaged?, exerted?, ready?, classes?, named?,
//         cost?:{lte|gte}, str?, wp?, lore?, kw?, zone?, here?, atLocation? }

import { canon, stripReminders } from './normalize.js';
import { SUPPORT } from './support.js';

export class Miss extends Error {
  constructor(why, at) { super(why); this.at = at; }
}
const miss = (why, at) => { throw new Miss(why, at); };

const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const N = (w) => (w == null ? null : /^\d+$/.test(w) ? Number(w) : NUMW[w.toLowerCase()] ?? null);
const NUM = String.raw`(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)`;
const STAT = { strength: 'str', willpower: 'wp', lore: 'lore' };
const lc = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// ---------------------------------------------------------------- keywords (L1)

const KW = {
  evasive: 'evasive', ward: 'ward', rush: 'rush', reckless: 'reckless', bodyguard: 'bodyguard', support: 'support',
  alert: 'alert', vanish: 'vanish', challenger: 'challenger', resist: 'resist', singer: 'singer', boost: 'boost',
  shift: 'shift', 'puppy shift': 'puppyShift', 'universal shift': 'universalShift', 'sing together': 'singTogether',
  adventurous: 'adventurous', underdog: 'underdog', 'floodborn shift': 'classShift',
};
const KW_NAMES = Object.keys(KW).sort((a, b) => b.length - a.length).join('|');
const KW_ITEM = new RegExp(String.raw`^(${KW_NAMES}|[A-Z][a-z]+ Shift)\b(?:\s*\+?\s*(\d+)(?:\s*\{ink\})?|:\s*([^.]+?)(?=\s+(?:${KW_NAMES})\b|$))?\s*`, 'i');

function keywordLine(text) {
  let rest = stripReminders(text);
  const kws = [];
  while (rest) {
    const m = rest.match(KW_ITEM);
    if (!m) return null;
    const word = m[1].toLowerCase();
    const kw = KW[word] || (/ shift$/.test(word) ? 'classShift' : null);
    const item = { kw };
    if (m[2] != null) item.n = Number(m[2]);
    if (m[3]) item.cost = m[3].trim();
    if (kw === 'classShift') item.cls = m[1].replace(/ Shift$/i, '');
    kws.push(item);
    rest = rest.slice(m[0].length).trim();
  }
  return kws.length ? kws : null;
}
const KW_LIST_ITEM = String.raw`(?:evasive|rush|ward|support|bodyguard|reckless|alert|vanish|(?:resist|challenger|singer) \+?\d+)`;
function kwList(s) {
  const out = [];
  for (const part of s.split(/,? and |, /i)) {
    const m = part.trim().match(/^(evasive|rush|ward|support|bodyguard|reckless|alert|vanish|resist|challenger|singer)(?: \+?(\d+))?$/i);
    if (!m) return null;
    out.push(m[2] ? { kw: m[1].toLowerCase(), n: Number(m[2]) } : { kw: m[1].toLowerCase() });
  }
  return out;
}

// ---------------------------------------------------------------- filters (L2)

const TYPES = String.raw`(character|item|location|action|song|card)s?`;
const TYPE_ALT = new RegExp(String.raw`^(?:${TYPES})(?:(?:,|,? or|,? and) (?:${TYPES}))*(?: cards?)?\b`, 'i');

// "damaged Villain characters of yours with cost 3 or less" → F
export function filter(phrase, at = phrase) {
  let s = phrase.trim();
  const F = {};
  // adjectives (any order)
  for (let guard = 0; guard < 8; guard++) {
    const m = s.match(/^(other|another|opposing|damaged|undamaged|exerted|ready|your|their|its|chosen opponent's|an opponent's|each opponent's|opponent's)\s+/i);
    if (!m) break;
    const w = m[1].toLowerCase();
    if (w === 'other' || w === 'another') F.other = true;
    else if (w === 'opposing' || /opponent's$/.test(w)) F.owner = 'opp';
    else if (w === 'your') F.owner = 'you';
    else if (w === 'their' || w === 'its') { /* their player's — no owner restriction */ }
    else F[w] = true;
    s = s.slice(m[0].length);
  }
  // classifications: Capitalised words before the type noun ("Seven Dwarfs", "Villain", "Hero or Princess")
  const cm = s.match(/^((?:[A-Z][\w'.-]*)(?:(?: |, |,? or |,? and )(?!(?:character|item|location|action|song|card)s?\b)[A-Z][\w'.-]*)*) (?=(?:character|item|location|action|song|card)s?\b)/);
  if (cm) {
    F.classes = cm[1].split(/,? or |,? and |, /).map((x) => x.trim().toLowerCase());
    s = s.slice(cm[0].length);
  }
  const tm = s.match(TYPE_ALT);
  if (!tm) miss('filter: no card type', at);
  const types = [...tm[0].toLowerCase().matchAll(/(character|item|location|action|song|card)/g)].map((x) => x[1]);
  const real = types.filter((t) => t !== 'card');                 // "character card" = character
  if (real.length) F.types = [...new Set(real)];
  s = s.slice(tm[0].length).trim();
  // suffixes
  for (let guard = 0; guard < 8 && s; guard++) {
    let m;
    if ((m = s.match(/^(?:of yours|you have in play|you control|of your own)\b\s*/i))) F.owner = 'you';
    else if ((m = s.match(/^(?:in play)\b\s*/i))) { /* default zone */ }
    else if ((m = s.match(/^(?:in|from) (your|their|an opponent's|chosen opponent's) (discard|hand)\b\s*/i))) {
      F.zone = m[2].toLowerCase(); F.owner = m[1].toLowerCase() === 'your' ? 'you' : m[1].toLowerCase() === 'their' ? undefined : 'opp';
    }
    else if ((m = s.match(/^with cost (\d+) or (less|more)\b\s*/i))) F.cost = { [m[2] === 'less' ? 'lte' : 'gte']: +m[1] };
    else if ((m = s.match(/^with (\d+) \{(strength|willpower|lore)\} or (less|more)\b\s*/i))) F[STAT[m[2]]] = { [m[3] === 'less' ? 'lte' : 'gte']: +m[1] };
    else if ((m = s.match(/^with (\d+) or (less|more) \{?(strength|willpower)\}?\b\s*/i))) F[STAT[m[3]]] = { [m[2] === 'less' ? 'lte' : 'gte']: +m[1] };
    else if ((m = s.match(/^with (evasive|bodyguard|rush|reckless|ward|support|alert|vanish|challenger|resist|singer|shift|boost)\b\s*/i))) F.kw = m[1].toLowerCase();
    else if ((m = s.match(/^with no damage\b\s*/i))) F.undamaged = true;
    else if ((m = s.match(/^with damage\b\s*/i))) F.damaged = true;
    else if ((m = s.match(/^(?:here|at this location)\b\s*/i))) F.here = true;
    else if ((m = s.match(/^at a location\b\s*/i))) F.atLocation = true;
    else if ((m = s.match(/^named ((?:[A-Z0-9][\w'.-]*|of|the|and|de|la|in|a)(?: (?:[A-Z0-9][\w'.-]*|of|the|and|de|la|in|a))*?)(?= or named | (?:in|of|with|from|at|this|to)\b|$|\s*[,.])\s*/))) {
      (F.named ||= []).push(m[1].trim());
      const more = s.slice(m[0].length).match(/^or (?:named )?((?:[A-Z][\w'.-]*)(?: [A-Z][\w'.-]*)*)\s*/);
      if (more) { F.named.push(more[1]); m[0] += more[0]; }
    }
    else if ((m = s.match(/^and (?=with |named |in )/i))) { /* "with cost 2 or less and named X" */ }
    else miss(`filter: "${s}"`, at);
    s = s.slice(m[0].length).trim();
  }
  return F;
}

// ---------------------------------------------------------------- selectors (L2)

export function selector(phrase, at = phrase) {
  const p = phrase.trim().replace(/^the /i, '');
  if (/^this (character|item|location|card)$/i.test(p)) return { self: true };
  if (/^(him|her|it|them|that character|the chosen character|that card|those characters|that item|that location|they|he|she)$/i.test(p)) return { ref: true };
  let m;
  if ((m = p.match(new RegExp(String.raw`^up to ${NUM} (?:other )?chosen (.+)$`, 'i')))) {
    const F = filter(m[2], at); if (/^up to \S+ other/i.test(p)) F.other = true;
    return { chosen: F, upTo: N(m[1]) };
  }
  if ((m = p.match(/^(another|a) chosen (.+)$/i))) { const F = filter(m[2], at); if (m[1].toLowerCase() === 'another') F.other = true; return { chosen: F }; }
  if ((m = p.match(/^chosen (.+)$/i))) return { chosen: filter(m[1], at) };
  if ((m = p.match(/^one of (your|their) (.+)$/i))) { const F = filter(m[2], at); if (m[1] === 'your') F.owner = 'you'; return { chosen: F, yours: true }; }
  if ((m = p.match(/^(?:each|all|every) (?:of )?(your |opposing )?(other )?(.+)$/i))) {
    const F = filter((m[1] || '') + (m[2] || '') + m[3], at);
    return { all: F };
  }
  if ((m = p.match(/^(your|opposing) (.+)$/i))) return { all: filter(p, at) };
  if ((m = p.match(/^(characters|items|locations) (here|in play)$/i))) return { all: filter(p, at) };
  miss(`selector: "${p}"`, at);
}

// ---------------------------------------------------------------- amounts & durations (L2)

function amount(phrase, at) {
  const p = phrase.trim();
  const n = N(p);
  if (n != null) return n;
  miss(`amount: "${p}"`, at);
}
// "for each other Villain character you have in play" → { forEach: F, zone? }
function forEach(phrase, at) {
  let p = phrase.trim();
  let m;
  if ((m = p.match(/^card in (your|an opponent's|each opponent's) (hand|discard)$/i))) return { count: { zone: m[2], owner: m[1] === 'your' ? 'you' : 'opp' } };
  if ((m = p.match(/^(.+?) card in your (discard|hand)$/i))) { const F = filter(m[1] + ' card', at); F.zone = m[2]; F.owner = 'you'; return { count: F }; }
  if ((m = p.match(/^card under (?:this character|him|her|it)$/i))) return { count: { under: true } };
  if ((m = p.match(/^damage on (?:this character|him|her|it)$/i))) return { count: { damageOnSelf: true } };
  if ((m = p.match(/^(?:1 )?damage on (?:this character|him|her|it)$/i))) return { count: { damageOnSelf: true } };
  return { count: filter(p, at) };
}
const DUR = [
  [/ (?:for the rest of|during) this turn$/i, 'turn'],
  [/ this turn$/i, 'turn'],
  [/ until the start of your next turn$/i, 'next'],
  [/ until the end of (?:your|the) turn$/i, 'turn'],
];
function takeDuration(s) {
  for (const [rx, d] of DUR) if (rx.test(s)) return [s.replace(rx, ''), d];
  return [s, null];
}

// ---------------------------------------------------------------- conditions (L2)

export function condition(phrase, at = phrase) {
  const p = phrase.trim().replace(/^it's /i, 'it is ');
  let m;
  if ((m = p.match(new RegExp(String.raw`^you have ${NUM} or more (.+?) in play$`, 'i')))) return { have: filter(m[2], at), n: N(m[1]), owner: 'you' };
  if ((m = p.match(/^you have (a|an|another) (.+?) in play$/i))) { const F = filter(m[2], at); if (/another/i.test(m[1])) F.other = true; return { have: F, n: 1 }; }
  if ((m = p.match(/^you have (?:a|an) (.+?) (here|at this location)$/i))) { const F = filter(m[1], at); F.here = true; return { have: F, n: 1 }; }
  if ((m = p.match(/^you have (?:a|an) (.+?) or (?:a|an) (.+?) in play$/i))) return { any: [{ have: filter(m[1], at), n: 1 }, { have: filter(m[2], at), n: 1 }] };
  if ((m = p.match(/^you have no (.+?) in play$/i))) return { have: filter(m[1], at), n: 0, exactly: true };
  if ((m = p.match(new RegExp(String.raw`^you have ${NUM} or more cards in your hand$`, 'i')))) return { hand: { gte: N(m[1]) } };
  if ((m = p.match(/^you have no cards in your hand$/i))) return { hand: { lte: 0 } };
  if ((m = p.match(/^you have more cards in your hand than each opponent$/i))) return { moreCardsThanOpp: true };
  if ((m = p.match(/^(?:an|each|chosen) opponent has more lore than you$/i))) return { oppMoreLore: true };
  if ((m = p.match(/^you have more lore than (?:each|an|chosen) opponent$/i))) return { youMoreLore: true };
  if ((m = p.match(/^(?:this character|he|she|it|they) (?:has|have) no damage$/i))) return { self: { undamaged: true } };
  if ((m = p.match(/^(?:this character|he|she|it|they) (?:is|are) damaged$/i))) return { self: { damaged: true } };
  if ((m = p.match(/^(?:this character|he|she|it|they) (?:is|are) exerted$/i))) return { self: { exerted: true } };
  if ((m = p.match(/^(?:this character|he|she|it|they) (?:is|are) at a location$/i))) return { self: { atLocation: true } };
  if ((m = p.match(/^(?:this character|he|she|it|they) (?:has|have) (\d+) \{(strength|willpower)\} or (more|less)$/i))) return { self: { [STAT[m[2]]]: { [m[3] === 'less' ? 'lte' : 'gte']: +m[1] } } };
  if ((m = p.match(/^(?:this character|he|she|it|they) (?:has|have) a card under (?:him|her|it|them)$/i))) return { self: { hasUnder: true } };
  if ((m = p.match(/^there's a card under (?:this character|him|her|it|them)$/i))) return { self: { hasUnder: true } };
  if ((m = p.match(/^you(?:'ve)? played (?:a|an|another) (.+?) this turn$/i))) return { playedThisTurn: filter(m[1], at) };
  if ((m = p.match(/^it is your turn$/i))) return { yourTurn: true };
  if ((m = p.match(/^(?:an|chosen) opponent has (?:a|an) (.+?) in play$/i))) { const F = filter(m[1], at); F.owner = 'opp'; return { have: F, n: 1 }; }
  if ((m = p.match(/^you have (?:a|an) (.+?) in your (discard|hand)$/i))) { const F = filter(m[1], at); F.zone = m[2]; F.owner = 'you'; return { have: F, n: 1 }; }
  if ((m = p.match(new RegExp(String.raw`^you have ${NUM} or more (.+?) in your (discard|hand)$`, 'i')))) { const F = filter(m[2], at); F.zone = m[3]; F.owner = 'you'; return { have: F, n: N(m[1]) }; }
  if ((m = p.match(/^(?:this character|he|she|it|they) (?:has|have) damage$/i))) return { self: { damaged: true } };
  if ((m = p.match(/^it is (?:an|your) opponent's turn$/i))) return { yourTurn: false };
  if ((m = p.match(/^you used shift to play (?:him|her|it|them|this character)$/i))) return { shifted: true };
  if ((m = p.match(/^(?:a|an) (.+?) (?:was|is) chosen$/i))) return { refIs: filter(m[1], at) };
  if ((m = p.match(/^(?:it's|it is|that card is) (?:a|an) (.+?)$/i))) return { refIs: filter(m[1], at) };
  miss(`condition: "${p}"`, at);
}

// ---------------------------------------------------------------- clauses (L3)

const HAND = String.raw`(?:their player's|its player's|their owner's|its owner's|your|their|his|her|its) hands?`;
const DECK = String.raw`(?:their player's|its player's|their owner's|its owner's|your|their) decks?`;
const INKWELL = String.raw`(?:their player's|its player's|their owner's|your|their) inkwells?`;

// One imperative clause → one step.
export function clause(raw, ctx = {}) {
  const at = raw;
  let s = raw.trim().replace(/[.!]$/, '').trim();
  let may = false;
  let m;
  if ((m = s.match(/^you may (.+)$/i))) { may = true; s = m[1]; }
  s = lc(s);
  const out = (o) => (may ? { ...o, may: true } : o);
  let dur;
  [s, dur] = takeDuration(s);
  const D = (o) => (dur ? { ...o, dur } : ctx.static ? o : miss('needs a duration (this turn / until …)', at));

  if ((m = s.match(new RegExp(String.raw`^draw ${NUM} cards?$`, 'i')))) return out({ fn: 'draw', n: N(m[1]) });
  if ((m = s.match(new RegExp(String.raw`^each player draws ${NUM} cards?$`, 'i')))) return out({ fn: 'draw', n: N(m[1]), who: 'each' });
  if ((m = s.match(new RegExp(String.raw`^(each|chosen) opponent draws ${NUM} cards?$`, 'i')))) return out({ fn: 'draw', n: N(m[2]), who: 'opp' });
  if ((m = s.match(/^gain (\d+) lore$/i))) return out({ fn: 'gainLore', n: +m[1] });
  if ((m = s.match(/^gain lore equal to (?:the|that|their|his|her|its) (?:character's )?\{lore\}$/i))) return out({ fn: 'gainLore', n: { stat: 'lore', of: 'ref' } });
  if ((m = s.match(/^(each|chosen) opponent loses (\d+) lore$/i))) return out({ fn: 'loseLore', n: +m[2], who: 'opp' });
  if ((m = s.match(/^deal (\d+) damage to (.+)$/i))) return out({ fn: 'damage', n: +m[1], sel: selector(m[2], at) });
  if ((m = s.match(/^deal damage equal to (?:their|his|her|its|this character's) \{strength\} to (.+)$/i))) return out({ fn: 'damage', n: { stat: 'str', of: ctx.refIsSelf ? 'self' : 'ref' }, sel: selector(m[1], at) });
  if ((m = s.match(/^remove up to (\d+) damage from (.+)$/i))) return out({ fn: 'heal', n: +m[1], sel: selector(m[2], at) });
  if ((m = s.match(/^remove all damage from (.+)$/i))) return out({ fn: 'heal', n: 99, sel: selector(m[1], at) });
  if ((m = s.match(/^move (?:up to )?(\d+) damage(?: counters?)? from (.+?) to (.+)$/i))) return out({ fn: 'moveDamage', n: +m[1], from: selector(m[2], at), to: selector(m[3], at) });
  if ((m = s.match(/^banish (.+)$/i))) return out({ fn: 'banish', sel: selector(m[1], at) });
  if ((m = s.match(new RegExp(String.raw`^return (a|an|up to \d+) (.+?) from your discard to your hand$`, 'i')))) {
    const F = filter(m[2], at); F.zone = 'discard'; F.owner = 'you';
    return out({ fn: 'fromDiscard', filter: F, n: /^up to/.test(m[1]) ? +m[1].split(' ')[2] : 1, upTo: /^up to/.test(m[1]) || undefined });
  }
  if ((m = s.match(new RegExp(String.raw`^return (.+?) to ${HAND}$`, 'i')))) return out({ fn: 'toHand', sel: selector(m[1], at) });
  if ((m = s.match(new RegExp(String.raw`^put (.+?) on the bottom of ${DECK}$`, 'i')))) return out({ fn: 'toDeckBottom', sel: selector(m[1], at) });
  if ((m = s.match(new RegExp(String.raw`^shuffle (.+?) into ${DECK}$`, 'i')))) return out({ fn: 'shuffleIn', sel: selector(m[1], at) });
  if ((m = s.match(/^put the top card of your deck into your inkwell facedown( and exerted)?$/i))) return out({ fn: 'inkTop', exerted: !!m[1] });
  if ((m = s.match(new RegExp(String.raw`^put (.+?) into ${INKWELL} facedown( and exerted)?$`, 'i')))) return out({ fn: 'toInkwell', sel: selector(m[1], at), exerted: !!m[2] });
  if ((m = s.match(/^exert (.+)$/i))) return out({ fn: 'exert', sel: selector(m[1], at) });
  if ((m = s.match(/^ready (.+)$/i))) return out({ fn: 'ready', sel: selector(m[1], at) });
  if ((m = s.match(new RegExp(String.raw`^(each|chosen) opponent (?:chooses and )?discards ${NUM} cards?( at random)?$`, 'i')))) return out({ fn: 'discard', who: 'opp', n: N(m[2]), random: !!m[3] || undefined });
  if ((m = s.match(new RegExp(String.raw`^(?:choose and )?discard ${NUM} cards?( at random)?$`, 'i')))) return out({ fn: 'discard', who: 'you', n: N(m[1]), random: !!m[2] || undefined });
  if ((m = s.match(/^each opponent chooses and banishes one of their (.+)$/i))) return out({ fn: 'oppChoose', act: 'banish', filter: filter(m[1], at) });
  if ((m = s.match(/^each opponent chooses and exerts one of their (.+)$/i))) return out({ fn: 'oppChoose', act: 'exert', filter: filter(m[1], at) });
  if ((m = s.match(/^each opponent chooses one of their (.+?) and returns (?:that card|it) to their hand$/i))) return out({ fn: 'oppChoose', act: 'toHand', filter: filter(m[1], at) });
  if ((m = s.match(/^each opponent chooses and deals (\d+) damage to one of their (.+)$/i))) return out({ fn: 'oppChoose', act: 'damage', n: +m[1], filter: filter(m[2], at) });
  if ((m = s.match(new RegExp(String.raw`^play (?:a|an) (.+?) (?:from your (hand|discard) )?for free$`, 'i')))) {
    const F = filter(m[1], at); F.zone = m[2] || 'hand'; F.owner = 'you';
    return out({ fn: 'playFree', filter: F });
  }
  if ((m = s.match(/^pay (\d+) \{ink\}$/i))) return out({ fn: 'payInk', n: +m[1] });
  if ((m = s.match(/^look at the top (\d+|card) cards? of your deck$/i))) return out({ fn: 'look', n: m[1] === 'card' ? 1 : +m[1] });
  if ((m = s.match(/^look at the top card of your deck$/i))) return out({ fn: 'look', n: 1 });
  if ((m = s.match(/^shuffle your deck$/i))) return out({ fn: 'shuffle' });
  if ((m = s.match(new RegExp(String.raw`^put the top (?:${NUM} )?cards? of your deck into your discard$`, 'i')))) return out({ fn: 'mill', n: N(m[1] || '1') });
  if ((m = s.match(/^put (\d+) damage(?: counters?)? on (.+)$/i))) return out({ fn: 'damage', n: +m[1], sel: selector(m[2], at), put: true });
  if ((m = s.match(/^give (.+?) ([+-]\d+) \{(strength|willpower|lore)\}$/i))) return out(D({ fn: 'mod', sel: selector(m[1], at), mods: [{ stat: STAT[m[3]], n: +m[2] }] }));
  if ((m = s.match(/^each opponent chooses one of their (.+?) and deals (\d+) damage to (?:them|it)$/i))) return out({ fn: 'oppChoose', act: 'damage', n: +m[2], filter: filter(m[1], at) });

  // "<selector> gets +N {stat}" / "gains <keywords>" / "can't quest"
  if ((m = s.match(/^(.+?) (?:gets?|gains?) ([+-]\d+) \{(strength|willpower|lore)\}(?: and ([+-]\d+) \{(strength|willpower|lore)\})?(?: for each (.+))?$/i))) {
    const sel = selector(m[1], at);
    const mods = [{ stat: STAT[m[3]], n: +m[2] }];
    if (m[4]) mods.push({ stat: STAT[m[5]], n: +m[4] });
    const st = { fn: 'mod', sel, mods };
    if (m[6]) st.per = forEach(m[6], at);
    return out(D(st));
  }
  if ((m = s.match(/^(.+?) (?:gets?|gains?) ([+-]\d+) \{(strength|willpower|lore)\} and gains? (.+)$/i))) {
    const kws = kwList(m[4]);
    if (!kws) miss(`keywords: "${m[4]}"`, at);
    return out(D({ fn: 'mod', sel: selector(m[1], at), mods: [{ stat: STAT[m[3]], n: +m[2] }], kws }));
  }
  if ((m = s.match(new RegExp(String.raw`^(.+?) (?:gains?|gets?) (${KW_LIST_ITEM}(?:(?:,|,? and) ${KW_LIST_ITEM})*)$`, 'i')))) {
    const kws = kwList(m[2]);
    if (!kws) miss(`keywords: "${m[2]}"`, at);
    return out(D({ fn: 'mod', sel: selector(m[1], at), kws }));
  }
  if ((m = s.match(/^(.+?) (?:can't|cannot) (quest|challenge|ready|be challenged|sing songs|move)(?: or (quest|challenge))?(?: during their next turn)?$/i))) {
    const no = [m[2], m[3]].filter(Boolean).map((x) => ({ quest: 'cantQuest', challenge: 'cantChallenge', ready: 'cantReady', 'be challenged': 'cantBeChallenged', 'sing songs': 'cantSing', move: 'cantMove' }[x.toLowerCase()]));
    const st = { fn: 'mod', sel: selector(m[1], at), kws: no.map((kw) => ({ kw })) };
    if (/during their next turn$/i.test(s)) st.dur = 'theirNext';
    return out(st.dur ? st : D(st));
  }
  if ((m = s.match(/^you pay (\d+) \{ink\} less (?:for the next (.+?) you play|to play (.+?))$/i))) {
    return out({ fn: 'costMod', n: +m[1], filter: filter(m[2] || m[3], at), next: !!m[2] || undefined, ...(dur ? { dur } : {}) });
  }
  if ((m = s.match(/^(?:this character|he|she|it) can challenge ready characters$/i))) return out(D({ fn: 'mod', sel: { self: true }, kws: [{ kw: 'challengeReady' }] }));
  miss(`effect: "${s}"`, at);
}

// ---------------------------------------------------------------- effect text → steps

function sentences(t) {
  const out = [];
  let buf = '';
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    buf += ch;
    if (ch === '"') q = !q;
    if (!q && /[.!]/.test(ch) && (i + 1 >= t.length || t[i + 1] === ' ') && !/\.\.$/.test(buf)) { out.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// Look-at-top-N sentences that belong to a "look" step
function lookTail(s, st, at) {
  let m;
  const t = s.replace(/\.$/, '');
  if ((m = t.match(new RegExp(String.raw`^you may reveal (?:(a|an|up to ${NUM}) )?(.+?) and put (?:it|them) into your hand$`, 'i')))) {
    st.pick = { filter: filter(m[3], at), n: m[2] ? N(m[2]) : 1, may: true, to: 'hand', reveal: true }; return true;
  }
  if ((m = t.match(/^put (one|\d+) (?:of them )?into your hand$/i))) { st.pick = { filter: {}, n: N(m[1]), to: 'hand' }; return true; }
  if ((m = t.match(/^put (one|\d+) (?:of them )?into your hand and the rest on the (bottom|top) of your deck(?: in any order)?$/i))) { st.pick = { filter: {}, n: N(m[1]), to: 'hand' }; st.rest = m[2]; return true; }
  if ((m = t.match(/^put the rest on the (bottom|top) of your deck(?: in any order)?$/i))) { st.rest = m[1]; return true; }
  if ((m = t.match(/^put (one|\d+) (?:of them )?into your hand and the (?:other|rest) on the (bottom|top) of your deck(?: in any order)?$/i))) { st.pick = { filter: {}, n: N(m[1]), to: 'hand' }; st.rest = m[2]; return true; }
  if ((m = t.match(/^put the rest (?:in|into) your discard$/i))) { st.rest = 'discard'; return true; }
  if ((m = t.match(/^put (?:it|them) on either the top or the bottom of your deck$/i)) || /^put it on (?:either )?the top or (?:the )?bottom of your deck$/i.test(t)) { st.scry = true; return true; }
  if ((m = t.match(/^put one on the top of your deck and the other on the bottom$/i))) { st.scry = true; return true; }
  if ((m = t.match(/^put (?:them|those cards) back (?:on top )?in any order$/i)) || /^put them back on (?:the )?top of your deck in any order$/i.test(t)) { st.rest = 'top'; return true; }
  return false;
}

export function effects(text, ctx = {}) {
  const steps = [];
  const at = text;
  const chooseAt = text.search(/choose one: • /i);
  if (chooseAt >= 0) {
    const before = text.slice(0, chooseAt).trim();
    const opts = text.slice(chooseAt).replace(/^choose one: • /i, '').split(/ • /);
    if (before) steps.push(...effects(before, ctx));
    steps.push({ fn: 'chooseOne', labels: opts.map((o) => o.trim().replace(/\.$/, '')), options: opts.map((o) => effects(o.trim(), ctx)) });
    return steps;
  }
  for (const sent of sentences(text)) {
    const last = steps[steps.length - 1];
    if (last?.fn === 'look' && lookTail(sent, last, at)) continue;
    let s = sent.replace(/[.!]$/, '').trim();
    let ifDid = false;
    let cond = null;
    let m;
    if ((m = s.match(/^then,? (.+)$/i))) s = m[1];
    if ((m = s.match(/^if you do,? (.+)$/i))) { ifDid = true; s = m[1]; }
    if ((m = s.match(/^if (.+?), (.+)$/i)) && !/^if you do/i.test(s)) { cond = condition(m[1], at); s = m[2]; }
    if ((m = s.match(/^otherwise,? (.+)$/i))) { const st = effects(m[1], ctx); st[0].otherwise = true; steps.push(...st); continue; }
    const parts = s.split(/,? then,? /i);
    parts.forEach((part, i) => {
      let p = part;
      let pm;
      // "you may pay 2 {ink} to draw a card" / "you may exert X to Y" / "you may banish this item to ..."
      if ((pm = p.match(/^(you may )?(pay \d+ \{ink\}|exert .+?|banish .+?|discard a card|choose and discard a card|put .+? into your inkwell facedown|return .+? to your hand) to (.+)$/i))) {
        const cost = clause((pm[1] || '') + pm[2], ctx);
        steps.push(cost);
        const st = effects(pm[3], ctx);
        st.forEach((x) => { x.ifDid = true; });
        steps.push(...st);
        return;
      }
      const st = clause(p, ctx);
      if (i > 0) st.linked = true;
      if (i === 0 && ifDid) st.ifDid = true;
      if (i === 0 && cond) st.cond = cond;
      steps.push(st);
    });
  }
  if (!steps.length) miss('no effect', at);
  return steps;
}

// ---------------------------------------------------------------- triggers (L1)

const TRIG = [
  [/^when you play this (?:character|item|location) and whenever (?:he|she|it|they|this character) quests?$/i, () => [{ ev: 'play' }, { ev: 'quest' }]],
  [/^when you play this (?:character|item|location)$/i, () => [{ ev: 'play' }]],
  [/^whenever this character quests$/i, () => [{ ev: 'quest' }]],
  [/^whenever (?:this character|he|she|it) challenges(?: another character| a character)?$/i, () => [{ ev: 'challenges' }]],
  [/^whenever (?:this character|he|she|it) challenges a damaged character$/i, () => [{ ev: 'challenges', filter: { damaged: true } }]],
  [/^whenever this character is challenged$/i, () => [{ ev: 'challenged' }]],
  [/^when(?:ever)? this (?:character|item|location) is banished$/i, () => [{ ev: 'banished' }]],
  [/^when(?:ever)? this character is banished in a challenge$/i, () => [{ ev: 'banished', inChallenge: true }]],
  [/^when(?:ever)? this character is challenged and banished$/i, () => [{ ev: 'banished', inChallenge: true, defending: true }]],
  [/^whenever this character banishes another character in a challenge$/i, () => [{ ev: 'banishOther' }]],
  [/^at the start of your turn$/i, () => [{ ev: 'turnStart' }]],
  [/^at the end of your turn$/i, () => [{ ev: 'turnEnd' }]],
  [/^whenever this character sings a song$/i, () => [{ ev: 'sings' }]],
  [/^whenever you ready this character$/i, () => [{ ev: 'ready' }]],
  [/^whenever you put a card under this character$/i, () => [{ ev: 'putUnder' }]],
  [/^whenever a character quests while here$/i, () => [{ ev: 'questHere' }]],
  [/^whenever this character is dealt damage$/i, () => [{ ev: 'dealtDamage' }]],
  [/^whenever this character moves to a location$/i, () => [{ ev: 'moves' }]],
  [/^whenever you move a character here$/i, () => [{ ev: 'moveHere' }]],
];
function trigger(head, at) {
  for (const [rx, f] of TRIG) if (rx.test(head)) return f();
  let m;
  if ((m = head.match(/^whenever you play (?:a|an|another) (.+)$/i))) { const F = filter(m[1], at); if (/^whenever you play another/i.test(head)) F.other = true; return [{ ev: 'playCard', filter: F }]; }
  if ((m = head.match(/^whenever an opponent plays (?:a|an) (.+)$/i))) return [{ ev: 'oppPlayCard', filter: filter(m[1], at) }];
  if ((m = head.match(/^whenever one of your (other )?(.+?) quests$/i))) { const F = filter(m[2], at); if (m[1]) F.other = true; return [{ ev: 'questAny', filter: F }]; }
  if ((m = head.match(/^whenever one of your (other )?(.+?) is banished( in a challenge)?$/i))) { const F = filter(m[2], at); if (m[1]) F.other = true; return [{ ev: 'banishedAny', filter: F, inChallenge: !!m[3] || undefined }]; }
  if ((m = head.match(/^whenever one of your (other )?(.+?) challenges another character$/i))) { const F = filter(m[2], at); if (m[1]) F.other = true; return [{ ev: 'challengesAny', filter: F }]; }
  if ((m = head.match(/^whenever you play a song$/i))) return [{ ev: 'playCard', filter: { types: ['song'] } }];
  if ((m = head.match(/^whenever (?:a card is put|you put a card) into your inkwell$/i))) return [{ ev: 'inked' }];
  if ((m = head.match(/^whenever one of your (other )?(.+?) sings a song$/i))) { const F = filter(m[2], at); if (m[1]) F.other = true; return [{ ev: 'singsAny', filter: F }]; }
  if ((m = head.match(/^whenever one of your (other )?(.+?) banishes another character in a challenge$/i))) { const F = filter(m[2], at); if (m[1]) F.other = true; return [{ ev: 'banishOtherAny', filter: F }]; }
  if ((m = head.match(/^whenever you play this character or another (.+)$/i))) { const F = filter(m[1], at); F.other = true; return [{ ev: 'play' }, { ev: 'playCard', filter: F }]; }
  if ((m = head.match(/^(.+?) while (?:he|she|it|they|this character) (?:has|have|is|are) (.+)$/i))) {
    const on = trigger(m[1], at);
    if (on) { const c = condition(`this character ${/^(?:has|have) /i.test(head.slice(m[1].length + 7).replace(/^\S+ /, '')) ? 'has' : 'has'} ${m[2]}`, at); return on.map((o) => ({ ...o, whileCond: c })); }
  }
  return null;
}

// ---------------------------------------------------------------- abilities (L1)

const SONG_REMINDER = /^\(?(?:a|an) character with cost \d+ or more can \{exert\} to sing this song for free\.?\)?$/i;
const SING_TOGETHER = /^sing together \d+\s*/i;

export function compileAbility(ab, cardType) {
  const name = ab.name || null;
  let text = canon(ab.text ?? ab.description ?? '');
  text = text.replace(/^[A-Z0-9][A-Z0-9'!?,.\- ]{2,}\s+(?=[A-Z][a-z])/, (h) => (name && h.trim().toUpperCase() === name.toUpperCase() ? '' : h));
  const base = { name, text };
  try {
    const proc = compileText(text, cardType, !!name);
    return { ...base, ...proc, ...execInfo(proc) };
  } catch (e) {
    if (!(e instanceof Miss)) throw e;
    return { ...base, kind: 'unparsed', why: e.message, at: e.at, exec: false };
  }
}

function compileText(text, cardType, named) {
  if (!text) return { kind: 'reminder' };
  const spell = cardType === 'action' || cardType === 'song';
  // songs: the "can sing this for free" reminder and "Sing Together N" are rules the engine already knows
  let t = text.replace(SING_TOGETHER, (m) => (spell ? '' : m)).trim();
  if (spell && SONG_REMINDER.test(stripReminders(t) === '' ? t : t.match(/^\([^)]*\)/)?.[0] || '')) t = t.replace(/^\([^)]*\)\s*/, '');
  if (!t) return { kind: 'reminder' };
  if (!named || /^(shift|evasive|bodyguard|rush|ward|resist|challenger|singer|support|reckless|alert|vanish|boost|puppy shift|universal shift|[A-Z][a-z]+ shift)\b/i.test(t)) {
    const kws = keywordLine(t);
    if (kws) return { kind: 'keyword', kws };
  }
  t = stripReminders(t);
  if (!t) return { kind: 'reminder' };
  if (spell) {
    // "If you have X in play, you pay 2 {ink} less to play this action." rides along as a play-cost rule
    let playCost;
    const pc = t.match(/^(?:if (.+?), )?you pay (\d+) \{ink\} less to play this (?:action|song)\.\s*(.*)$/i);
    if (pc) { playCost = { n: +pc[2], ...(pc[1] ? { cond: condition(pc[1], t) } : {}) }; t = pc[3]; }
    return { kind: 'action', ...(playCost ? { playCost } : {}), do: effects(t) };
  }

  // modifiers that wrap the rest
  let once = false; let during = null; let m;
  for (let guard = 0; guard < 3; guard++) {
    if ((m = t.match(/^once (?:during your|per) turn,? (.+)$/i))) { once = true; t = m[1]; continue; }
    if ((m = t.match(/^during your turn,? (.+)$/i))) { during = 'yours'; t = m[1]; continue; }
    if ((m = t.match(/^during (?:an opponent's turn|opponents' turns|each opponent's turn),? (.+)$/i))) { during = 'opp'; t = m[1]; continue; }
    break;
  }
  const mods = { ...(once ? { once } : {}), ...(during ? { during } : {}) };

  // activated:  "{exert}, 2 {ink}, Banish this item — effect"
  const cm = t.match(/^((?:\{exert\}|\d+ \{ink\}|banish this (?:item|character|location)|choose and discard (?:a|an?) (?:\w+ )?card|discard (?:a|an?) (?:\w+ )?card|exert (?:one of your|an?|\d+) [^—]+?|put [^—]+? into your inkwell facedown|remove \d+ damage from this character|[, ]+)+) — (.+)$/i);
  if (cm) return { kind: 'activated', cost: costOf(cm[1], t), ...mods, do: effects(cm[2]) };

  // triggered:  "<trigger>, effect"  (trigger may contain commas only via known heads)
  const ci = t.indexOf(', ');
  if (ci > 0) {
    const head = t.slice(0, ci);
    const on = trigger(head, t);
    if (on) {
      let body = t.slice(ci + 2);
      let cond;
      const cm2 = body.match(/^if (.+?), (.+)$/i);
      if (cm2 && !/^if you do/i.test(body)) { cond = condition(cm2[1], t); body = cm2[2]; }
      return { kind: 'triggered', on, ...mods, ...(cond ? { cond } : {}), do: effects(body, { refIsSelf: true }) };
    }
    if (/^(when|whenever|at the) /i.test(head)) miss(`trigger: "${head}"`, t);
  }

  // static
  t = t.replace(/\.$/, '');
  let cond = null;
  if ((m = t.match(/^(?:while|if|as long as) (.+?), (.+)$/i))) { cond = condition(m[1], t); t = m[2]; }
  if ((m = t.match(/^for each (.+?), you pay (\d+) \{ink\} less to play this character$/i))) {
    return { kind: 'static', ...mods, ...(cond ? { cond } : {}), effect: { fn: 'selfCost', n: +m[2], per: forEach(m[1], t) } };
  }
  if ((m = t.match(/^you pay (\d+) \{ink\} less to play this (?:character|item|location)$/i))) {
    return { kind: 'static', ...mods, ...(cond ? { cond } : {}), effect: { fn: 'selfCost', n: +m[1] } };
  }
  if ((m = t.match(/^this (?:character|item|location) enters play (exerted|with (\d+) damage)$/i))) {
    return { kind: 'static', ...mods, ...(cond ? { cond } : {}), effect: { fn: 'enters', ...(m[2] ? { damage: +m[2] } : { exerted: true }) } };
  }
  const parts = sentences(t);
  if (parts.length === 1) {
    const eff = clause(parts[0], { static: true });
    if (eff.fn === 'mod' || eff.fn === 'costMod') {
      if (eff.dur) miss('static with a duration', t);
      return { kind: 'static', ...mods, ...(cond ? { cond } : {}), effect: eff };
    }
  }
  miss(`static: "${t}"`, t);
}

function costOf(s, at) {
  const cost = {};
  for (const raw of s.split(/,\s*/)) {
    const p = raw.trim();
    if (!p) continue;
    let m;
    if (p === '{exert}') cost.exert = true;
    else if ((m = p.match(/^(\d+) \{ink\}$/))) cost.ink = +m[1];
    else if (/^banish this (item|character|location)$/i.test(p)) cost.banishSelf = true;
    else if ((m = p.match(/^(?:choose and )?discard (?:a|an) (.+)$/i))) cost.discard = m[1].toLowerCase() === 'card' ? {} : filter(m[1], at);
    else if ((m = p.match(/^exert (?:one of your|an?) (.+)$/i))) cost.exertOther = filter(m[1], at);
    else if ((m = p.match(/^remove (\d+) damage from this character$/i))) cost.healSelf = +m[1];
    else miss(`cost: "${p}"`, at);
  }
  return cost;
}

// ---------------------------------------------------------------- can the engine run it?

function walk(proc, visit) {
  const seen = (st) => {
    if (!st || typeof st !== 'object') return;
    visit(st);
    for (const v of Object.values(st)) {
      if (Array.isArray(v)) v.forEach((x) => (Array.isArray(x) ? x.forEach(seen) : seen(x)));
      else if (v && typeof v === 'object') seen(v);
    }
  };
  seen(proc);
}

export function execInfo(proc) {
  const missing = new Set();
  if (proc.kind === 'keyword') {
    for (const k of proc.kws) if (!SUPPORT.kw.has(k.kw) || (k.cost && !/^\d+$/.test(k.cost))) missing.add(`keyword ${k.kw}${k.cost ? ': ' + k.cost : ''}`);
  } else if (proc.kind === 'reminder') {
    /* nothing to do */
  } else {
    for (const o of proc.on || []) if (!SUPPORT.trigger.has(o.ev)) missing.add(`trigger ${o.ev}`);
    if (proc.kind === 'activated') for (const k of Object.keys(proc.cost)) if (!SUPPORT.cost.has(k)) missing.add(`cost ${k}`);
    if (proc.kind === 'static' && !SUPPORT.static.has(proc.effect.fn)) missing.add(`static ${proc.effect.fn}`);
    walk(proc, (st) => {
      if (st.fn && st !== proc.effect && !SUPPORT.fn.has(st.fn)) missing.add(`fn ${st.fn}`);
      for (const k of ['have', 'self', 'hand', 'moreCardsThanOpp', 'oppMoreLore', 'youMoreLore', 'playedThisTurn', 'yourTurn', 'shifted', 'refIs', 'any', 'count', 'under', 'damageOnSelf']) {
        if (k in st && st !== proc && !SUPPORT.cond.has(k) && !(k === 'self' && st.self === true)) missing.add(`cond ${k}`);
      }
      if (st.kw && typeof st.kw === 'string' && st.kw.startsWith('cant') && !SUPPORT.kw.has(st.kw)) missing.add(`restriction ${st.kw}`);
      if (st.kws) for (const k of st.kws) if (!SUPPORT.kw.has(k.kw)) missing.add(`keyword ${k.kw}`);
      if (st.dur && !SUPPORT.dur.has(st.dur)) missing.add(`duration ${st.dur}`);
    });
  }
  return missing.size ? { exec: false, why: `engine can't run: ${[...missing].join(', ')}` } : { exec: true };
}

// A whole card → one proc per ability
export function compileCard(card) {
  const type = (card.type || '').toLowerCase();
  return (card.abilities || []).map((ab) => compileAbility(ab, type));
}
