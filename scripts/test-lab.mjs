// Deck Lab brain (game/lab/brain.js) on real card data: reads Adam's Zero To Hero seed and a Bolt seed, finds
// synergies, assembles legal lists, scores card impact from game records and proposes swaps. Prints the narration.
//   node scripts/test-lab.mjs            (add --quiet to skip the narration)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadCardIndex, resolveDeck, isFullyAutomated, nameKey } from '../game/cards.js';
import { readSeed, findSynergies, assemble, cardImpact, proposeSwaps, swapKey } from '../game/lab/brain.js';
import { playGame } from '../game/analysis/playgame.js';
import { buildReport } from '../game/analysis/report.js';

const DB = process.env.CARDS_DB || 'cache/sanitized.db';
if (!existsSync(DB)) { console.error(`no ${DB} — start the server once to download it`); process.exit(1); }
const quiet = process.argv.includes('--quiet');
const index = await loadCardIndex(DB);
const card = (full) => { const d = index.byFull.get(nameKey(full)); assert.ok(d, `card not found: ${full}`); return d; };
const full = (id) => index.byId.get(id)?.full || id;
const say = (...a) => { if (!quiet) console.log(...a); };
const showThoughts = (title, thoughts) => { say(`\n--- ${title}`); for (const t of thoughts) say(`  * ${t.text}`); };
const showList = (cards) => { for (const [id, n] of cards) { const d = index.byId.get(id); say(`  ${n} ${d.full}  (${d.cost} ${d.inks.join('/')}${d.inkable ? '' : ', uninkable'})`); } };
const fmtLegal = (d, f) => [...index.byId.values()].some((x) => x.full === d.full && (x.formats || []).map(String).includes(f));
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok -', name); } catch (e) { console.error('FAIL -', name); throw e; } };

const ZTH = ['Zero to Hero', 'Lady - Family Dog', 'Mirabel Madrigal - Family Gatherer', 'Stitch - Rock Star', 'Pudge - Controls the Weather', 'Lilo - Making a Wish', 'Lilo - Snow Artist'].map(card);
const PUDGE = card('Pudge - Controls the Weather');

function checkList(list, inks, label) {
  const r = resolveDeck(index, list);
  assert.ok(r.legal, `${label}: not legal: ${r.problems.join('; ')} ${r.errors.join('; ')}`);
  assert.equal(r.size, 60, `${label}: ${r.size} cards`);
  assert.ok(r.inks.length <= 2, `${label}: inks ${r.inks}`);
  for (const i of r.inks) assert.ok(inks.includes(i), `${label}: ink ${i} outside ${inks}`);
  return r;
}

let zth, zthSyn, zthDeck;
await test('readSeed: Zero To Hero seed reads the idea and picks Infinity (Zero to Hero has rotated)', () => {
  zth = readSeed(index, { cards: ZTH.map((d) => d.id) });
  showThoughts('readSeed (Zero To Hero)', zth.thoughts);
  say(`  core: ${zth.core.map(full).join(', ')} | inks ${zth.inks} | format ${zth.format}`);
  assert.deepEqual(zth.inks, ['amber']);
  assert.equal(zth.core.length, ZTH.length);
  assert.equal(zth.format, 'infinity');
  assert.ok(/board|wide/i.test(zth.idea), zth.idea);
  assert.ok(zth.thoughts.some((t) => /named Lilo/.test(t.text) && t.cards?.includes(PUDGE.id)), 'Pudge narration names Lilo');
  for (const t of zth.thoughts) assert.equal(typeof t.text, 'string');
});

