// Who an effect touches:  { self } · { ref } (it/them — the last thing acted on) · { chosen: Query, upTo? } · { all: Query }
import { miss, N, NUM } from './text.js';
import { filter } from './filter.js';
import { Query } from '../query.js';

export class Selector {
  static parse(phrase, at = phrase) {
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
    if ((m = p.match(/^(?:each|all|every) (?:of )?(your |opposing )?(other )?(.+)$/i))) return { all: filter((m[1] || '') + (m[2] || '') + m[3], at) };
    if ((m = p.match(/^(your|opposing) (.+)$/i))) return { all: filter(p, at) };
    if ((m = p.match(/^(characters|items|locations) (here|in play)$/i))) return { all: filter(p, at) };
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
