import { Effect } from './Effect.js';
import { Amount } from '../phrases/amount.js';
import { Selector } from '../phrases/selector.js';

export class Damage extends Effect {
  static fn = 'damage';
  static harmful = true;
  static rules = [
    [/^deal (\d+) damage to (.+)$/i, (m, P) => ({ fn: 'damage', n: +m[1], sel: P.sel(m[2]) })],
    [/^deal (?:that much|the same amount of) damage to (.+)$/i, (m, P) => ({ fn: 'damage', n: { last: true }, sel: P.sel(m[1]) })],
    [/^deal damage equal to (?:their|his|her|its|this character's) \{strength\} to (.+)$/i, (m, P) => ({ fn: 'damage', n: { stat: 'str', of: P.ctx.refIsSelf ? 'self' : 'ref' }, sel: P.sel(m[1]) })],
    [/^deal damage to (.+?) equal to (?:their|his|her|its|this character's) \{strength\}$/i, (m, P) => ({ fn: 'damage', n: { stat: 'str', of: P.ctx.refIsSelf ? 'self' : 'ref' }, sel: P.sel(m[1]) })],
    [/^deal (\d+) damage to (.+?) for each (.+)$/i, (m, P) => ({ fn: 'damage', n: { n: +m[1], per: P.forEach(m[3]) }, sel: P.sel(m[2]) })],
    [/^put (\d+) damage(?: counters?)? on (.+)$/i, (m, P) => ({ fn: 'damage', n: +m[1], sel: P.sel(m[2]), put: true })],
  ];
  static run(rt, s, job, st, ev) {
    const ids = rt.targets(s, job, st, st.sel);
    if (!ids) return null;
    const n0 = Amount.value(rt, s, job, st.n);
    job.ctx.it = ids;
    job.ctx.n = n0;                                                    // "deal that much damage to …" next
    return rt.each(ids, (iid) => {
      const c = s.cards[iid]; const d = rt.E.D(s, c);
      const safe = !st.put && (rt.E.hasKw(c, d, 'noDamage') || rt.E.hasKw(c, d, 'noEffectDamage'));
      const n = safe ? 0 : st.put || st.noResist ? n0 : Math.max(0, n0 - rt.E.kwVal(c, d, 'resist'));          // Resist (8.8) — not for "put damage"
      c.damage += n;
      if (n) { ev.push({ k: 'damage', iid, n }); rt.fire(s, 'damaged', { iid, n, by: job.src }); }
      rt.log(s, `↳ ${st.put ? 'Put' : 'Dealt'} ${n} damage ${st.put ? 'on' : 'to'} ${rt.tl(s, iid)}.`, { seat: job.seat, kind: 'effect' });
    });
  }
  static verb(rt, s, job, st) { return `deal ${typeof st.n === 'number' ? st.n : 'that much'} damage`; }
  static say(st) { return `${st.put ? 'put' : 'deal'} ${Amount.say(st.n)} damage ${st.put ? 'on' : 'to'} ${Selector.say(st.sel)}${st.noResist ? " (Resist can't reduce it)" : ''}`; }
}
export class Heal extends Effect {
  static fn = 'heal';
  static rules = [
    [/^remove up to (\d+) damage from (.+)$/i, (m, P) => ({ fn: 'heal', n: +m[1], sel: P.sel(m[2]) })],
    [/^remove (\d+) damage from (.+)$/i, (m, P) => ({ fn: 'heal', n: +m[1], sel: P.sel(m[2]) })],
    [/^remove all damage from (.+)$/i, (m, P) => ({ fn: 'heal', n: 99, sel: P.sel(m[1]) })],
  ];
  static run(rt, s, job, st, ev) {
    const ids = rt.targets(s, job, st, st.sel, 'sel', { keep: (iid) => s.cards[iid].damage > 0 });
    if (!ids) return null;
    job.ctx.it = ids;
    job.ctx.healed = 0;
    return rt.each(ids, (iid) => {
      const c = s.cards[iid];
      const n = Math.min(Amount.value(rt, s, job, st.n), c.damage);
      c.damage -= n; job.ctx.healed += n; job.ctx.n = job.ctx.healed;
      if (n) { ev.push({ k: 'damage', iid, n: -n }); rt.fire(s, 'healed', { iid, n, seat: job.seat }); }
      rt.log(s, `↳ Removed ${n} damage from ${rt.tl(s, iid)}.`, { seat: job.seat, kind: 'effect' });
    });
  }
  static verb(rt, s, job, st) { return `remove up to ${st.n} damage`; }
  static say(st) { return `remove ${st.n === 99 ? 'all' : `up to ${Amount.say(st.n)}`} damage from ${Selector.say(st.sel)}`; }
}
export class MoveDamage extends Effect {
  static fn = 'moveDamage';
  static rules = [[/^move (?:up to )?(\d+) damage(?: counters?)? from (.+?) to (.+)$/i, (m, P) => ({ fn: 'moveDamage', n: +m[1], from: P.sel(m[2]), to: P.sel(m[3]) })]];
  static chooses(st) { return !!(st.from?.chosen || st.to?.chosen); }
  static run(rt, s, job, st, ev) {
    const from = rt.targets(s, job, st, st.from, 'from', { keep: (iid) => s.cards[iid].damage > 0, verb: `move ${st.n} damage from` });
    if (!from) return null;
    if (!from.length) return false;
    const to = rt.targets(s, job, st, st.to, 'to', { keep: (iid) => !from.includes(iid), verb: `move ${st.n} damage to` });
    if (!to) return null;
    if (!to.length) return false;
    const b = s.cards[to[0]];
    job.ctx.n = 0;
    for (const id of from.filter((x) => x !== b.iid)) {       // "from each damaged character …" moves from all of them
      const a = s.cards[id];
      const n = Math.min(st.n, a.damage);
      if (!n) continue;
      a.damage -= n; b.damage += n;
      ev.push({ k: 'damage', iid: a.iid, n: -n }, { k: 'damage', iid: b.iid, n });
      rt.log(s, `↳ Moved ${n} damage from ${rt.tl(s, a.iid)} to ${rt.tl(s, b.iid)}.`, { seat: job.seat, kind: 'effect' });
      job.ctx.n += n;
    }
    job.ctx.it = [b.iid];
    return job.ctx.n > 0;
  }
  static say(st) { return `move ${st.n} damage from ${Selector.say(st.from)} to ${Selector.say(st.to)}`; }
}
