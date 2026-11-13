// Union Arena effect compiler: a card's effect and trigger text → abilities the engine runs (game/ua/effects.js ops).
//
//   compileDef(def) → { abilities: [{ timing, cond, cost, once, ops, text, manual }], statics: [{ target, cond, mod }],
//                       event: { ops } | null, trigger: { ops } | null, aliases: [], copyLimit, handMods: [], coverage }
//
// timing: 'played' | 'sidelined' | 'attack' | 'block' | 'activate' | 'winBattle' | 'loseBattle' | 'notBlocked' |
//         'directDamage' | 'endPhase' | 'startTurn' | 'battleEnd'
//
// The text is the official English card list's (lib/ua/official.js turns icons into [Tag]s). A sentence the compiler
// doesn't recognise makes its whole ability manual: the engine shows the text and lets the owner resolve it with table
// actions. Nothing is guessed. coverage tells scripts/ua-coverage.mjs what's automated.

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const num = (w) => (w == null ? null : /^\d+$/.test(w) ? Number(w) : NUM[String(w).toLowerCase()] ?? null);
const NUMW = '(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)';

const TIMING_TAGS = {
  'when played': 'played', 'when sidelined': 'sidelined', 'when attacking': 'attack', 'when blocking': 'block',
  'activate: main': 'activate', 'activate:main': 'activate', 'when removed': 'removed',
};
const COND_TAGS = {
  'during your turn': { k: 'yourTurn' }, "during opponent's turn": { k: 'oppTurn' }, "during your opponent's turn": { k: 'oppTurn' },
  'if on the front line': { k: 'front' }, 'if on the energy line': { k: 'energy' },
};
const COLORS = ['red', 'blue', 'green', 'yellow', 'purple'];

// ---------- text helpers ----------
export function stripReminders(t) {
  // "[Damage (2)]" / "[Impact (1)]": the number is part of the keyword, not reminder text
  let s = String(t).replace(/\[([^\]]*?)\s*\((\+?\d+)\)\]/g, '[$1 $2]');
  for (let i = 0; i < 6; i++) {
    const n = s.replace(/\s*\([^()]*\)/g, '');
    if (n === s) break;
    s = n;
  }
  return s.replace(/\s+/g, ' ').replace(/\s+([.,])/g, '$1').trim();
}
export function sentences(t) {
  const out = [];
  let depth = 0, cur = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '[' || ch === '{' || ch === '<' || ch === '"' && depth === 0 && !cur.includes('"')) depth += ch === '"' ? 0 : 1;
    if (ch === ']' || ch === '}' || ch === '>') depth = Math.max(0, depth - 1);
    cur += ch;
    if (ch === '.' && depth === 0 && (t[i + 1] === ' ' || i === t.length - 1)) { out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}
const names = (str) => [...String(str).matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
const affs = (str) => [...String(str).matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());

// ---------- targets ----------
// "up to one other character with 3000 or less BP on your opponent's front line" → { min, max, all, f }
export function parseTarget(phrase) {
  let p = String(phrase).trim().replace(/[{}]/g, '');
  const m = p.match(new RegExp(`^(all|any number of|up to ${NUMW}|${NUMW})\\s+(?:of\\s+)?(other\\s+)?(.*)$`, 'i'));
  if (!m) return null;
  const q = m[1].toLowerCase();
  let min, max, all = false;
  if (q === 'all') { all = true; min = 0; max = 99; }
  else if (q === 'any number of') { min = 0; max = 99; }
  else if (q.startsWith('up to')) { min = 0; max = num(m[2]); }
  else { min = max = num(m[3]); }
  const f = {};
  if (m[4]) f.other = true;
  let rest = m[5];
  // location
  const loc = rest.match(/\s+(?:on|in|from)\s+(your opponent's|your|their|its owner's|both players')\s+(front line|energy line|field|hand|sideline|removal area)(?:\s+(?:or|and)\s+(front line|energy line))?/i);
  if (loc) {
    const who = loc[1].toLowerCase();
    f.who = who === "your opponent's" || who === 'their' ? 'opp' : who === "both players'" ? 'any' : 'self';
    const z = (x) => ({ 'front line': ['front'], 'energy line': ['energy'], field: ['front', 'energy'], hand: ['hand'], sideline: ['side'], 'removal area': ['removal'] })[x.toLowerCase()];
    f.zones = [...z(loc[2]), ...(loc[3] ? z(loc[3]) : [])];
    rest = (rest.slice(0, loc.index) + ' ' + rest.slice(loc.index + loc[0].length)).trim();
  } else {
    return null;
  }
  if (!applyDesc(rest, f)) return null;
  return { min, max, all, f };
}

// "character with 3000 or less BP", "[Phantom Troupe] affinity card", "<Gon Freecss>", "resting character", "site"
function applyDesc(desc, f) {
  let d = ' ' + desc.trim().replace(/\bwith\s+(?=\[[^\]]+\]\s*affinity)/i, '') + ' ';
  const take = (rx, fn) => { const m = d.match(rx); if (m) { fn(m); d = d.replace(m[0], ' '); } return !!m; };
  take(/\s+with\s+(\d+)\s+or\s+(less|more)\s+BP\b/i, (m) => { f[m[2].toLowerCase() === 'less' ? 'bpMax' : 'bpMin'] = Number(m[1]); });
  take(/\s+with\s+(\d+)\s+or\s+(less|more)\s+required energy\b/i, (m) => { f[m[2].toLowerCase() === 'less' ? 'energyMax' : 'energyMin'] = Number(m[1]); });
  take(/\s+(?:with|and)\s+(\d+)\s+or\s+(less|more)\s+AP cost\b/i, (m) => { if (m[2].toLowerCase() === 'less') f.apMax = Number(m[1]); else f.apMin = Number(m[1]); });
  take(/\s+(?:with|and)\s+(\d+)\s+AP cost\b/i, (m) => { f.apMax = Number(m[1]); f.apMin = Number(m[1]); });
  take(/\s+and\s+(\d+)\s+or\s+(less|more)\s+BP\b/i, (m) => { f[m[2].toLowerCase() === 'less' ? 'bpMax' : 'bpMin'] = Number(m[1]); });
  take(/\s+and\s+(\d+)\s+or\s+(less|more)\s+required energy\b/i, (m) => { f[m[2].toLowerCase() === 'less' ? 'energyMax' : 'energyMin'] = Number(m[1]); });
  take(/\s+(Raided)\s/i, () => { f.raided = true; });
  take(/\s+with\s+a\s+trigger\b/i, () => { f.hasTrigger = true; });
  take(/\s+with\s+no\s+affinit(?:y|ies)\b/i, () => { f.noAffinity = true; });
  take(/\s+(?:other than|except)\s+((?:<[^>]+>(?:,?\s*(?:or|and)?\s*)?)+)/i, (m) => { f.notName = names(m[1]); });
  take(/\s(resting|rested)\s/i, () => { f.rested = true; });
  take(/\s(active)\s/i, () => { f.active = true; });
  take(new RegExp(`\\s(${COLORS.join('|')})(?:\\s+or\\s+(${COLORS.join('|')}))?\\s`, 'i'), (m) => { f.color = [m[1].toLowerCase(), ...(m[2] ? [m[2].toLowerCase()] : [])]; });
  // [X] affinity / [X] or <Y> / <A>, <B>, or <C>
  const affM = d.match(/((?:\[[^\]]+\]\s*(?:affinity)?\s*(?:,|or|and)?\s*)+)affinity\b/i) || d.match(/(\[[^\]]+\](?:\s*(?:,|or)\s*\[[^\]]+\])*)\s*affinity/i);
  const nmM = d.match(/((?:<[^>]+>\s*(?:,\s*or|,|or|and)?\s*)+)/);
  if (affM && nmM) { f.nameOrAffinity = [...affs(affM[1]).map((a) => ({ affinity: a })), ...names(nmM[1]).map((n) => ({ name: n }))]; d = d.replace(affM[0], ' ').replace(nmM[0], ' '); }
  else if (affM) { f.affinity = affs(affM[1]); d = d.replace(affM[0], ' '); }
  else if (nmM) { f.name = names(nmM[1]); d = d.replace(nmM[0], ' '); }
  d = d.replace(/\b(cards?|characters?|sites?|events?)\b/gi, (w) => {
    const k = w.toLowerCase().replace(/s$/, '');
    if (k !== 'card') f.kind = k;
    return ' ';
  });
  d = d.replace(/\b(character|site|event)\s+card\b/gi, ' ');
  d = d.replace(/\b(of|your|each|the|a|or|and)\b/gi, ' ').replace(/,/g, ' ').trim();
  if (d) return false;      // something we didn't understand
  if (!f.kind && !f.affinity && !f.name && !f.nameOrAffinity) f.kind = 'card';
  return true;
}

