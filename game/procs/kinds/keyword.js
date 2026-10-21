// "Evasive" · "Shift 5 {ink}" · "Resist +2" · "Singer 5" · "Boost 2 {ink}" · "Puppy Shift: Discard a card"
import { Kind } from './Kind.js';
import { stripReminders } from '../normalize.js';
import { keywordId, kwLabel, KEYWORD_ALT } from '../classifiers/index.js';

const ITEM = new RegExp(String.raw`^(${KEYWORD_ALT}|[A-Z][a-z]+ Shift)\b(?:\s*\+?\s*(\d+)(?:\s*\{ink\})?|:\s*([^.]+?)(?=\s+(?:${KEYWORD_ALT})\b|$))?\s*`, 'i');
export const KEYWORD_START = new RegExp(String.raw`^(?:${KEYWORD_ALT}|[A-Z][a-z]+ shift)\b`, 'i');

export class KeywordLine extends Kind {
  static kind = 'keyword';
  static parse(text) {
    let rest = stripReminders(text);
    const kws = [];
    while (rest) {
      const m = rest.match(ITEM);
      if (!m) return null;
      const kw = keywordId(m[1]) || (/ shift$/i.test(m[1]) ? 'classShift' : null);
      const item = { kw };
      if (m[2] != null) item.n = Number(m[2]);
      if (m[3]) item.cost = m[3].trim();
      if (kw === 'classShift') item.cls = m[1].replace(/ Shift$/i, '');
      kws.push(item);
      rest = rest.slice(m[0].length).trim();
    }
    return kws.length ? { kind: 'keyword', kws } : null;
  }
  static check(p, missing, S) {
    for (const k of p.kws) if (!S.kw.has(k.kw) || (k.cost && !/^\d+$/.test(k.cost))) missing.add(`keyword ${k.kw}${k.cost ? ': ' + k.cost : ''}`);
  }
  static explain(p, X) {
    return [X.tag('keyword'), p.kws.map((k) => `${k.kw === 'classShift' ? `${k.cls} Shift${k.n != null ? ` ${k.n}` : ''}` : kwLabel(k.kw, k.n)}${k.cost ? ` (${k.cost})` : ''}`).join(', ')];
  }
}
