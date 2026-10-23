// Shared Lorcana rules helpers — imported by BOTH the Node game engine
// (game/engine.js) and the 3D client (for enabling/disabling actions), so the
// two can never disagree about what's legal.
//
// They operate on "card instances" shaped like:
//   { iid, cardId, owner, exerted, damage, drying, atLocation, mods: [...], under: [...] }
// plus the card's static "def" (see game/cards.js).
//
// Section numbers refer to the Disney Lorcana Comprehensive Rules v2.3.0.

export const LORE_TO_WIN = 20;        // 1.8.1.1
export const OPENING_HAND = 7;        // 2.2.1.4
export const INKS_PER_TURN = 1;       // 4.2.3

export const KEYWORD_HELP = {
  alert: 'Alert — This character can challenge as if they had Evasive. (8.2)',
  bodyguard: 'Bodyguard — May enter play exerted. An opposing character who challenges one of your characters must choose one with Bodyguard if able. (8.3)',
  boost: 'Boost N — Once during your turn, you may pay N ink to put the top card of your deck facedown under this card. (8.4)',
  challenger: 'Challenger +N — While challenging, this character gets +N strength. (8.5)',
  evasive: 'Evasive — Only characters with Evasive can challenge this character. (8.6)',
  reckless: "Reckless — This character can't quest and must challenge each turn if able. (8.7)",
  resist: 'Resist +N — Damage dealt to this character is reduced by N. (8.8)',
  rush: 'Rush — This character can challenge the turn they\'re played. (8.9)',
  shift: 'Shift — Pay the Shift cost to play this on top of one of your characters with the same name. Its variants say what it may go on top of instead (8.10.8). (8.10)',
  puppyShift: 'Puppy Shift N — Pay N ink to play this on top of one of your Puppy characters. (8.10.8.1)',
  universalShift: 'Universal Shift N — Pay N ink to play this on top of any one of your characters. (8.10.8.2)',
  singer: 'Singer N — This character counts as cost N to sing songs. (8.11)',
  singTogether: 'Sing Together N — Any number of your characters with total cost N or more may exert to sing this song for free. (8.12)',
  support: "Support — Whenever this character quests, you may add their strength to another chosen character's strength this turn. (8.13)",
  vanish: 'Vanish — When an opponent chooses this character for an action, banish them. (8.14)',
  ward: "Ward — Opponents can't choose this character except to challenge. (8.15)",
};

export const KEYWORD_LABEL = {
  alert: 'Alert', bodyguard: 'Bodyguard', boost: 'Boost', challenger: 'Challenger', evasive: 'Evasive',
  reckless: 'Reckless', resist: 'Resist', rush: 'Rush', shift: 'Shift', puppyShift: 'Puppy Shift',
  universalShift: 'Universal Shift', classShift: 'Shift', tempShift: 'Temporary Shift', vanish: 'Vanish', singer: 'Singer', singTogether: 'Sing Together', support: 'Support',
  vanish: 'Vanish', ward: 'Ward',
  cantQuest: "Can't quest", cantChallenge: "Can't challenge", mustQuest: 'Must quest if able', adventurous: 'Adventurous', cantReady: "Can't ready", cantMove: "Can't move", noDamage: "Can't be dealt damage", noChallengeDamage: 'Takes no damage from challenges',
  noDamageChallenging: 'Takes no damage while challenging', noEffectDamage: "Can't be dealt damage outside challenges", skipReady: "Skips its next ready", cantBeChallenged: "Can't be challenged", cantBeChallengedBy: "Can't be challenged by some characters",
  mustChoose: 'Opponents must choose it if able', cantSing: "Can't sing", challengeReady: 'Can challenge ready characters', challengeReadyOf: 'Can challenge some ready characters', questFresh: 'Can quest the turn it\'s played',
};

export function cardLabel(def) {
  if (!def) return 'a card';
  return def.title ? `${def.name} – ${def.title}` : def.name;
}

// ---------- effective values ----------

