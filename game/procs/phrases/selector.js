// Who an effect touches:  { self } · { ref } (it/them — the last thing acted on) · { chosen: Query, upTo? } · { all: Query }
import { miss, N, NUM } from './text.js';
import { filter } from './filter.js';
import { Query } from '../query.js';

export class Selector {
  static parse(phrase, at = phrase) {
    const p = phrase.trim().replace(/^the /i, '');
    if (/^this (character|item|location|card)$/i.test(p)) return { self: true };
    // the two sides of the challenge this ability fired in
    if (/^(?:challenging character|challenger|character who challenged)$/i.test(p)) return { role: 'challenger' };
    if (/^(?:challenged character|character who was challenged|character (?:he|she|they) challenged)$/i.test(p)) return { role: 'challenged' };
    if (/^(he|she|him|her)$/i.test(p)) return { ref: true, pron: true };
    if (/^other (?:character|card|one)$/i.test(p)) return { ref: true, nth: -1 };    // "the other character" — the last one acted on
    if (/^(?:that card|that character|it) from (?:your|their) discard$/i.test(p)) return { ref: true };
    // "chosen opposing character and all other opposing characters with the same name" · "each opposing character with
    // Evasive and each opposing location with Evasive" — both groups, the second seeing the first as "that character"
    const both = Selector.union(p, at);
    if (both) return both;
    if (/^(him|her|it|them|that character|the chosen character|that card|those characters|those cards|that item|that location|they|he|she|the challenging character|the challenged character|the revealed card|that song|the banished character|the moved character|discarded character|those characters|each of them|both of them)$/i.test(p)) return { ref: true };
    let m;
    // "any number of cards from under your characters and locations"
    if ((m = p.match(/^(any number of|up to (\d+)) cards from under your (?:characters|locations|characters and locations|characters or locations)$/i))) return { chosen: { zone: 'under', owner: 'you' }, upTo: m[2] ? +m[2] : 99 };
    if ((m = p.match(new RegExp(String.raw`^up to ${NUM} (?:other )?chosen (.+)$`, 'i')))) {
      const F = filter(m[2], at); if (/^up to \S+ other/i.test(p)) F.other = true;
      return { chosen: F, upTo: N(m[1]) };
    }
    if ((m = p.match(/^any number of (?:your |chosen )?(other )?(.+)$/i))) { const F = filter(/^any number of your/i.test(p) ? `your ${m[2]}` : m[2], at); if (m[1]) F.other = true; return { chosen: F, upTo: 99 }; }
    // "a card from your hand", "an item card from your discard", "a card from chosen player's discard"
    if ((m = p.match(/^(?:a|an|another|one) (.+? )?(?:card )?from (your|chosen player's|any|chosen opponent's|an opponent's) (hand|discard)$/i))) {
      const F = m[1] ? filter(`${m[1].trim()}${/\bcard\b/i.test(m[1]) ? '' : ' card'}`, at) : {};
      F.zone = m[3].toLowerCase();
      if (m[2] === 'your') F.owner = 'you'; else if (/opponent/.test(m[2])) F.owner = 'opp';
      if (/^another/i.test(p)) F.other = true;
      return { chosen: F };
    }
    // "up to 2 cards from chosen player's discard" · "3 item cards from your discard" (exactly that many)
    if ((m = p.match(new RegExp(String.raw`^(up to )?${NUM} (.+? )?cards? from (your|chosen player's|any|chosen opponent's) (hand|discard)$`, 'i')))) {
      const F = m[3] ? filter(`${m[3].trim()} card`, at) : {};
      F.zone = m[5].toLowerCase(); if (m[4] === 'your') F.owner = 'you'; else if (/opponent/.test(m[4])) F.owner = 'opp';
      return { chosen: F, upTo: N(m[2]), ...(m[1] ? {} : { exactly: true }) };
    }
    if (/^all (?:of )?(?:the )?cards in your hand$/i.test(p)) return { all: { zone: 'hand', owner: 'you' } };
    // "2 cards at random from your inkwell" — picked by the game (CR 6.7)
    if ((m = p.match(new RegExp(String.raw`^${NUM} cards? at random from (your|their) (inkwell|hand|discard)$`, 'i')))) return { all: { zone: m[3].toLowerCase(), owner: 'you' }, random: N(m[1]) };
    if (/^this card from your discard$/i.test(p)) return { self: true };
    if ((m = p.match(/^(another|a) chosen (.+)$/i))) { const F = filter(m[2], at); if (m[1].toLowerCase() === 'another') F.other = true; return { chosen: F }; }
    // "another 2 chosen characters of yours" — exactly that many
    if ((m = p.match(new RegExp(String.raw`^(another )?${NUM} (?:other )?chosen (.+)$`, 'i'))) && N(m[2]) > 1) { const F = filter(m[3], at); if (m[1] || /other chosen/i.test(p)) F.other = true; return { chosen: F, upTo: N(m[2]), exactly: true }; }
    if ((m = p.match(/^chosen (.+)$/i))) return { chosen: filter(m[1], at) };
    if ((m = p.match(/^one of (your|their) (.+)$/i))) { const F = filter(m[2], at); if (m[1] === 'your') F.owner = 'you'; return { chosen: F, yours: true }; }
    if ((m = p.match(/^(?:each|all|every) (?:of )?(your |opposing )?(other )?(.+)$/i))) return { all: filter((m[1] || '') + (m[2] || '') + m[3], at) };
    if ((m = p.match(/^(your|opposing) (.+)$/i))) return { all: filter(p, at) };
    if ((m = p.match(/^(characters|items|locations) (here|in play)$/i))) return { all: filter(p, at) };
    if ((m = p.match(/^(other )?((?:[\w'.-]+ )*?(?:characters|items|locations))(?: (.+))?$/))) {   // "Villain characters" — filter() decides
      try { const F = filter(p.replace(/^other /i, ''), at); if (m[1]) F.other = true; return { all: F }; } catch { /* fall through */ }
    }
    miss(`selector: "${p}"`, at);
  }
  static union(p, at) {
    for (const m of p.matchAll(/ and (?=(?:all|each|every|chosen|up to|another) )/gi)) {
      const a = p.slice(0, m.index), b = p.slice(m.index + 5);
      let A, B;
      try { A = Selector.parse(a, at); B = Selector.parse(b, at); } catch { continue; }
      if ((A.chosen || A.all) && (B.chosen || B.all)) return { both: [A, B] };
    }
    return null;
  }
  static say(s) {
    if (!s) return '';
    if (s.both) return s.both.map(Selector.say).join(' and ');
    if (s.self) return 'this card';
    if (s.role) return `the ${s.role} character`;
    if (s.singers) return 'the characters who sang it';
    if (s.ref && s.pron) return 'him/her';
    if (s.ref) return 'that card';
    if (s.all) return `each ${Query.describe(s.all)}`;
    if (s.chosen) return `${s.upTo ? `up to ${s.upTo} ` : ''}chosen ${Query.describe(s.chosen)}`;
    return '?';
  }
}
