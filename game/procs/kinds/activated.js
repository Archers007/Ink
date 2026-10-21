// "{exert}, 2 {ink}, Banish this item — effect"   { kind:'activated', cost:{…}, once?, do:[step] }
import { Kind, modsOf, sayDuring } from './Kind.js';
import { Query } from '../query.js';

// cost key → [phrase regex, (m, c, at) => value, runs?, words]
const COSTS = {
  exert: [/^\{exert\}$/, () => true, true, () => '{exert}'],
  ink: [/^(\d+) \{ink\}$/, (m) => +m[1], true, (v) => `${v} {ink}`],
  banishSelf: [/^banish this (?:item|character|location)$/i, () => true, true, () => 'banish this'],
  discard: [/^(?:choose and )?discard (?:a|an) (.+)$/i, (m, c, at) => (m[1].toLowerCase() === 'card' ? {} : c.filter(m[1], at)), true, (v) => `discard a ${Query.describe(v)}`],
  exertOther: [/^exert (?:one of your|an?) (.+)$/i, (m, c, at) => c.filter(m[1], at), false, (v) => `exert a ${Query.describe(v)}`],
  healSelf: [/^remove (\d+) damage from this character$/i, (m) => +m[1], false, (v) => `remove ${v} damage from this`],
  inkSelf: [/^put this (?:character|item) into your inkwell facedown$/i, () => true, false, () => 'put this into your inkwell'],
};
export const COST_SUPPORT = new Set(Object.entries(COSTS).filter(([, v]) => v[2]).map(([k]) => k));
const HEAD = /^((?:\{exert\}|\d+ \{ink\}|banish this (?:item|character|location)|choose and discard (?:a|an?) (?:\w+ )?card|discard (?:a|an?) (?:\w+ )?card|exert (?:one of your|an?|\d+) [^—]+?|put [^—]+? into your inkwell facedown|remove \d+ damage from this character|[, ]+)+) — (.+)$/i;

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
    return [X.tag('activated'), `COST ${cost}${sayDuring(p)}`, ...p.do.map((st, i) => `${i + 1}. ${X.step(st)}`)];
  }

  // runtime: pay the costs and queue the effect. false → not runnable (manual)
  static activate(rt, s, seat, c, index, ev) {
    const { E } = rt;
    const d = E.D(s, c);
    const proc = rt.procsOf(s, c)[index];
    if (!proc || proc.kind !== 'activated' || !proc.exec) return false;
    const cost = proc.cost;
    if (proc.once) { c.once ||= {}; if (c.once[index] === s.turn) throw E.RE('This ability can only be used once per turn.'); }
    if (cost.exert) {
      if (d.type === 'location') throw E.RE("Locations can't exert.");
      if (c.exerted) throw E.RE('It is exerted — this ability costs ⟳.');
      if (d.type === 'character' && c.drying) throw E.RE("Characters can't ⟳ the turn they're played (drying).");
    }
    if (cost.discard && !E.P(s, seat).hand.some((iid) => rt.matches(s, { ...cost.discard, zone: 'hand' }, s.cards[iid], seat, c.iid))) throw E.RE('You have no card to discard for this cost.');
    E.payInk(s, seat, cost.ink || 0);
    const paid = [];
    if (cost.exert) { c.exerted = true; paid.push('⟳'); }
    if (cost.ink) paid.push(`${cost.ink} ink`);
    if (proc.once) c.once[index] = s.turn;
    rt.log(s, `${E.nameOf(s, seat)} used ${E.cardLabel(d)}'s ${proc.name || 'ability'}${paid.length ? ` (paid ${paid.join(' + ')})` : ''}.`, { seat, kind: 'play' });
    ev.push({ k: 'ability', iid: c.iid, index });
    const steps = [...(cost.discard ? [{ fn: 'discard', who: 'you', n: 1, filter: cost.discard }] : []), ...proc.do];
    if (cost.banishSelf) { rt.log(s, `↳ ${E.cardLabel(d)} was banished to pay for it.`, { kind: 'effect' }); E.banish(s, c.iid, ev, 'cost'); }
    rt.queue(s, seat, c.iid, rt.labelOf(s, c, proc), steps);
    return true;
  }
}
