// lorcanajson.org's allCards.json — community-transcribed from the printed cards, official errata applied.
// The third source in the rulings vote (cards.db · card image · lorcanajson); see tools/build-rulings.mjs.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { splitDbAbilities } from '../../game/procs/normalize.js';

export const LORCANAJSON_URL = 'https://lorcanajson.org/files/current/en/allCards.json';

const SYM = { '⬡': '{ink}', '¤': '{strength}', '◊': '{lore}', '⟳': '{exert}', '⛉': '{willpower}', '◉': '{inkable}' };
const sym = (t) => Object.entries(SYM).reduce((s, [k, v]) => s.split(k).join(v), String(t || '')).replace(/\s+/g, ' ').trim();

// one card → [{ name, text }] in the DB's shape (actions / songs: keyword lines + one effect text)
export function ljAbilities(c) {
  const kw = (c.abilities || []).filter((a) => a.type === 'keyword').map((a) => ({ name: '', text: sym(a.fullText) }));
  if (c.type === 'Action') return [...kw, ...(c.effects?.length ? [{ name: '', text: sym(c.effects.join(' ')) }] : [])];
  return (c.abilities || []).map((a) => (a.type === 'keyword' ? { name: '', text: sym(a.fullText) }
    : { name: a.name || '', text: sym((a.costsText ? `${a.costsText} — ` : '') + (a.effect || '')) }));
}

// the card's own keyword lines ("Shift 5 {ink} (You may pay…)", "Evasive (…)") that `abilities` doesn't print —
// the DB keeps keywords in a column of their own, so its ability text often leaves them out
export function missingKeywordLines(c, abilities) {
  const have = abilities.map((a) => String(a.text).toLowerCase());
  return (c?.abilities || []).filter((a) => a.type === 'keyword' && a.keyword)
    .filter((a) => !have.some((t) => t.startsWith(a.keyword.toLowerCase())))
    .map((a) => ({ name: '', text: sym(a.fullText) }));
}

// "Name - Title" → card; null when the file isn't there (the vote then runs on DB + scan only)
export function loadLorcanaJson(file) {
  if (!existsSync(file)) return null;
  const cards = JSON.parse(readFileSync(file, 'utf8')).cards || [];
  return new Map(cards.map((c) => [c.fullName || c.name, c]));
}

// Comparable form of a card's rules: words + icons only, reminder text and keyword lines dropped (the DB keeps
// keywords in their own column), every icon spelling the same. Two sources agree when their keys are equal.
const KW_LINE = /^(?:shift|adventurous|singer|support|ward|evasive|rush|bodyguard|resist|challenger|reckless|alert|vanish|boost|sing together|universal shift|puppy shift|[a-z]+ shift)\b/;
const ICON = { I: 'ink', S: 'strength', E: 'exert', L: 'lore', W: 'willpower', C: 'inkable' };
export function rulesKey(abilities) {
  return abilities.flatMap((a) => splitDbAbilities(a.name || '', a.text ?? a.description ?? ''))
    .map((a) => `${a.name || ''} | ${a.text}`.replace(/\{([ISELWC])\}/g, (m, k) => `{${ICON[k]}}`)
      .replace(/[<>\\]/g, '').replace(/[‘’]/g, "'").replace(/—/g, '-').toLowerCase()
      .replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9{}|+-]+/g, ' ').trim())
    .filter((t) => t.replace(/[|\s]/g, '') && !KW_LINE.test(t.replace(/^\s*\|\s*/, '')))
    .join(' / ');
}
// the same, without ability names — for checking text against the set release notes
const bodyKey = (abilities) => rulesKey(abilities.map((a) => ({ text: a.text ?? a.description }))).replace(/\s*\|\s*/g, ' ').replace(/ \/ /g, ' ');

// Set release notes (docs/rules/) reprint changed cards with their official text (Jukebox's errata).
// → (abilities) → true when that wording is printed there
export function officialText(rulesDir) {
  const notes = existsSync(rulesDir) ? readdirSync(rulesDir).filter((f) => /notes/i.test(f))
    .map((f) => readFileSync(path.join(rulesDir, f), 'utf8')).join(' ') : '';
  const flat = notes.replace(/\\[^\\\n]+\\/g, ' ').toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9{}+-]+/g, ' ');
  return (abilities) => {
    const k = bodyKey(abilities);
    return k.length > 20 && flat.includes(k);
  };
}
