// Deck Lab brain: builds and improves a deck the way a person does, out loud (Adam's write-up of how he built
// "AS - Zero To Hero"): read what the seed cards want, look for enablers and payoffs (high lore, cares about low
// costs, plays cards for free, names another character), follow the chains those open, add cheap Bodyguards, a
// fallback plan, removal and draw, and when the list is all one colour with slots left, see what each second ink
// offers. Then, from simulated games, find the card that "does nothing" and propose swaps.
//
// Pure and deterministic: no I/O, no randomness, no clock. Everything takes the card index from game/cards.js.
//
//   readSeed(index, { cards, deck, inks, format })            → { core, inks, idea, thoughts, format, base? }
//   findSynergies(index, core, { inks, exclude, format })     → [{ id, full, score, role, reasons }] best first
//   assemble(index, { core, inks, synergies, locks, base })   → { name, cards: [[id, qty]], thoughts }
//   cardImpact(records, defs)                                  → [{ id, full, drawn, played, inked, stuck, … dead, note }]
//   proposeSwaps(index, cards, { impact, report, synergies, inks, locks, tried, max }) → [{ out, in, why, kind }]
//
// A thought is { text, cards?: [id] }: one or two plain sentences naming cards by their full name.
import { isFullyAutomated, resolveDeck, nameKey, INK_ORDER } from '../cards.js';
import { cardRoles } from '../procs/roles.js';
import { DECK } from '../rulebook/deck.js';

const SIZE = DECK.minSize.base;                 // 60
const MAX_INKS = DECK.maxInks.base;             // 2
const NON_CANON = new Set(['enchanted', 'iconic', 'epic', 'promo']);
const FORMATS = { core: '2', infinity: '1' };
const FORMAT_NAME = { 2: 'Core', 1: 'Infinity' };
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const r1 = (x) => Math.round(x * 10) / 10;
const pct = (x) => Math.round(x * 100);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const inkList = (inks) => inks.map(cap).join('/');
const listNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const byInkOrder = (a, b) => INK_ORDER.indexOf(a) - INK_ORDER.indexOf(b);

// ---------- per-index caches (the index is loaded once and never changes) ----------

const CACHE = new WeakMap();
function cacheOf(index) {
  let c = CACHE.get(index);
  if (!c) {
    // formats a full name is legal in: any printing counts
    const formats = new Map();
    for (const d of index.byId.values()) {
      const k = nameKey(d.full);
      const s = formats.get(k) || formats.set(k, new Set()).get(k);
      for (const f of d.formats || []) s.add(String(f));
    }
    c = { formats, pools: new Map() };
    CACHE.set(index, c);
  }
  return c;
}
const legalIn = (index, d, fmt) => !fmt || cacheOf(index).formats.get(nameKey(d.full))?.has(String(fmt));

// candidate cards for a format: one standard printing per full name, fully run by the engine, legal
function poolOf(index, fmt) {
  const c = cacheOf(index);
  let p = c.pools.get(fmt);
  if (!p) {
    p = [...index.byFull.values()].filter((d) => !NON_CANON.has(d.rarity) && d.inks?.length && isFullyAutomated(d) && legalIn(index, d, fmt))
      .sort((a, b) => a.full.localeCompare(b.full));
    c.pools.set(fmt, p);
  }
  return p;
}

function normFormat(f) {
  if (f == null || f === '') return null;
  const s = String(f).toLowerCase();
  return FORMATS[s] || (s === '1' || s === '2' ? s : null);
}
// Core when every seed card is legal there, else Infinity (Core is the smaller pool)
function pickFormat(index, defs, wanted) {
  const f = normFormat(wanted);
  if (f) return f;
  return defs.every((d) => legalIn(index, d, '2')) ? '2' : '1';
}

function maxCopies(d) {
  const r = (d.procs || []).find((p) => p.kind === 'static' && p.effect?.fn === 'deck' && 'copies' in p.effect);
  return r ? Math.min(SIZE, r.effect.copies ?? SIZE) : DECK.maxCopies.base;
}

// ---------- reading a card ----------

const FEAT = new WeakMap();
function walk(x, fn) {
  if (Array.isArray(x)) { for (const y of x) walk(y, fn); return; }
  if (!x || typeof x !== 'object') return;
  fn(x);
  for (const v of Object.values(x)) walk(v, fn);
}
const NAME_WORD = "[A-Z][\\w'’.-]*";
const NAMED_RX = new RegExp(`\\bnamed (${NAME_WORD}(?: ${NAME_WORD})*(?: (?:or|and) ${NAME_WORD}(?: ${NAME_WORD})*)*)`, 'g');