export function modSum(card, stat) {
  let n = 0;
  for (const m of card?.mods || []) if (m.stat === stat) n += m.delta;
  return n;
}
// "Your characters' {strength} can't be reduced below their printed value" (CR 6.6.4: after modifiers)
export const effStr = (card, def) => { const v = (def.str ?? 0) + modSum(card, 'str'); return (card?.mods || []).some((m) => m.stat === 'strFloor') ? Math.max(v, def.str ?? 0) : v; };
export const effWp = (card, def) => (def.wp ?? 0) + modSum(card, 'wp');
export const effLore = (card, def) => (def.lore ?? 0) + modSum(card, 'lore');

// Keyword value including manual grants ("gains Evasive this turn" → kw mod +1).
export function kwVal(card, def, k) {
  const base = def?.kw?.[k];
  let v = typeof base === 'number' ? base : (base ? 1 : 0);
  const blocked = (card?.mods || []).some((m) => m.stat === 'kwBlock' && m.kw === k);   // "can't gain Evasive" — gains don't count (6.6)
  for (const m of card?.mods || []) if (m.stat === 'kw' && m.kw === k && !(blocked && m.delta > 0)) v += m.delta;
  return v;
}
export const hasKw = (card, def, k) => kwVal(card, def, k) > 0;

// Merged keyword map for display.
export function effectiveKeywords(card, def) {
  const out = {};
  const keys = new Set([...Object.keys(def?.kw || {}), ...(card?.mods || []).filter((m) => m.stat === 'kw').map((m) => m.kw)]);
  for (const k of keys) {
    const v = kwVal(card, def, k);
    if (v > 0) out[k] = typeof def?.kw?.[k] === 'string' ? def.kw[k] : v;
  }
  return out;
}

// What a character counts as when singing (8.11). Singer N replaces their cost.
export function singValue(card, def) {
  const base = hasKw(card, def, 'singer') ? kwVal(card, def, 'singer') : (def.cost || 0);
  return base + modSum(card, 'sing');
}

// Names for "same name" checks — "Flotsam & Jetsam" is also "Flotsam" and "Jetsam" (5.2.6.1).
export function namesOf(def) {
  const names = new Set([def.name]);
  if (/&|\s'n'\s/.test(def.name)) {
    for (const part of def.name.split(/\s*&\s*|\s+'n'\s+|,\s*/)) if (part.trim()) names.add(part.trim());
  }
  return names;
}
export function sharesName(a, b) {
  const nb = namesOf(b);
  for (const n of namesOf(a)) if (nb.has(n)) return true;
  return false;
}

// ---------- turn-action legality ----------
// Each returns null when legal, or a short human-readable reason.

// Some restrictions name a query ("can't be challenged by characters with cost 3 or less", "can challenge ready
// damaged characters"). The engine installs a hook that evaluates it; the client has none and stays lenient —
// the server has the final say.
let queryHook = null;
export const setQueryHook = (f) => { queryHook = f; };
const queryOk = (F, card, def, ctl) => (queryHook ? queryHook(F, card, def, ctl) : null);
const blockedBy = (by, att, attDef, ctl) => (by.q ? queryOk(by.q, att, attDef, ctl) === true
  : by.class ? (attDef.classes || []).map((x) => x.toLowerCase()).includes(by.class) : effStr(att, attDef) >= by.strGte);
// "can challenge ready characters" — all of them, or only ones a query names ("ready damaged characters")
function mayChallengeReady(att, attDef, tgt, tgtDef) {
  if (hasKw(att, attDef, 'challengeReady')) return true;
  return (att.mods || []).some((m) => m.stat === 'kw' && m.kw === 'challengeReadyOf' && queryOk(m.of, tgt, tgtDef, att.owner) !== false);
}

export function questBlocker(card, def) {
  if (def.type !== 'character') return 'Only characters can quest.';
  if (card.exerted) return 'Already exerted.';
  if (card.drying && !hasKw(card, def, 'questFresh')) return 'Still drying — characters can quest the turn after they\'re played.';
  if (hasKw(card, def, 'reckless')) return 'Reckless characters can\'t quest.';
  if (hasKw(card, def, 'cantQuest')) return 'An ability says this character can\'t quest.';
  return null;
}

