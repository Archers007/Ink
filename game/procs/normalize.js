// L0 — one canonical spelling for ability text, whatever source it came from
// (dreamborn DB rows of different eras, scanned text, lorcanajson).
//
//   icons      {I} {S} {E} {L} {W} → {ink} {strength} {exert} {lore} {willpower}
//   tags       <Bodyguard> → Bodyguard
//   quotes     ’ ‘ → '   “ ” → "
//   costs      "{exert}, 2 {ink} - Draw" → "{exert}, 2 {ink} — Draw"
//   bullets    "Choose one: - A - B" / "• A • B" → "Choose one: • A • B"
//   spacing    collapsed, no space before . or ,

const ICON = {
  i: 'ink', ink: 'ink', inkk: 'ink', s: 'strength', strength: 'strength', e: 'exert', exert: 'exert',
  l: 'lore', lore: 'lore', w: 'willpower', willpower: 'willpower', toughness: 'willpower', c: 'inkable',
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
    .replace(/\bcharacterin\b/g, 'character in')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/\s+[-–—]\s+/g, ' — ');                       // every spaced dash is a separator
  t = t.replace(/\{exert\} "(,\s*\d+ \{ink\})?\s*—/g, '"{exert}$1 —');   // OCR put the quote after the {exert} icon
  t = t.replace(/(choose one:)\s*(?:[•—]\s*)?/i, '$1 • ');     // first bullet right after "Choose one:"
  const co = t.search(/choose one: • /i);
  if (co >= 0) t = t.slice(0, co) + t.slice(co).replace(/ — (?=[A-Z])/g, ' • ').replace(/\s*•\s*/g, ' • ');
  return t.replace(/\s+([.,;:!?])/g, '$1').replace(/\.{4,}/g, '...').replace(/\s+/g, ' ').trim();
}

// Reminder text is the parenthesised explanation after a keyword; it never adds rules.
export const stripReminders = (t) => String(t).replace(/\s*\([^()]*\)/g, '').replace(/\s+/g, ' ').trim();

// Is a {token} we don't know about left in the text? (fails the build)
export const unknownIcons = (t) => [...String(t).matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).filter((k) => !ICONS.has(k));

// Newer dreamborn rows mark the ability name with backslashes and pack several abilities into one string:
//   "<Singer> 3 (…)\n\n\\Band Loyalty\\ This character can't sing songs…"  →  [{ text: "<Singer> 3 (…)" }, { name: "Band Loyalty", text: "This character…" }]
// Older rows write the name in capitals instead: "VENDETTA When this character…", and run a keyword line and the
// next ability together: "Evasive (Only characters…) ETHEREAL GLOW Whenever you play…"
const CAPS_NAME = String.raw`((?=[^a-z]*[A-Z]{3})(?:[A-Z0-9][A-Z0-9'’!?,.&-]*\s+)+)(?=[A-Z][a-z]|\{)`;
const CAPS_AT_START = new RegExp(`^${CAPS_NAME}`);
const CAPS_INSIDE = new RegExp(`(?<=[.)!]\\s)${CAPS_NAME}`, 'g');
function splitCaps(a) {
  const out = [];
  let rest = a.text, name = a.name;
  for (const m of [...rest.matchAll(CAPS_INSIDE)].reverse()) {          // last first, so earlier indexes stay put
    out.unshift({ name: m[1].trim(), text: rest.slice(m.index + m[1].length).trim() });
    rest = rest.slice(0, m.index).trim();
  }
  const m = !name && rest.match(CAPS_AT_START);
  if (m) { name = m[1].trim(); rest = rest.slice(m[1].length).trim(); }
  if (rest) out.unshift({ name: name || '', text: rest });
  return out;
}

export function splitDbAbilities(name, text) {
  const out = [];
  // the name's closing "?" / "!" landed in the text: { name: "WHERE AM I", text: "? When this…" }
  const tail = String(text ?? '').match(/^\s*([?!])\s+/);
  if (tail && name) { name = name + tail[1]; text = String(text).slice(tail[0].length); }
  for (const chunk of String(text ?? '').split(/\n\s*\n/)) {
    // "\Name\" opens an ability where it starts the chunk or follows a space
    const marks = [...chunk.matchAll(/(?:^|(?<=\s))\\([^\\\n]+)\\\s*/g)];
    const head = chunk.slice(0, marks.length ? marks[0].index : chunk.length).trim();
    if (head) out.push(...splitCaps({ name: out.length ? '' : name || '', text: head }));
    marks.forEach((m, i) => {
      const body = chunk.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : chunk.length).trim();
      out.push(...splitCaps({ name: m[1].trim(), text: body }));
    });
  }
  return out;
}

// "HERE NOW" + "," + "DON'T DO THAT …" — one ability whose name contains a comma got split in two
export function mergeSplitNames(abilities) {
  const out = [];
  for (let i = 0; i < abilities.length; i++) {
    const a = abilities[i];
    const next = abilities[i + 1];
    if (/^\s*,?\s*$/.test(a.text) && a.name && next) { out.push({ ...next, name: `${a.name}, ${next.name || ''}`.trim() }); i++; continue; }
    // …or the first half of the name became an ability of its own: "OK," + { name: "WHERE AM I?", … }
    if (!a.name && /^[A-Z][A-Z' ]*,$/.test(a.text.trim()) && next?.name) { out.push({ ...next, name: `${a.text.trim()} ${next.name}` }); i++; continue; }
    out.push(a);
  }
  return out;
}
