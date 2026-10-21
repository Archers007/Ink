// Shared bits every parser uses.

export class Miss extends Error {
  constructor(why, at) { super(why); this.at = at; }
}
export const miss = (why, at) => { throw new Miss(why, at); };

const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
export const N = (w) => (w == null ? null : /^\d+$/.test(w) ? Number(w) : NUMW[w.toLowerCase()] ?? null);
export const NUM = String.raw`(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)`;
export const STAT = { strength: 'str', willpower: 'wp', lore: 'lore' };
export const STAT_WORD = { str: '{strength}', wp: '{willpower}', lore: '{lore}' };
export const lc = (s) => s.charAt(0).toLowerCase() + s.slice(1);
export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
export const SUBJ = String.raw`(?:this character|he|she|it|they)`;
export const OBJ = String.raw`(?:him|her|it|them|this character)`;

export const HAND = String.raw`(?:their player's|its player's|their owner's|its owner's|your|their|his|her|its) hands?`;
export const DECK = String.raw`(?:their player's|its player's|their owner's|its owner's|your|their) decks?`;
export const INKWELL = String.raw`(?:their player's|its player's|their owner's|your|their) inkwells?`;

// Split into sentences on . or ! — but not inside quotes (granted abilities) or "..."
export function sentences(t) {
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

// One regex table → first match wins: [[rx, (m) => value], …]
export function firstMatch(table, s) {
  for (const [rx, f] of table) { const m = s.match(rx); if (m) { const v = f(m); if (v !== undefined) return v; } }
  return undefined;
}