export function attackerBlocker(card, def) {
  if (def.type !== 'character') return 'Only characters can challenge.';
  if (card.exerted) return 'Already exerted.';
  if (card.drying && !hasKw(card, def, 'rush')) return 'Still drying — only characters with Rush can challenge the turn they\'re played.';
  if (hasKw(card, def, 'cantChallenge')) return 'An ability says this character can\'t challenge.';
  if (hasKw(card, def, 'adventurous')) return 'Adventurous characters can\'t challenge.';
  return null;
}

function evasiveBlocks(att, attDef, tgt, tgtDef) {
  return hasKw(tgt, tgtDef, 'evasive') && !hasKw(att, attDef, 'evasive') && !hasKw(att, attDef, 'alert');
}

// `defenderSide` = [{ card, def }] for every card the defending player has in play.
export function defenderBlocker(att, attDef, tgt, tgtDef, defenderSide) {
  for (const m of tgt.mods || []) if (m.stat === 'kw' && m.kw === 'cantBeChallengedBy' && m.by && blockedBy(m.by, att, attDef, tgt.owner)) return 'An ability says this can\'t be challenged by that character.';
  if (tgtDef.type === 'location') return null;                                 // 4.6.8 — locations can always be challenged
  if (tgtDef.type !== 'character') return 'You can only challenge characters and locations.';
  if (hasKw(tgt, tgtDef, 'cantBeChallenged')) return 'An ability says this character can\'t be challenged.';
  if (!tgt.exerted && !mayChallengeReady(att, attDef, tgt, tgtDef)) return 'Only exerted characters can be challenged.';       // 4.6.4.2
  if (evasiveBlocks(att, attDef, tgt, tgtDef)) return 'Evasive — only characters with Evasive (or Alert) can challenge it.';
  if (!hasKw(tgt, tgtDef, 'bodyguard')) {
    const guard = defenderSide.find(({ card, def }) => def.type === 'character' && card.exerted
      && hasKw(card, def, 'bodyguard') && !evasiveBlocks(att, attDef, card, def));
    if (guard) return `Bodyguard — you must challenge ${cardLabel(guard.def)} first.`;
  }
  return null;
}

// Challenge damage (4.6.6 + Challenger 8.5 + Resist 8.8). Negative strength deals 0.
// opts.attStat / defStat: which stat deals the damage ('str' — or 'wp': "your characters deal damage with their {willpower}")
export function challengeDamage(att, attDef, tgt, tgtDef, opts = {}) {
  const dmg = (c, d, stat) => (stat === 'wp' ? effWp(c, d) : effStr(c, d));
  const atk = Math.max(0, dmg(att, attDef, opts.attStat) + kwVal(att, attDef, 'challenger'));
  const safe = (c, d, ...k) => ['noDamage', 'noChallengeDamage', ...k].some((x) => hasKw(c, d, x));   // "takes no damage from challenges"
  const toDefender = safe(tgt, tgtDef) ? 0 : Math.max(0, atk - kwVal(tgt, tgtDef, 'resist'));
  const back = tgtDef.type === 'character' ? Math.max(0, dmg(tgt, tgtDef, opts.defStat)) : 0;  // locations deal no damage
  const toAttacker = safe(att, attDef, 'noDamageChallenging') ? 0 : Math.max(0, back - kwVal(att, attDef, 'resist'));
  return { toDefender, toAttacker };
}

export function singerBlocker(card, def, songDef) {
  if (def.type !== 'character') return 'Only characters can sing.';
  if (card.exerted) return 'Already exerted.';
  if (card.drying) return 'Still drying.';
  if (hasKw(card, def, 'cantSing')) return 'An ability says this character can\'t sing.';
  if (songDef && hasKw(card, def, 'cantSingSolo')) return 'This character can only sing with Sing Together.';   // Meilin Lee - Lead Vocalist
  if (songDef && singValue(card, def) < songDef.cost) return `Needs cost ${songDef.cost}+ to sing this song.`;
  return null;
}