// what a card is and does, read off its structured fields, compiled procs and ability text (reminder text dropped)
export function features(d) {
  let f = FEAT.get(d);
  if (f) return f;
  const text = (d.abilities || []).map((a) => a.text).join(' \n ').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const char = d.type === 'character';
  const { roles, cares } = cardRoles(d);
  const names = [];
  for (const m of text.matchAll(NAMED_RX)) {
    for (const n of m[1].split(/ (?:or|and) /)) if (nameKey(n) !== nameKey(d.name) && !names.includes(n)) names.push(n);
  }
  let playsFree = 0;
  for (const p of d.procs || []) walk(p.do, (st) => {
    if (st.fn !== 'playFree') return;
    const c = st.filter?.with?.find?.((w) => w.cost?.lte != null || w.cost?.eq != null)?.cost;
    playsFree = Math.max(playsFree, c?.lte ?? c?.eq ?? 9);
  });
  if (!playsFree) { const m = text.match(/\bplay an? (?:\w+ )?character with cost (\d+) or less for free/i); if (m) playsFree = +m[1]; }
  const low = text.match(/\bcharacters? with cost (\d+) or less\b/i);
  const needs = text.match(/can't play this character unless you have (\d+) or more (?:other )?characters in play/i);
  const wide = /count the number of characters you have in play|for each (?:other )?(?:\w+ )?characters? you have in play|(?:while|if) you have (\d+) or more (?:other )?characters in play/i.test(text) || !!needs;
  const costCheat = roles.includes('ramp') && /less\b/i.test(text) && /\bcharacters? you have in play\b/i.test(text);
  const selfFree = /\bplay this character for free\b/i.test(text);
  const shiftOnto = (d.shifts || []).find((s) => s.onto?.by === 'name') ? d.name : null;
  // removal that only hits one classification ("banish chosen Illusion character") doesn't count
  const broad = /\b(?:banish|damage to|return)\s+(?:chosen|all|each|up to \w+|another chosen)\s+(?:(?:opposing|damaged|exerted|other)\s+)*(?:characters?|items?|locations?)\b|\b(?:chosen|each|all) opposing characters?\b/i.test(text);
  const removal = roles.includes('removal') && (broad || !/\bchosen [A-Z][a-z]+ characters?\b/.test(text));
  const cantQuest = /\bthis character can't quest\b/i.test(text);
  const removalHow = /\bbanish\b/i.test(text) ? 'banishes' : /\bdeal \d+ damage|\bdamage\b/i.test(text) ? 'deals damage to' : /\breturn\b[^.]*\bto (?:their|its owner's|your) hand/i.test(text) ? 'bounces' : 'deals with';
  // how much the card brings for its cost (as in game/analysis/autofix.js), capped so 1-drops don't dwarf everything
  const body = char ? ((d.lore || 0) * 2 + ((d.str || 0) + (d.wp || 0)) / 2) / Math.max(1, d.cost) : 0.8;
  const worth = Math.min(4, body) * (cantQuest ? 0.5 : 1) + roles.length * 0.6 + (d.inkable ? 0.4 : 0);
  f = {
    text, char, roles, cares, names, playsFree,
    caresLow: low ? +low[1] : 0,
    lowTrigger: !!low && !playsFree,
    needsN: needs ? +needs[1] : 0,
    wide, costCheat, selfFree, shiftOnto, removal, removalHow,
    draw: roles.includes('draw'),
    ramp: roles.includes('ramp'),
    song: d.type === 'song' || (d.classes || []).includes('song'),
    singer: d.kw?.singer || 0,
    bodyguard: !!d.kw?.bodyguard,
    cheap: char && d.cost <= 2,
    lore: cantQuest ? 0 : d.lore || 0,
    cantQuest,
    worth,
  };
  FEAT.set(d, f);
  return f;
}

// "Pudge - Controls the Weather is free to play if I have a character named Lilo in play" — what a card wants
function describe(d) {
  const f = features(d);
  const out = [];
  if (f.song && f.costCheat) out.push(`is a song that makes my next character cheaper for every character I have in play, so it wants a wide board, and any character costing ${d.cost} or more can sing it for free`);
  else if (f.song) out.push(`is a song any character costing ${d.cost} or more can sing for free`);
  else if (f.costCheat) out.push('makes my next character cheaper for every character I have in play');
  if (f.needsN) out.push(`quests for ${f.lore} lore but needs ${f.needsN} characters in play before I can play it`);
  if (f.playsFree) out.push(`plays a character costing ${f.playsFree} or less for free, so it puts two bodies on the board for one card`);
  if (f.lowTrigger) out.push(`rewards me every time I play a character costing ${f.caresLow} or less${f.draw ? ' by drawing a card' : ''}`);
  if (f.selfFree && f.names.length) out.push(`is free to play if I have a character named ${f.names[0]} in play`);
  else if (f.selfFree) out.push('can be played for free');
  else if (f.names.length) out.push(`wants a character named ${listNames(f.names)} in play`);
  if (f.shiftOnto && !f.lowTrigger) out.push(`can shift onto a ${f.shiftOnto}`);
  else if (f.shiftOnto) out.push(`shifts onto a ${f.shiftOnto}`);
  if (f.wide && !f.needsN && !f.costCheat) out.push('gets better the more characters I have in play');
  if (f.lore >= 3 && !f.needsN) out.push(`quests for ${f.lore} lore`);
  if (f.singer) out.push(`sings songs as if it cost ${f.singer}`);
  if (f.bodyguard) out.push('is a Bodyguard that protects my cheaper characters');
  if (f.removal && out.length < 2) out.push(`${f.removalHow} the opponent's characters`);
  if (f.draw && !f.lowTrigger && out.length < 2) out.push('draws cards');
  if (f.ramp && !f.costCheat && out.length < 2) out.push('ramps my ink');
  if (!out.length && f.char) out.push(`is a ${d.cost}-cost character that quests for ${f.lore}`);
  if (!out.length) out.push(`is a ${d.cost}-cost ${d.type}`);
  return out.slice(0, 2);
}
const sayCard = (d) => ({ text: `${d.full} ${describe(d).join(', and it ')}.`, cards: [d.id] });

// ---------- the seed ----------

function defsOfIds(index, ids) {
  const out = [], seen = new Set(), missing = [];
  for (const id of ids || []) {
    const d = index.byId.get(String(id)) || index.byFull.get(nameKey(id));
    if (!d) { missing.push(String(id)); continue; }
    if (seen.has(nameKey(d.full))) continue;
    seen.add(nameKey(d.full));
    out.push(d);
  }
  return { defs: out, missing };
}

// the two inks most of these cards share (dual-ink cards count for both)
function inferInks(defs) {
  const n = new Map();
  for (const d of defs) for (const i of d.inks || []) n.set(i, (n.get(i) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || byInkOrder(a[0], b[0])).slice(0, MAX_INKS).map(([i]) => i).sort(byInkOrder);
}

const BASES = new WeakMap();   // core array → the deck it was read from, so assemble() keeps that list

export function readSeed(index, { cards = [], deck = null, inks = null, format = null } = {}) {
  const thoughts = [];
  let base = null;
  let ids = cards || [];
  if (deck?.cards?.length) {
    const counts = deck.cards.filter((p) => Array.isArray(p) && index.byId.has(String(p[0])) && p[1] > 0).map(([id, n]) => [String(id), Math.floor(n)]);
    base = counts;
    // the deck's core: what it runs the most of, the expensive cards first (they're usually the payoffs)
    const ranked = counts.map(([id, n]) => ({ d: index.byId.get(id), n })).sort((a, b) => b.n - a.n || b.d.cost - a.d.cost || a.d.full.localeCompare(b.d.full));
    ids = [...(cards || []), ...ranked.filter((x) => x.n >= 3).slice(0, 8).map((x) => x.d.id)];
    if (!ids.length) ids = ranked.slice(0, 6).map((x) => x.d.id);
    const size = counts.reduce((s, [, n]) => s + n, 0);
    thoughts.push({ text: `Starting from your deck ${deck.name ? `"${deck.name}"` : ''} (${size} cards). I'll read what its main cards want, then look for better cards around them.`.replace('  ', ' ') });
  }
  const { defs: seedDefs, missing } = defsOfIds(index, ids);
  if (missing.length) thoughts.push({ text: `I couldn't find ${missing.length === 1 ? 'one of the seed cards' : `${missing.length} of the seed cards`}, so I'm leaving ${missing.length === 1 ? 'it' : 'them'} out.` });

  // inks: the player's choice, else what the seed shares
  let chosen = (Array.isArray(inks) ? inks : []).map((i) => String(i).toLowerCase()).filter((i) => INK_ORDER.includes(i));
  chosen = [...new Set(chosen)].sort(byInkOrder).slice(0, MAX_INKS);
  const asked = chosen.length > 0;
  if (!asked) chosen = inferInks(seedDefs);
  // one ink picked: a seed card of another ink brings the second ink along
  if (asked && chosen.length === 1) {
    const second = inferInks(seedDefs.map((d) => ({ inks: d.inks.filter((i) => i !== chosen[0]) })));
    if (second[0]) chosen = [chosen[0], second[0]].sort(byInkOrder);
  }
  const out = seedDefs.filter((d) => !d.inks.every((i) => chosen.includes(i)));
  if (out.length) thoughts.push({ text: `A deck can only use ${MAX_INKS} inks, so I'm going ${inkList(chosen)} and leaving out ${listNames(out.map((d) => d.full))}.`, cards: out.map((d) => d.id) });
  const core = seedDefs.filter((d) => !out.includes(d));

  const fmt = pickFormat(index, core, format);
  if (!normFormat(format) && fmt === '1') {
    const old = core.filter((d) => !legalIn(index, d, '2'));
    if (old.length) thoughts.push({ text: `${listNames(old.map((d) => d.full))} ${old.length === 1 ? "isn't" : "aren't"} legal in Core any more, so I'm building for Infinity.`, cards: old.map((d) => d.id) });
  }
  const manual = core.filter((d) => !isFullyAutomated(d));
  if (manual.length) thoughts.push({ text: `The bots can't run all the text on ${listNames(manual.map((d) => d.full))}, so the games will undersell ${manual.length === 1 ? 'it' : 'them'}.`, cards: manual.map((d) => d.id) });

  if (!base) for (const d of core) thoughts.push(sayCard(d));
  const idea = ideaOf(core, chosen);
  thoughts.push({ text: `The idea: ${idea}` });
  if (chosen.length === 1) thoughts.push({ text: `Everything here is ${cap(chosen[0])}. I'll fill out the ${cap(chosen[0])} part first and then see what a second ink can offer.` });

  const coreIds = core.map((d) => d.id);
  if (base) BASES.set(coreIds, base);
  const res = { core: coreIds, inks: chosen, idea, thoughts, format: FORMAT_NAME[fmt].toLowerCase() };
  if (base) res.base = base;
  return res;
}

function ideaOf(core, inks) {
  if (!core.length) return `a solid ${inkList(inks) || 'two-ink'} curve of efficient characters, removal and card draw.`;
  const F = core.map((d) => [d, features(d)]);
  const enablers = F.filter(([, f]) => f.playsFree || f.selfFree || (f.cheap && !f.needsN)).map(([d]) => d.full);
  const payoffs = F.filter(([, f]) => f.needsN || f.wide || f.lowTrigger || f.costCheat || f.lore >= 3).map(([d]) => d.full);
  const named = F.flatMap(([d, f]) => f.names.map((n) => [n, d]));
  const wide = F.some(([, f]) => f.wide || f.playsFree || f.lowTrigger || f.costCheat);
  const parts = [];
  if (wide) {
    let s = 'flood the board with cheap characters';
    const en = enablers.filter((n) => !payoffs.includes(n));
    if (en.length) s += `, using ${listNames(en.slice(0, 3))} to get extra bodies down cheaply`;
    if (payoffs.length) s += `, then cash the board in with ${listNames(payoffs.slice(0, 3))}`;
    parts.push(s + '.');
  } else if (payoffs.length) {
    parts.push(`quest hard with ${listNames(payoffs.slice(0, 3))} and protect them long enough to win the race.`);
  } else if (F.some(([, f]) => f.removal)) {
    parts.push(`control the board with ${listNames(F.filter(([, f]) => f.removal).map(([d]) => d.full).slice(0, 3))} and win with whatever survives.`);
  } else {
    parts.push(`build around ${listNames(core.map((d) => d.full).slice(0, 3))}.`);
  }
  for (const [n, d] of named.slice(0, 2)) parts.push(`Keep a character named ${n} around for ${d.full}.`);
  const songs = F.filter(([, f]) => f.song).map(([d]) => d.full);
  if (songs.length && !wide) parts.push(`Sing ${listNames(songs)} for free.`);
  return parts.join(' ').replace(/^./, (c) => c.toUpperCase());
}

// ---------- enablers and payoffs ----------

function coreContext(defs) {
  const ctx = { defs, names: new Map(), shiftNames: new Map(), coreNames: new Map(), caresLow: 0, caresLowBy: null, wide: false, wideBy: null,
    costCheat: null, playsFree: null, cheap: 0, songs: [], singer: 0, cares: new Map(), needsN: 0 };
  for (const d of defs) {
    const f = features(d);
    ctx.coreNames.set(nameKey(d.name), d);
    for (const n of f.names) {
      const k = nameKey(n), prev = ctx.names.get(k);
      const strong = f.selfFree || f.playsFree > 0 || f.lore >= 2;
      if (!prev || (strong && !prev.strong)) ctx.names.set(k, { by: d, strong, freeIf: f.selfFree });
    }
    if (f.shiftOnto) ctx.shiftNames.set(nameKey(f.shiftOnto), d);
    if (f.caresLow > ctx.caresLow) { ctx.caresLow = f.caresLow; ctx.caresLowBy = d; }
    if (f.wide || f.costCheat || f.playsFree || f.lowTrigger) { ctx.wide = true; ctx.wideBy ||= d; }
    if (f.costCheat) ctx.costCheat ||= d;
    if (f.playsFree) ctx.playsFree ||= d;
    if (f.needsN) ctx.needsN = Math.max(ctx.needsN, f.needsN);
    if (f.cheap) ctx.cheap++;
    if (f.song) ctx.songs.push(d);
    if (f.singer) ctx.singer = Math.max(ctx.singer, f.singer);
    for (const c of f.cares) if (!ctx.cares.has(c)) ctx.cares.set(c, d);
  }
  return ctx;
}

function scoreCard(c, ctx) {
  const f = features(c);
  const add = [];
  const push = (role, pts, reason) => add.push({ role, pts, reason });
  const k = nameKey(c.name);
  // chains: a payoff that names a character pulls in cheap versions of that character
  const named = ctx.names.get(k);
  if (named && f.char) {
    push('chain', (named.strong ? 6 : 2.5) + (c.cost <= 2 ? (named.strong ? 1.5 : 0.5) : 0) + Math.min(2, f.lore) * 0.5,
      `${named.by.full} ${named.freeIf ? 'is free' : 'gets better'} with a character named ${c.name} in play${c.cost <= 2 ? `, and this one only costs ${c.cost}${f.lore >= 2 ? ` and quests for ${f.lore}` : ''}` : ''}.`);
  }
  const shifter = ctx.shiftNames.get(k);
  if (shifter && f.char && c.cost < shifter.cost && !ctx.coreNames.has(nameKey(c.full))) {
    push('chain', 1 + (f.text ? 0.5 : 0) + (f.lore >= 2 ? 0.5 : 0), `A cheaper ${c.name} to shift ${shifter.full} onto${f.text ? '' : ', though it does little on its own'}.`);
  }
  for (const n of f.names) {
    const coreCard = ctx.coreNames.get(nameKey(n));
    if (coreCard) push('payoff', 3 + (f.selfFree ? 1.5 : 0), `It wants a character named ${n} in play, and ${coreCard.full} is in the core.`);
  }
  // low costs and going wide
  if (ctx.caresLow && f.char && c.cost <= ctx.caresLow) {
    push('enabler', 1.5 + Math.min(2, f.worth * 0.4), `${ctx.caresLowBy.full} cares about characters costing ${ctx.caresLow} or less, and this is a ${c.cost}-cost character${f.lore >= 2 ? ` that quests for ${f.lore}` : ''}.`);
  } else if (ctx.wide && f.cheap) {
    push('enabler', 1 + Math.min(2, f.worth * 0.3), `A cheap body to help ${ctx.wideBy.full} go wide.`);
  }
  if (f.selfFree && ctx.wide) push('enabler', 2, 'It can come down for free, which is an extra body at no cost.');
  if (f.playsFree && (ctx.wide || ctx.cheap >= 2)) push('enabler', 4 + Math.min(1, f.lore * 0.3), `It plays a character costing ${f.playsFree} or less for free: two bodies for one card.`);
  if (f.lowTrigger && (ctx.cheap >= 2 || ctx.wide)) push('payoff', 3.5 + (f.draw ? 0.5 : 0), `It pays me off for playing characters costing ${f.caresLow} or less${f.draw ? ' by drawing cards' : ''}, which this deck does all the time.`);
  if ((f.wide || f.needsN || f.costCheat) && (ctx.wide || ctx.cheap >= 2)) {
    push('payoff', 3.5 + (f.lore >= 3 ? 1 : 0), f.needsN ? `It quests for ${f.lore} lore once I have ${f.needsN} characters in play, and this deck gets there.` : f.costCheat ? 'It makes my next character cheaper for each character I have in play.' : 'It gets better with every character I have in play.');
  }
  if (f.char && f.lore >= 3 && !f.needsN && (ctx.wide || ctx.costCheat)) {
    push('payoff', 1 + f.lore * 0.6 + (ctx.costCheat && c.cost >= 5 ? 1.5 : 0),
      ctx.costCheat && c.cost >= 5 ? `It quests for ${f.lore} lore, and ${ctx.costCheat.full} can get it down early.` : `High lore: it quests for ${f.lore}.`);
  }
  // songs and singers
  if (ctx.songs.length && f.singer) push('enabler', 1.5, `It sings ${ctx.songs[0].full} as if it cost ${f.singer}.`);
  if (ctx.singer && f.song && c.cost <= ctx.singer) push('payoff', 2, `My singers can sing it for free (cost ${c.cost}).`);
  // classifications the core pays off
  for (const cl of c.classes || []) {
    const by = ctx.cares.get(cl.toLowerCase());
    if (by && f.char && by.id !== c.id) { push('payoff', 2.5, `${by.full} cares about ${cap(cl)} characters.`); break; }
  }
  for (const cl of f.cares) {
    const n = ctx.defs.filter((d) => (d.classes || []).map((x) => x.toLowerCase()).includes(cl)).length;
    if (n >= 2) { push('payoff', 2, `It pays off ${cap(cl)} characters, and the core has ${n}.`); break; }
  }
  // defence, removal, draw, a fallback plan
  if (f.bodyguard && f.char && c.cost <= 3 && (ctx.cheap >= 1 || ctx.wide)) push('defense', 2.5 + (c.cost === 2 ? 1 : 0) + Math.min(1, f.lore * 0.3), `A ${c.cost}-cost Bodyguard to defend my cheap characters.`);
  if (f.removal && c.cost <= 5) push('removal', 2.2 + (c.cost <= 3 ? 0.5 : 0), `Removal: it ${f.removalHow} the opponent's characters.`);
  if (f.draw && !f.lowTrigger) push('draw', 1.6 + (c.cost <= 3 ? 0.3 : 0), 'Card draw, so the deck doesn\'t run out of gas.');
  if (f.char && c.cost <= 3 && f.worth >= 2.6) push('fallback', 0.6 + f.worth * 0.4, `A solid ${c.cost}-cost character for a more straightforward board-flood plan.`);
  if (!add.length) return null;
  add.sort((a, b) => b.pts - a.pts);
  // the main reason counts in full, the others half: a card that does one thing well beats one that ticks boxes
  const score = add[0].pts + add.slice(1).reduce((s, x) => s + x.pts, 0) * 0.5 + f.worth * 0.5 + (c.inkable ? 0.3 : 0);
  return { role: add[0].role, score, reasons: add.map((x) => x.reason) };
}

export function findSynergies(index, core, { inks = null, exclude = [], format = null, limit = 80 } = {}) {
  const { defs } = defsOfIds(index, core);
  const fmt = pickFormat(index, defs, format);
  const chosen = (inks?.length ? inks : inferInks(defs)).map((i) => String(i).toLowerCase());
  const skip = new Set([...defs, ...defsOfIds(index, exclude).defs].map((d) => nameKey(d.full)));
  const ctx = coreContext(defs);
  // one ink chosen: also look at every second ink (assemble picks the one with the most support)
  const fits = (d) => (chosen.length >= MAX_INKS ? d.inks.every((i) => chosen.includes(i))
    : chosen.length === 1 ? d.inks.length <= 2 && (d.inks.includes(chosen[0]) || d.inks.length === 1) : true);
  const out = [];
  for (const c of poolOf(index, fmt)) {
    if (skip.has(nameKey(c.full)) || !fits(c)) continue;
    const s = scoreCard(c, ctx);
    if (!s) continue;
    const off = chosen.length === 1 && !c.inks.includes(chosen[0]);
    out.push({ id: c.id, full: c.full, score: r1(s.score * (off ? 0.9 : 1)), role: s.role, reasons: s.reasons, inks: c.inks });
  }
  out.sort((a, b) => b.score - a.score || a.full.localeCompare(b.full));
  // the best overall, plus the best few of each kind so removal, draw and Bodyguards are always on the table
  const keep = new Set(out.slice(0, limit));
  const kinds = { removal: (d) => features(d).removal, draw: (d) => features(d).draw, defense: (d) => features(d).bodyguard };
  for (const f of Object.values(kinds)) {
    for (const ink of INK_ORDER) for (const s of out.filter((x) => x.inks.includes(ink) && f(index.byId.get(x.id))).slice(0, 6)) keep.add(s);
  }
  for (const role of ['enabler', 'payoff', 'chain', 'fallback']) for (const s of out.filter((x) => x.role === role).slice(0, 6)) keep.add(s);
  return out.filter((s) => keep.has(s));
}

// ---------- building the list ----------

function makeList() {
  const m = new Map();   // nameKey(full) → { d, n, core }
  const L = {
    m,
    total: () => [...m.values()].reduce((s, x) => s + x.n, 0),
    has: (d) => m.has(nameKey(d.full)),
    n: (d) => m.get(nameKey(d.full))?.n || 0,
    count: (f) => [...m.values()].reduce((s, x) => s + (f(x.d) ? x.n : 0), 0),
    // add up to n copies (fewer if the curve or the inkwell can't take them); returns how many went in
    add(d, n, { force = false } = {}) {
      const room = Math.min(SIZE - L.total(), maxCopies(d) - L.n(d));
      let k = Math.min(n, room);
      if (!force) {
        if (d.cost >= 6) k = Math.min(k, 12 - L.count((x) => x.cost >= 6));
        if (d.cost >= 5) k = Math.min(k, 18 - L.count((x) => x.cost >= 5));
        if (!d.inkable) k = Math.min(k, Math.floor(SIZE * 0.3) - L.count((x) => !x.inkable));
      }
      if (k <= 0) return 0;
      const e = m.get(nameKey(d.full)) || { d, n: 0, core: force };
      e.n += k;
      m.set(nameKey(d.full), e);
      return k;
    },
    cards: () => [...m.values()].sort((a, b) => a.d.cost - b.d.cost || a.d.full.localeCompare(b.d.full)).map((x) => [x.d.id, x.n]),
  };
  return L;
}

const lockSet = (locks) => new Set((locks || []).map((s) => String(s).toLowerCase()));
const isLocked = (set, d) => set.has(String(d.id).toLowerCase()) || set.has(d.full.toLowerCase());

export function assemble(index, { core = [], inks = null, synergies = null, locks = [], base = null, format = null } = {}) {
  const thoughts = [];
  const say = (text, defs = []) => thoughts.push(defs.length ? { text, cards: defs.map((d) => d.id) } : { text });
  const { defs: coreDefs } = defsOfIds(index, core);
  const lockDefs = defsOfIds(index, locks).defs;
  const fmt = pickFormat(index, [...coreDefs, ...lockDefs], format);
  let deckInks = (inks?.length ? inks.map((i) => String(i).toLowerCase()) : inferInks([...coreDefs, ...lockDefs])).sort(byInkOrder).slice(0, MAX_INKS);
  const syn = (synergies || findSynergies(index, core, { inks: deckInks, format: fmt })).map((s) => ({ ...s, d: index.byId.get(s.id) })).filter((s) => s.d);
  const L = makeList();
  const fitsInks = (d) => d.inks.every((i) => deckInks.includes(i));
  const used = (d) => L.has(d);

  // a saved deck: keep it as it is, legal and at 60
  base ||= BASES.get(core) || null;
  if (base?.length) {
    for (const [id, n] of base) { const d = index.byId.get(String(id)); if (d) L.add(d, n, { force: true }); }
    deckInks = [...new Set([...L.m.values()].flatMap((x) => x.d.inks))].sort(byInkOrder);
    const t = L.total();
    say(`Your list as it stands: ${t} cards in ${inkList(deckInks)}. I'll test it as is first.`);
    if (t < SIZE) fill(L, syn, fitsInks, say, 'It was short of 60, so I topped it up with');
  } else {
    // the core and the locks at full copies
    for (const d of [...coreDefs, ...lockDefs]) L.add(d, maxCopies(d), { force: true });
    if (coreDefs.length) say(`I start with 4 of each core card: ${listNames(coreDefs.map((d) => d.full))}. That's ${L.total()} cards.`, coreDefs);

    // follow the chains: cheap versions of the characters the core names
    const ctx = coreContext(coreDefs);
    const chains = syn.filter((s) => s.role === 'chain' && s.d.cost <= 2 && ctx.names.get(nameKey(s.d.name))?.strong && fitsInks(s.d) && !used(s.d)).slice(0, 4);
    const chainIn = [];
    for (const s of chains) if (L.add(s.d, 4)) chainIn.push(s);
    if (chainIn.length) {
      const by = new Map();
      for (const s of chainIn) { const k = s.reasons[0].split(' is free')[0].split(' gets better')[0]; by.set(k, [...(by.get(k) || []), s.d]); }
      for (const [who, ds] of by) {
        const cheap = ds.every((d) => d.cost <= 2);
        say(`${who} leads directly to ${listNames(ds.map((d) => d.full))}${cheap ? `, which are cheap ${ds[0].name}s that can give good lore` : ''}.`, ds);
      }
    }

    // enablers and payoffs: what cares about low costs, plays cards for free, has high lore
    const mono = deckInks.length === 1;
    const stopAt = mono ? 44 : 40;
    const picked = [];
    for (const s of syn) {
      if (L.total() >= stopAt) break;
      if (!['enabler', 'payoff'].includes(s.role) || s.score < 4 || used(s.d) || !fitsInks(s.d)) continue;
      if (L.add(s.d, 4)) picked.push(s);
    }
    if (picked.length) {
      const pay = picked.filter((s) => s.role === 'payoff'), en = picked.filter((s) => s.role !== 'payoff');
      if (pay.length) say(`Looking for payoffs (high lore, cares about low costs), I found ${listNames(pay.map((s) => s.d.full))}. ${pay[0].reasons[0]}`, pay.map((s) => s.d));
      if (en.length) say(`For enablers (cheap characters, cards that play others for free) I'm adding ${listNames(en.map((s) => s.d.full))}. ${en[0].reasons[0]}`, en.map((s) => s.d));
    }

    // defence: good cheap Bodyguards for the fragile early drops
    const oneDrops = L.count((d) => d.type === 'character' && d.cost <= 2);
    if (oneDrops >= 8) {
      const bg = syn.filter((s) => features(s.d).bodyguard && s.d.cost <= 3 && !used(s.d) && fitsInks(s.d)).slice(0, 2);
      const inBg = bg.filter((s) => L.add(s.d, 4));
      if (inBg.length) say(`I have ${oneDrops} characters costing 2 or less, so I'm adding ${listNames(inBg.map((s) => s.d.full))} as Bodyguards to defend them.`, inBg.map((s) => s.d));
    }

    // a fallback: a more straightforward board flood if the big cards don't land
    if (L.total() < 52) {
      const fb = syn.filter((s) => s.role === 'fallback' && !used(s.d) && fitsInks(s.d)).slice(0, 1);
      const inFb = fb.filter((s) => L.add(s.d, 4));
      if (inFb.length) say(`${inFb[0].d.full} gives me a more straightforward board-flooding option if I can't land my expensive cards.`, inFb.map((s) => s.d));
    }

    // all one colour with slots left: what does each second ink offer?
    if (deckInks.length === 1 && L.total() < SIZE) {
      const left = SIZE - L.total();
      const options = INK_ORDER.filter((i) => i !== deckInks[0]).map((ink) => {
        const cards = syn.filter((s) => s.d.inks.includes(ink) && s.d.inks.every((i) => i === ink || i === deckInks[0]) && !used(s.d));
        const top = cards.slice(0, Math.ceil(left / 4) + 2);
        const roles = {};
        for (const s of top) roles[s.role] = (roles[s.role] || 0) + s.score;
        const main = Object.entries(roles).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
        return { ink, support: top.reduce((s, x) => s + x.score, 0), main, top };
      }).filter((o) => o.top.length).sort((a, b) => b.support - a.support || byInkOrder(a.ink, b.ink));
      if (options.length) {
        const offer = { defense: 'more Bodyguards', payoff: 'payoffs mostly', enabler: 'more cheap enablers', chain: 'more of the characters my cards name', removal: 'removal', draw: 'card draw', fallback: 'solid cheap characters' };
        const two = options.slice(0, 2);
        const desc = two.map((o) => `${cap(o.ink)} would add ${offer[o.main] || 'support'} (${listNames(o.top.slice(0, 2).map((s) => s.d.full))})`);
        say(`All my cards are ${cap(deckInks[0])} and I have ${left} slots left, so I looked at what other colours could offer. The main options are ${listNames(two.map((o) => cap(o.ink)))}: ${desc.join(', and ')}.`, two.flatMap((o) => o.top.slice(0, 2).map((s) => s.d)));
        deckInks = [deckInks[0], options[0].ink].sort(byInkOrder);
        say(`${cap(options[0].ink)} has the most support, so the deck is ${inkList(deckInks)}.`);
      }
    }

    // removal and draw if the list has little
    const removal = L.count((d) => features(d).removal);
    if (removal < 6) {
      const rm = syn.filter((s) => features(s.d).removal && s.d.cost <= 5 && !used(s.d) && fitsInks(s.d)).slice(0, removal < 2 && SIZE - L.total() >= 12 ? 2 : 1);
      const inRm = rm.filter((s) => L.add(s.d, s === rm[0] ? 4 : 3));
      if (inRm.length) say(`${removal ? `Only ${removal} cards deal` : 'Nothing here deals'} with the opponent's board, so I'm adding ${listNames(inRm.map((s) => s.d.full))} for removal.`, inRm.map((s) => s.d));
    }
    const draw = L.count((d) => features(d).draw);
    if (draw < 4 && L.total() < SIZE) {
      const dr = syn.filter((s) => features(s.d).draw && !used(s.d) && fitsInks(s.d)).slice(0, 1);
      const inDr = dr.filter((s) => L.add(s.d, 3));
      if (inDr.length) say(`With only ${draw} draw cards I'd run out of gas, so ${inDr[0].d.full} goes in.`, inDr.map((s) => s.d));
    }
    if (L.total() < SIZE) fill(L, syn, fitsInks, say, 'To round out the 60 I added the next best fits:');
  }

  // anything still missing: more copies of what's there, then the best cards in these inks
  if (L.total() < SIZE) {
    for (const x of [...L.m.values()].sort((a, b) => a.d.cost - b.d.cost || a.d.full.localeCompare(b.d.full))) L.add(x.d, 4);
  }
  if (L.total() < SIZE) {
    for (const d of poolOf(index, fmt).filter((d) => d.inks.every((i) => deckInks.includes(i)) && !L.has(d)).sort((a, b) => features(b).worth - features(a).worth || a.full.localeCompare(b.full))) {
      if (L.total() >= SIZE) break;
      L.add(d, 4);
    }
  }
  if (L.total() < SIZE) for (const x of L.m.values()) L.add(x.d, 4, { force: true });

  const name = `Lab: ${coreDefs[0]?.name || inkList(deckInks)}${coreDefs[0] ? ` (${inkList(deckInks)})` : ''}`;
  const cards = L.cards();
  const r = resolveDeck(index, { name, cards });
  const curve = [1, 2, 3, 4, 5, 6, 7].map((c) => `${c}${c === 7 ? '+' : ''}: ${r.defs.filter((d) => (c === 7 ? d.cost >= 7 : d.cost === c)).length}`).join(', ');
  say(`That's ${r.size} cards in ${inkList(r.inks)}, ${r.inkable} inkable (${pct(r.inkable / Math.max(1, r.size))}%). Curve ${curve}.`);
  if (!r.legal) say(`Something's off with this list: ${[...r.problems, ...r.errors].join('; ')}.`);
  return { name, cards, thoughts };
}

// the rest of the slots, best score first; partial copies for the last one
function fill(L, syn, fitsInks, say, lead) {
  const added = [];
  for (const s of syn) {
    if (L.total() >= SIZE) break;
    // a slot or two left: more copies of a card already in beats a 1-of
    if (SIZE - L.total() <= 2) {
      const more = syn.find((x) => L.has(x.d) && !L.m.get(nameKey(x.d.full)).core && L.n(x.d) < maxCopies(x.d));
      if (more && L.add(more.d, SIZE - L.total())) continue;
    }
    if (L.has(s.d) || !fitsInks(s.d)) continue;
    if (L.add(s.d, 4)) added.push(s.d);
  }
  if (added.length) say(`${lead} ${listNames(added.map((d) => d.full))}.`, added);
}

// ---------- what does nothing ----------

// records: playGame() recs from the tested seat (they name cards by full name). defs: the deck's defs, e.g.
// resolveDeck(...).defs (duplicates are fine) or a Map of them.
export function cardImpact(records, defs) {
  const recs = (records || []).filter((r) => r && r.turns && r.reason !== 'unfinished');
  const byFull = new Map();
  for (const d of (defs instanceof Map ? [...defs.values()] : defs || [])) if (d?.full && !byFull.has(d.full)) byFull.set(d.full, d);
  const N = recs.length;
  const wins = recs.filter((r) => r.win).length;
  const base = N ? wins / N : 0;
  const S = new Map([...byFull.keys()].map((k) => [k, { played: 0, inked: 0, stuck: 0, drawn: 0, gamesPlayed: 0, winsPlayed: 0 }]));
  for (const r of recs) {
    const per = new Map();
    const bump = (n, key) => { const s = S.get(n); if (!s) return; s[key]++; s.drawn++; per.set(n, true); };
    const playedHere = new Set();
    for (const t of r.turns) {
      for (const n of t.played || []) { bump(n, 'played'); playedHere.add(n); }
      for (const n of t.inked || []) bump(n, 'inked');
    }
    for (const n of r.endHand || []) bump(n, 'stuck');
    for (const n of playedHere) { const s = S.get(n); if (s) { s.gamesPlayed++; if (r.win) s.winsPlayed++; } }
  }
  const out = [];
  for (const [full, s] of S) {
    const d = byFull.get(full);
    const playRate = s.drawn ? Math.min(1, s.played / s.drawn) : 0;
    const winWhenPlayed = s.gamesPlayed ? s.winsPlayed / s.gamesPlayed : null;
    let dead, note;
    if (!s.drawn) {
      dead = 0.25;
      note = `Never drawn in ${N} game${N === 1 ? '' : 's'}, so there's nothing to judge it on yet.`;
    } else {
      const gap = winWhenPlayed != null && s.gamesPlayed >= 3 ? base - winWhenPlayed : 0;
      dead = clamp01((1 - playRate) * 0.6 + (s.stuck / s.drawn) * 0.25 + Math.max(0, gap) * 0.6 - Math.max(0, -gap) * 0.3 + (s.inked / s.drawn) * 0.1);
      if (!s.played) {
        const where = [s.inked ? `inked ${s.inked} time${s.inked === 1 ? '' : 's'}` : '', s.stuck ? `stuck in hand ${s.stuck} time${s.stuck === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
        note = `Drawn ${s.drawn} time${s.drawn === 1 ? '' : 's'} and never played${where ? ` (${where})` : ''}. It really does nothing here.`;
      } else if (s.stuck / s.drawn >= 0.4) {
        note = `Sits in hand: still there at the end ${s.stuck} of the ${s.drawn} times it was drawn.`;
      } else if (gap > 0.15 && s.gamesPlayed >= 3) {
        note = `Played ${s.played} of ${s.drawn} times drawn, but the deck wins only ${pct(winWhenPlayed)}% of games where it's played (${pct(base)}% overall).`;
      } else if (s.inked / s.drawn >= 0.6) {
        note = `Mostly ink: inked ${s.inked} of the ${s.drawn} times it was drawn.`;
      } else {
        note = `Played ${s.played} of ${s.drawn} times drawn${winWhenPlayed != null ? `; ${pct(winWhenPlayed)}% wins when played` : ''}.`;
      }
    }
    out.push({ id: d.id, full, drawn: s.drawn, played: s.played, inked: s.inked, stuck: s.stuck, playRate: r1(playRate * 100) / 100,
      winWhenPlayed: winWhenPlayed == null ? null : Math.round(winWhenPlayed * 100) / 100, dead: Math.round(dead * 100) / 100, note });
  }
  return out.sort((a, b) => b.dead - a.dead || b.drawn - a.drawn || a.full.localeCompare(b.full));
}

// ---------- trying new combos ----------

export const swapKey = (s) => {
  const sw = s?.swap || s;
  if (typeof sw === 'string') return sw;
  const side = (xs) => (xs || []).map(([id, n]) => `${id}:${n}`).sort().join(',');
  return `${side(sw?.out)}>${side(sw?.in)}`;
};

export function proposeSwaps(index, cards, { impact = null, report = null, synergies = null, inks = null, locks = [], tried = [], max = 4, format = null } = {}) {
  const deck = (cards || []).map(([id, n]) => ({ id: String(id), n: Math.floor(n), d: index.byId.get(String(id)) })).filter((x) => x.d && x.n > 0);
  if (!deck.length) return [];
  const before = resolveDeck(index, { cards: deck.map((x) => [x.id, x.n]) });
  const allowed = (inks?.length ? inks.map((i) => String(i).toLowerCase()) : before.inks).slice(0, MAX_INKS);
  const fmt = pickFormat(index, deck.map((x) => x.d), format);
  const locked = lockSet(locks);
  const inDeck = new Map(deck.map((x) => [nameKey(x.d.full), x]));
  const triedKeys = new Set((tried || []).map(swapKey));
  const coreIds = deck.filter((x) => x.n >= 3).map((x) => x.id);
  const syn = (synergies || findSynergies(index, coreIds.length ? coreIds : deck.map((x) => x.id), { inks: allowed, format: fmt, exclude: deck.map((x) => x.id) }))
    .map((s) => ({ ...s, d: index.byId.get(s.id) }))
    .filter((s) => s.d && isFullyAutomated(s.d) && legalIn(index, s.d, fmt) && s.d.inks.every((i) => allowed.includes(i)) && (inDeck.get(nameKey(s.d.full))?.n || 0) < maxCopies(s.d));

  // what to cut: most dead first (sim numbers), else what the report says sits in hand / gets inked, else the weakest fit
  let cuts = [];
  if (impact?.length) {
    cuts = impact.map((c) => ({ c, x: inDeck.get(nameKey(c.full)) || deck.find((x) => x.id === c.id) })).filter(({ x }) => x && !isLocked(locked, x.d))
      .map(({ c, x }) => ({ x, dead: c.dead, why: c.note }));
  } else if (report?.cards?.length) {
    cuts = report.cards.map((c) => ({ c, x: inDeck.get(nameKey(c.name)) })).filter(({ x }) => x && !isLocked(locked, x.d))
      .map(({ c, x }) => ({ x, dead: clamp01((c.inkShare ?? 50) / 150 + (c.stuckPerGame || 0) * 0.4 - (c.playedDelta?.d || 0) / 100), why: `It mostly gets inked (${c.inkShare ?? '?'}% of the time).` }))
      .sort((a, b) => b.dead - a.dead || a.x.d.full.localeCompare(b.x.d.full));
  } else {
    const ctx = coreContext(deck.filter((x) => x.n >= 3).map((x) => x.d));
    cuts = deck.filter((x) => !isLocked(locked, x.d)).map((x) => ({ x, dead: clamp01(1 - (scoreCard(x.d, ctx)?.score || 0) / 12), why: 'It does the least for the plan.' }))
      .sort((a, b) => b.dead - a.dead || a.x.d.full.localeCompare(b.x.d.full));
  }
  cuts = cuts.slice(0, 5);
  if (!cuts.length) return [];

  const has = (f) => deck.reduce((s, x) => s + (f(x.d) ? x.n : 0), 0);
  const removalN = has((d) => features(d).removal);
  const bodyguardN = has((d) => features(d).bodyguard);
  const weak = new Set((report?.weaknesses || []).map((w) => w.kind));
  const pick = (f) => syn.filter((s) => f(s));
  const wants = [];
  if (removalN < 8 || weak.has('removal')) wants.push({ kind: 'removal', list: pick((s) => features(s.d).removal && s.d.cost <= 5), say: 'gives the deck removal instead' });
  wants.push({ kind: 'cut-dead', list: pick((s) => ['chain', 'enabler', 'payoff'].includes(s.role)), say: 'fits the plan better' });
  wants.push({ kind: 'new-combo', list: pick((s) => s.role === 'chain' || (s.role === 'payoff' && !inDeck.has(nameKey(s.d.full)))), say: 'opens a new combo with the cards already here' });
  if (bodyguardN < 8 || weak.has('matchup') || weak.has('removal')) wants.push({ kind: 'defense', list: pick((s) => features(s.d).bodyguard && s.d.cost <= 3), say: 'helps keep my board alive' });
  if (weak.has('curve')) {
    const curve = [1, 2, 3, 4, 5].map((c) => has((d) => d.cost === c));
    const gap = [2, 3, 4, 5].sort((a, b) => curve[a - 1] - curve[b - 1] || a - b)[0];
    wants.push({ kind: 'curve', list: pick((s) => s.d.type === 'character' && s.d.cost === gap), say: `fills the ${gap}-cost slot` });
  }
  if (weak.has('draw')) wants.push({ kind: 'cut-dead', list: pick((s) => features(s.d).draw), say: 'adds card draw' });

  const out = [];
  const seen = new Set();
  const tryOne = (cut, want, add) => {
    if (nameKey(add.d.full) === nameKey(cut.x.d.full) || isLocked(locked, add.d)) return false;
    if (want.kind === 'removal' && features(cut.x.d).removal) return false;
    if (want.kind === 'defense' && features(cut.x.d).bodyguard) return false;
    const have = inDeck.get(nameKey(add.d.full))?.n || 0;
    const room = maxCopies(add.d) - have;
    const n = Math.min(cut.dead >= 0.6 ? cut.x.n : Math.min(2, cut.x.n), room);
    if (n <= 0 || n < Math.min(2, cut.x.n)) return false;
    const swap = { out: [[cut.x.id, n]], in: [[add.id, n]] };
    const key = swapKey(swap);
    if (seen.has(key) || triedKeys.has(key)) return false;
    const next = new Map(deck.map((x) => [x.id, x.n]));
    next.set(cut.x.id, next.get(cut.x.id) - n);
    const addId = inDeck.get(nameKey(add.d.full))?.id || add.id;
    swap.in = [[addId, n]];
    if (triedKeys.has(swapKey(swap))) return false;
    next.set(addId, (next.get(addId) || 0) + n);
    const r = resolveDeck(index, { cards: [...next].filter(([, k]) => k > 0) });
    if (!r.legal || r.size !== before.size || !r.inks.every((i) => allowed.includes(i))) return false;
    seen.add(key);
    const cutWhy = cut.dead >= 0.6 ? `${cut.x.d.full} is my number ${cuts.indexOf(cut) + 1} cut: ${cut.why}` : `${cut.x.d.full} is pulling the least weight. ${cut.why}`;
    const f = features(add.d);
    const reason = want.kind === 'removal' ? `It ${f.removalHow} the opponent's characters.`
      : want.kind === 'defense' ? `It's a ${add.d.cost}-cost Bodyguard.`
      : (add.reasons?.[0] || '');
    out.push({ out: swap.out, in: swap.in, kind: want.kind, why: `${cutWhy} Swapping ${n === cut.x.n ? 'all of them' : n} for ${add.d.full} ${want.say}. ${reason}`.trim() });
    return true;
  };
  // round-robin: idea k starts from the k-th worst card (Adam's number 1 cut goes for removal first), best candidate first
  const top = cuts.slice(0, 3);
  for (let round = 0; round < 3 && out.length < max; round++) {
    wants.forEach((want, w) => {
      for (let j = 0; j < top.length && out.length < max; j++) {
        const cut = top[(w + round + j) % top.length];
        const cands = want.list.filter((s) => !out.some((o) => o.in[0][0] === s.id)).slice(0, 4);
        if (cands.some((s) => tryOne(cut, want, s))) break;
      }
    });
  }
  return out.slice(0, max);
}
