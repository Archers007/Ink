// Who an effect touches:  { self } · { ref } (it/them — the last thing acted on) · { chosen: Query, upTo? } · { all: Query }
import { miss, N, NUM } from './text.js';
import { filter } from './filter.js';
import { Query } from '../query.js';

export class Selector {
  static parse(phrase, at = phrase) {
    const p = phrase.trim().replace(/^the /i, '');
    if (/^this (character|item|location|card)$/i.test(p)) return { self: true };
    if (/^(him|her|it|them|that character|the chosen character|that card|those characters|those cards|that item|that location|they|he|she|the challenging character|the challenged character|the revealed card|that song|the banished character|the moved character|each of them|both of them)$/i.test(p)) return { ref: true };
    let m;
    if ((m = p.match(new RegExp(String.raw`^up to ${NUM} (?:other )?chosen (.+)$`, 'i')))) {
      const F = filter(m[2], at); if (/^up to \S+ other/i.test(p)) F.other = true;
      return { chosen: F, upTo: N(m[1]) };
    }
    if ((m = p.match(/^any number of (?:your |chosen )?(other )?(.+)$/i))) { const F = filter(/^any number of your/i.test(p) ? `your ${m[2]}` : m[2], at); if (m[1]) F.other = true; return { chosen: F, upTo: 99 }; }
    // "a card from your hand", "an item card from your discard", "a card from chosen player's discard"
    if ((m = p.match(/^(?:a|an|another|one) (.+? )?(?:card )?from (your|chosen player's|any|chosen opponent's|an opponent's) (hand|discard)$/i))) {
      const F = m[1] ? filter(`${m[1].trim()}${/card$/i.test(m[1].trim()) ? '' : ' card'}`, at) : {};
      F.zone = m[3].toLowerCase();
      if (m[2] === 'your') F.owner = 'you'; else if (/opponent/.test(m[2])) F.owner = 'opp';
      if (/^another/i.test(p)) F.other = true;
      return { chosen: F };
    }
    if ((m = p.match(/^up to (\d+) (.+? )?cards? from (your|chosen player's|any) (hand|discard)$/i))) {
      const F = m[2] ? filter(`${m[2].trim()} card`, at) : {};
      F.zone = m[4].toLowerCase(); if (m[3] === 'your') F.owner = 'you';
      return { chosen: F, upTo: +m[1] };
    }
    if (/^this card from your discard$/i.test(p)) return { self: true };
    if ((m = p.match(/^(another|a) chosen (.+)$/i))) { const F = filter(m[2], at); if (m[1].toLowerCase() === 'another') F.other = true; return { chosen: F }; }
    if ((m = p.match(/^chosen (.+)$/i))) return { chosen: filter(m[1], at) };
    if ((m = p.match(/^one of (your|their) (.+)$/i))) { const F = filter(m[2], at); if (m[1] === 'your') F.owner = 'you'; return { chosen: F, yours: true }; }
    if ((m = p.match(/^(?:each|all|every) (?:of )?(your |opposing )?(other )?(.+)$/i))) return { all: filter((m[1] || '') + (m[2] || '') + m[3], at) };
    if ((m = p.match(/^(your|opposing) (.+)$/i))) return { all: filter(p, at) };
    if ((m = p.match(/^(characters|items|locations) (here|in play)$/i))) return { all: filter(p, at) };
    if ((m = p.match(/^(other )?((?:[A-Z][\w'.-]* )*(?:characters|items|locations))(?: (.+))?$/))) {
      try { const F = filter(p.replace(/^other /i, ''), at); if (m[1]) F.other = true; return { all: F }; } catch { /* fall through */ }
    }
    miss(`selector: "${p}"`, at);
  }
  static say(s) {
    if (!s) return '';
    if (s.self) return 'this card';
    if (s.ref) return 'that card';
    if (s.all) return `each ${Query.describe(s.all)}`;
    if (s.chosen) return `${s.upTo ? `up to ${s.upTo} ` : ''}chosen ${Query.describe(s.chosen)}`;
    return '?';
  }
}
