// "{exert}, 2 {ink}, Banish this item — effect"   { kind:'activated', cost:{…}, once?, do:[step] }
import { Kind, modsOf, sayDuring } from './Kind.js';
import { Query } from '../query.js';
import { sameNamePairs } from '../effects/extra.js';

// cost key → [phrase regex, (m, c, at) => value, runs?, words]
const COSTS = {
  exert: [/^\{exert\}$/, () => true, true, () => '{exert}'],
  ink: [/^(\d+) \{ink\}$/, (m) => +m[1], true, (v) => `${v} {ink}`],
  banishSelf: [/^banish this (?:item|character|location)$/i, () => true, true, () => 'banish this'],
  discard: [/^(?:choose and )?discard (?:a|an) (.+)$/i, (m, c, at) => (m[1].toLowerCase() === 'card' ? {} : c.filter(m[1], at)), true, (v) => `discard a ${Query.describe(v)}`],
  exertOther: [/^\{exert\} (?:one of your|an?) (.+)$|^exert (?:one of your|an?) (.+)$/i, (m, c, at) => { const F = c.filter(`your ${m[1] || m[2]}`, at); return { ...F, with: [...(F.with || []), { ready: true }, { dry: true }] }; }, true, (v) => `exert a ${Query.describe(v)}`],
  banishOther: [/^banish (?:one of your|chosen) (.+?)(?: of yours)?$/i, (m, c, at) => c.filter(`your ${m[1]}`, at), true, (v) => `banish a ${Query.describe(v)}`],
  banishN: [/^banish (\d+|two|three) of your (.+)$/i, (m, c, at) => ({ n: { two: 2, three: 3 }[m[1].toLowerCase()] || +m[1], filter: c.filter(`your ${m[2]}`, at) }), true, (v) => `banish ${v.n} ${Query.describe(v.filter)}`],
  healSelf: [/^remove (\d+) damage from this character$/i, (m) => +m[1], false, (v) => `remove ${v} damage from this`],
  damageSelf: [/^deal (\d+) damage to this character$/i, (m) => +m[1], true, (v) => `deal ${v} damage to this`],
  inkSelf: [/^put this (?:character|item) into your inkwell facedown$/i, () => true, false, () => 'put this into your inkwell'],
  // "Reveal 2 cards with the same name in your hand" (Merlin's Wand) — "that name" afterwards is theirs
  revealSame: [/^reveal (\d+) cards with the same name in your hand$/i, (m) => +m[1], true, (v) => `reveal ${v} cards with the same name from your hand`],
};
export const COST_SUPPORT = new Set(Object.entries(COSTS).filter(([, v]) => v[2]).map(([k]) => k));
const HEAD = /^((?:\{exert\}|\d+ \{ink\}|banish this (?:item|character|location)|choose and discard (?:a|an?) (?:\w+ )?card|discard (?:a|an?) (?:\w+ )?card|(?:exert|\{exert\}) (?:one of your|an?|\d+) [^—]+?|banish (?:one of your|chosen|\d+ of your|two of your) [^—]+?|put [^—]+? into your inkwell facedown|remove \d+ damage from this character|deal \d+ damage to this character|reveal \d+ cards with the same name in your hand|[, ]+)+) — (.+)$/i;

export class Activated extends Kind {
  static kind = 'activated';
  static parse(t, c, mods) {
    const m = t.match(HEAD);
    return m ? { kind: 'activated', cost: Activated.cost(m[1], c, t), ...mods, do: c.effects(m[2]) } : null;
  }
  static cost(s, c, at) {
    const cost = {};
    for (const raw of s.split(/,\s*/)) {
      const p = raw.trim();
      if (!p) continue;
      const hit = Object.entries(COSTS).find(([, [rx]]) => rx.test(p));
      if (!hit) c.miss(`cost: "${p}"`, at);
      cost[hit[0]] = hit[1][1](p.match(hit[1][0]), c, at);
    }
    return cost;
  }
  static check(p, missing, S) { for (const k of Object.keys(p.cost)) if (!S.cost.has(k)) missing.add(`cost ${k}`); }
  static explain(p, X) {
    const cost = Object.entries(p.cost).map(([k, v]) => COSTS[k][3](v)).join(' + ');
    return [X.tag('activated'), `${p.from === 'hand' ? 'FROM HAND ' : ''}COST ${cost || 'see steps'}${sayDuring(p)}`, ...(p.cond ? [`IF ${X.cond(p.cond)}`] : []), ...p.do.map((st, i) => `${i + 1}. ${X.step(st)}`)];
  }

