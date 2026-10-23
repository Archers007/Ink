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
    if (/^(?:1 )?damage on (?:them|that character)$/i.test(p)) return { count: { damageOnRef: true } };
    if ((m = p.match(/^(?:1 )?damage on (.+)$/i))) return { count: { damageOn: filter(m[1], at) } };
    if ((m = p.match(/^lore you have$/i))) return { count: { lore: true } };
    if ((m = p.match(/^different ink type of (.+)$/i))) return { count: { inks: filter(m[1], at) } };
    // "for each 1 damage removed this way" · "for each damage counter moved this way" · "for each 1 lore lost this way"
    if (/^(?:1 )?(?:damage(?: counter)?|lore|card) (?:removed|moved|lost|discarded|put \w+) this way$/i.test(p)) return { count: { thisWay: true } };
    return { count: filter(p, at) };
  }
  static value(rt, s, job, n) {
    if (typeof n === 'number') return n;
    if (n && n.stat) {
      let id = n.of === 'self' ? job.src : (job.ctx.it || [])[0];
      if (n.of === 'loc') {                                     // "that location's {lore}"
        const x = s.cards[id];
        id = x && rt.E.D(s, x).type === 'location' ? id : (x?.atLocation || s.cards[job.src]?.atLocation);
      }
      const c = s.cards[id];
      if (!c) return 0;
      const d = rt.E.D(s, c);
      const v = Math.max(0, n.stat === 'str' ? rt.E.effStr(c, d) : n.stat === 'lore' ? rt.E.effLore(c, d) : n.stat === 'cost' ? d.cost : n.stat === 'damage' ? c.damage : rt.E.effWp(c, d));
      return n.max != null ? Math.min(v, n.max) : v;
    }
    if (n && n.per?.count?.thisWay) return n.n * (job.ctx.n || 0);
    if (n && n.per) return n.n * Amount.count(rt, s, n.per, job.seat, job.src);
    if (n && n.healed) return job.ctx.healed || 0;
    return 0;
  }
  static count(rt, s, per, ctl, src) {
    const c = per.count;
    const me = s.cards[src];
    if (c.under) return me ? me.under.length : 0;
    if (c.damageOnSelf) return me ? me.damage : 0;
    if (c.damageOnRef) return 0;                                      // counted per target by the effect
    if (c.damageOn) return rt.candidates(s, c.damageOn, ctl, src).reduce((n, id) => n + (s.cards[id].damage || 0), 0);
    if (c.lore) return rt.E.P(s, ctl).lore;
    if (c.inks) return new Set(rt.candidates(s, c.inks, ctl, src).flatMap((id) => rt.E.D(s, s.cards[id]).inks || [])).size;
    if (c.size) {
      const seats = c.owner === 'opp' ? rt.E.opponentsOf(s, ctl) : [ctl];
      return seats.reduce((n, seat) => n + rt.E.P(s, seat)[c.zone].length, 0);
    }
    return rt.candidates(s, c, ctl, src).length;
  }
  static say(n) {
    if (typeof n === 'number') return n;
    if (n?.stat) return `${n.of === 'self' ? "this card's" : n.of === 'loc' ? "that location's" : "that card's"} ${n.stat === 'cost' ? 'cost' : n.stat === 'damage' ? 'damage' : STAT_WORD[n.stat]}${n.max != null ? ` (max ${n.max})` : ''}`;
    if (n?.per) return `${n.n} for each ${Amount.sayPer(n.per)}`;
    if (n?.healed) return 'the damage removed';
    return '?';
  }
  static sayPer(per) {
    const c = per.count;
    if (c.thisWay) return 'one done this way';
    if (c.under) return 'card under this';
    if (c.damageOnSelf) return 'damage on this';
    if (c.damageOnRef) return 'damage on that card';
    if (c.damageOn) return `1 damage on ${Query.describe(c.damageOn)}`;
    if (c.lore) return 'lore you have';
    if (c.inks) return `different ink type of ${Query.describe(c.inks)}`;
    if (c.size) return `card in ${c.owner === 'opp' ? "opponents'" : 'your'} ${c.zone}`;
    return Query.describe(c);
  }
}
