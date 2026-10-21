// Always-on rules while the card is in play.   { kind:'static', during?, cond?, effect: step }
//   mod        "Your other Hero characters get +1 {strength}"   (re-applied every state check, until:'static')
//   costMod    "You pay 1 {ink} less to play Princess characters"
//   selfCost   "You pay 2 {ink} less to play this character [for each X]"  (from hand)
//   enters     "This character enters play exerted"
import { Kind, sayDuring } from './Kind.js';
import { sentences } from '../phrases/text.js';
import { Amount } from '../phrases/amount.js';

export const STATIC_FNS = new Set(['mod', 'costMod', 'selfCost', 'enters']);

export class Static extends Kind {
  static kind = 'static';
  static parse(t, c, mods) {
    t = t.replace(/\.$/, '');
    let cond = null;
    let m;
    if ((m = t.match(/^(?:while|if|as long as) (.+?), (.+)$/i))) { cond = c.condition(m[1], t); t = m[2]; }
    if ((m = t.match(/^(.+?) unless (.+)$/i))) { const u = { not: c.condition(m[2], t) }; cond = cond ? { all: [cond, u] } : u; t = m[1]; }
    // "this character may enter play exerted [to X]" = when you play it, you may exert it [to X]
    if ((m = t.match(/^this character may enter play exerted(?: to (.+))?$/i))) {
      const steps = [{ fn: 'exert', sel: { self: true }, may: true }, ...(m[1] ? c.effects(m[1]).map((x, i) => (i === 0 ? { ...x, ifDid: true } : x)) : [])];
      return { kind: 'triggered', ...mods, on: [{ ev: 'play' }], ...(cond ? { cond } : {}), do: steps };
    }
    const wrap = (effect) => ({ kind: 'static', ...mods, ...(cond ? { cond } : {}), effect });
    if ((m = t.match(/^for each (.+?), you pay (\d+) \{ink\} less to play this character$/i))) return wrap({ fn: 'selfCost', n: +m[2], per: Amount.forEach(m[1], t) });
    if ((m = t.match(/^you pay (\d+) \{ink\} less to play this (?:character|item|location)$/i))) return wrap({ fn: 'selfCost', n: +m[1] });
    if ((m = t.match(/^this (?:character|item|location) enters play (exerted|with (\d+) damage)$/i))) return wrap({ fn: 'enters', ...(m[2] ? { damage: +m[2] } : { exerted: true }) });
    // location statics: "characters get +2 {strength} while here" → the characters at this location
    let here = false;
    if ((m = t.match(/^(.+?) while here$/i))) { here = true; t = m[1]; }
    const parts = sentences(t);
    if (parts.length === 1) {
      const eff = c.clause(parts[0], { static: true });
      if (here && eff.sel?.all) (eff.sel.all.with ||= []).push({ here: true });
      else if (here) c.miss('static: "while here" without a group', t);
      if (eff.sel?.ref) eff.sel = { self: true };            // static "he/she/it gets …" = this card
      if (eff.fn === 'mod' || eff.fn === 'costMod') {
        if (eff.dur) c.miss('static with a duration', t);
        return wrap(eff);
      }
    }
    c.miss(`static: "${t}"`, t);
  }
  static check(p, missing, S) { if (!S.static.has(p.effect.fn)) missing.add(`static ${p.effect.fn}`); }
  static explain(p, X) { return [X.tag('static'), `${p.cond ? `WHILE ${X.cond(p.cond)}: ` : 'ALWAYS: '}${X.step(p.effect)}${sayDuring(p)}`]; }

  // runtime: is this static on (its turn window + condition)?
  static active(rt, s, proc, owner, src) { return proc.kind === 'static' && proc.exec && rt.duringOk(s, proc, owner) && rt.test(s, proc.cond, owner, src); }

  // runtime: re-apply every "mod" static on the board
  static apply(rt, s) {
    for (const p of s.players) for (const iid of p.play) {
      const c = s.cards[iid];
      if (c.mods.some((m) => m.until === 'static')) c.mods = c.mods.filter((m) => m.until !== 'static');
    }
    for (const p of s.players) for (const iid of p.play) {
      const c = s.cards[iid];
      for (const proc of rt.procsOf(s, c)) {
        if (proc.kind !== 'static' || proc.effect.fn !== 'mod' || !Static.active(rt, s, proc, c.owner, c.iid)) continue;
        const st = proc.effect;
        const job = { seat: c.owner, src: c.iid, label: rt.labelOf(s, c, proc), ctx: { it: [] }, tmp: {} };
        const ids = st.sel.self ? [c.iid] : st.sel.all ? rt.candidates(s, st.sel.all, c.owner, c.iid) : [];
        const mult = st.per ? Amount.count(rt, s, st.per, c.owner, c.iid) : 1;
        for (const id of ids) rt.addMods(s, job, st, id, null, mult);
      }
    }
  }

  // runtime: ink cost change for playing `c` from hand (its own selfCost, board costMods, one-shot costMods)
  static costDelta(rt, s, seat, c, consume) {
    let delta = 0;
    for (const proc of rt.procsOf(s, c)) {
      if (proc.kind === 'static' && proc.exec && proc.effect.fn === 'selfCost' && rt.test(s, proc.cond, seat, c.iid)) {
        delta -= proc.effect.n * (proc.effect.per ? Amount.count(rt, s, proc.effect.per, seat, c.iid) : 1);
      }
      if (proc.kind === 'action' && proc.playCost && proc.exec && rt.test(s, proc.playCost.cond, seat, c.iid)) delta -= proc.playCost.n;
    }
    for (const iid of rt.E.P(s, seat).play) {
      const src = s.cards[iid];
      for (const proc of rt.procsOf(s, src)) {
        if (proc.kind === 'static' && proc.effect.fn === 'costMod' && Static.active(rt, s, proc, seat, iid)
          && rt.matches(s, proc.effect.filter, c, seat, iid, { anyZone: true })) delta -= proc.effect.n;
      }
    }
    const p = rt.E.P(s, seat);
    p.costMods = (p.costMods || []).filter((m) => m.turn === s.turn);
    for (const m of [...p.costMods]) {
      if (!rt.matches(s, m.filter, c, seat, null, { anyZone: true })) continue;
      delta -= m.n;
      if (consume && m.next) p.costMods.splice(p.costMods.indexOf(m), 1);
    }
    return delta;
  }

  // runtime: "enters play exerted / with N damage"
  static onEnter(rt, s, c) {
    for (const proc of rt.procsOf(s, c)) {
      if (proc.kind !== 'static' || !proc.exec || proc.effect.fn !== 'enters') continue;
      if (proc.effect.exerted) c.exerted = true;
      if (proc.effect.damage) c.damage += proc.effect.damage;
    }
  }
}
