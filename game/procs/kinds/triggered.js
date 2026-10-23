// "<trigger>, [if <cond>,] effect"   { kind:'triggered', on:[{ev,…}], once?, during?, cond?, do:[step] }
import { Kind, sayDuring } from './Kind.js';
import { secondPerson } from '../compiler.js';
import { sentences } from '../phrases/text.js';
import { parseTrigger, sayTrigger, TRIGGER } from '../triggers/index.js';

export class Triggered extends Kind {
  static kind = 'triggered';
  static parse(t, c, mods) {
    // the head ends at the first ", " that leaves a trigger we read ("Whenever one of your opponents' characters,
    // items, or locations is returned to their hand from play, …")
    let ci = -1, on = null;
    for (let k = t.indexOf(', '); k > 0 && !on; k = t.indexOf(', ', k + 1)) { on = parseTrigger(t.slice(0, k), c.P(t)); if (on) ci = k; }
    if (!on) {
      const head = t.slice(0, Math.max(0, t.indexOf(', ')));
      if (head && /^(when|whenever|at the) /i.test(head)) c.miss(`trigger: "${head}"`, t);
      return null;
    }
    let body = t.slice(ci + 2);
    let cond;
    // "At the start of your turn, if this card is in your discard, …" — the trigger listens from the discard
    const fd = body.match(/^if this card is in your discard, (.+)$/i);
    if (fd) { on = on.map((o) => ({ ...o, fromDiscard: true })); body = fd[1]; }
    // "At the end of each player's turn, if they have more than 2 cards in their hand, they …" — they = the player whose
    // turn it is; the whole effect is theirs
    if (on.every((o) => /^turn(?:Start|End)$/.test(o.ev) && (o.whose === 'each' || o.whose === 'opp')) && /^(?:if )?they\b/i.test(body)) {
      return { kind: 'triggered', on, ...mods, do: [{ fn: 'eachPlayer', who: 'active', do: c.effects(secondPerson(body), { refIsSelf: true }) }] };
    }
    const m = body.match(/^if (.+?), (.+)$/i);
    // "…, if X, draw a card. Otherwise, …" — the if belongs to the step, so Otherwise can follow it
    if (m && !/^if you do/i.test(body) && !/^otherwise,/i.test(sentences(body)[1] || '')) { cond = c.condition(m[1], t); body = m[2]; }
    return { kind: 'triggered', on, ...mods, ...(cond ? { cond } : {}), do: c.effects(body, { refIsSelf: true }) };
  }
  static check(p, missing, S) { for (const o of p.on) if (!S.trigger.has(o.ev)) missing.add(`trigger ${o.ev}`); }
  static explain(p, X) {
    const when = p.on.map((o) => `${sayTrigger(o)}${o.whileCond ? ` while ${X.cond(o.whileCond)}` : ''}`).join(' or ');
    return [X.tag('triggered'), `WHEN ${when}${sayDuring(p)}`, ...(p.cond ? [`IF ${X.cond(p.cond)}`] : []), ...p.do.map((st, i) => `${i + 1}. ${X.step(st)}`)];
  }

  // runtime: queue every trigger on card `c` listening for `ev` that passes `pass` (into the bag)
  static fire(rt, s, c, ev, pass, it, info = {}) {
    rt.procsOf(s, c).forEach((proc, k) => {
      if (proc.kind !== 'triggered') return;
      const on = proc.on.find((o) => o.ev === ev && (!pass || pass(o)));
      if (!on) return;
      const label = rt.labelOf(s, c, proc);
      if (!proc.exec) { rt.log(s, `↳ ${label}: ${rt.E.prettyText(proc.text)}`, { kind: 'effect' }); return; }
      if (!rt.duringOk(s, proc, c.owner)) return;
      if (on.during && !rt.duringOk(s, { during: on.during }, c.owner)) return;   // "… and whenever he banishes … during your turn"
      if (on.whileCond && !rt.test(s, on.whileCond, c.owner, c.iid)) return;
      if (proc.once) {
        c.once ||= {};
        if (c.once[k] === s.turn) return;
        c.once[k] = s.turn;
      }
      if (on.first) {                                                  // "the first time … each turn" (this trigger only)
        const key = `${k}:${proc.on.indexOf(on)}`;
        c.firsts ||= {};
        if (c.firsts[key] === s.turn) return;
        c.firsts[key] = s.turn;
      }
      // self-subject triggers ('whenever this character moves, he gets +3'): he/she = this card until a step picks something
      const cx = s.challengeCtx || s.challenge;                    // "the challenging character / player"
      rt.queue(s, c.owner, c.iid, label, proc.do, { it: it || [], trigIt: it || [], ...(TRIGGER[ev]?.selfSubject ? { selfSubj: true } : {}), ...(cx ? { cx: { a: cx.a, t: cx.t } } : {}),
        ...(typeof info.n === 'number' ? { n: info.n } : {}) }, { cond: proc.cond || null });   // n: how much the event dealt ("deal that much damage")
    });
  }
}
