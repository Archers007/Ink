// How many:  2 · { stat, of:'self'|'ref' } ("damage equal to their {strength}") · per: { count: … } ("for each X")
import { miss, N, STAT_WORD } from './text.js';
import { filter } from './filter.js';
import { Query } from '../query.js';

export class Amount {
  static parse(phrase, at) {
    const n = N(phrase.trim());
    if (n != null) return n;
    miss(`amount: "${phrase.trim()}"`, at);
  }
  // "for each other Villain character you have in play" → { count: Query | {under} | {damageOnSelf} | {zone, owner} }
  static forEach(phrase, at) {
    const p = phrase.trim();
    let m;
    if ((m = p.match(/^card in (your|an opponent's|each opponent's) (hand|discard)$/i))) return { count: { zone: m[2], owner: m[1] === 'your' ? 'you' : 'opp', size: true } };
    if ((m = p.match(/^(.+?) card in your (discard|hand)$/i))) { const F = filter(m[1] + ' card', at); F.zone = m[2]; F.owner = 'you'; return { count: F }; }
    if (/^card under (?:this character|him|her|it)$/i.test(p)) return { count: { under: true } };
    if (/^(?:1 )?damage on (?:this character|him|her|it)$/i.test(p)) return { count: { damageOnSelf: true } };
    if ((m = p.match(/^lore you have$/i))) return { count: { lore: true } };
    return { count: filter(p, at) };
  }
  static value(rt, s, job, n) {
    if (typeof n === 'number') return n;
    if (n && n.stat) {
      const id = n.of === 'self' ? job.src : (job.ctx.it || [])[0];
      const c = s.cards[id];
      if (!c) return 0;
      const d = rt.E.D(s, c);
      return Math.max(0, n.stat === 'str' ? rt.E.effStr(c, d) : n.stat === 'lore' ? rt.E.effLore(c, d) : n.stat === 'cost' ? d.cost : rt.E.effWp(c, d));
    }
    if (n && n.per) return n.n * Amount.count(rt, s, n.per, job.seat, job.src);
    if (n && n.healed) return job.ctx.healed || 0;
    return 0;
  }
  static count(rt, s, per, ctl, src) {
    const c = per.count;
    const me = s.cards[src];
    if (c.under) return me ? me.under.length : 0;
    if (c.damageOnSelf) return me ? me.damage : 0;
    if (c.lore) return rt.E.P(s, ctl).lore;
    if (c.size) {
      const seats = c.owner === 'opp' ? rt.E.opponentsOf(s, ctl) : [ctl];
      return seats.reduce((n, seat) => n + rt.E.P(s, seat)[c.zone].length, 0);
    }
    return rt.candidates(s, c, ctl, src).length;
  }
  static say(n) {
    if (typeof n === 'number') return n;
    if (n?.stat) return `${n.of === 'self' ? "this card's" : 'their'} ${n.stat === 'cost' ? 'cost' : STAT_WORD[n.stat]}`;
    if (n?.per) return `${n.n} for each ${Amount.sayPer(n.per)}`;
    if (n?.healed) return 'the damage removed';
    return '?';
  }
  static sayPer(per) {
    const c = per.count;
    if (c.under) return 'card under this';
    if (c.damageOnSelf) return 'damage on this';
    if (c.lore) return 'lore you have';
    if (c.size) return `card in ${c.owner === 'opp' ? "opponents'" : 'your'} ${c.zone}`;
    return Query.describe(c);
  }
}
