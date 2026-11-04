// Board-state signals: what each of my cards can do right now, as one colour language (duels.ink's action auras),
// and the outcome of a challenge before it's made. Pure functions over the view the client already has; the server
// still has the final say (the same rules.js helpers drive main.js's action buttons).

import {
  questBlocker, attackerBlocker, defenderBlocker, challengeDamage, singerBlocker, singValue, effWp,
  shiftOptions, shiftTargetOk, shiftDiscardOk, parseActivatedCost,
} from './rules.js';

// one colour per thing a card can do; no glow = nothing to do with it right now
export const AURA = {
  play: 0xffc94a,       // gold: playable from hand
  ink: 0x4f86ff,        // blue: can only go into the inkwell
  shift: 0x36d6e7,      // cyan: can shift onto a card in play
  sing: 0xe36bea,       // magenta: a song one of my characters can sing
  quest: 0x45d46a,      // green: can quest
  ability: 0xa463ff,    // purple: an activated ability (or Boost) is usable
  challenge: 0xff8a3d,  // orange: can't quest, but can challenge (Reckless, Rush the turn it's played)
  target: 0xff4a4a,     // red: a valid challenge target for the selected attacker
};

const sideOf = (view, defs, seat) => view.players[seat].play.map((c) => ({ card: c, def: defs[c.cardId] || { type: 'character' } }));

// Is it my move (my turn, nothing pending, playing)?
export function myMove(view) {
  return !!view && view.status === 'playing' && view.you >= 0 && view.active === view.you && !view.pending;
}

// Opposing cards this attacker may challenge right now
export function challengeTargets(view, defs, attIid) {
  const out = new Set();
  if (!myMove(view)) return out;
  const me = view.players[view.you];
  const att = me?.play.find((c) => c.iid === attIid);
  const ad = att && defs[att.cardId];
  if (!ad || ad.type !== 'character' || attackerBlocker(att, ad)) return out;
  for (const p of view.players) {
    if (p.seat === view.you) continue;
    const side = sideOf(view, defs, p.seat);
    for (const t of p.play) {
      const td = defs[t.cardId];
      if (td && !defenderBlocker(att, ad, t, td, side)) out.add(t.iid);
    }
  }
  return out;
}

function abilityReady(view, me, c, def) {
  const ink = me.inkReady ?? 0;
  const isChar = def.type === 'character';
  const ok = (cost) => !(cost.exert && c.exerted) && !(cost.exert && isChar && c.drying) && !((cost.ink || 0) > ink);
  for (let i = 0; i < (def.abilities || []).length; i++) {
    const cost = parseActivatedCost(def.abilities[i].text);
    const proc = def.procs?.[i];
    if (cost && ok(cost)) return true;
    if (!cost && proc?.kind === 'activated' && proc.exec && proc.from !== 'hand' && ok(proc.cost || {})) return true;
  }
  for (const g of c.granted || []) {
    const cost = g.kind === 'activated' && parseActivatedCost(g.text);
    if (cost && ok(cost)) return true;
  }
  if (typeof def.kw?.boost === 'number' && c.boostedTurn !== view.turn && ink >= def.kw.boost) return true;
  return false;
}

function shiftReady(me, defs, c, def) {
  const ink = me.inkReady ?? 0;
  for (const opt of shiftOptions(def)) {
    if (!me.play.some((t) => defs[t.cardId] && shiftTargetOk(opt, def, defs[t.cardId]))) continue;
    const cost = opt.spec.cost;
    if (cost.ink != null) { if (ink >= cost.ink) return true; continue; }
    if (cost.inkDrops != null) { if ((me.inkDrops || 0) >= cost.inkDrops) return true; continue; }
    if (cost.bottomFromDiscard != null) { if (me.discard.filter((x) => !cost.type || defs[x.cardId]?.type === cost.type).length >= cost.bottomFromDiscard) return true; continue; }
    const pay = me.hand.filter((h) => h.iid !== c.iid && defs[h.cardId] && shiftDiscardOk({ spec: { cost: { ...cost, discard: 1 } } }, [defs[h.cardId]]));
    if (pay.length >= (cost.discard || 0)) return true;
  }
  return false;
}

function singReady(me, defs, def) {
  if (def.type !== 'song') return false;
  const chars = me.play.filter((t) => defs[t.cardId]?.type === 'character');
  if (chars.some((t) => !singerBlocker(t, defs[t.cardId], def))) return true;
  const n = def.kw?.singTogether;
  if (!n) return false;
  const total = chars.filter((t) => !singerBlocker(t, defs[t.cardId], null)).reduce((a, t) => a + singValue(t, defs[t.cardId]), 0);
  return total >= n;
}

// iid -> AURA key for every card of mine that can do something right now
export function computeAuras(view, defs) {
  const out = new Map();
  if (!myMove(view)) return out;
  const me = view.players[view.you];
  if (!me) return out;
  const ink = me.inkReady ?? 0;
  const canInk = (me.inkedThisTurn ?? 0) < (me.inkLimit ?? 1);
  for (const c of me.hand || []) {
    const def = defs[c.cardId];
    if (!def) continue;
    const cost = c.cost ?? def.cost ?? 0;
    if (ink >= cost) out.set(c.iid, 'play');
    else if (shiftReady(me, defs, c, def)) out.set(c.iid, 'shift');
    else if (singReady(me, defs, def)) out.set(c.iid, 'sing');
    else if (canInk && (def.inkable || me.rules?.handInkable)) out.set(c.iid, 'ink');
  }
  const opp = view.players.filter((p) => p.seat !== view.you);
  for (const c of me.play) {
    const def = defs[c.cardId];
    if (!def) continue;
    if (def.type === 'character' && !questBlocker(c, def)) { out.set(c.iid, 'quest'); continue; }
    if (abilityReady(view, me, c, def)) { out.set(c.iid, 'ability'); continue; }
    if (def.type === 'character' && !attackerBlocker(c, def)) {
      const any = opp.some((p) => { const side = sideOf(view, defs, p.seat); return p.play.some((t) => defs[t.cardId] && !defenderBlocker(c, def, t, defs[t.cardId], side)); });
      if (any) out.set(c.iid, 'challenge');
    }
  }
  return out;
}

// What a challenge would do: { toDefender, toAttacker, banishT, banishA }, or null if these aren't attacker and target
export function challengeOutcome(view, defs, attIid, tgtIid) {
  let att = null, tgt = null;
  for (const p of view?.players || []) for (const c of p.play) { if (c.iid === attIid) att = c; if (c.iid === tgtIid) tgt = c; }
  const ad = att && defs[att.cardId], td = tgt && defs[tgt.cardId];
  if (!ad || !td || ad.type !== 'character' || att.owner === tgt.owner) return null;
  const d = challengeDamage(att, ad, tgt, td);
  const wpT = tgt.eff?.wp ?? effWp(tgt, td), wpA = att.eff?.wp ?? effWp(att, ad);
  return {
    ...d,
    banishT: d.toDefender > 0 && (tgt.damage || 0) + d.toDefender >= wpT,
    banishA: d.toAttacker > 0 && (att.damage || 0) + d.toAttacker >= wpA,
  };
}
