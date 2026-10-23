// The first oracles, from the trial run: Hyperia and Attack of the Vine release notes, and the Beast - Relentless FAQ.
import { assert, applyAction, checkInvariants, all, byName, ok, setup, oracle, vanilla, put, giveInk, drain, passTo, viewFor } from './lib.mjs';

const inkReady = (s, seat) => s.players[seat].inkwell.filter((iid) => !s.cards[iid].exerted).length + (s.players[seat].inkDrops || 0);
const loreOf = (s, seat, iid) => viewFor(s, seat).players[seat].play.find((c) => c.iid === iid).eff.lore;

// 1. Hyperia: Mr. Manchas quests twice → next character costs 2 less (stacks)
oracle('ef58bcc531', 'quest twice → pay 2 less for next character', () => {
  const m = byName('Mr. Manchas - Service with a Smile');
  const three = vanilla((d) => d.cost === 3);
  const { s, ids } = setup({ play0: [m], hand0: [three] });
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s);
  ok(applyAction(s, 0, { type: 'exert', iid: ids.play0[0], exerted: false }));        // "somehow" ready him
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] })); drain(s);
  const before = inkReady(s, 0);
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
  assert.equal(before - inkReady(s, 0), 1, 'cost 3 − 2 = 1');
  checkInvariants(s);
});
// 2. Hyperia: Nick Wilde – Toy Drive Officer counts himself (+ negative: alone → no draw)
oracle('8d76c6fa0d', 'counts himself among "2 or more characters played"', () => {
  const nick = byName('Nick Wilde - Toy Drive Officer'); const one = vanilla((d) => d.cost === 1);
  for (const [extra, want] of [[true, 1], [false, 0]]) {
    const { s, ids } = setup({ hand0: extra ? [nick, one] : [nick] });
    for (const iid of ids.hand0) { ok(applyAction(s, 0, { type: 'play', iid })); drain(s); }
    const h = s.players[0].hand.length;
    ok(applyAction(s, 0, { type: 'endTurn' })); drain(s);
    assert.equal(s.players[0].hand.length - h, want, `played ${ids.hand0.length}: drew ${want}`);
  }
});
// 3. Hyperia: Miguel Rivera with 2 songs in discard → +1 lore, not +2
oracle('c7b440f044', '2 songs in discard → +1 lore only', () => {
  const mig = byName('Miguel Rivera - Street Musician');
  const songs = all.filter((d) => d.type === 'song' || (d.classes || []).includes('song') || d.sing).slice(0, 2);
  const { s, ids } = setup({ play0: [mig] });
  assert.equal(loreOf(s, 0, ids.play0[0]), mig.lore, 'no song → printed lore');
  for (const g of songs) put(s, 0, g, 'discard');
  ok(applyAction(s, 0, { type: 'lore', seat: 0, delta: 0 }));                         // any action → game state check re-applies statics
  assert.equal(loreOf(s, 0, ids.play0[0]), mig.lore + 1);
  checkInvariants(s);
});
// 4. FAQ: Beast – Relentless challenges a Resist-4 character for 4 → it took no damage → no Second Wind
oracle('c43fc83068', 'all damage prevented by Resist → "takes damage" does not trigger', () => {
  const beast = byName('Beast - Relentless'); const armor = byName('Mouse Armor');
  const target = vanilla((d) => d.wp >= 6 && d.str <= 1) || vanilla((d) => d.wp >= 5);
  for (const [uses, fires] of [[4, false], [3, true]]) {
    const { s, ids } = setup({ play0: [beast], play1: [target] });
    const arm = Array.from({ length: uses }, () => put(s, 1, armor, 'play'));
    giveInk(s, 1, 0); passTo(s, 1);
    for (const a of arm) { ok(applyAction(s, 1, { type: 'useAbility', iid: a, index: 0 })); ok(applyAction(s, 1, { type: 'choose', target: ids.play1[0] })); }
    ok(applyAction(s, 1, { type: 'exert', iid: ids.play1[0], exerted: true }));
    passTo(s, 0);
    ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[0], target: ids.play1[0] }));
    const asked = !!s.pending; drain(s, 'yes');
    assert.equal(s.cards[ids.play1[0]].damage, Math.max(0, beast.str - uses), 'resist reduced damage');
    assert.equal(asked, fires, fires ? 'Second Wind offered' : 'Second Wind must not trigger on 0 damage');
    assert.equal(s.cards[ids.play0[0]].exerted, !fires);
  }
});
// 5. Attack of the Vine: Celia Mae with no ready ink → no character is chosen, nobody gets "can't quest"
oracle('fde670a184', "can't pay the 1 ink → no part of the effect happens", () => {
  const celia = byName('Celia Mae - Friendly Receptionist'); const other = vanilla((d) => d.cost === 1);
  const { s, ids } = setup({ hand0: [celia], play0: [other], ink0: celia.cost });
  s.cards[ids.play0[0]].exerted = true;
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s, 'yes');
  for (const iid of s.players[0].play) assert.ok(!s.cards[iid].mods.some((m) => m.kw === 'cantQuest'), `${s.defs[s.cards[iid].cardId].full} got cantQuest`);
  assert.equal(s.cards[ids.play0[0]].exerted, true, 'not readied');
});
// 6. Attack of the Vine: Pocahontas & Meeko — the quest lore is gained before Welcome Return resolves
oracle('65ff735438', 'quest lore is gained before the quest trigger resolves', () => {
  const pm = byName('Pocahontas & Meeko - Adventurous Friends'); const one = vanilla((d) => d.cost === 1);
  const { s, ids } = setup({ play0: [pm, one] });
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
  assert.equal(s.players[0].lore, pm.lore, 'lore already gained while the trigger waits');
  ok(applyAction(s, 0, { type: 'choose', target: ids.play0[1] }));             // scripted answers, not a generic drain:
  ok(applyAction(s, 0, { type: 'choose', target: ids.play0[1] }));             // the hand holds 7 identical cost-1 fillers
  assert.equal(s.cards[ids.play0[1]].zone, 'play', 'returned and replayed for free');
  assert.ok(s.log.findIndex((l) => /quested with/.test(l.text)) < s.log.findIndex((l) => /Returned/.test(l.text)));
});
// 7. Hyperia: Yama used twice → 2 ink drops on one challenge
oracle('1bcab3056c', 'two uses → two floating triggers → 2 ink drops per challenge', () => {
  const yama = byName('Yama - Notorious Criminal'); const atk = vanilla((d) => d.str >= 1); const def = vanilla((d) => d.wp >= 5);
  const { s, ids } = setup({ play0: [yama, atk], play1: [def], ink0: 12 });
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 })); drain(s);
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.play0[0], index: 0 })); drain(s);
  s.cards[ids.play1[0]].exerted = true;
  const d0 = s.players[0].inkDrops || 0;
  ok(applyAction(s, 0, { type: 'challenge', attacker: ids.play0[1], target: ids.play1[0] })); drain(s);
  assert.equal((s.players[0].inkDrops || 0) - d0, 2);
});

