// Ability-text → effect steps, for the common, unambiguous patterns.
//
// An ability is automated only if EVERY sentence matches a known pattern;
// otherwise parseAbility() returns null and the engine falls back to a manual
// reminder in the log. That way a card is never half-resolved.
//
// Step shape: { op, n?, stat?, kw?, target?: Filter, optional?, who? }
// Filter: { kinds:Set, side:'opp'|'mine'|'any', another, damaged, exerted, max?, min?, maxCost?, minCost?, stat? }

const KW = { evasive: 'evasive', rush: 'rush', ward: 'ward', resist: 'resist', challenger: 'challenger', support: 'support',
  bodyguard: 'bodyguard', reckless: 'reckless', alert: 'alert', singer: 'singer', vanish: 'vanish' };
const STAT = { s: 'str', strength: 'str', w: 'wp', willpower: 'wp', l: 'lore', lore: 'lore' };
const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };
const num = (s) => (s in NUM ? NUM[s] : Number(s));

// normalise dreamborn tokens: "{S}" / "{strength}" → "strength", strip <Keyword> brackets and reminder text
export function normalise(text) {
  return String(text || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/\{(support|evasive|rush|ward|resist|challenger|bodyguard|reckless|alert|singer|vanish)\}/gi, '$1')
    .replace(/\{(S|strength)\}/gi, 'strength').replace(/\{(W|willpower)\}/gi, 'willpower').replace(/\{(L|lore)\}/gi, 'lore')
    .replace(/[’]/g, "'").replace(/\s+/g, ' ').trim()
    .replace(/^[A-Z0-9][A-Z0-9'!?,.\- ]{2,}\s+(?=[A-Z][a-z])/, '');   // ability name baked into the text ("HUNNY POT Whenever…")
}

const TARGET_RX = /^(?:another )?chosen ((?:(?:opposing|damaged|exerted|ready) )*)(character, item, or location|character or location|item or location|character|item|location)( of yours)?(?: with (?:(\d+) (strength|willpower) or (less|more)|cost (\d+) or (less|more)|(\d+) or (less|more)))?$/;

function parseTarget(phrase) {
  const p = phrase.trim();
  const m = p.match(TARGET_RX);
  if (!m) return null;
  const mods = m[1] || '';
  const f = {
    kinds: new Set(m[2].replace(/,? or /g, ',').split(/,\s*/).map((x) => x.trim()).filter(Boolean)),
    side: mods.includes('opposing') ? 'opp' : m[3] ? 'mine' : 'any',
    another: /^another /.test(p),
    damaged: mods.includes('damaged'),
    exerted: mods.includes('exerted'),
    ready: mods.includes('ready'),
  };
  if (m[4]) { f.stat = STAT[m[5]]; f[m[6] === 'less' ? 'max' : 'min'] = Number(m[4]); }
  if (m[7]) f[m[8] === 'less' ? 'maxCost' : 'minCost'] = Number(m[7]);
  if (m[9]) { f.stat = 'str'; f[m[10] === 'less' ? 'max' : 'min'] = Number(m[9]); } // "with 2 or less" (stat icon stripped) — dreamborn drops {S}
  return f;
}

// One sentence → one step (or null if unknown).
function parseSentence(raw) {
  let s = raw.trim().replace(/^then,?\s*/i, '').replace(/\.$/, '').trim();
  let optional = false;
  const may = s.match(/^you may (.+)$/i);
  if (may) { optional = true; s = may[1]; }
  s = s.charAt(0).toLowerCase() + s.slice(1);
  let m;
  const T = (phrase) => parseTarget(phrase);
  const out = (o) => ({ optional, ...o });
  // duration: "this turn" (eot) or "until the start of your next turn" (sot)
  let until = null;
  if (/ this turn$/.test(s)) { until = 'eot'; s = s.replace(/ this turn$/, ''); }
  else if (/ until the start of your next turn$/.test(s)) { until = 'sot'; s = s.replace(/ until the start of your next turn$/, ''); }
  const timed = (o) => (until ? out({ ...o, until }) : null);

  if ((m = s.match(/^draw (a|an|one|two|three|\d+) cards?$/))) return out({ op: 'draw', n: num(m[1]) });
  if ((m = s.match(/^gain (\d+) lore$/))) return out({ op: 'gainLore', n: +m[1] });
  if ((m = s.match(/^(?:each|chosen) opponent loses (\d+) lore$/))) return out({ op: 'oppLoseLore', n: +m[1] });
  if ((m = s.match(/^(?:each|chosen) opponent chooses and discards (a|one|two|\d+) cards?$/))) return out({ op: 'oppDiscard', n: num(m[1]) });
  if ((m = s.match(/^discard (a|one|two|\d+) cards? at random$/))) return out({ op: 'randomDiscard', n: num(m[1]) });
  if ((m = s.match(/^each opponent chooses and banishes one of their characters$/))) return out({ op: 'oppBanish' });
  if ((m = s.match(/^each opponent chooses and exerts one of their ready characters$/))) return out({ op: 'oppExert' });
  if ((m = s.match(/^choose and discard (a|one|\d+) cards?$/))) return out({ op: 'selfDiscard', n: num(m[1]) });
  if ((m = s.match(/^your characters get ([+-]\d+) (strength|willpower|lore)$/))) return timed({ op: 'allMod', stat: STAT[m[2]], n: +m[1] });
  if ((m = s.match(/^deal (\d+) damage to (.+)$/))) { const t = T(m[2]); return t && out({ op: 'damage', n: +m[1], target: t }); }
  if ((m = s.match(/^remove up to (\d+) damage from (.+)$/))) { const t = T(m[2]); return t && out({ op: 'heal', n: +m[1], target: t }); }
  if ((m = s.match(/^banish (.+)$/))) { const t = T(m[1]); return t && out({ op: 'banish', target: t }); }
  if ((m = s.match(/^return (.+?) to (?:their player's|its player's|your|their owner's) hand$/))) { const t = T(m[1]); return t && out({ op: 'bounce', target: t }); }
  if ((m = s.match(/^put (.+?) on the bottom of (?:their player's|its player's|your) deck$/))) { const t = T(m[1]); return t && out({ op: 'tuck', target: t }); }
  if ((m = s.match(/^exert (.+)$/))) { const t = T(m[1]); return t && out({ op: 'exert', target: t }); }
  if ((m = s.match(/^ready (.+)$/))) { const t = T(m[1]); return t && out({ op: 'ready', target: t }); }
  // dreamborn sometimes drops the stat icon ("gets +2 this turn"); on printed cards that's always strength
  if ((m = s.match(/^(.+?) gets ([+-]\d+)(?: (strength|willpower|lore))?$/))) { const t = T(m[1]); return t && timed({ op: 'mod', stat: STAT[m[3] || 'strength'], n: +m[2], target: t }); }
  if ((m = s.match(/^(.+?) (?:gains|gets) ((?:evasive|rush|ward|support|bodyguard|reckless|alert|vanish|(?:resist|challenger|singer) \+?\d+)(?:(?:,| and|, and) (?:evasive|rush|ward|support|bodyguard|reckless|alert|vanish|(?:resist|challenger|singer) \+?\d+))*)$/i))) {
    const t = T(m[1]);
    if (!t) return null;
    const kws = m[2].split(/,? and |, /i).map((k) => { const x = k.trim().toLowerCase().match(/^(\w+)(?: \+?(\d+))?$/); return x && KW[x[1]] ? [KW[x[1]], x[2] ? +x[2] : 1] : null; });
    return kws.every(Boolean) ? timed({ op: 'grant', kws, target: t }) : null;
  }
  return null;
}

// Sentences resolve in order; ", then ..." clauses are linked to the clause
// before them, so "you may draw a card, then choose and discard a card" is one
// optional unit (declining skips the discard too).
export function parseEffect(text) {
  const t = normalise(text);
  if (!t) return null;
  const steps = [];
  for (const sent of t.split(/(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean)) {
    const parts = sent.replace(/\.$/, '').split(/,\s*then,?\s+/i);
    let head = null;
    for (const part of parts) {
      const st = parseSentence(part);
      if (!st) return null;
      if (head) { st.linked = true; st.optional = false; if (head.optional) st.underMay = true; }
      else head = st;
      steps.push(st);
    }
  }
  return steps.length ? steps : null;
}

// Classify an ability: { trigger: 'play'|'quest'|'action', steps } or null.
export const TRIGGERS = [
  ['play', /^when you play this (?:character|item|location),\s*(.+)$/i],
  ['quest', /^whenever this character quests,\s*(.+)$/i],
];
export function parseAbility(ab, defType) {
  const t = normalise(ab.text);
  if (defType === 'action' || defType === 'song') {
    const body = t.replace(/^sing together \d+\s*/i, '').trim();
    if (!body) return { trigger: 'action', steps: [] };   // reminder-only (e.g. the song's singing reminder)
    const steps = parseEffect(body);
    return steps ? { trigger: 'action', steps } : null;
  }
  for (const [trigger, rx] of TRIGGERS) {
    const m = t.match(rx);
    if (m) { const steps = parseEffect(m[1]); return steps ? { trigger, steps } : null; }
  }
  return null;
}

// Human-readable description of a filter, for prompts.
export function describeTarget(f) {
  const kinds = [...f.kinds].join(' / ');
  const bits = [f.side === 'opp' ? 'opposing' : '', f.damaged ? 'damaged' : '', f.exerted ? 'exerted' : '', kinds, f.side === 'mine' ? 'of yours' : ''];
  if (f.max != null) bits.push(`with ${f.max} ${f.stat === 'wp' ? '🛡️' : '⚔️'} or less`);
  if (f.min != null) bits.push(`with ${f.min} ${f.stat === 'wp' ? '🛡️' : '⚔️'} or more`);
  if (f.maxCost != null) bits.push(`with cost ${f.maxCost} or less`);
  if (f.minCost != null) bits.push(`with cost ${f.minCost} or more`);
  return bits.filter(Boolean).join(' ');
}
export const KEYWORD_ONLY = /^\s*(Support|Shift|Puppy Shift|Universal Shift|Bodyguard|Singer|Sing Together|Boost|Vanish|Reckless|Rush|Evasive|Ward|Resist|Challenger|Alert)\b/i;
export const HARMFUL = new Set(['damage', 'banish', 'bounce', 'tuck', 'exert']);
