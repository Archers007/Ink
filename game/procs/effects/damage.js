import { Effect } from './Effect.js';
import { Amount } from '../phrases/amount.js';
import { Selector } from '../phrases/selector.js';

export class Damage extends Effect {
  static fn = 'damage';
  static harmful = true;
  static rules = [
    [/^deal (\d+) damage to (.+?) for each (.+)$/i, (m, P) => ({ fn: 'damage', n: { n: +m[1], per: P.forEach(m[3]) }, sel: P.sel(m[2]) })],
    [/^deal (\d+) damage to (.+)$/i, (m, P) => ({ fn: 'damage', n: +m[1], sel: P.sel(m[2]) })],
    [/^deal (?:that much|the same amount of) damage to (.+)$/i, (m, P) => ({ fn: 'damage', n: { last: true }, sel: P.sel(m[1]) })],
    [/^deal damage equal to (?:their|his|her|its|this character's) \{strength\} to (.+)$/i, (m, P) => ({ fn: 'damage', n: { stat: 'str', of: P.ctx.refIsSelf ? 'self' : 'ref' }, sel: P.sel(m[1]) })],
    [/^deal damage to (.+?) equal to (?:their|his|her|its|this character's) \{strength\}$/i, (m, P) => ({ fn: 'damage', n: { stat: 'str', of: P.ctx.refIsSelf ? 'self' : 'ref' }, sel: P.sel(m[1]) })],
    [/^put (\d+|a) damage(?: counters?)? on (.+)$/i, (m, P) => ({ fn: 'damage', n: m[1] === 'a' ? 1 : +m[1], sel: P.sel(m[2]), put: true })],
  ];
  static run(rt, s, job, st, ev) {
    const got = rt.targets(s, job, st, st.sel);
    if (!got) return null;
    const ids = got.filter((iid) => s.cards[iid].zone === 'play');          // only cards in play take damage ("put 1 damage on it" after it was banished)
    const n0 = Amount.value(rt, s, job, st.n);
    job.ctx.it = ids;
    job.ctx.n = n0;                                                    // "deal that much damage to …" next
    return rt.each(ids, (iid) => {
      const c = s.cards[iid]; const d = rt.E.D(s, c);
      const safe = !st.put && (rt.E.hasKw(c, d, 'noDamage') || rt.E.hasKw(c, d, 'noEffectDamage'));
      const n = safe ? 0 : st.put || st.noResist ? n0 : Math.max(0, n0 - rt.E.kwVal(c, d, 'resist'));          // Resist (8.8) — not for "put damage"
      rt.log(s, `↳ ${st.put ? 'Put' : 'Dealt'} ${n} damage ${st.put ? 'on' : 'to'} ${rt.tl(s, iid)}.`, { seat: job.seat, kind: 'effect' });
      if (st.put) { c.damage += n; if (n) ev.push({ k: 'damage', iid, n }); }       // counters, not "dealt" — no replacement, no trigger
      else rt.E.dealDamage(s, iid, n, ev, { by: job.src });
    });
  }
  static verb(rt, s, job, st) { return `deal ${typeof st.n === 'number' ? st.n : 'that much'} damage`; }
  static say(st) { return `${st.put ? 'put' : 'deal'} ${Amount.say(st.n)} damage ${st.put ? 'on' : 'to'} ${Selector.say(st.sel)}${st.noResist ? " (Resist can't reduce it)" : ''}`; }
}
export class Heal extends Effect {
  static fn = 'heal';
  static rules = [
    // "remove up to 4 damage total from any number of your characters" — one pool, spent in the order picked
    [/^remove up to (\d+) damage total from any number of (.+)$/i, (m, P) => ({ fn: 'heal', n: +m[1], total: true, sel: { chosen: P.filter(m[2].replace(/^your /i, 'your ')), upTo: 99 } })],
    [/^remove up to (\d+) damage from (.+)$/i, (m, P) => ({ fn: 'heal', n: +m[1], sel: P.sel(m[2]), upTo: true })],
    [/^remove (\d+) damage from (.+)$/i, (m, P) => ({ fn: 'heal', n: +m[1], sel: P.sel(m[2]) })],
    [/^remove all damage from (.+)$/i, (m, P) => ({ fn: 'heal', n: 99, sel: P.sel(m[1]) })],
  ];
  static run(rt, s, job, st, ev) {
    // any character can be chosen, damaged or not — 0 is removed, and "ready it" / "it gains Resist" still apply (Try
    // Everything, Penny - Bolt's Person); only the pooled "up to N total from any number" picks among damaged ones
    const ids = rt.targets(s, job, st, st.sel, 'sel', st.total ? { keep: (iid) => s.cards[iid].damage > 0 } : {});
    if (!ids) return null;
    // "remove up to 3 damage" from one card: the player says how much, 0 included (Pluto - Determined Defender ruling)
    let chosen = null;
    if (st.upTo && !st.total && ids.length === 1) {
      const c = s.cards[ids[0]];
      const max = rt.rule(s, 'removeDamage', c.owner) ? Math.min(Amount.value(rt, s, job, st.n), c.damage) : 0;
      if (max > 0) {
        if (job.answer?.key !== 'healN') { job.waitKey = 'healN'; return rt.ask(s, job, { op: 'amount', choices: Array.from({ length: max + 1 }, (_, k) => `${max - k}`), prompt: `remove how much damage from ${rt.tl(s, c.iid)}?` }); }
        chosen = max - (job.answer.option ?? 0); job.answer = null;
      }
    }
    job.ctx.it = ids;
    job.ctx.healed = 0;
    job.ctx.healedIds = [];                                            // "each character you removed damage from this way"
    return rt.each(ids, (iid) => {
      const c = s.cards[iid];
      const cap = chosen != null ? chosen : st.total ? Amount.value(rt, s, job, st.n) - job.ctx.healed : Amount.value(rt, s, job, st.n);
      const n = rt.rule(s, 'removeDamage', c.owner) ? Math.max(0, Math.min(cap, c.damage)) : 0;   // "damage counters can't be removed"
      c.damage -= n; job.ctx.healed += n; job.ctx.n = job.ctx.healed;
      if (n) { ev.push({ k: 'damage', iid, n: -n }); rt.fire(s, 'healed', { iid, n, seat: job.seat }); job.ctx.healedIds.push(iid); }
      rt.log(s, `↳ Removed ${n} damage from ${rt.tl(s, iid)}.`, { seat: job.seat, kind: 'effect' });
    });
  }
  static verb(rt, s, job, st) { return `remove up to ${st.n} damage`; }
  static say(st) { return `remove ${st.n === 99 ? 'all' : `${st.upTo || st.total ? 'up to ' : ''}${Amount.say(st.n)}${st.total ? ' total' : ''}`} damage from ${Selector.say(st.sel)}`; }
}
export class MoveDamage extends Effect {
  static fn = 'moveDamage';
  static rules = [
    [/^move (up to )?(\d+) damage(?: counters?)? from (.+?) to (.+)$/i, (m, P) => ({ fn: 'moveDamage', n: +m[2], from: P.sel(m[3]), to: P.sel(m[4]), ...(m[1] ? { upTo: true } : {}) })],
    // "move all damage counters from all other characters to that character" (CR 1.9.2: damage can be moved)
    [/^move all damage(?: counters)? from (.+?) to (.+)$/i, (m, P) => ({ fn: 'moveDamage', n: 99, from: P.sel(m[1]), to: P.sel(m[2]) })],
  ];
  static chooses(st) { return !!(st.from?.chosen || st.to?.chosen); }
  static run(rt, s, job, st, ev) {
    const from = rt.targets(s, job, st, st.from, 'from', { keep: (iid) => s.cards[iid].damage > 0, verb: `move ${st.n} damage from` });
    if (!from) return null;
    if (!from.length) return false;
    const to = rt.targets(s, job, st, st.to, 'to', { keep: (iid) => !from.includes(iid), verb: `move ${st.n} damage to` });
    if (!to) return null;
    if (!to.length) return false;
    const b = s.cards[to[0]];
    const srcs = from.filter((x) => x !== b.iid);
    // "move up to 2 damage" from one card: the player says how much
    let cap = st.n;
    if (st.upTo && srcs.length === 1) {
      const max = Math.min(st.n, s.cards[srcs[0]].damage);
      if (max > 1) {
        if (job.answer?.key !== 'moveN') { job.waitKey = 'moveN'; return rt.ask(s, job, { op: 'amount', choices: Array.from({ length: max + 1 }, (_, k) => `${max - k}`), prompt: `move how much damage from ${rt.tl(s, srcs[0])} to ${rt.tl(s, b.iid)}?` }); }
        cap = max - (job.answer.option ?? 0); job.answer = null;
      }
    }
    job.ctx.n = 0;
    for (const id of srcs) {                                  // "from each damaged character …" moves from all of them
      const a = s.cards[id];
      const n = Math.min(cap, a.damage);
      if (!n) continue;
      a.damage -= n; b.damage += n;
      ev.push({ k: 'damage', iid: a.iid, n: -n }, { k: 'damage', iid: b.iid, n });
      rt.log(s, `↳ Moved ${n} damage from ${rt.tl(s, a.iid)} to ${rt.tl(s, b.iid)}.`, { seat: job.seat, kind: 'effect' });
      rt.fire(s, 'healed', { iid: a.iid, n, seat: job.seat, moved: true });   // moving damage removes it from the first card (Pepa - Calm Before the Storm ruling)
      job.ctx.n += n;
    }
    job.ctx.it = [b.iid];
    return job.ctx.n > 0;
  }
  static say(st) { return `move ${st.n === 99 ? 'all' : `${st.upTo ? 'up to ' : ''}${st.n}`} damage from ${Selector.say(st.from)} to ${Selector.say(st.to)}`; }
}