// 8. Hyperia: Clawhauser can't be played "for free" unless you played another character this turn
oracle('8b49e397d2', '"for free" still obeys "can\'t play unless you played another character"', () => {
  const claw = byName('Clawhauser - Safety Officer'); const jit = byName('Just in Time');
  const { s, ids } = setup({ hand0: [jit, claw] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] }));
  const offered = s.pending?.valid?.includes(ids.hand0[1]) || false;
  if (offered) ok(applyAction(s, 0, { type: 'choose', target: ids.hand0[1] }));
  drain(s, 'no');
  assert.equal(s.cards[ids.hand0[1]].zone, 'hand', `Clawhauser was ${offered ? 'offered and ' : ''}played for free`);
});
// 9. Hyperia: Russell moves 2 characters to Port Authority at once → each player 1 drop + 1 lore (once)
oracle('1aba9cc580', 'two simultaneous moves → "once during your turn" pays out once', () => {
  const pa = byName('Port Authority - Center Hub'); const rus = byName('Russell - Junior Wilderness Explorer'); const one = vanilla((d) => d.cost === 1);
  const { s, ids } = setup({ play0: [rus, one] });
  const loc = put(s, 0, pa, 'play');
  const l0 = [s.players[0].lore, s.players[1].lore];
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
  for (let k = 0; k < 6 && s.pending; k++) { const p = s.pending; ok(applyAction(s, 0, { type: 'choose', ...(p.confirm ? { confirm: true } : { target: p.valid.includes(loc) ? loc : p.valid.includes(ids.play0[1]) ? ids.play0[1] : p.valid[0] }) })); }
  assert.equal(s.cards[ids.play0[1]].atLocation, loc, 'the other character moved too');
  assert.equal(s.players[0].lore - l0[0], rus.lore + 1, 'P0: quest lore + 1');
  assert.equal(s.players[1].lore - l0[1], 1, 'P1: +1');
  assert.deepEqual([s.players[0].inkDrops || 0, s.players[1].inkDrops || 0], [1, 1]);
});
// 10. Hyperia: a 0-lore character given Adventurous must still quest
oracle('355fcf27e8', 'Adventurous on a 0-lore character → still must quest', () => {
  const nick = byName('Nick Wilde - Inquisitive Harbormaster');
  const zero = all.find((d) => d.type === 'character' && d.lore === 0 && !Object.keys(d.kw || {}).length && d.procs.every((p) => p.kind !== 'static' && p.kind !== 'triggered'));   // first try picked a Reckless card (can't quest) — a fixture bug
  const { s, ids } = setup({ play0: [nick], play1: [zero] });
  ok(applyAction(s, 0, { type: 'quest', iid: ids.play0[0] }));
  ok(applyAction(s, 0, { type: 'choose', target: ids.play1[0] }));
  ok(applyAction(s, 0, { type: 'endTurn' })); drain(s, 'no');
  assert.equal(applyAction(s, 1, { type: 'endTurn' }).ok, false, `${zero.full} (0 lore) must quest first`);
});
// 11. Hyperia: Ancestral Guitar on a character that already has Singer still gives +2 to sing
oracle('88322c82c0', 'already a Singer → still counts +2 cost to sing', () => {
  const g = byName('Ancestral Guitar');
  const singer = all.find((d) => d.type === 'character' && typeof d.kw?.singer === 'number' && d.procs.every((p) => p.kind === 'keyword'));
  const song = all.find((d) => d.type === 'song' && d.cost === singer.kw.singer + 2 && d.procs.every((p) => p.exec) && !/opponent|chosen|banish/i.test(d.abilities.map((a) => a.text).join(' ')));
  const { s, ids } = setup({ play0: [singer], hand0: [g, song] });
  ok(applyAction(s, 0, { type: 'play', iid: ids.hand0[0] })); drain(s);
  s.cards[ids.hand0[0]].drying = false;
  ok(applyAction(s, 0, { type: 'useAbility', iid: ids.hand0[0], index: g.procs.findIndex((p) => p.kind === 'activated') }));
  ok(applyAction(s, 0, { type: 'choose', target: ids.play0[0] })); drain(s);
  const r = applyAction(s, 0, { type: 'play', iid: ids.hand0[1], mode: 'sing', singers: [ids.play0[0]] });
  assert.ok(r.ok, `Singer ${singer.kw.singer} + 2 can sing cost-${song.cost} ${song.full}: ${r.error}`);
});