// ---------- Shift (8.10) ----------
// Every Shift line — plain, [Classification], Universal, Duo, Combo, Temporary, Potato, or several combined
// (8.10.9: "Temporary Red Panda Shift") — is one spec built from three parts:
//   cost  { ink: N }  ·  { discard: N, type? }  ("Shift: Discard an action card")  ·  { inkDrops: N }
//   onto  { by: 'name' } · { by: 'class', cls } · { by: 'any' } · { by: 'duo' } · { by: 'combo' } · { by: 'item', named }
//   temp  true → back to hand at the end of the turn (8.10.8.5)
// The compiler turns each keyword line into a spec (def.shifts); the engine, bot and client all read it here.
const SHIFT_LINE = /^((?:[A-Z][a-z]+ ){0,3})Shift\b(?::\s*([^.]+?)\.?|\s+(\d+)(?:\s*\{(?:ink|I)\})?|\s+(Remove \d+ ink drops?))?\s*$/;
const SHIFT_WORD = {
  temporary: (sp) => { sp.temp = true; }, universal: (sp) => { sp.onto = { by: 'any' }; }, duo: (sp) => { sp.onto = { by: 'duo' }; },
  combo: (sp) => { sp.onto = { by: 'combo' }; }, potato: (sp) => { sp.onto = { by: 'item', named: 'Potato' }; },
};
const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3 };
export function shiftCost(t) {
  const x = String(t ?? '').trim();
  if (/^\d+$/.test(x)) return { ink: Number(x) };
  let m = x.match(/^discard (a|an|one|two|three|\d+) (?:(character|action|item|location|song) )?cards?$/i);
  if (m) return { discard: NUM[m[1].toLowerCase()] ?? Number(m[1]), ...(m[2] ? { type: m[2].toLowerCase() } : {}) };
  m = x.match(/^remove (\d+) ink drops?$/i);
  if (m) return { inkDrops: Number(m[1]) };
  return null;
}
// "Temporary Red Panda Shift 2 {ink}" → spec, or null when it isn't a Shift line / the cost is unknown
export function parseShift(text) {
  const m = String(text ?? '').replace(/\s*\([^()]*\)/g, '').trim().match(SHIFT_LINE);
  if (!m) return null;
  const sp = { label: `${m[1]}Shift`, onto: { by: 'name' }, temp: false };
  const cls = [];
  for (const w of m[1].trim().split(/\s+/).filter(Boolean)) (SHIFT_WORD[w.toLowerCase()] || (() => cls.push(w)))(sp);
  if (cls.length) {
    if (sp.onto.by !== 'name') return null;                             // "Universal Puppy Shift" — no such card
    sp.onto = { by: 'class', cls: cls.join(' ').toLowerCase() };
  }
  sp.cost = shiftCost(m[3] ?? m[2] ?? m[4]);
  return sp.cost ? sp : null;
}
export const shiftCostLabel = (c) => (c.ink != null ? `${c.ink} ⬡` : c.inkDrops != null ? `remove ${c.inkDrops} ink drop${c.inkDrops === 1 ? '' : 's'}`
  : `discard ${c.discard} ${c.type ? `${c.type} ` : ''}card${c.discard === 1 ? '' : 's'}`);
const SHIFT_KIND = { name: 'shift', class: 'classShift', any: 'universalShift', duo: 'duoShift', combo: 'comboShift', item: 'potatoShift' };

