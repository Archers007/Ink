// Choices: target selection for selectors, picking from a list of cards, and the pending prompt itself.
// A step that needs a choice calls these; they return null while waiting (s.pending is set),
// and the pump re-enters the same step once Runtime.answer() records the choice on the job.
import { Query } from '../query.js';

export class Prompter {
  constructor(rt) { this.rt = rt; }

  ask(s, job, spec) {
    s.pending = {
      type: 'choose', seat: spec.seat ?? job.seat, valid: spec.valid || [], optional: !!spec.optional,
      src: job.src, op: spec.op, prompt: `${job.label}: ${spec.prompt}`, harmful: !!spec.harmful,
      ...(spec.confirm ? { confirm: true } : {}),
      ...(spec.cards ? { cards: spec.cards } : {}),
      ...(spec.choices ? { choices: spec.choices } : {}),
    };
    return null;
  }

  // selector → iids, or null while waiting
  targets(s, job, st, sel, key = 'sel', o = {}) {
    const { rt } = this;
    const T = (job.tmp[key] ||= { acc: [] });
    if (!sel) return [];
    if (sel.self) return s.cards[job.src] ? [job.src] : [];
    if (sel.ref) {
      // "it/them" = the last thing acted on; with nothing before it, the pronoun means this card ("he gets +1 {lore}")
      const it = (job.ctx.it || []).filter((id) => s.cards[id]);
      return it.length || job.i > 0 ? it : s.cards[job.src] ? [job.src] : [];
    }
    if (sel.all) return rt.candidates(s, sel.all, job.seat, job.src).filter(o.keep || (() => true));
    if (!sel.chosen) return [];
    this.take(job, key, T);
    const max = sel.upTo || 1;
    if (T.done || T.acc.length >= max) return T.acc;
    let valid = rt.candidates(s, sel.chosen, job.seat, job.src)
      .filter((iid) => !T.acc.includes(iid))
      .filter((iid) => s.cards[iid].owner === job.seat || !rt.E.hasKw(s.cards[iid], rt.E.D(s, s.cards[iid]), 'ward'));   // Ward (8.15)
    if (o.keep) valid = valid.filter(o.keep);
    if (!valid.length) {
      if (!T.acc.length) rt.log(s, `↳ ${job.label}: no valid ${Query.describe(sel.chosen)} — skipped.`, { kind: 'effect' });
      return T.acc;
    }
    job.waitKey = key;
    const E = rt.effect(st.fn);
    const zone = sel.chosen.zone || 'play';
    return this.ask(s, job, {
      valid, op: st.fn, harmful: E.harmful,
      optional: !!st.may || !!sel.upTo || T.acc.length > 0,
      prompt: `${o.verb || E.verb(rt, s, job, st)} — choose ${sel.upTo ? `up to ${sel.upTo} ` : ''}${Query.describe(sel.chosen)}${T.acc.length ? ` (${T.acc.length} picked)` : ''}.`,
      cards: zone === 'play' ? undefined : valid.map((iid) => ({ iid, cardId: s.cards[iid].cardId })),
    });
  }

  // pick up to spec.n of `valid` (cards shown as images) → iids, or null while waiting
  pickFrom(s, job, st, key, valid, spec) {
    const T = (job.tmp[key] ||= { acc: [] });
    this.take(job, key, T);
    if (T.done || T.acc.length >= (spec.n || 1)) return T.acc;
    const v = valid.filter((iid) => !T.acc.includes(iid));
    if (!v.length) return T.acc;
    job.waitKey = key;
    return this.ask(s, job, { ...spec, valid: v, cards: v.map((iid) => ({ iid, cardId: s.cards[iid].cardId })), op: spec.op || st.fn });
  }

  take(job, key, T) {
    if (!job.answer || job.answer.key !== key) return;
    const a = job.answer; job.answer = null;
    if (a.skip) T.done = true; else T.acc.push(a.target);
  }
}
