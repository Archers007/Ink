// L0 — one canonical spelling for ability text, whatever source it came from
// (dreamborn DB rows of different eras, scanned text, lorcanajson corrections).
//
//   icons      {I} {S} {E} {L} {W} → {ink} {strength} {exert} {lore} {willpower}
//   tags       <Bodyguard> → Bodyguard
//   quotes     ’ ‘ → '   “ ” → "
//   costs      "{exert}, 2 {ink} - Draw" → "{exert}, 2 {ink} — Draw"
//   bullets    "Choose one: - A - B" / "• A • B" → "Choose one: • A • B"
//   spacing    collapsed, no space before . or ,

const ICON = {
  i: 'ink', ink: 'ink', inkk: 'ink', s: 'strength', strength: 'strength', e: 'exert', exert: 'exert',
  l: 'lore', lore: 'lore', w: 'willpower', willpower: 'willpower', toughness: 'willpower',
  inkwell: 'inkable', inkable: 'inkable',
};
export const ICONS = new Set(Object.values(ICON));

export function canon(text) {
  let t = String(text ?? '')
    .replace(/\{\s*([A-Za-z]+)\s*\}/g, (m, k) => (ICON[k.toLowerCase()] ? `{${ICON[k.toLowerCase()]}}` : m))
    .replace(/<([^<>]+)>/g, '$1')
    .replace(/\{((?:Evasive|Reckless|Rush|Ward|Resist|Bodyguard|Support|Challenger|Singer|Alert|Vanish|Boost|Shift)(?: \+?\d+)?)\}/gi,
      (m, k) => k.replace(/^\w/, (c) => c.toUpperCase()))            // {Rush} / {Challenger +1} → keyword name
    .replace(/\\([^\\]+)\\/g, '$1')
    .replace(/[\u2018\u2019\u02bc`´]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/\s+[-–—]\s+/g, ' — ');                       // every spaced dash is a separator
  t = t.replace(/(choose one:)\s*(?:[•—]\s*)?/i, '$1 • ');     // first bullet right after "Choose one:"
  const co = t.search(/choose one: • /i);
  if (co >= 0) t = t.slice(0, co) + t.slice(co).replace(/ — (?=[A-Z])/g, ' • ').replace(/\s*•\s*/g, ' • ');
  return t.replace(/\s+([.,;:!?])/g, '$1').replace(/\.{4,}/g, '...').replace(/\s+/g, ' ').trim();
}

// Reminder text is the parenthesised explanation after a keyword; it never adds rules.
export const stripReminders = (t) => String(t).replace(/\s*\([^()]*\)/g, '').replace(/\s+/g, ' ').trim();

// Is a {token} we don't know about left in the text? (fails the build)
export const unknownIcons = (t) => [...String(t).matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).filter((k) => !ICONS.has(k));

// "HERE NOW" + "," + "DON'T DO THAT …" — one ability whose name contains a comma got split in two
export function mergeSplitNames(abilities) {
  const out = [];
  for (let i = 0; i < abilities.length; i++) {
    const a = abilities[i];
    const next = abilities[i + 1];
    if (/^\s*,?\s*$/.test(a.text) && a.name && next) { out.push({ ...next, name: `${a.name}, ${next.name || ''}`.trim() }); i++; continue; }
    out.push(a);
  }
  return out;
}
