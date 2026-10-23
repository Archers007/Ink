// Always-on rules while the card is in play.   { kind:'static', during?, cond?, effect: step }
//   mod        "Your other Hero characters get +1 {strength}"   (re-applied every state check, until:'static')
//   costMod    "You pay 1 {ink} less to play Princess characters"
//   selfCost   "You pay 2 {ink} less to play this character [for each X]"  (from hand)
//   enters     "This character enters play exerted"
//   shiftAs    "This character also counts as being named Syndrome for Shift" · "You can shift any character on top of this character"
//   moveCost   "Your Pirate characters may move here for free" · "You pay 1 {ink} less to move your characters to a location"
import { Kind, sayDuring } from './Kind.js';
import { sentences } from '../phrases/text.js';
import { Amount } from '../phrases/amount.js';
import { Query } from '../query.js';
import { PlayBan } from '../effects/playBan.js';
import { parseRule } from '../../rulebook/rules.js';
import { parseDeckRule } from '../../rulebook/deck.js';

export const STATIC_FNS = new Set(['mod', 'costMod', 'selfCost', 'enters', 'playBan', 'selfBan', 'shiftAs', 'moveCost', 'rule', 'deck']);

export class Static extends Kind {
  static kind = 'static';
  static parse(t, c, mods) {
    t = t.replace(/\.$/, '');
    let cond = null;
    let m;
    if ((m = t.match(/^(?:while|if|as long as) (.+?), (.+)$/i))) { cond = c.condition(m[1], t); t = m[2]; }
    if ((m = t.match(/^(.+?) unless (.+)$/i))) { const u = { not: c.condition(m[2], t) }; cond = cond ? { all: [cond, u] } : u; t = m[1]; }
    if (!cond && (m = t.match(/^(.+?) while (?!here$|challenging)(.+)$/i))) { try { cond = c.condition(m[2], t); t = m[1]; } catch { /* not a condition */ } }
    // "this character may enter play exerted [to X]" = when you play it, you may exert it [to X]
    if ((m = t.match(/^this character may enter play exerted(?: to (.+))?$/i))) {
      const steps = [{ fn: 'exert', sel: { self: true }, may: true }, ...(m[1] ? c.effects(m[1]).map((x, i) => (i === 0 ? { ...x, ifDid: true } : x)) : [])];
      return { kind: 'triggered', ...mods, on: [{ ev: 'play' }], ...(cond ? { cond } : {}), do: steps };
    }
    const wrap = (effect) => ({ kind: 'static', ...mods, ...(cond ? { cond } : {}), effect });
    // a game rule the card changes (game/rulebook/rules.js) — "Opponents need 25 lore to win the game"
    const deck = parseDeckRule(t);                                  // deck construction (CR 1.10.1.3)
    if (deck) return wrap(deck);
    const rule = parseRule(t);
    if (rule) {
      const { unlessText, ...r } = rule;
      // "each opposing player can't gain lore unless one of their characters has challenged this turn": the
      // condition is asked of that player — "their" reads as "your" from their side
      return wrap({ fn: 'rule', ...r, ...(unlessText ? { unless: c.condition(unlessText.replace(/\btheir\b/gi, 'your').replace(/\bthey\b/gi, 'you'), t) } : {}) });
    }
    // "You can't play this character unless …" (the unless is already folded into cond as a not)
    if (/^you can't play this (?:character|action|item|location|song)$/i.test(t)) return wrap({ fn: 'selfBan' });
    if ((m = t.match(/^for each (.+?), you pay (\d+) \{ink\} less to play this character$/i))) return wrap({ fn: 'selfCost', n: +m[2], per: Amount.forEach(m[1], t) });
    if ((m = t.match(/^you pay (\d+) \{ink\} less to play this (?:character|item|location)$/i))) return wrap({ fn: 'selfCost', n: +m[1] });
    // "If you have a character named Lilo in play, you can play this character for free" · "… for free if <condition>"
    if ((m = t.match(/^you (?:may|can) play this (?:character|item|card|location|action|song) for free(?: if (.+))?$/i))) {
      if (m[1]) { const c2 = c.condition(m[1].replace(/ this turn$/i, ' this turn'), t); cond = cond ? { all: [cond, c2] } : c2; }
      return { kind: 'static', ...mods, ...(cond ? { cond } : {}), effect: { fn: 'selfCost', n: 99, free: true } };
    }
    if ((m = t.match(/^this (?:character|item|location) enters play (exerted|with (\d+) damage)$/i))) return wrap({ fn: 'enters', ...(m[2] ? { damage: +m[2] } : { exerted: true }) });
    // "opposing items enter play exerted" · "opposing characters with Singer enter play with 1 damage"
    if ((m = t.match(/^(.+?) enters? play (exerted|with (\d+) damage)$/i))) return wrap({ fn: 'enters', filter: c.filter(m[1], t), ...(m[3] ? { damage: +m[3] } : { exerted: true }) });
    if ((m = t.match(/^this character also counts as being named (.+?) for shift$/i))) return wrap({ fn: 'shiftAs', names: m[1].split(/\s*(?:,|\band\b|\bor\b)\s*/).filter(Boolean) });
    if (/^you can shift any character on top of this character$/i.test(t)) return wrap({ fn: 'shiftAs', any: true });
    // moving: "<movers> may/can move here for free" · "you pay N {ink} less to move <movers> (here|to a location)"
    if ((m = t.match(/^(.+?) (?:may|can) move (here|to a location|to this location) for free$/i))) return wrap({ fn: 'moveCost', who: c.filter(m[1].replace(/^your /i, 'your '), t), ...(/here|this/i.test(m[2]) ? { here: true } : {}), n: 'free' });
    if ((m = t.match(/^(?:you )?pay (\d+) \{ink\} less to move (.+?) (here|to (?:a|this) location|to locations?)$/i))) {
      const who = /^this character$/i.test(m[2]) ? null : c.filter(/^(a|an) /i.test(m[2]) ? m[2].replace(/^an? /i, '') : m[2], t);
      return wrap({ fn: 'moveCost', ...(who ? { who } : {}), ...(/here|this/i.test(m[3]) ? { here: true } : {}), n: +m[1] });
    }
    if (/^you may play any character with shift on this character as if this character had any name$/i.test(t)) return wrap({ fn: 'shiftAs', anyName: true });
    // location statics: "characters get +2 {strength} while here" → the characters at this location
    let here = false;
    if ((m = t.match(/^(.+?) while here$/i))) { here = true; t = m[1]; }
    const parts = sentences(t);
    if (parts.length === 1) {
      // "your characters with Bodyguard gain Resist +1 and get +1 {lore}" — halves that change the same cards are one mod
      let eff;
      try { eff = c.clause(parts[0], { static: true }); } catch (e) {
        const halves = (() => { try { return c.compound(parts[0], { static: true }); } catch { return null; } })();
        if (!halves || halves.length < 2 || !halves.every((h) => h.fn === 'mod' && (h.sel?.ref || JSON.stringify(h.sel) === JSON.stringify(halves[0].sel)))) throw e;
        eff = { ...halves[0], mods: halves.flatMap((h) => h.mods || []), kws: halves.flatMap((h) => h.kws || []) };
        for (const k of ['mods', 'kws']) if (!eff[k].length) delete eff[k];
        delete eff.linked;
      }
      if (here && eff.sel?.all) (eff.sel.all.with ||= []).push({ here: true });
      else if (here) c.miss('static: "while here" without a group', t);
      // "While one of your Knight characters is at a location, that character gains Resist +2" — the pronoun is the
      // condition's subject; otherwise a static "he/she/it gets …" is this card
      if (eff.sel?.ref && cond?.exists && !eff.sel.pron) eff.sel = { all: cond.exists };
      else if (eff.sel?.ref) eff.sel = { self: true };
      if (eff.fn === 'mod' || eff.fn === 'costMod' || eff.fn === 'playBan') {
        if (eff.dur === 'turn' && cond && /"(?:history|did|playedTurn)"/.test(JSON.stringify(cond))) delete eff.dur;   // "If you've played a song this turn, … gains Rush this turn"
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
      if (c.mods.some((m) => m.until === 'static' || m.until === 'src')) c.mods = c.mods.filter((m) => m.until !== 'static' && !(m.until === 'src' && s.cards[m.srcIid]?.zone !== 'play'));
    }
    for (const which of ['own+temp', 'granted-static']) for (const p of s.players) for (const iid of p.play) {
      const c = s.cards[iid];
      for (const proc of rt.procsOf(s, c, which)) {
        if (proc.kind !== 'static' || proc.effect.fn !== 'mod' || !Static.active(rt, s, proc, c.owner, c.iid)) continue;
        const st = proc.effect;
        const job = { seat: c.owner, src: c.iid, label: rt.labelOf(s, c, proc), ctx: { it: [] }, tmp: {} };
        const ids = st.sel.self ? [c.iid] : st.sel.all ? rt.candidates(s, st.sel.all, c.owner, c.iid) : [];
        const mult = st.per ? Amount.count(rt, s, st.per, c.owner, c.iid) : 1;
        for (const id of ids) rt.addMods(s, job, st, id, null, mult);
      }
    }
  }

  // runtime: why `seat` can't play hand card `c` right now (or null) — its own "can't play unless",
  // static bans on the board, and timed bans from effects
  static playBlocked(rt, s, seat, c) {
    const { E } = rt;
    for (const proc of rt.procsOf(s, c)) if (proc.kind === 'static' && proc.exec && proc.effect.fn === 'selfBan' && rt.test(s, proc.cond, seat, c.iid)) return "You can't play this card yet — its condition isn't met.";
    for (const proc of rt.procsOf(s, c)) if (proc.kind === 'action' && proc.exec && proc.playIf && !rt.test(s, proc.playIf, seat, c.iid)) return "You can't play this action yet — its condition isn't met.";
    const hit = (F, ctl) => Query.matches(F, c, E.D(s, c), { E, s, ctl, src: null }, { anyZone: true });
    for (const p of s.players) for (const iid of p.play) {
      const src = s.cards[iid];
      for (const proc of rt.procsOf(s, src)) {
        if (proc.kind !== 'static' || proc.effect.fn !== 'playBan' || !Static.active(rt, s, proc, src.owner, src.iid)) continue;
        const st = proc.effect;
        if ((st.who === 'you') === (seat === src.owner) && hit(st.filter, src.owner)) return `${E.cardLabel(E.D(s, src))} stops you playing that.`;
      }
    }
    for (const b of s.playBans || []) if (b.seat === seat && PlayBan.live(s, b) && hit(b.filter, b.by)) return `${s.cards[b.src] ? E.cardLabel(E.D(s, s.cards[b.src])) : 'An effect'} stops you playing that right now.`;
    return null;
  }

  // runtime: ink cost change for playing `c` from hand (its own selfCost, board costMods, one-shot costMods)
  static costDelta(rt, s, seat, c, consume) {
    let delta = 0;
    for (const proc of rt.procsOf(s, c)) {
      if (proc.kind === 'static' && proc.exec && proc.effect.fn === 'selfCost' && rt.test(s, proc.cond, seat, c.iid)) {
        delta -= proc.effect.n * (proc.effect.per ? Amount.count(rt, s, proc.effect.per, seat, c.iid) : 1);
      }
      if (proc.kind === 'action' && proc.playCost && proc.exec && rt.test(s, proc.playCost.cond, seat, c.iid)) delta -= proc.playCost.n * (proc.playCost.per ? Amount.count(rt, s, proc.playCost.per, seat, c.iid) : 1);
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

  // runtime: ink change for moving `c` to location `loc` (board moveCost statics) → { free } | { delta }
  static moveDelta(rt, s, seat, c, loc) {
    let delta = 0, free = false;
    for (const iid of rt.E.P(s, seat).play) {
      const src = s.cards[iid];
      for (const proc of rt.procsOf(s, src)) {
        if (proc.kind !== 'static' || proc.effect.fn !== 'moveCost' || !Static.active(rt, s, proc, seat, iid)) continue;
        const st = proc.effect;
        if (st.here && loc.iid !== iid) continue;
        if (st.who ? !rt.matches(s, st.who, c, seat, iid) : c.iid !== iid) continue;
        if (st.n === 'free') free = true; else delta -= st.n;
      }
    }
    return { free, delta };
  }

  // runtime: "enters play exerted / with N damage"
  static onEnter(rt, s, c) {
    const apply = (st) => { if (st.exerted) c.exerted = true; if (st.damage) c.damage += st.damage; };
    for (const proc of rt.procsOf(s, c)) if (proc.kind === 'static' && proc.exec && proc.effect.fn === 'enters' && !proc.effect.filter) apply(proc.effect);
    // the board's "<cards> enter play exerted": every card in play whose static names the entering card
    for (const p of s.players) for (const iid of p.play) {
      const src = s.cards[iid];
      if (iid === c.iid) continue;
      for (const proc of rt.procsOf(s, src)) {
        if (proc.kind === 'static' && proc.effect.fn === 'enters' && proc.effect.filter && Static.active(rt, s, proc, src.owner, iid)
          && rt.matches(s, proc.effect.filter, c, src.owner, iid, { anyZone: true })) apply(proc.effect);
      }
    }
  }
}