await test('findSynergies: the Lilos for Pudge, cheap Bodyguards, removal; only legal automated cards', () => {
  zthSyn = findSynergies(index, zth.core, { inks: zth.inks });
  say('\n--- findSynergies (Zero To Hero): top 20');
  for (const s of zthSyn.slice(0, 20)) say(`  ${String(s.score).padStart(5)} ${s.role.padEnd(8)} ${s.full} — ${s.reasons[0]}`);
  assert.ok(zthSyn.length >= 20);
  const lilos = zthSyn.filter((s) => s.role === 'chain' && index.byId.get(s.id).name === 'Lilo');
  assert.ok(lilos.length >= 2, 'cheap Lilos found');
  assert.ok(lilos.every((s) => s.reasons.some((r) => r.includes(PUDGE.full))), 'chained from Pudge');
  assert.ok(zthSyn.slice(0, 15).some((s) => s.role === 'chain' && s.full.startsWith('Lilo')), 'Lilos rank near the top');
  assert.ok(zthSyn.some((s) => s.role === 'defense'), 'Bodyguards');
  assert.ok(zthSyn.some((s) => s.role === 'removal'), 'removal');
  for (const s of zthSyn) {
    const d = index.byId.get(s.id);
    assert.ok(isFullyAutomated(d), `${d.full} automated`);
    assert.ok(fmtLegal(d, '1'), `${d.full} legal in Infinity`);
    assert.ok(!zth.core.includes(s.id), 'core excluded');
    assert.ok(['enabler', 'payoff', 'chain', 'defense', 'removal', 'draw', 'fallback'].includes(s.role));
  }
  // sorted, deterministic
  for (let i = 1; i < zthSyn.length; i++) assert.ok(zthSyn[i - 1].score >= zthSyn[i].score);
  assert.deepEqual(findSynergies(index, zth.core, { inks: zth.inks }), zthSyn);
  // exclude works
  const ex = findSynergies(index, zth.core, { inks: zth.inks, exclude: [lilos[0].id] });
  assert.ok(!ex.some((s) => s.id === lilos[0].id));
});

await test('assemble: legal 60 in the seed ink plus the best second ink, core at 4', () => {
  zthDeck = assemble(index, { core: zth.core, inks: zth.inks, synergies: zthSyn });
  showThoughts(`assemble → ${zthDeck.name}`, zthDeck.thoughts);
  showList(zthDeck.cards);
  const r = checkList(zthDeck, ['amber', 'amethyst', 'emerald', 'ruby', 'sapphire', 'steel'], 'zth');
  assert.ok(r.inks.includes('amber'));
  for (const id of zth.core) assert.equal(zthDeck.cards.find(([x]) => x === id)?.[1], 4, `4 of ${full(id)}`);
  assert.ok(r.inkable / r.size >= 0.65, `inkable ${r.inkable}`);
  assert.ok(zthDeck.cards.some(([id]) => index.byId.get(id).name === 'Lilo' && !zth.core.includes(id)) || zth.core.filter((id) => index.byId.get(id).name === 'Lilo').length >= 2);
  for (const [id] of zthDeck.cards) if (!zth.core.includes(id)) { const d = index.byId.get(id); assert.ok(isFullyAutomated(d) && fmtLegal(d, '1'), d.full); }
  assert.deepEqual(assemble(index, { core: zth.core, inks: zth.inks, synergies: zthSyn }), zthDeck, 'deterministic');
});

let bolt, boltDeck;
await test('Bolt - Superdog seed: Amber/Steel, legal 60', () => {
  bolt = readSeed(index, { cards: [card('Bolt - Superdog').id] });
  showThoughts('readSeed (Bolt - Superdog)', bolt.thoughts);
  assert.deepEqual(bolt.inks, ['amber', 'steel']);
  const fmt = bolt.format === 'core' ? '2' : '1';
  const syn = findSynergies(index, bolt.core, { inks: bolt.inks });
  say('\n--- findSynergies (Bolt): top 10');
  for (const s of syn.slice(0, 10)) say(`  ${String(s.score).padStart(5)} ${s.role.padEnd(8)} ${s.full} — ${s.reasons[0]}`);
  assert.ok(syn.some((s) => index.byId.get(s.id).name === 'Bolt'), 'cheaper Bolts to shift onto');
  for (const s of syn) assert.ok(fmtLegal(index.byId.get(s.id), fmt), `${s.full} legal in ${bolt.format}`);
  boltDeck = assemble(index, { core: bolt.core, inks: bolt.inks, synergies: syn });
  showThoughts(`assemble → ${boltDeck.name}`, boltDeck.thoughts);
  showList(boltDeck.cards);
  checkList(boltDeck, ['amber', 'steel'], 'bolt');
  for (const [id] of boltDeck.cards) assert.ok(fmtLegal(index.byId.get(id), fmt), `${full(id)} legal in ${bolt.format}`);
});