// card spec inside "reveal up to one X card among them": "[X] affinity", "<N>", "character", "[X] affinity or <N>"
function parseSpec(spec) {
  const f = {};
  if (!applyDesc(spec.replace(/\bcards?\b/i, 'card'), f)) return null;
  return f;
}

// ---------- conditions ----------
export function parseCond(t) {
  let c = String(t).trim().replace(/[{}]/g, '');
  let m;
  if ((m = c.match(/^((?:<[^>]+>(?:,?\s*(?:or)\s*)?)+) (?:is|are) on your field$/i))) return { k: 'count', f: { who: 'self', zones: ['front', 'energy'], name: names(m[1]) }, op: '>=', n: 1 };
  if ((m = c.match(/^((?:<[^>]+>(?:,?\s*(?:or)\s*)?)+) (?:is|are) on your front line$/i))) return { k: 'count', f: { who: 'self', zones: ['front'], name: names(m[1]) }, op: '>=', n: 1 };
  if ((m = c.match(/^((?:<[^>]+>(?:,?\s*(?:or)\s*)?)+) (?:is|are) on your energy line$/i))) return { k: 'count', f: { who: 'self', zones: ['energy'], name: names(m[1]) }, op: '>=', n: 1 };
  if ((m = c.match(/^there (?:is|are) (\d+|one|two|three|four|five|six|seven|eight) or (more|less) (other )?(.+?) on (your|your opponent's) (field|front line|energy line)$/i))) {
    const f = { who: m[5].toLowerCase() === 'your' ? 'self' : 'opp', zones: m[6].toLowerCase() === 'field' ? ['front', 'energy'] : [m[6].toLowerCase() === 'front line' ? 'front' : 'energy'] };
    if (m[3]) f.other = true;
    if (!applyDesc(m[4], f)) return null;
    return { k: 'count', f, op: m[2].toLowerCase() === 'more' ? '>=' : '<=', n: num(m[1]) };
  }
  if ((m = c.match(/^(\d+|one|two|three|four|five|six|seven|eight) or (more|less) (other )?(.+?) (?:is|are) on (your|your opponent's) (field|front line|energy line)$/i))) {
    const f = { who: m[5].toLowerCase() === 'your' ? 'self' : 'opp', zones: m[6].toLowerCase() === 'field' ? ['front', 'energy'] : [m[6].toLowerCase() === 'front line' ? 'front' : 'energy'] };
    if (m[3]) f.other = true;
    if (!applyDesc(m[4], f)) return null;
    return { k: 'count', f, op: m[2].toLowerCase() === 'more' ? '>=' : '<=', n: num(m[1]) };
  }
  if ((m = c.match(/^you have (\d+|one|two|three|four|five|six|seven|eight) or (more|less) (other )?(.+?) on your (field|front line|energy line)$/i))) {
    const f = { who: 'self', zones: m[5].toLowerCase() === 'field' ? ['front', 'energy'] : [m[5].toLowerCase() === 'front line' ? 'front' : 'energy'] };
    if (m[3]) f.other = true;
    if (!applyDesc(m[4], f)) return null;
    return { k: 'count', f, op: m[2].toLowerCase() === 'more' ? '>=' : '<=', n: num(m[1]) };
  }
  if ((m = c.match(/^there (?:is|are) (?:a|an|one or more) (.+?) on (your|your opponent's) (field|front line|energy line)$/i))) {
    const f = { who: m[2].toLowerCase() === 'your' ? 'self' : 'opp', zones: m[3].toLowerCase() === 'field' ? ['front', 'energy'] : [m[3].toLowerCase() === 'front line' ? 'front' : 'energy'] };
    if (!applyDesc(m[1], f)) return null;
    return { k: 'count', f, op: '>=', n: 1 };
  }
  if ((m = c.match(/^you have (\d+|one|two|three|four|five|six|seven|eight) or (more|less) cards in your (hand|life area|life|sideline|removal area)$/i))) {
    const k = { hand: 'hand', 'life area': 'life', life: 'life', sideline: 'side', 'removal area': 'removal' }[m[3].toLowerCase()];
    return { k, who: 'self', op: m[2].toLowerCase() === 'more' ? '>=' : '<=', n: num(m[1]) };
  }
  if ((m = c.match(/^your opponent has (\d+|one|two|three|four|five|six|seven|eight) or (more|less) cards in their (hand|life area|life|sideline)$/i))) {
    const k = { hand: 'hand', 'life area': 'life', life: 'life', sideline: 'side' }[m[3].toLowerCase()];
    return { k, who: 'opp', op: m[2].toLowerCase() === 'more' ? '>=' : '<=', n: num(m[1]) };
  }
  if ((m = c.match(/^you have (\d+) or more energy generation$/i))) return { k: 'gen', op: '>=', n: Number(m[1]) };
  if ((m = c.match(/^you have (\d+|one|two|three|four|five|six|seven) (?:or (less|more) )?life$/i))) return { k: 'life', who: 'self', op: m[2] ? (m[2].toLowerCase() === 'less' ? '<=' : '>=') : '==', n: num(m[1]) };
  if ((m = c.match(/^your opponent has (\d+|one|two|three|four|five|six|seven) (?:or (less|more) )?life$/i))) return { k: 'life', who: 'opp', op: m[2] ? (m[2].toLowerCase() === 'less' ? '<=' : '>=') : '==', n: num(m[1]) };
  if ((m = c.match(/^(?:this character|it) has (\d+) or (more|less) BP$/i))) return { k: 'selfBp', op: m[2].toLowerCase() === 'more' ? '>=' : '<=', n: Number(m[1]) };
  if ((m = c.match(/^(?:two|2|three|3|(\d+)) or more characters have been sidelined this turn$/i))) return { k: 'sidelinedCount', op: '>=', n: num(c.split(' ')[0]) };
  if (/^you have used an event card this turn$/i.test(c)) return { k: 'usedEvent' };
  if (/^you have no cards on your field$/i.test(c)) return { k: 'count', f: { who: 'self', zones: ['front', 'energy'] }, op: '==', n: 0 };
  if (/^this character is played with one of your abilities$/i.test(c)) return { k: 'playedByAbility' };
  if ((m = c.match(/^the chosen character is ((?:<[^>]+>(?:,?\s*or\s*)?)+)$/i))) return { k: 'chosenMatches', f: { name: names(m[1]) } };
  if ((m = c.match(/^(?:the chosen character|it) has \[([^\]]+)\] affinity$/i))) return { k: 'chosenMatches', f: { affinity: [m[1]] } };
  if ((m = c.match(/^((?:<[^>]+>(?:,\s*)?)+) and (<[^>]+>) are on your field$/i))) return { k: 'and', all: [...names(m[1]), ...names(m[2])].map((n) => ({ k: 'count', f: { who: 'self', zones: ['front', 'energy'], name: [n] }, op: '>=', n: 1 })) };
  if ((m = c.match(/^you have (\w+) or more (.+?) with unique card names on your (field|sideline)$/i))) {
    const f = { who: 'self', zones: m[3].toLowerCase() === 'field' ? ['front', 'energy'] : ['side'] };
    if (!applyDesc(m[2], f)) return null;
    return { k: 'uniqueNames', f, op: '>=', n: num(m[1]) };
  }
  if (/^this character has (?:a|one or more) (?:face-down )?cards? under it$/i.test(c)) return { k: 'raided' };
  if ((m = c.match(/^you have (\w+) or (more|less) (.+?) in your (sideline|removal area|hand)$/i))) {
    const f = { who: 'self', zones: [{ sideline: 'side', 'removal area': 'removal', hand: 'hand' }[m[4].toLowerCase()]] };
    if (!applyDesc(m[3], f)) return null;
    return { k: 'count', f, op: m[2].toLowerCase() === 'more' ? '>=' : '<=', n: num(m[1]) };
  }
  if ((m = c.match(/^you have (?:a|an|one or more) (.+?) in your (sideline|removal area|hand)$/i))) {
    const f = { who: 'self', zones: [{ sideline: 'side', 'removal area': 'removal', hand: 'hand' }[m[2].toLowerCase()]] };
    if (!applyDesc(m[1], f)) return null;
    return { k: 'count', f, op: '>=', n: 1 };
  }
  if (/^you have no cards in your hand$/i.test(c)) return { k: 'hand', who: 'self', op: '==', n: 0 };
  if ((m = c.match(/^the card you revealed (?:was|is) ((?:<[^>]+>(?:,?\s*or\s*)?)+)$/i))) return { k: 'chosenMatches', f: { name: names(m[1]) } };
  if ((m = c.match(/^(?:that card|the revealed card|it) has \[([^\]]+)\] affinity$/i))) return { k: 'lookedMatches', f: { affinity: [m[1]] } };
  if ((m = c.match(/^((?:<[^>]+>(?:,\s*)?)+) and (<[^>]+>) are both on your field$/i))) return { k: 'and', all: [...names(m[1]), ...names(m[2])].map((n) => ({ k: 'count', f: { who: 'self', zones: ['front', 'energy'], name: [n] }, op: '>=', n: 1 })) };
  if (/^this character is active$/i.test(c)) return { k: 'selfActive' };
  if (/^this character is resting$/i.test(c)) return { k: 'selfRested' };
  if (/^this character is on your front line$/i.test(c)) return { k: 'front' };
  if (/^this character is on your energy line$/i.test(c)) return { k: 'energy' };
  if (/^it is your turn$/i.test(c)) return { k: 'yourTurn' };
  if (/^(?:this character is|you have) raided|^this character has a card under it$/i.test(c)) return { k: 'raided' };
  if (/^a character on your field has been sidelined this turn$/i.test(c)) return { k: 'sidelinedThisTurn' };
  return null;
}

// ---------- sentences → ops ----------
const UNTIL = [
  [/\s*until the end of the turn$/i, 'eot'],
  [/\s*until the end of this turn$/i, 'eot'],
  [/\s*until the start of your next turn$/i, 'sont'],
  [/\s*until the end of your opponent's next turn$/i, 'sont'],
  [/\s*for the duration of this battle$/i, 'battle'],
  [/\s*during this battle$/i, 'battle'],
];
function splitUntil(t) {
  for (const [rx, u] of UNTIL) if (rx.test(t)) return [t.replace(rx, ''), u];
  return [t, null];
}

// "gains 1000 BP" / "loses 2000 BP" / "gains [Impact (1)]" / "gains [Green] energy generation" / "cannot block"
function parseGain(t) {
  let m;
  t = t.trim().replace(/[{}]/g, '');
  // granted abilities: gains "When this character attacks and wins a battle, draw a card" / gains [X] and "…"
  if ((m = t.match(/^gains? (?:(.+?) and )?"([^"]+)"$/i))) {
    const first = m[1] ? parseGain(`gains ${m[1].trim()}`) : {};
    if (!first) return null;
    const g = grantOf(m[2]);
    return g ? { ...first, ...g } : null;
  }
  if ((m = t.match(/^(?:gains?|get) (\d+) BP$/i))) return { bp: Number(m[1]) };
  if ((m = t.match(/^loses? (\d+) BP$/i))) return { bp: -Number(m[1]) };
  if ((m = t.match(/^(?:gains?|get) \+?(\d+) BP and \[([^\]]+)\]$/i))) { const kw = kwFrom(m[2]); return kw ? { bp: Number(m[1]), kw } : null; }
  if ((m = t.match(/^gains? \[([^\]]+)\](?: and \[([^\]]+)\])?$/i))) {
    const kw = kwFrom(m[1]); if (!kw) return null;
    if (m[2]) { const k2 = kwFrom(m[2]); if (!k2) return null; Object.assign(kw, k2); }
    return { kw };
  }
  if ((m = t.match(/^gains? ((?:\[[^\]]+\]\s*)+)energy generation$/i))) {
    const cols = affs(m[1]).map(colorOf);
    return cols.length && cols.every(Boolean) ? { gen: cols } : null;
  }
  if (/^cannot attack$/i.test(t)) return { cantAttack: true };
  if (/^cannot block$/i.test(t)) return { cantBlock: true };
  if (/^cannot attack or block$/i.test(t)) return { cantAttack: true, cantBlock: true };
  if (/^cannot be chosen by your opponent's abilities$/i.test(t)) return { cantBeChosen: true };
  if ((m = t.match(/^loses \[([^\]]+)\]$/i))) { const kw = kwFrom(m[1]); return kw ? { loseKw: Object.keys(kw) } : null; }
  return null;
}
// a quoted ability a card gains for a while: a trigger ("When this character …"), a delayed one, or a static
function grantOf(q) {
  const text = q.trim().replace(/\.$/, '');
  let m;
  if ((m = text.match(/^At the end of the main phase, (.+)$/i))) {
    const inner = parseSentence(m[1], { effect: true });
    return inner ? { grantDelayed: { at: 'endMain', ops: inner, text } } : null;
  }
  for (const [rx, timing] of TEXT_TRIGGERS) {
    if (rx.test(text)) {
      const ops = compileBody(text.replace(rx, '').replace(/^./, (c) => c.toUpperCase()), {});
      return ops ? { grant: { timing, ops, text } } : null;
    }
  }
  const st = parseStatic(text, null);
  if (st && st.length === 1 && st[0].target === 'self' && !st[0].cond && !st[0].perCard) return st[0].mod;
  if ((m = text.match(/^Your opponent must block this character's attacks if able$/i))) return { mustBeBlocked: true };
  return null;
}
const colorOf = (x) => { const c = String(x).toLowerCase().replace(/×\d+$/, '').trim(); return COLORS.includes(c) ? c : null; };
function kwFrom(tag) {
  const t = tag.trim();
  let m;
  if (/^step$/i.test(t)) return { step: true };
  if (/^snipe$/i.test(t)) return { snipe: true };
  if (/^double attack$/i.test(t)) return { doubleAttack: true };
  if (/^double block$/i.test(t)) return { doubleBlock: true };
  if (/^nullify impact$/i.test(t)) return { nullifyImpact: true };
  if ((m = t.match(/^impact\s*\+\s*\(?(\d+)\)?$/i))) return { impactPlus: Number(m[1]) };
  if (/^impact(\s*\(?1\)?)?$/i.test(t)) return { impact: 1 };
  if ((m = t.match(/^impact\s*\(?(\d+)\)?$/i))) return { impact: 1, impactPlus: Number(m[1]) - 1 };
  if ((m = t.match(/^damage\s*\+\s*\(?(\d+)\)?$/i))) return { damagePlus: Number(m[1]) };
  if ((m = t.match(/^damage\s*\(?(\d+)\)?$/i))) return { damage: Number(m[1]) };
  return null;
}

const VERBS = [
  [/^sideline (?:it|them)$/i, { do: 'sideline' }],
  [/^switch (?:it|them) to resting$/i, { do: 'rest' }],
  [/^switch (?:it|them) to active$/i, { do: 'active' }],
  [/^return (?:it|them) to (?:your|their|its owner's|the owner's) hands?$/i, { do: 'hand' }],
  [/^place (?:it|them) on the bottom of (?:your|their|its owner's|the owner's) decks?$/i, { do: 'deckBottom' }],
  [/^place (?:it|them) on the top of (?:your|their|its owner's|the owner's) decks?$/i, { do: 'deckTop' }],
  [/^place (?:it|them) into (?:your|their|its owner's|the owner's) removal areas?$/i, { do: 'removal' }],
  [/^place (?:it|them) into (?:your|their|its owner's|the owner's) sidelines?$/i, { do: 'side' }],
  [/^move (?:it|them) to the other line$/i, { do: 'otherLine' }],
  [/^move (?:it|them) to (?:your|their) front line$/i, { do: 'front' }],
  [/^move (?:it|them) to (?:your|their) energy line$/i, { do: 'energy' }],
  [/^add (?:it|them) to (?:your|their|its owner's) life(?: area)?$/i, { do: 'life' }],
];
function verbOp(t, target = 'it') {
  const [body, until] = splitUntil(t.trim());
  for (const [rx, op] of VERBS) if (rx.test(body)) return { op: 'act', t: target, ...op };
  // "it gains 1000 BP until the end of the turn" as a verb phrase after "and"
  const g = body.match(/^(?:it|they|they each)\s+(.*)$/i);
  const gain = parseGain(g ? g[1] : body);
  if (gain) return { op: 'act', t: target, do: 'mod', mod: gain, until: until || 'perm' };
  return null;
}

const promptFor = (tg, verb) => `Choose ${tg.max === 99 ? 'any number of' : tg.min === 0 ? `up to ${tg.max}` : tg.max} card${tg.max === 1 ? '' : 's'}${verb ? ` to ${verb}` : ''}.`;

// one sentence (plus the ability so far, for "it" / "if you do") → ops, or null if not understood
export function parseSentence(sent, ctx) {
  let t = sent.trim().replace(/^・\s*/, '').replace(/\.$/, '').trim();
  let m;

  // conditional prefixes
  if ((m = t.match(/^If you do,\s*(.*)$/i))) { const inner = parseSentence(m[1], ctx); return inner ? [{ op: 'if', cond: { k: 'did' }, then: inner }] : null; }
  if ((m = t.match(/^If you cannot,\s*(.*)$/i)) || (m = t.match(/^If you do not,\s*(.*)$/i))) { const inner = parseSentence(m[1], ctx); return inner ? [{ op: 'if', cond: { k: 'did' }, then: [], else: inner }] : null; }
  if ((m = t.match(/^If you added a card to your hand(?: with this ability)?,\s*(.*)$/i))) { const inner = parseSentence(m[1], ctx); return inner ? [{ op: 'if', cond: { k: 'addedToHand' }, then: inner }] : null; }
  if ((m = t.match(/^If (.+?),\s*(.*)$/i))) {
    const cond = parseCond(m[1]);
    if (!cond) return null;
    const inner = parseSentence(m[2], ctx);
    return inner ? [{ op: 'if', cond, then: inner }] : null;
  }
  if ((m = t.match(/^You may (.*)$/i))) {
    const inner = parseSentence(m[1].replace(/^./, (c) => c.toUpperCase()), ctx);
    return inner ? [{ op: 'may', prompt: `${m[1].replace(/^./, (c) => c.toUpperCase())}?`, ops: inner }] : null;
  }

  if ((m = t.match(/^Then,?\s+(.*)$/i))) return parseSentence(m[1].replace(/^./, (c) => c.toUpperCase()), ctx);
  if (/^Draw up to one card$/i.test(t)) return [{ op: 'may', prompt: 'Draw a card?', ops: [{ op: 'draw', n: 1 }] }];
  if ((m = t.match(/^Switch (?:it|them) to (active|resting)$/i))) return [{ op: 'act', t: 'it', do: m[1].toLowerCase() === 'active' ? 'active' : 'rest' }];
  if (/^Add one card among them to your hand$/i.test(t)) return [{ op: 'takeLook', f: { kind: 'card' }, max: 1, min: 1 }];
  if ((m = t.match(/^Place up to (one|two|\d+) (.+?) (?:among them )?into your sideline$/i)) && !/from your/i.test(t)) {
    const f = parseSpec(m[2]);
    return f ? [{ op: 'takeLook', f, max: num(m[1]), min: 0, to: 'side' }] : null;
  }
  if (/^Place them on the top and\/or bottom of your deck in any order$/i.test(t)) return [{ op: 'arrangeLook', rest: 'bottom' }];
  if (/^Place any number of cards from your hand into your sideline$/i.test(t)) return [{ op: 'discard', n: 99, upTo: true }];
  if ((m = t.match(new RegExp(`^Place ${NUMW} cards? from your life(?: area)? into your sideline$`, 'i')))) return [{ op: 'lifeTo', n: num(m[1]), to: 'side' }];
  if (/^You cannot activate this ability on the turn this character is played$/i.test(t)) return [];
  // "choose one of the following" with the bullets that follow the line
  if (/^Choose (?:one|up to one|all) of the (?:following|abilities listed below)[:.]?$/i.test(t) && ctx.bullets?.length) {
    const options = ctx.bullets.map((b) => ({ text: b, ops: compileBody(b, { bullets: null }) }));
    if (options.some((o) => !o.ops)) return null;
    if (/^Choose all/i.test(t)) return options.flatMap((o) => o.ops);
    return [{ op: 'modal', options, min: /up to/i.test(t) ? 0 : 1, max: 1 }];
  }
  // "X and give this character 1000 BP" / "… and give it 1000 BP"
  if ((m = t.match(/^(.+?) and give (this character|it) (\d+) BP( until the end of the turn)?$/i))) {
    const a = parseSentence(m[1], ctx);
    if (!a) return null;
    return [...a, { op: 'act', t: /^this/i.test(m[2]) ? 'self' : 'it', do: 'mod', mod: { bp: Number(m[3]) }, until: m[4] ? 'eot' : 'perm' }];
  }
  if ((m = t.match(/^Play this (?:character|site|card) set to (active|resting)(?: onto your field)?$/i))) return [{ op: 'playSelf', active: m[1].toLowerCase() === 'active' }];
  if ((m = t.match(new RegExp(`^Reveal up to ${NUMW} (.+?) and add (?:it|them) to your hand$`, 'i'))) && !/among them/i.test(t)) {
    const f = parseSpec(m[2]);
    return f ? [{ op: 'takeLook', f, max: num(m[1]), min: 0 }] : null;
  }
  if ((m = t.match(/^Reveal up to one (.+?) and up to one (.+?) among them and add them to your hand$/i))) {
    const f1 = parseSpec(m[1]), f2 = parseSpec(m[2]);
    return f1 && f2 ? [{ op: 'takeLook', f: f1, max: 1, min: 0 }, { op: 'takeLook', f: f2, max: 1, min: 0 }] : null;
  }
  if ((m = t.match(/^Place up to (one|two|\d+) (?:of them|cards?) into your sideline, then place the remaining cards on the top of your deck in any order$/i))) return [{ op: 'takeLook', f: { kind: 'card' }, max: num(m[1]), min: 0, to: 'side', prompt: 'Choose cards to place into your sideline (the rest go back on top).' }, { op: 'restLook', to: 'top' }];
  if (/^Place them on the top of your deck in any order$/i.test(t)) return [{ op: 'restLook', to: 'top' }];
  if ((m = t.match(/^Switch (one|up to one|two|up to two) (.+?) to (resting|active)$/i)) && !/AP cards?/i.test(t)) {
    const tg = parseTarget(`${m[1]} ${m[2]}`);
    if (!tg) return null;
    return [{ op: 'choose', f: tg.f, min: tg.min, max: tg.max, prompt: promptFor(tg, m[3] === 'resting' ? 'rest' : 'make active'), required: tg.min > 0 }, { op: 'act', t: 'it', do: m[3].toLowerCase() === 'resting' ? 'rest' : 'active' }];
  }
  if ((m = t.match(new RegExp(`^Switch ${NUMW} of your AP cards to active$`, 'i')))) return [{ op: 'ap', n: num(m[1]), active: true }];
  if ((m = t.match(/^(?:Place|You may place) (one|two|\d+) face-down cards? under this character into your sideline$/i))) return [{ op: 'underToSide', n: num(m[1]) }];
  if (/^Place this card into your removal area$/i.test(t)) return [{ op: 'act', t: 'self', do: 'removal' }];
  if (/^Place all the cards in your hand into your sideline$/i.test(t)) return [{ op: 'discardAll' }];
  if ((m = t.match(new RegExp(`^Place ${NUMW} cards? from your hand on (?:the )?top of your deck$`, 'i')))) return [{ op: 'handTo', n: num(m[1]), to: 'deckTop' }];
  if (/^Reveal one card from your hand and place it on the bottom of your deck$/i.test(t)) return [{ op: 'handTo', n: 1, to: 'deckBottom', reveal: true }];
  if ((m = t.match(new RegExp(`^Draw ${NUMW} cards?, then place ${NUMW} cards? from your hand face down under this character$`, 'i')))) return [{ op: 'draw', n: num(m[1]) }, { op: 'handTo', n: num(m[2]), to: 'under' }];
  if ((m = t.match(new RegExp(`^Place ${NUMW} (.+?) from your hand into your sideline$`, 'i'))) && !/^Place (?:one|two|three|\d+) cards? from/i.test(t)) {
    const f = parseSpec(m[2]);
    return f ? [{ op: 'discard', n: num(m[1]), f }] : null;
  }
  if ((m = t.match(/^Reduce the AP cost of the next (.+?) you use from your hand this turn by (\d+)$/i))) {
    const f = parseSpec(m[1]);
    return f ? [{ op: 'costMod', mod: { filter: f, ap: -Number(m[2]), next: true } }] : null;
  }
  if ((m = t.match(/^At the start of (?:the|your) attack phase this turn, (.+)$/i))) {
    const inner = parseSentence(m[2] ?? m[1], { ...ctx, effect: true });
    return inner ? [{ op: 'delayed', at: 'startAttack', ops: inner, text: m[1] }] : null;
  }
  // "It loses 500 BP for each [X] affinity card on your field until the end of the turn"
  if ((m = t.match(/^(It|This character|The chosen character) (gains|loses) (\d+) BP for each (.+?)( until the end of the turn)?$/i))) {
    const tg = parseTarget(`all ${m[4]}`);
    if (!tg) return null;
    return [{ op: 'count', f: tg.f }, { op: 'act', t: /^this/i.test(m[1]) ? 'self' : 'it', do: 'mod', mod: { bp: (m[2].toLowerCase() === 'gains' ? 1 : -1) * Number(m[3]) }, perCard: true, until: m[5] ? 'eot' : 'perm' }];
  }
  t = t.replace(/^(The chosen character|That character|It) also /i, 'It ').replace(/^The chosen character /i, 'It ');

  // draw
  if ((m = t.match(new RegExp(`^Draw ${NUMW} cards?(?:, then place ${NUMW} cards? from your hand into your sideline)?$`, 'i')))) {
    const ops = [{ op: 'draw', n: num(m[1]) }];
    if (m[2]) ops.push({ op: 'discard', n: num(m[2]) });
    return ops;
  }
  if ((m = t.match(new RegExp(`^Place ${NUMW} cards? from your hand into your sideline(?:, then draw ${NUMW} cards?)?$`, 'i')))) {
    const ops = [{ op: 'discard', n: num(m[1]) }];
    if (m[2]) ops.push({ op: 'if', cond: { k: 'did' }, then: [{ op: 'draw', n: num(m[2]) }] });
    return ops;
  }
  if ((m = t.match(new RegExp(`^Place up to ${NUMW} cards? from your hand into your sideline$`, 'i')))) return [{ op: 'discard', n: num(m[1]), upTo: true }];
  if ((m = t.match(new RegExp(`^Your opponent places ${NUMW} cards? from their hand into their sideline$`, 'i')))) return [{ op: 'discard', n: num(m[1]), who: 'opp' }];
  if ((m = t.match(new RegExp(`^Place the top ${NUMW} cards? of your deck into your sideline$`, 'i')))) return [{ op: 'mill', n: num(m[1]) }];
  if (/^Place the top card of your deck into your sideline$/i.test(t)) return [{ op: 'mill', n: 1 }];
  if ((m = t.match(new RegExp(`^Your opponent places the top ${NUMW} cards? of their deck into their sideline$`, 'i')))) return [{ op: 'mill', n: num(m[1]), who: 'opp' }];
  if ((m = t.match(new RegExp(`^Deal ${NUMW} damage to your opponent$`, 'i')))) return [{ op: 'damage', n: num(m[1]) }];
  if ((m = t.match(new RegExp(`^(?:Add|Place) the top ${NUMW} cards? of your deck (?:to|into) your life(?: area)?$`, 'i'))) || (m = t.match(/^(?:Add|Place) the top card of your deck (?:to|into) your life(?: area)?$/i))) return [{ op: 'lifeFromDeck', n: num(m[1] || 1) }];
  if (/^You can only (?:activate|use) this .*(?:one time each turn|per turn)$/i.test(t) || /^You can only activate this ability on the turn this character is played$/i.test(t)) return [];
  if ((m = t.match(new RegExp(`^Place ${NUMW} cards? from your sideline into your removal area$`, 'i')))) return [{ op: 'sideToRemoval', n: num(m[1]) }];
  if ((m = t.match(new RegExp(`^Place up to ${NUMW} cards? from the top of your deck into your sideline$`, 'i')))) return [{ op: 'millUpTo', n: num(m[1]) }];
  if (/^Place the top card of your deck face down under this character$/i.test(t)) return [{ op: 'underTop', n: 1 }];
  if ((m = t.match(new RegExp(`^Place the top ${NUMW} cards of your deck face down under this character$`, 'i')))) return [{ op: 'underTop', n: num(m[1]) }];
  if (/^(?:Look at|Reveal) the top card of your deck$/i.test(t)) return [{ op: 'look', n: 1, public: /^Reveal/i.test(t) }];
  if ((m = t.match(new RegExp(`^Reveal the top ${NUMW} cards of your deck$`, 'i')))) return [{ op: 'look', n: num(m[1]), public: true }];
  if (/^Reveal one card among them and add it to your hand$/i.test(t)) return [{ op: 'takeLook', f: { kind: 'card' }, max: 1, min: 1 }];
  if (/^(?:Sideline|Sideline it|Sideline this character)$/i.test(t) || /^Sideline it$/i.test(t)) return [{ op: 'act', t: 'self', do: 'sideline' }];
  if ((m = t.match(/^(Play|Play up to) (one|two|\d+) (.+?) from your (hand|sideline) set to (active|resting) onto your (field|front line|energy line)$/i))) {
    const f = parseSpec(m[3]);
    if (!f) return null;
    return [{ op: 'playFrom', zone: m[4].toLowerCase() === 'hand' ? 'hand' : 'side', f, max: num(m[2]), min: /up to/i.test(m[1]) ? 0 : num(m[2]), active: m[5].toLowerCase() === 'active', line: { field: null, 'front line': 'front', 'energy line': 'energy' }[m[6].toLowerCase()] }];
  }
  if ((m = t.match(/^(Play|Play up to) (one|two|\d+) (.+?) from your (hand|sideline) onto your (field|front line|energy line) set to (active|resting)$/i))) {
    const f = parseSpec(m[3]);
    if (!f) return null;
    return [{ op: 'playFrom', zone: m[4].toLowerCase() === 'hand' ? 'hand' : 'side', f, max: num(m[2]), min: /up to/i.test(m[1]) ? 0 : num(m[2]), active: m[6].toLowerCase() === 'active', line: { field: null, 'front line': 'front', 'energy line': 'energy' }[m[5].toLowerCase()] }];
  }
  if ((m = t.match(new RegExp(`^Add ${NUMW} cards? from (?:the top of )?your life(?: area)? to your hand$`, 'i')))) return [{ op: 'lifeToHand', n: num(m[1]) }];

  // look / reveal / arrange
  if ((m = t.match(new RegExp(`^Look at the top ${NUMW} cards of your deck$`, 'i')))) return [{ op: 'look', n: num(m[1]) }];
  if (/^Look at the top card of your deck, then place it on the top or bottom of your deck$/i.test(t)) return [{ op: 'arrange', n: 1 }];
  if (/^Look at the top card of your deck, then place it on the top of your deck or into your sideline$/i.test(t)) return [{ op: 'arrange', n: 1, rest: 'side' }];
  if ((m = t.match(new RegExp(`^Reveal up to ${NUMW} (.+?) among them and add (?:it|them) to your hand$`, 'i')))) {
    const f = parseSpec(m[2]);
    return f ? [{ op: 'takeLook', f, max: num(m[1]), min: 0 }] : null;
  }
  if ((m = t.match(new RegExp(`^Add up to ${NUMW} (.+?) among them to your hand$`, 'i')))) {
    const f = parseSpec(m[2]);
    return f ? [{ op: 'takeLook', f, max: num(m[1]), min: 0 }] : null;
  }
  if (/^Place the remaining cards on the bottom of your deck in any order$/i.test(t)) return [{ op: 'restLook', to: 'bottom' }];
  if (/^Place the remaining cards into your sideline$/i.test(t)) return [{ op: 'restLook', to: 'side' }];
  if (/^Place the remaining cards on the top of your deck in any order$/i.test(t)) return [{ op: 'restLook', to: 'top' }];
  if (/^Place any number of them on the top of your deck in any order(?:,| and) (?:then )?place any remaining cards on the bottom of your deck in any order$/i.test(t)) return [{ op: 'arrangeLook', rest: 'bottom' }];
  if (/^Place any number of them on the top of your deck in any order(?:,| and) (?:then )?place any remaining cards into your sideline$/i.test(t)) return [{ op: 'arrangeLook', rest: 'side' }];

  // AP
  if ((m = t.match(new RegExp(`^Choose up to ${NUMW} of your AP cards and switch (?:it|them) to active$`, 'i')))) return [{ op: 'ap', n: num(m[1]), active: true }];
  if ((m = t.match(new RegExp(`^Choose ${NUMW} of your AP cards and switch (?:it|them) to active$`, 'i')))) return [{ op: 'ap', n: num(m[1]), active: true }];
  if ((m = t.match(new RegExp(`^Switch up to ${NUMW} of your AP cards to active$`, 'i')))) return [{ op: 'ap', n: num(m[1]), active: true }];
  if ((m = t.match(new RegExp(`^Pay ${NUMW} AP$`, 'i')))) return [{ op: 'payAp', n: num(m[1]) }];

  // self
  if (/^(?:Switch this character to active|Switch to active)$/i.test(t)) return [{ op: 'act', t: 'self', do: 'active' }];
  if (/^Switch this character to resting$/i.test(t)) return [{ op: 'act', t: 'self', do: 'rest' }];
  if (/^Sideline this (?:character|card|site)$/i.test(t)) return [{ op: 'act', t: 'self', do: 'sideline' }];
  if (/^Return this (?:character|card|site) to your hand$/i.test(t)) return [{ op: 'act', t: 'self', do: 'hand' }];
  if (/^Move this character to (?:your|the) front line$/i.test(t) || /^May move to the front line$/i.test(t)) return /^May/i.test(t) ? [] : [{ op: 'act', t: 'self', do: 'front' }];
  if (/^Move this character to the other line$/i.test(t)) return [{ op: 'act', t: 'self', do: 'otherLine' }];
  if ((m = t.match(/^Play this (character|site|card) (?:set to active )?onto your field(?: set to active)?$/i))) return [{ op: 'playSelf', active: /set to active/i.test(t) }];
  if ((m = t.match(/^(?:Add this card to your hand)$/i))) return [{ op: 'act', t: 'self', do: 'hand' }];

  // "This character gains …" / "It gains …" / "They each gain …" (with a duration, as an effect)
  if ((m = t.match(/^(This character|This card|This site|It|They each|They|Those characters|That character)\s+(.*)$/i))) {
    const [body, until] = splitUntil(m[2]);
    const gain = parseGain(body);
    if (gain) {
      const self = /^this/i.test(m[1]);
      if (!until && !ctx.effect) return null;                     // a static: handled by parseStatic
      return [{ op: 'act', t: self ? 'self' : 'it', do: 'mod', mod: gain, until: until || 'perm' }];
    }
    if (/^will remain set to resting the next time it would be switched to active$/i.test(m[2])) return [{ op: 'act', t: /^this/i.test(m[1]) ? 'self' : 'it', do: 'mod', mod: { stayRested: true }, until: 'perm' }];
    const v = verbOp(m[2].replace(/^(\w)/, (c) => c.toLowerCase()), /^this/i.test(m[1]) ? 'self' : 'it');
    if (v && v.do !== 'mod') return [v];
  }
  // "All characters on your field gain 1000 BP until the end of the turn"
  if ((m = t.match(/^(All .+?)\s+(gains?|loses?|cannot)\s+(.*)$/i))) {
    const tg = parseTarget(m[1]);
    const [body, until] = splitUntil(`${m[2]} ${m[3]}`);
    const gain = parseGain(body);
    if (tg && gain && until) return [{ op: 'act', t: tg.f, do: 'mod', mod: gain, until }];
    if (tg && gain && ctx.effect) return [{ op: 'act', t: tg.f, do: 'mod', mod: gain, until: 'perm' }];
    return null;
  }
  if ((m = t.match(/^(Sideline|Rest|Return) all (.+)$/i))) {
    const tg = parseTarget(`all ${m[2].replace(/ to (?:their|its owner's|your) hands?$/i, '')}`);
    if (!tg) return null;
    return [{ op: 'act', t: tg.f, do: { sideline: 'sideline', rest: 'rest', return: 'hand' }[m[1].toLowerCase()] }];
  }
  if ((m = t.match(/^Switch all (.+?) to (resting|active)$/i))) {
    const tg = parseTarget(`all ${m[1]}`);
    return tg ? [{ op: 'act', t: tg.f, do: m[2].toLowerCase() === 'resting' ? 'rest' : 'active' }] : null;
  }
  if ((m = t.match(/^Your opponent cannot block(.*)$/i))) {
    const [, until] = splitUntil(m[1]);
    return [{ op: 'act', t: { who: 'opp', zones: ['front'], kind: 'character' }, do: 'mod', mod: { cantBlock: true }, until: until || 'eot' }];
  }

  // choose …
  if ((m = t.match(/^(?:Choose|Select) (.+?)(?: and (.+))?$/i))) {
    let phrase = m[1], verb = m[2] || null;
    // "Choose one character … and sideline it" — the "and" may be inside the target phrase ("front line and energy line")
    let tg = parseTarget(phrase);
    if (!tg && verb) { tg = parseTarget(`${phrase} and ${verb}`); if (tg) verb = null; }
    if (!tg || tg.all) return null;
    const ops = [{ op: 'choose', f: tg.f, min: tg.min, max: tg.max, prompt: promptFor(tg, verb ? verb.replace(/\s+(?:it|them)\b.*$/i, '').toLowerCase() : null), required: tg.min > 0 }];
    if (verb) {
      const parts = verb.split(/,?\s+then\s+|,\s+and\s+/i);
      for (const v of parts) {
        const o = verbOp(v);
        if (!o) return null;
        ops.push(o);
      }
    }
    return ops;
  }
  // "Return one other character on your field with 2 or less required energy to your hand"
  if ((m = t.match(/^Return (.+?) to (?:your|their|its owner's) hands?$/i))) {
    const tg = parseTarget(m[1]);
    if (!tg || tg.all) return null;
    return [{ op: 'choose', f: tg.f, min: tg.min, max: tg.max, prompt: promptFor(tg, 'return to hand'), required: tg.min > 0 }, { op: 'act', t: 'it', do: 'hand' }];
  }
  if ((m = t.match(/^Sideline (.+)$/i))) {
    const tg = parseTarget(m[1]);
    if (!tg || tg.all) return null;
    return [{ op: 'choose', f: tg.f, min: tg.min, max: tg.max, prompt: promptFor(tg, 'sideline'), required: tg.min > 0 }, { op: 'act', t: 'it', do: 'sideline' }];
  }
  if ((m = t.match(/^Add (up to (?:one|two|three|\d+)|one|two|three|\d+) (.+?) from your (sideline|removal area) to your hand$/i))) {
    const q = m[1].toLowerCase();
    const max = num(q.replace('up to ', ''));
    const f = parseSpec(m[2]);
    return f ? [{ op: 'fromZone', zone: m[3].toLowerCase() === 'sideline' ? 'side' : 'removal', f, max, min: q.startsWith('up to') ? 0 : max }] : null;
  }
  if ((m = t.match(/^At the end of the (main phase|turn), (.+)$/i))) {
    const inner = parseSentence(m[2], { ...ctx, effect: true });
    return inner ? [{ op: 'delayed', at: m[1].toLowerCase() === 'turn' ? 'endTurn' : 'endMain', ops: inner, text: m[2] }] : null;
  }
  if (/^Shuffle your deck$/i.test(t)) return [{ op: 'shuffle' }];
  return null;
}

// ---------- statics (no timing): "This character gains 1000 BP." ----------
function parseStatic(t, cond) {
  let m;
  t = t.trim().replace(/\.$/, '');
  if ((m = t.match(/^If (.+?),\s*(.*)$/i))) {
    const c = parseCond(m[1]);
    if (!c) return null;
    return parseStatic(m[2], cond ? { k: 'and', all: [cond, c] } : c);
  }
  if ((m = t.match(/^(?:This character|This card|This site|It)\s+(.*)$/i))) {
    let body = m[1], perCard = null;
    const each = body.match(/^(.*?) for each (.+)$/i);
    if (each) {
      body = each[1];
      if (/^face-down card under it$|^card under it$/i.test(each[2])) perCard = 'under';
      else { const tg = parseTarget(`all ${each[2]}`); if (!tg) return null; perCard = tg.f; }
    }
    const gain = parseGain(body);
    if (gain) return [{ target: 'self', cond, mod: gain, ...(perCard ? { perCard } : {}) }];
    if ((m = body.match(/^cannot be blocked by (?:a )?characters? with (\d+) or (less|more) BP$/i))) return [{ target: 'self', cond, mod: { unblockable: { [m[2].toLowerCase() === 'less' ? 'bpMax' : 'bpMin']: Number(m[1]) } } }];
    if (/^cannot be blocked$/i.test(body)) return [{ target: 'self', cond, mod: { unblockable: {} } }];
    if (/^is not affected by BP-reducing abilities$/i.test(body)) return [{ target: 'self', cond, mod: { noBpReduce: true } }];
    if (/^generates energy even if it is on the front line$/i.test(body)) return [{ target: 'self', cond, mod: { genFront: true } }];
    if (/^cannot be chosen by your opponent's abilities$/i.test(body)) return [{ target: 'self', cond, mod: { cantBeChosen: true } }];
    if (/^cannot attack$/i.test(body)) return [{ target: 'self', cond, mod: { cantAttack: true } }];
    if (/^cannot be removed from the field by your opponent's abilities$/i.test(body)) return [{ target: 'self', cond, mod: { cantBeRemoved: true } }];
    if (/^cannot block$/i.test(body)) return [{ target: 'self', cond, mod: { cantBlock: true } }];
    return null;
  }
  if ((m = t.match(/^(All .+?|Other .+?)\s+(gains?|loses?)\s+(.*)$/i))) {
    const tg = parseTarget(/^other/i.test(m[1]) ? `all ${m[1]}` : m[1]);
    const gain = parseGain(`${m[2]} ${m[3]}`);
    if (tg && gain) return [{ target: tg.f, cond, mod: gain }];
  }
  if ((m = t.match(/^Your (?:other )?(.+?) gain (.+)$/i))) {
    const tg = parseTarget(`all ${/other/i.test(t.slice(0, 12)) ? 'other ' : ''}${m[1]} on your field`);
    const gain = parseGain(`gain ${m[2]}`);
    if (tg && gain) return [{ target: tg.f, cond, mod: gain }];
  }
  return null;
}

// ---------- an ability line ----------
function splitTags(line) {
  const tags = [];
  let rest = line.trim(), m;
  while ((m = rest.match(/^\[([^\]]+)\]\s*/))) { tags.push(m[1].replace(/#/g, '').trim()); rest = rest.slice(m[0].length); }
  return { tags, body: rest.trim() };
}

// "{A} … If X, {B} instead." → a cond and the two versions of the text
function substitution(body) {
  const m = body.match(/\s*If ([^.]+?),\s*\{([^}]*)\}\s*instead\.?/i);
  if (!m) return null;
  const without = body.replace(m[0], '').trim();
  const first = without.match(/\{([^}]*)\}/);
  if (!first) return null;
  const base = without.replace(/[{}]/g, '');
  const alt = without.replace(first[0], m[2]).replace(/[{}]/g, '');
  return { cond: m[1], base, alt };
}

// the sentence that last failed to compile (coverage reports use it)
export let lastFail = null;
function compileBody(body, opts = {}) {
  const sub = substitution(body);
  if (sub) {
    const cond = parseCond(sub.cond);
    const a = compileBody(sub.base, opts), b = compileBody(sub.alt, opts);
    if (!cond || !a || !b) return null;
    return [{ op: 'if', cond, then: b, else: a }];
  }
  const text = stripReminders(body);
  const out = [];
  const ss = sentences(text);
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i];
    if (/^Choose (?:one|up to one) of the following:?$/i.test(s) && opts.bullets?.length) {
      const options = opts.bullets.map((b) => ({ text: b, ops: compileBody(b, { ...opts, bullets: null }) }));
      if (options.some((o) => !o.ops)) return null;      // lastFail is the bullet's sentence
      out.push({ op: 'modal', options, min: /up to/i.test(s) ? 0 : 1, max: 1 });
      continue;
    }
    lastFail = null;
    const ops = parseSentence(s, { effect: true, prev: out, bullets: opts.bullets });
    if (!ops) { lastFail ||= s; return null; }
    // "Place any number of them on top …" after a look: the look becomes an arrange
    if (ops[0]?.op === 'arrangeLook') {
      const look = out.findLast?.((o) => o.op === 'look') || [...out].reverse().find((o) => o.op === 'look');
      if (!look) return null;
      look.op = 'arrange'; look.rest = ops[0].rest;
      continue;
    }
    out.push(...ops);
  }
  return out;
}

const COST_TAGS = [
  [/^switch to resting$/i, () => ({ k: 'rest' })],
  [/^pay (\d+) ap$/i, (m) => ({ k: 'ap', n: Number(m[1]) })],
  [/^place (\d+) cards? from hand into sideline$/i, (m) => ({ k: 'discard', n: Number(m[1]) })],
  [/^sideline this card$/i, () => ({ k: 'sidelineSelf' })],
  [/^place (\d+) cards? from (?:your )?sideline into (?:your )?removal area$/i, (m) => ({ k: 'removeSide', n: Number(m[1]) })],
];

// text-level triggers without a tag: "When this character attacks and wins a battle, draw a card."
const TEXT_TRIGGERS = [
  [/^When this character attacks and wins a battle,\s*/i, 'winBattle'],
  [/^When this character wins a battle,\s*/i, 'winBattle'],
  [/^When this character attacks and loses a battle,\s*/i, 'loseBattle'],
  [/^When this character attacks and deals direct damage,\s*/i, 'directDamage'],
  [/^When this character attacks and is not blocked,\s*/i, 'notBlocked'],
  [/^When this character attacks,\s*/i, 'attack'],
  [/^When this character blocks,\s*/i, 'block'],
  [/^When this character is sidelined,\s*/i, 'sidelined'],
  [/^At the start of your end phase,\s*/i, 'endPhase'],
  [/^At the start of your attack phase,\s*/i, 'attackPhase'],
  [/^At the start of your turn,\s*/i, 'startTurn'],
];

// "When a character on your field attacks and wins a battle, …": the ability watches other cards' events
const WATCH_TRIGGERS = [
  [/^When (?:a|one of your|another) characters? on your field attacks and wins a battle,\s*/i, 'winBattle', { who: 'self', kind: 'character' }],
  [/^When (?:a|one of your|another) characters? on your field attacks,\s*/i, 'attack', { who: 'self', kind: 'character' }],
  [/^When (?:a|one of your|another) characters? on your field is sidelined,\s*/i, 'sidelined', { who: 'self', kind: 'character' }],
  [/^When (?:a|one of your|another) characters? on your field blocks,\s*/i, 'block', { who: 'self', kind: 'character' }],
];

export function compileLine(line, def, bullets = []) {
  const { tags, body } = splitTags(line);
  const ab = { text: line, timing: null, cond: null, cost: [], once: false, ops: null };
  const conds = [];
  for (const tag of tags) {
    const t = tag.toLowerCase();
    if (TIMING_TAGS[t]) { ab.timing = ab.timing ? ab.timing : TIMING_TAGS[t]; if (ab.timing !== TIMING_TAGS[t]) (ab.also ||= []).push(TIMING_TAGS[t]); continue; }
    if (COND_TAGS[t]) { conds.push(COND_TAGS[t]); continue; }
    if (t === 'once per turn') { ab.once = true; continue; }
    const cost = COST_TAGS.map(([rx, fn]) => { const m = tag.match(rx); return m ? fn(m) : null; }).find(Boolean);
    if (cost) { ab.cost.push(cost); continue; }
    if (t === 'raid') return { kind: 'raid' };
    const kw = kwFrom(tag);
    if (kw) { (ab.kw ||= {}); Object.assign(ab.kw, kw); continue; }
    return { ...ab, manual: `unknown tag [${tag}]` };
  }
  if (conds.length) ab.cond = conds.length === 1 ? conds[0] : { k: 'and', all: conds };

  // keywords granted under a condition: "[During Your Turn] [Impact (1)]"
  if (ab.kw && !stripReminders(body)) return { kind: 'static', statics: [{ target: 'self', cond: ab.cond, mod: { kw: ab.kw } }] };
  if (ab.kw) return { ...ab, manual: 'keyword with text' };

  let text = body;
  // "You can only activate this ability …" restrictions
  const restr = [];
  text = text.replace(/\s*You can only activate this (?:<[^>]+> )?ability one time each turn\.?/gi, () => { ab.once = true; return ''; });
  text = text.replace(/\s*You can only activate this ability on the turn this character is played\.?/gi, () => { restr.push({ k: 'playedThisTurn' }); return ''; });
  text = text.replace(/\s*You cannot activate this ability on the turn this character is played\.?/gi, () => { restr.push({ k: 'not', c: { k: 'playedThisTurn' } }); return ''; });
  text = text.replace(/\s*You can only (?:activate this ability|use this card) if ([^.]+)\.?/gi, (all, c) => { const pc = parseCond(c); if (pc) restr.push(pc); else restr.push(null); return ''; });
  if (restr.includes(null)) return { ...ab, manual: 'restriction' };
  if (restr.length) ab.cond = ab.cond ? { k: 'and', all: [ab.cond, ...restr] } : (restr.length === 1 ? restr[0] : { k: 'and', all: restr });

  if (!ab.timing) {
    for (const [rx, timing, watch] of WATCH_TRIGGERS) {
      const plain = stripReminders(text);
      if (rx.test(plain)) { ab.timing = timing; ab.watch = watch; text = plain.replace(rx, '').replace(/^./, (c) => c.toUpperCase()); break; }
    }
  }
  if (!ab.timing) {
    for (const [rx, timing] of TEXT_TRIGGERS) {
      if (rx.test(stripReminders(text))) { ab.timing = timing; text = stripReminders(text).replace(rx, '').replace(/^./, (c) => c.toUpperCase()); break; }
    }
  }
  if (!ab.timing) {
    // no timing: an event's effect, or a static ability
    if (def.type === 'event') {
      const ops = compileBody(text, { bullets });
      return ops ? { kind: 'event', ops, text: line } : { kind: 'event', ops: [], manual: line, text: line };
    }
    const st = [];
    for (const s of sentences(stripReminders(text))) {
      const r = parseStatic(s, ab.cond);
      if (!r) return { ...ab, kind: 'static', manual: line, fail: s };
      st.push(...r);
    }
    return { kind: 'static', statics: st };
  }
  const ops = compileBody(text, { bullets });
  if (!ops) return { ...ab, kind: 'ability', ops: [], manual: line };
  return { ...ab, kind: 'ability', ops };
}

// ---------- a whole card ----------
export function compileDef(def) {
  const out = { abilities: [], statics: [], event: null, trigger: null, aliases: [], copyLimit: null, handMods: [], coverage: { lines: 0, auto: 0, manual: [], fails: [] } };
  const raw = String(def.effect || '').split('\n').map((s) => s.trim()).filter(Boolean);
  // bullets (・ …) belong to the line before them
  const lines = [];
  for (const l of raw) {
    if (/^・/.test(l) && lines.length) lines[lines.length - 1].bullets.push(l.replace(/^・\s*/, ''));
    else lines.push({ text: l, bullets: [] });
  }
  for (const { text, bullets } of lines) {
    const plain = stripReminders(text);
    // a line of keywords only (the def already has them)
    const { tags, body } = splitTags(text);
    if (tags.length && !stripReminders(body) && tags.every((t) => kwFrom(t))) continue;
    if (/^\[Raid\]/i.test(text)) continue;                                        // Raid is in def.raid
    let m;
    if ((m = plain.match(/^This card is also treated as ((?:<[^>]+>(?:,?\s*(?:and|or)?\s*)?)+)\.?$/i))) { out.aliases.push(...names(m[1])); continue; }
    if (/^Play this (?:character|site|card) set to active(?: onto your field)?\.?$/i.test(plain)) { out.entersActive = true; out.coverage.lines++; out.coverage.auto++; continue; }
    if (/^This card cannot be played onto or moved to your front line\.?$/i.test(plain)) { out.noFront = true; out.coverage.lines++; out.coverage.auto++; continue; }
    if (/^This character can only be played by performing Raid with it\.?$/i.test(plain)) { out.raidOnly = true; out.coverage.lines++; out.coverage.auto++; continue; }
    if ((m = plain.match(/^A deck can (?:only )?contain up to (\w+) copies of this card\.?$/i))) { out.copyLimit = num(m[1]); continue; }
    if (/^This card cannot be played onto your energy line\.?$/i.test(plain)) { out.noEnergy = true; out.coverage.lines++; out.coverage.auto++; continue; }
    if ((m = plain.match(/^A deck can contain any number of copies of this card\.?$/i))) { out.copyLimit = 50; continue; }
    out.coverage.lines++;
    if ((m = plain.match(/^For every (\w+) cards in your (sideline|removal area), reduce this card's (AP cost|required energy) by (?:(\d+)|\[([^\]]+)\])(?: while in your hand)?\.?$/i))) {
      out.coverage.lines++; out.coverage.auto++;
      out.handMods.push({ per: { zone: m[2].toLowerCase() === 'sideline' ? 'side' : 'removal', n: num(m[1]) }, [m[3].toLowerCase() === 'ap cost' ? 'ap' : 'energy']: -(m[4] ? Number(m[4]) : Number((m[5].match(/×(\d+)/) || [0, 1])[1])) });
      continue;
    }
    // hand cost reductions: "If <N> is on your field, reduce this card's AP cost by 1 while in your hand."
    if ((m = plain.match(/^(?:If (.+?), )?reduce this card's (AP cost|required energy) by (?:(\d+)|\[([^\]]+)\])(?: while in your hand)?\.?$/i))) {
      const cond = m[1] ? parseCond(m[1]) : null;
      if (m[1] && !cond) { out.coverage.manual.push(text); continue; }
      out.handMods.push({ cond, [m[2].toLowerCase() === 'ap cost' ? 'ap' : 'energy']: -(m[3] ? Number(m[3]) : Number((m[4].match(/×(\d+)/) || [0, 1])[1])) });
      out.coverage.auto++;
      continue;
    }
    lastFail = null;
    const r = compileLine(text, def, bullets);
    if (r.kind === 'raid') continue;
    if (r.kind === 'static') {
      if (r.manual) { out.coverage.manual.push(text); out.coverage.fails.push(r.fail || lastFail || text); out.abilities.push({ timing: 'static', manual: text, text, ops: [] }); continue; }
      out.statics.push(...r.statics);
      out.coverage.auto++;
      continue;
    }
    if (r.kind === 'event') {
      out.event = { ops: r.ops, manual: r.manual || null, text };
      if (r.manual) { out.coverage.manual.push(text); out.coverage.fails.push(lastFail || text); } else out.coverage.auto++;
      continue;
    }
    if (r.manual) { out.coverage.manual.push(text); out.coverage.fails.push(r.fail || lastFail || text); out.abilities.push({ ...r, ops: [], manual: text, text }); continue; }
    out.abilities.push(r);
    out.coverage.auto++;
  }
  // life trigger: Draw / Get / Raid are handled by the engine from the type; the rest are compiled from the text
  if (def.trigger && !['get', 'raid'].includes(def.trigger.type)) {
    const ops = compileBody(def.trigger.text || '', {});
    out.trigger = ops ? { ops, text: def.trigger.text } : { ops: [], manual: def.trigger.text, text: def.trigger.text };
    out.coverage.lines++;
    if (ops) out.coverage.auto++; else { out.coverage.manual.push(`[Trigger] ${def.trigger.text}`); out.coverage.fails.push(lastFail || def.trigger.text); }
  }
  return out;
}
