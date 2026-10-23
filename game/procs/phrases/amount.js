// How many:  2 · { stat, of:'self'|'ref' } ("damage equal to their {strength}") · per: { count: … } ("for each X")
import { miss, N, STAT_WORD } from './text.js';
import { filter } from './filter.js';
import { Query } from '../query.js';
import { Did } from '../conditions/exists.js';

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
    // "for each card under him" · "for each card that was under them" (it left play — what was under it then)
    if ((m = p.match(/^card (that (?:was|were) )?under (this character|him|her|it|them)$/i))) return { count: { under: true, ...(m[1] ? { was: true } : {}), ...(/^them$/i.test(m[2]) ? { pron: true } : {}) } };
    if (/^(?:1 )?damage on (?:this character|him|her|it)$/i.test(p)) return { count: { damageOnSelf: true } };
    if (/^(?:1 )?damage on (?:them|that character)$/i.test(p)) return { count: { damageOnRef: true } };
    if ((m = p.match(/^(?:1 )?damage on (.+)$/i))) return { count: { damageOn: filter(m[1], at) } };
    if ((m = p.match(/^lore you have$/i))) return { count: { lore: true } };
    if (/^(?:opponent|player) who (?:doesn't|didn't|does not)$/i.test(p)) return { count: { didnt: true } };   // after "each opponent may …"
    if ((m = p.match(/^different ink type of (.+)$/i))) return { count: { inks: filter(m[1], at) } };
    // "for each 1 damage removed this way" · "for each damage counter moved this way" · "for each 1 lore lost this way"
    if (/^(?:1 )?(?:damage(?: counter)?|lore|card) (?:removed|moved|lost|discarded|put \w+) this way$/i.test(p)) return { count: { thisWay: true } };
    // "for each item banished this way" · "for each item card put into your discard this way" — what the last step moved
    if ((m = p.match(/^(.+?) (?:banished|put into (?:your|their) discard|discarded|moved|returned|revealed|exerted|readied) this way$/i))) return { count: { thisWayOf: filter(m[1], at) } };
    // "for each opposing character banished in a challenge this turn" — the turn log, counted like the "did" condition
    const did = Did.rules[0][0].exec(p);
    if (did) { const C = Did.rules[0][1](did, at); if (C) return { count: { did: C } }; }
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
    if (n && n.per) return n.n * Amount.count(rt, s, n.per, job.seat, job.src, job);
    if (n && n.healed) return job.ctx.healed || 0;
    if (n && n.itCount) return (job.ctx.it || []).length + (n.plus || 0);   // "that number of cards [plus 1]"
    if (n && n.last) return job.ctx.n || 0;                                // "that much" — what the last step dealt / lost
    return 0;
  }
  static count(rt, s, per, ctl, src, job) {
    const c = per.count;
    const me = s.cards[src];
    if (c.thisWayOf) return (job?.ctx.it || []).filter((id) => rt.matches(s, c.thisWayOf, s.cards[id], ctl, src, { anyZone: true })).length;
    if (c.did) return Did.count(rt, s, c.did, { ctl, src, job });
    if (c.didnt) return job?.ctx.tally?.didnt.length || 0;
    if (c.under) {
      const ref = c.pron && (job?.ctx.it || [])[0] != null && !job.ctx.selfSubj ? s.cards[job.ctx.it[0]] : me;   // "them": the card the trigger is about
      return ref ? (c.was ? ref.lastUnder || [] : ref.under).length : 0;
    }
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
    if (n?.itCount) return `that many${n.plus ? ` plus ${n.plus}` : ''}`;
    if (n?.last) return 'that much';
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
    if (c.thisWayOf) return `${Query.describe(c.thisWayOf)} done this way`;
    if (c.did) return `${Query.describe(c.did.of || {})} ${c.did.did} this turn`;
    if (c.size) return `card in ${c.owner === 'opp' ? "opponents'" : 'your'} ${c.zone}`;
    return Query.describe(c);
  }
}