await test('readSeed edge cases: given inks, too many inks, a saved deck, nothing', () => {
  const three = readSeed(index, { cards: [card('Bolt - Superdog').id, card('Stitch - Rock Star').id, card('Mickey Mouse - Brave Little Tailor').id] });
  assert.ok(three.inks.length <= 2 && three.core.length < 3, 'drops the card outside two inks');
  const asked = readSeed(index, { cards: [PUDGE.id], inks: ['amber', 'sapphire'] });
  assert.deepEqual(asked.inks, ['amber', 'sapphire']);
  const meta = index.metaDecks[0];
  const fromDeck = readSeed(index, { deck: meta });
  assert.ok(fromDeck.core.length > 0 && fromDeck.base?.length);
  const kept = assemble(index, { core: fromDeck.core, inks: fromDeck.inks });
  assert.deepEqual(new Map(kept.cards), new Map(meta.cards.map(([id, n]) => [id, n])), 'a saved deck is kept as it is');
  // a seed that's all Core-legal builds a Core list
  const coreSeed = readSeed(index, { cards: [card('Stitch - Rock Star').id] });
  assert.equal(coreSeed.format, 'core');
  const coreList = assemble(index, { core: coreSeed.core, inks: coreSeed.inks });
  checkList(coreList, ['amber', 'amethyst', 'emerald', 'ruby', 'sapphire', 'steel'], 'core seed');
  for (const [id] of coreList.cards) assert.ok(fmtLegal(index.byId.get(id), '2'), `${full(id)} legal in Core`);
  const none = readSeed(index, { cards: [], inks: ['ruby', 'steel'] });
  const built = assemble(index, { core: none.core, inks: none.inks });
  checkList(built, ['ruby', 'steel'], 'empty seed');
});

// synthetic records: Mirabel never played (inked or stuck), the rest played normally
const recordsFor = (cards, deadFull, n = 20) => {
  const fulls = cards.map(([id]) => full(id));
  return Array.from({ length: n }, (_, g) => {
    const turns = Array.from({ length: 8 }, (_, t) => ({
      n: t + 1, played: fulls.filter((f, i) => f !== deadFull && (i + g + t) % 7 === 0),
      inked: t % 2 === 0 ? [deadFull] : [fulls[(g + t) % fulls.length] === deadFull ? fulls[0] : fulls[(g + t) % fulls.length]],
      board: [], hand: 5, ink: t, quests: 1, challenges: 0, unusedInk: 0, loreEnd: t * 2, oppLore: t, oppBoard: 2, hadInkable: true,
    }));
    return { first: g % 2 === 0, opening: fulls.slice(0, 7), shipped: [], turns, win: g % 3 !== 0, endTurn: 8, lore: [20, 12], endHand: [deadFull], reason: 'lore', opp: 'x' };
  });
};

let impact;
await test('cardImpact: a card drawn but never played is the most dead', () => {
  const dead = 'Mirabel Madrigal - Family Gatherer';
  const r = resolveDeck(index, zthDeck);
  impact = cardImpact(recordsFor(zthDeck.cards, dead), r.defs);
  say('\n--- cardImpact (synthetic records)');
  for (const c of impact.slice(0, 6)) say(`  dead ${c.dead.toFixed(2)}  ${c.full}: ${c.note}`);
  assert.equal(impact[0].full, dead);
  assert.equal(impact[0].played, 0);
  assert.ok(impact[0].drawn > 0 && impact[0].dead > impact[1].dead);
  assert.equal(impact.length, zthDeck.cards.length);
  for (const c of impact) assert.ok(c.dead >= 0 && c.dead <= 1 && c.id && typeof c.note === 'string');
  for (let i = 1; i < impact.length; i++) assert.ok(impact[i - 1].dead >= impact[i].dead);
  assert.deepEqual(cardImpact([], r.defs).every((c) => c.drawn === 0), true);
});

