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
  shift: 'Shift N — You may pay N ink to play this on top of one of your characters with the same name. (8.10)',
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
  universalShift: 'Universal Shift', singer: 'Singer', singTogether: 'Sing Together', support: 'Support',
  vanish: 'Vanish', ward: 'Ward',
  cantQuest: "Can't quest", cantChallenge: "Can't challenge", cantReady: "Can't ready", cantBeChallenged: "Can't be challenged",
  cantSing: "Can't sing", challengeReady: 'Can challenge ready characters',
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
export const effStr = (card, def) => (def.str ?? 0) + modSum(card, 'str');
export const effWp = (card, def) => (def.wp ?? 0) + modSum(card, 'wp');
export const effLore = (card, def) => (def.lore ?? 0) + modSum(card, 'lore');

// Keyword value including manual grants ("gains Evasive this turn" → kw mod +1).
export function kwVal(card, def, k) {
  const base = def?.kw?.[k];
  let v = typeof base === 'number' ? base : (base ? 1 : 0);
  for (const m of card?.mods || []) if (m.stat === 'kw' && m.kw === k) v += m.delta;
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

export function questBlocker(card, def) {
  if (def.type !== 'character') return 'Only characters can quest.';
  if (card.exerted) return 'Already exerted.';
  if (card.drying) return 'Still drying — characters can quest the turn after they\'re played.';
  if (hasKw(card, def, 'reckless')) return 'Reckless characters can\'t quest.';
  if (hasKw(card, def, 'cantQuest')) return 'An ability says this character can\'t quest.';
  return null;
}

export function attackerBlocker(card, def) {
  if (def.type !== 'character') return 'Only characters can challenge.';
  if (card.exerted) return 'Already exerted.';
  if (card.drying && !hasKw(card, def, 'rush')) return 'Still drying — only characters with Rush can challenge the turn they\'re played.';
  if (hasKw(card, def, 'cantChallenge')) return 'An ability says this character can\'t challenge.';
  return null;
}

function evasiveBlocks(att, attDef, tgt, tgtDef) {
  return hasKw(tgt, tgtDef, 'evasive') && !hasKw(att, attDef, 'evasive') && !hasKw(att, attDef, 'alert');
}

// `defenderSide` = [{ card, def }] for every card the defending player has in play.
export function defenderBlocker(att, attDef, tgt, tgtDef, defenderSide) {
  if (tgtDef.type === 'location') return null;                                 // 4.6.8 — locations can always be challenged
  if (tgtDef.type !== 'character') return 'You can only challenge characters and locations.';
  if (hasKw(tgt, tgtDef, 'cantBeChallenged')) return 'An ability says this character can\'t be challenged.';
  if (!tgt.exerted && !hasKw(att, attDef, 'challengeReady')) return 'Only exerted characters can be challenged.';       // 4.6.4.2
  if (evasiveBlocks(att, attDef, tgt, tgtDef)) return 'Evasive — only characters with Evasive (or Alert) can challenge it.';
  if (!hasKw(tgt, tgtDef, 'bodyguard')) {
    const guard = defenderSide.find(({ card, def }) => def.type === 'character' && card.exerted
      && hasKw(card, def, 'bodyguard') && !evasiveBlocks(att, attDef, card, def));
    if (guard) return `Bodyguard — you must challenge ${cardLabel(guard.def)} first.`;
  }
  return null;
}

// Challenge damage (4.6.6 + Challenger 8.5 + Resist 8.8). Negative strength deals 0.
export function challengeDamage(att, attDef, tgt, tgtDef) {
  const atk = Math.max(0, effStr(att, attDef) + kwVal(att, attDef, 'challenger'));
  const toDefender = Math.max(0, atk - kwVal(tgt, tgtDef, 'resist'));
  const back = tgtDef.type === 'character' ? Math.max(0, effStr(tgt, tgtDef)) : 0;  // locations deal no damage
  const toAttacker = Math.max(0, back - kwVal(att, attDef, 'resist'));
  return { toDefender, toAttacker };
}

export function singerBlocker(card, def, songDef) {
  if (def.type !== 'character') return 'Only characters can sing.';
  if (card.exerted) return 'Already exerted.';
  if (card.drying) return 'Still drying.';
  if (hasKw(card, def, 'cantSing')) return 'An ability says this character can\'t sing.';
  if (songDef && singValue(card, def) < songDef.cost) return `Needs cost ${songDef.cost}+ to sing this song.`;
  return null;
}

// Which shift variants does this card have, and what do they cost?
export function shiftOptions(def) {
  const out = [];
  if (def.kw?.shift != null) out.push({ kind: 'shift', cost: def.kw.shift });
  if (def.kw?.puppyShift != null) out.push({ kind: 'puppyShift', cost: def.kw.puppyShift });
  if (def.kw?.universalShift != null) out.push({ kind: 'universalShift', cost: def.kw.universalShift });
  return out;
}

export function shiftTargetOk(kind, shifterDef, tgtDef) {
  if (tgtDef.type !== 'character') return false;
  if (kind === 'universalShift') return true;
  if (kind === 'puppyShift') return (tgtDef.classes || []).includes('puppy');
  return sharesName(shifterDef, tgtDef);
}

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
