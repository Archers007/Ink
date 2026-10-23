// Trigger registry + engine-event dispatch table.
import { parseCondition } from '../conditions/index.js';
import * as play from './play.js';
import * as quest from './quest.js';
import * as challenge from './challenge.js';
import * as banish from './banish.js';
import * as turn from './turn.js';
import * as sing from './sing.js';
import * as board from './board.js';
import * as act from './act.js';
import { Act } from './act.js';

const FAMILIES = [play, quest, challenge, banish, turn, sing, board, act];
export const TRIGGERS = FAMILIES.flatMap((f) => Object.values(f).filter((x) => typeof x === 'function' && x.ev));
export const TRIGGER = Object.fromEntries(TRIGGERS.map((T) => [T.ev, T]));
export const EVENTS = Object.assign({}, ...FAMILIES.map((f) => f.events || {}));

// head text → [on…] or null.  "<head> while this character has/is X" adds a condition checked at fire time.
export function parseTrigger(head, P) {
  head = head.replace(/\b(he|she|it)'s\b/gi, '$1 is').replace(/\bthey're\b/gi, 'they are');
  // "the first time you move a character here [each turn]" · "whenever he sings a song for the first time each turn"
  let fm = head.match(/^the first time (.+?)(?: each turn)?$/i);
  if (fm) { const r = parseTrigger(`whenever ${fm[1]}`, P); return r && r.map((o) => ({ ...o, first: true })); }
  fm = head.match(/^((?:when|whenever) .+?) for the first time each turn$/i);
  if (fm) { const r = parseTrigger(fm[1], P); return r && r.map((o, i, a) => (i === a.length - 1 ? { ...o, first: true } : o)); }
  // checked first: the specific rules would read "an action while this character is exerted" as a filter
  const m = head.match(/^(.+?) while (?:he|she|it|they|this character) ((?:has|have|is|are) .+)$/i);
  if (m) {
    const on = parseTrigger(m[1], P);
    if (on) { const c = parseCondition(`this character ${m[2]}`, P.at); return on.map((o) => ({ ...o, whileCond: c })); }
  }
  for (const T of TRIGGERS) for (const [rx, f] of T.rules) {
    const m = head.match(rx);
    if (m) return f(m, P);
  }
  // grouping: "When you play this character and whenever you play a location" = either trigger fires it
  const g = head.match(/^((?:when|whenever|at) .+?) and ((?:when|whenever|at) .+)$/i);
  if (g) {
    const a = parseTrigger(g[1], P);
    // "… and whenever he banishes another character in a challenge during your turn" — the duration is that trigger's
    const d = g[2].match(/^(.+) during (your|an opponent's|opponents') turns?$/i);
    const b = a && (d ? parseTrigger(d[1], P)?.map((o) => ({ ...o, during: /^your$/i.test(d[2]) ? 'yours' : 'opp' })) : parseTrigger(g[2], P));
    if (a && b) return [...a, ...b];
  }
  // "when" and "whenever" are the same trigger word (CR 7.4) — retry with the other spelling
  if (!P.swapped) {
    const alt = /^when /i.test(head) ? head.replace(/^when /i, 'whenever ') : /^whenever /i.test(head) ? head.replace(/^whenever /i, 'when ') : null;
    if (alt) { const r = parseTrigger(alt, { ...P, swapped: true }); if (r) return r; }
  }
  // any subject, any verb in the act table: "Whenever one of your Hyena characters challenges a damaged character"
  return P.swapped ? null : Act.parse(head, P);
}
export const sayTrigger = (o) => (TRIGGER[o.ev] ? TRIGGER[o.ev].say(o) : o.ev);
