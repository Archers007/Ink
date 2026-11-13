// Union Arena bot: picks one of legalActions() with simple, readable heuristics.
//
//   botDecide(state, seat) → an action
//
// Plan each turn: keep enough energy on the energy line for the cards in hand, put the biggest characters on the
// front line, Raid when it can, attack when the attack is safe or the opponent is low, block to protect life when
// the blocker survives or life is short, and always take life triggers.

import { legalActions, P, C, D, other, bpOf, energyOf, apActive, kwOf } from './engine.js';

const bp = (s, iid) => bpOf(s, C(s, iid)) ?? 0;

export function botDecide(s, seat) {
  const acts = legalActions(s, seat);
  if (!acts.length) return null;
  const pend = s.pending;
  const p = P(s, seat), opp = P(s, other(seat));
  const first = (t) => acts.find((a) => a.type === t);

  switch (pend.type) {
    case 'mulligan': {
      // keep a hand with at least two cheap cards (0–1 energy)
      const cheap = p.hand.filter((iid) => (D(s, C(s, iid)).energy || 0) <= 1).length;
      return { type: 'mulligan', redraw: cheap < 2 };
    }
    case 'trigger': {
      const raid = acts.find((a) => a.type === 'trigger' && a.raidOnto);
      return raid || acts.find((a) => a.type === 'trigger' && a.use) || acts[0];
    }
    case 'yesno': return { type: 'yesno', yes: true };
    case 'manual': return { type: 'manualDone' };
    case 'block': {
      const att = C(s, pend.attacker);
      const abp = bpOf(s, att) ?? 0;
      const kw = kwOf(s, att);
      const dmg = (kw.damage || 1) + (kw.damagePlus || 0);
      const opts = pend.options.map((iid) => ({ iid, bp: bp(s, iid) })).sort((a, b) => a.bp - b.bp);
      const survivor = opts.find((o) => o.bp > abp);
      if (survivor) return { type: 'block', iid: survivor.iid };
      if (p.life.length <= dmg + 1 && opts.length) return { type: 'block', iid: opts[0].iid };    // chump to stay alive
      return acts.find((a) => a.type === 'block' && !a.iid) || acts[0];
    }
    case 'choose': return chooseFor(s, seat, pend, acts);
    case 'phase': break;
    default: return acts[0];
  }

  if (pend.phase === 'start') {
    const extra = first('extraDraw');
    if (extra && p.hand.length <= 3 && apActive(s, seat) >= 2) return extra;
    return first('next');
  }

  if (pend.phase === 'move') {
    // move to the front only while the energy line still pays for the hand
    const need = Math.max(0, ...p.hand.map((iid) => D(s, C(s, iid)).energy || 0));
    const gen = energyOf(s, seat).any;
    const moves = acts.filter((a) => a.type === 'move' && C(s, a.iid).zone === 'energy')
      .map((a) => ({ a, bp: bp(s, a.iid), gen: (D(s, C(s, a.iid)).gen || []).length }))
      .sort((x, y) => y.bp - x.bp);
    for (const m of moves) if (m.bp >= 2000 && gen - m.gen >= need && p.front.length < 4) return m.a;
    return first('next');
  }

  if (pend.phase === 'main') {
    const plays = acts.filter((a) => a.type === 'play');
    const raid = plays.filter((a) => a.raid).sort((x, y) => (D(s, C(s, y.iid)).bp || 0) - (D(s, C(s, x.iid)).bp || 0))[0];
    if (raid) return raid;
    const gen = energyOf(s, seat).any;
    const need = Math.max(0, ...p.hand.map((iid) => D(s, C(s, iid)).energy || 0));
    // ramp: a generator onto the energy line while short of energy
    if (gen < Math.min(need, 6) && p.energy.length < 4) {
      const g = plays.filter((a) => a.line === 'energy').map((a) => ({ a, d: D(s, C(s, a.iid)) }))
        .filter((x) => (x.d.gen || []).length).sort((x, y) => (x.d.bp || 0) - (y.d.bp || 0))[0];
      if (g) return g.a;
    }
    // the strongest character to the front
    const front = plays.filter((a) => a.line === 'front').map((a) => ({ a, d: D(s, C(s, a.iid)) })).sort((x, y) => (y.d.bp || 0) - (x.d.bp || 0))[0];
    if (front && p.front.length < 4) return front.a;
    // events with something to hit
    const ev = plays.find((a) => !a.line && D(s, C(s, a.iid)).type === 'event' && (opp.front.length || /draw|look|AP/i.test(D(s, C(s, a.iid)).effect || '')));
    if (ev) return ev;
    const site = plays.find((a) => D(s, C(s, a.iid)).type === 'site');
    if (site) return site;
    // an Activate: Main ability the engine runs, at most once per card per turn (abilities resolved by hand are skipped)
    const act = acts.find((a) => {
      if (a.type !== 'activate') return false;
      const ab = s.compiled[C(s, a.iid).no]?.abilities?.[a.ab];
      if (!ab || ab.manual) return false;
      const used = (s.botUsed ||= {});
      return used[`${a.iid}:${a.ab}`] !== s.turnNo;
    });
    if (act) { (s.botUsed ||= {})[`${act.iid}:${act.ab}`] = s.turnNo; return act; }
    const anyEnergy = plays.find((a) => a.line === 'energy');
    if (anyEnergy && p.energy.length < 3) return anyEnergy;
    return first('next');
  }

  if (pend.phase === 'attack') {
    const blockers = opp.front.filter((iid) => !C(s, iid).rest).map((iid) => bp(s, iid));
    const top = Math.max(0, ...blockers);
    const attacks = acts.filter((a) => a.type === 'attack');
    // Snipe a target it beats
    const snipe = attacks.filter((a) => a.target && bp(s, a.iid) >= bp(s, a.target)).sort((x, y) => bp(s, y.target) - bp(s, x.target))[0];
    if (snipe) return snipe;
    // a losing attacker isn't sidelined (UA-8.4), so attacking is cheap: the only cost is a resting character on the
    // opponent's turn. Hold back the best blocker only when our own life is short.
    const plain = attacks.filter((a) => !a.target).sort((x, y) => bp(s, y.iid) - bp(s, x.iid));
    const theirAttackers = opp.front.length;
    const keepBack = p.life.length <= 2 && theirAttackers > 0 && plain.length ? plain[0].iid : null;
    const go = plain.find((a) => a.iid !== keepBack && (bp(s, a.iid) >= top || p.life.length > 2 || !blockers.length));
    if (go) return go;
    return first('next');
  }
  return acts[0];
}