// This card's ways to shift: [{ kind, label, cost (ink number, or the cost in words), spec }]
export function shiftOptions(def) {
  let specs = def.shifts;
  if (!specs) {                                   // a def built without procs: its keyword column only
    specs = [];
    const k = def.kw || {};
    if (typeof k.shift === 'number') specs.push({ label: 'Shift', cost: { ink: k.shift }, onto: { by: 'name' }, temp: !!k.tempShift });
    if (typeof k.puppyShift === 'number') specs.push({ label: 'Puppy Shift', cost: { ink: k.puppyShift }, onto: { by: 'class', cls: 'puppy' }, temp: false });
    if (typeof k.universalShift === 'number') specs.push({ label: 'Universal Shift', cost: { ink: k.universalShift }, onto: { by: 'any' }, temp: false });
  }
  return specs.map((spec) => ({ kind: SHIFT_KIND[spec.onto.by], label: spec.label, cost: spec.cost.ink ?? shiftCostLabel(spec.cost), spec }));
}
// the names a Duo / Combo Shift card is made of ("Mickey Mouse & Minnie Mouse" → Mickey Mouse, Minnie Mouse)
const partNames = (def) => [...namesOf(def)].filter((n) => n !== def.name);
// a target's names for Shift, plus what its own abilities add (def.shiftAs: "also counts as being named Syndrome")
const shiftNames = (t) => new Set([...namesOf(t), ...(t.shiftAs?.names || [])]);
const anyNameOk = (t) => !!(t.shiftAs?.any || t.shiftAs?.anyName);
function ontoOne(spec, shifter, t) {
  const ch = t.type === 'character';
  if (ch && t.shiftAs?.any) return true;                               // Morph: every Shift variant
  switch (spec.onto.by) {
    case 'any': return ch;
    case 'class': return ch && (t.classes || []).includes(spec.onto.cls);
    case 'item': return t.type === 'item' && namesOf(t).has(spec.onto.named);
    default: return ch && (anyNameOk(t) || [...namesOf(shifter)].some((n) => shiftNames(t).has(n)));   // name · duo / combo halves
  }
}
// Can the shifter go on top of exactly these cards? One card — or two for Duo / Combo Shift, one of each name (8.10.8.3)
export function shiftOntoOk(opt, shifter, tgts) {
  const spec = opt.spec || opt;
  if (spec.onto.by === 'duo' || spec.onto.by === 'combo') {
    if (tgts.length === 1) return spec.onto.by === 'combo' && ontoOne(spec, shifter, tgts[0]);
    if (tgts.length !== 2 || !tgts.every((t) => t.type === 'character')) return false;
    const parts = partNames(shifter);
    const [a, b] = tgts.map((t) => (anyNameOk(t) ? new Set(parts) : shiftNames(t)));
    return parts.some((n1) => a.has(n1) && parts.some((n2) => n2 !== n1 && b.has(n2)));
  }
  return tgts.length === 1 && ontoOne(spec, shifter, tgts[0]);
}
// Could this card be one of the cards it shifts onto? (what to highlight while picking)
export function shiftTargetOk(opt, shifter, tgt) {
  if (typeof opt === 'string') opt = shiftOptions(shifter).find((o) => o.kind === opt) || shiftOptions(shifter)[0];
  return !!opt && ontoOne(opt.spec || opt, shifter, tgt);
}
// How many cards it goes on top of: [min, max]
export const shiftOntoCount = (opt) => ({ duo: [2, 2], combo: [1, 2] }[(opt.spec || opt).onto.by] || [1, 1]);
// Can these hand cards pay a "discard" Shift cost?
export const shiftDiscardOk = (opt, defs) => {
  const c = (opt.spec || opt).cost;
  return c.discard == null ? defs.length === 0 : defs.length === c.discard && defs.every((d) => !c.type || d.type === c.type || (c.type === 'action' && d.type === 'song'));
};

// Parse the cost of an activated ability, e.g. "{exert}, 2 {ink} - Draw a card."
// Returns { exert, ink, effect } or null if it doesn't look like an activated ability.
export function parseActivatedCost(text) {
  const t = String(text || '').trim();
  const m = t.match(/^((?:\{(?:exert|E)\}|\d+\s*\{(?:ink|I)\}|[,\s])+)\s*[-—–]\s*([\s\S]+)$/);
  if (!m) return null;
  const costPart = m[1];
  const exert = /\{(?:exert|E)\}/.test(costPart);
  const inkM = costPart.match(/(\d+)\s*\{(?:ink|I)\}/);
  const ink = inkM ? Number(inkM[1]) : 0;
  if (!exert && !ink) return null;
  return { exert, ink, effect: m[2].trim() };
}

// Pretty-print dreamborn's ability text tokens.
export function prettyText(text) {
  return String(text || '')
    .replace(/\{(?:exert|E)\}/g, '⟳')
    .replace(/\{(?:ink|I|inkk)\}/g, '⬡')
    .replace(/\{(?:strength|S)\}/g, '⚔️')
    .replace(/\{(?:willpower|W|toughness)\}/g, '🛡️')
    .replace(/\{(?:lore|L)\}/g, '◆')
    .replace(/\{inkwell\}|\{inkable\}/g, '⬡')
    .replace(/\{([A-Za-z][^}]*)\}/g, '$1');
}