await test('proposeSwaps: never touches locks, legal results, skips tried swaps', () => {
  const inks = resolveDeck(index, zthDeck).inks;
  const swaps = proposeSwaps(index, zthDeck.cards, { impact, synergies: zthSyn, inks, max: 4 });
  say('\n--- proposeSwaps (no locks)');
  for (const s of swaps) say(`  [${s.kind}] -${s.out.map(([id, n]) => `${n} ${full(id)}`).join(', ')} +${s.in.map(([id, n]) => `${n} ${full(id)}`).join(', ')}\n      ${s.why}`);
  assert.ok(swaps.length >= 2 && swaps.length <= 4);
  assert.equal(swaps[0].out[0][0], impact[0].id, 'number 1 cut goes first');
  const check = (list, locks) => {
    for (const s of list) {
      assert.ok(['cut-dead', 'new-combo', 'removal', 'defense', 'curve'].includes(s.kind));
      const m = new Map(zthDeck.cards);
      for (const [id, n] of s.out) { assert.ok(!locks.includes(id) && !locks.map((x) => x.toLowerCase()).includes(full(id).toLowerCase()), `touched lock ${full(id)}`); m.set(id, m.get(id) - n); }
      for (const [id, n] of s.in) { assert.ok(!locks.includes(id)); m.set(id, (m.get(id) || 0) + n); }
      const r = resolveDeck(index, { cards: [...m].filter(([, n]) => n > 0) });
      assert.ok(r.legal && r.size === 60, `legal after ${swapKey(s)}`);
      for (const i of r.inks) assert.ok(inks.includes(i));
      for (const [id] of s.in) assert.ok(isFullyAutomated(index.byId.get(id)) && fmtLegal(index.byId.get(id), '1'));
    }
  };
  check(swaps, []);
  // lock the dead card (by id) and the second worst (by full name): neither may leave
  const locks = [impact[0].id, impact[1].full];
  const locked = proposeSwaps(index, zthDeck.cards, { impact, synergies: zthSyn, inks, locks, max: 4 });
  say('\n--- proposeSwaps (with locks)');
  for (const s of locked) say(`  [${s.kind}] -${s.out.map(([id, n]) => `${n} ${full(id)}`).join(', ')} +${s.in.map(([id, n]) => `${n} ${full(id)}`).join(', ')}`);
  assert.ok(locked.length > 0);
  for (const s of locked) assert.ok(s.out.every(([id]) => id !== impact[0].id && id !== impact[1].id));
  check(locked, [impact[0].id, impact[1].id]);
  // tried swaps aren't proposed again
  const again = proposeSwaps(index, zthDeck.cards, { impact, synergies: zthSyn, inks, tried: swaps, max: 4 });
  for (const s of again) assert.ok(!swaps.some((t) => swapKey(t) === swapKey(s)), 'tried swap proposed again');
  // without synergies or impact it still works (static fallback)
  const bare = proposeSwaps(index, boltDeck.cards, {});
  check.call(null, [], []);
  for (const s of bare) { const m = new Map(boltDeck.cards); for (const [id, n] of s.out) m.set(id, m.get(id) - n); for (const [id, n] of s.in) m.set(id, (m.get(id) || 0) + n); assert.ok(resolveDeck(index, { cards: [...m].filter(([, n]) => n > 0) }).legal); }
});

await test('real games: impact and swaps from playGame records', async () => {
  const deck = resolveDeck(index, zthDeck).defs;
  const records = [];
  const opps = index.metaDecks.slice(0, 3);
  for (let g = 0; g < 6; g++) {
    const opp = opps[g % opps.length];
    const rec = await playGame({ deck, oppDeck: resolveDeck(index, opp).defs, me: g % 2, seed: 1000 + g, pilot: 'quick' });
    rec.opp = opp.id || opp.name;
    records.push(rec);
  }
  const imp = cardImpact(records, deck);
  const report = buildReport({ records, defs: deck, opponents: opps.map((o) => ({ key: o.id || o.name, name: o.name })), settings: {} });
  say(`\n--- real games: ${records.filter((r) => r.win).length}/${records.length} wins; most dead:`);
  for (const c of imp.slice(0, 5)) say(`  dead ${c.dead.toFixed(2)}  ${c.full}: ${c.note}`);
  const swaps = proposeSwaps(index, zthDeck.cards, { impact: imp, report, inks: resolveDeck(index, zthDeck).inks, max: 3 });
  for (const s of swaps) say(`  [${s.kind}] ${s.why}`);
  assert.ok(imp.length === zthDeck.cards.length);
  for (const s of swaps) { const m = new Map(zthDeck.cards); for (const [id, n] of s.out) m.set(id, m.get(id) - n); for (const [id, n] of s.in) m.set(id, (m.get(id) || 0) + n); assert.ok(resolveDeck(index, { cards: [...m].filter(([, n]) => n > 0) }).legal); }
});

console.log(`ALL OK (${passed} tests)`);