function chooseFor(s, seat, pend, acts) {
  const opts = pend.options || [];
  if (pend.op === 'handLimit') {
    // keep the cheapest-to-play, highest-BP cards
    const ranked = [...opts].sort((a, b) => score(s, b) - score(s, a));
    return { type: 'choose', picks: ranked.slice(0, pend.max) };
  }
  if (pend.modal) return { type: 'choose', picks: [opts[0]] };
  if (pend.lines) return { type: 'choose', picks: [opts.includes('front') ? 'front' : opts[0]] };
  if (pend.count) return { type: 'choose', picks: [opts[opts.length - 1]] };
  const cards = opts.filter((o) => C(s, o));
  const theirs = cards.filter((iid) => C(s, iid).owner !== seat);
  const mine = cards.filter((iid) => C(s, iid).owner === seat);
  let picks;
  if (theirs.length && !mine.length) picks = [...theirs].sort((a, b) => bp(s, b) - bp(s, a));          // hit their biggest
  else if (/sideline|removal|place/i.test(pend.prompt || '') && C(s, opts[0])?.zone === 'hand') picks = [...opts].sort((a, b) => score(s, a) - score(s, b));   // discard the weakest
  else picks = [...opts].sort((a, b) => score(s, b) - score(s, a));
  const k = Math.max(pend.min, Math.min(pend.max, picks.length));
  return { type: 'choose', picks: picks.slice(0, k) };
}
const score = (s, iid) => { const d = D(s, C(s, iid)); return (d.bp || 1500) / 1000 - (d.energy || 0) * 0.4 + (d.trigger ? 0.5 : 0); };