  // runtime: pay the costs and queue the effect. false → not runnable (manual)
  static activate(rt, s, seat, c, index, ev) {
    const { E } = rt;
    const d = E.D(s, c);
    const proc = rt.procsOf(s, c)[index];
    if (!proc || proc.kind !== 'activated' || !proc.exec) return false;
    if ((proc.from === 'hand') !== (c.zone === 'hand')) throw E.RE(proc.from === 'hand' ? 'Use this from your hand.' : 'Only cards in play can use this ability.');
    // "you may use this item's Shapeshift ability for free": every cost but {exert} (CR 6.1.7.1)
    const free = rt.procsOf(s, c).some((p) => p.kind === 'static' && p.exec && p.effect?.fn === 'freeAbility' && proc.name && p.effect.name.toLowerCase() === proc.name.toLowerCase() && rt.test(s, p.cond, seat, c.iid));
    const cost = free ? (proc.cost.exert ? { exert: true } : {}) : proc.cost;
    if (proc.once) { c.once ||= {}; if (c.once[index] === s.turn) throw E.RE('This ability can only be used once per turn.'); }
    if (proc.during === 'yours' && s.active !== seat) throw E.RE('Only during your turn.');
    if (proc.cond && !rt.test(s, proc.cond, seat, c.iid)) throw E.RE("This ability's condition isn't met right now.");
    if (cost.exert) {
      if (d.type === 'location') throw E.RE("Locations can't exert.");
      if (c.exerted) throw E.RE('It is exerted — this ability costs ⟳.');
      if (d.type === 'character' && c.drying) throw E.RE("Characters can't ⟳ the turn they're played (drying).");
    }
    for (const k of ['banishOther', 'exertOther']) if (cost[k] && !rt.candidates(s, cost[k], seat, c.iid).length) throw E.RE(`You have no ${Query.describe(cost[k])} to ${k === 'banishOther' ? 'banish' : 'exert'} for this cost.`);
    if (cost.banishN && rt.candidates(s, cost.banishN.filter, seat, c.iid).length < cost.banishN.n) throw E.RE(`You need ${cost.banishN.n} ${Query.describe(cost.banishN.filter)} to banish for this cost.`);
    if (cost.revealSame && !sameNamePairs(rt, s, seat, cost.revealSame).length) throw E.RE(`You need ${cost.revealSame} cards with the same name in your hand.`);
    if (cost.discard && !E.P(s, seat).hand.some((iid) => rt.matches(s, { ...cost.discard, zone: 'hand' }, s.cards[iid], seat, c.iid))) throw E.RE('You have no card to discard for this cost.');
    E.payInk(s, seat, cost.ink || 0);
    const paid = [];
    if (cost.exert) { E.exertCard(s, c); paid.push('⟳'); }
    if (cost.ink) paid.push(`${cost.ink} ink`);
    if (free) paid.push('free');
    if (proc.once) c.once[index] = s.turn;
    rt.log(s, `${E.nameOf(s, seat)} used ${E.cardLabel(d)}'s ${proc.name || 'ability'}${paid.length ? ` (paid ${paid.join(' + ')})` : ''}.`, { seat, kind: 'play' });
    ev.push({ k: 'ability', iid: c.iid, index });
    const steps = [
      ...(cost.revealSame ? [{ fn: 'revealSame', n: cost.revealSame, cost: true }] : []),
      ...(cost.discard ? [{ fn: 'discard', who: 'you', n: 1, filter: cost.discard }] : []),
      ...(cost.exertOther ? [{ fn: 'exert', sel: { chosen: cost.exertOther }, cost: true }] : []),
      ...(cost.banishOther ? [{ fn: 'banish', sel: { chosen: cost.banishOther }, cost: true }] : []),
      ...(cost.banishN ? [{ fn: 'banish', sel: { chosen: cost.banishN.filter, upTo: cost.banishN.n, exactly: true }, cost: true }] : []),
      ...proc.do,
    ];
    if (cost.damageSelf) E.dealDamage(s, c.iid, cost.damageSelf, ev, { cost: true });   // "Deal 1 damage to this character —"
    if (cost.banishSelf) { rt.log(s, `↳ ${E.cardLabel(d)} was banished to pay for it.`, { kind: 'effect' }); E.banish(s, c.iid, ev, 'cost'); }
    rt.queue(s, seat, c.iid, rt.labelOf(s, c, proc), steps);
    return true;
  }
}
