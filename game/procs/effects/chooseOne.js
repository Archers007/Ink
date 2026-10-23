// "Choose one: • … • …" — the chosen option's steps are spliced in after this step
import { Effect } from './Effect.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
export class ChooseOne extends Effect {
  static fn = 'chooseOne';
  // CR 1.7.7: an option that can't be done isn't a legal choice ("choose and discard a card or banish this character")
  static feasible(rt, s, job, steps) {
    const st = steps[0];
    if (!st) return true;
    if (st.sel?.chosen) return rt.candidates(s, st.sel.chosen, job.seat, job.src).length > 0;
    if (st.fn === 'discard' && (!st.who || st.who === 'you')) return rt.E.P(s, job.seat).hand.length > 0;
    return true;
  }
  static run(rt, s, job, st) {
    // "If you have another Toy character in play, choose both instead"
    if (st.bothIf && rt.test(s, st.bothIf, job.seat, job.src, job)) {
      job.steps.splice(job.i + 1, 0, ...st.options.flatMap((o) => clone(o)));
      rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} gets both.`, { seat: job.seat, kind: 'effect' });
      return true;
    }
    if (job.answer?.key !== 'chooseOne') {
      const ok = st.options.map((o) => ChooseOne.feasible(rt, s, job, o));
      if (ok.filter(Boolean).length === 1) job.answer = { key: 'chooseOne', option: ok.indexOf(true) };
    }
    if (job.answer?.key === 'chooseOne') {
      const k = job.answer.option; job.answer = null;
      job.steps.splice(job.i + 1, 0, ...clone(st.options[k]));
      rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} chose: ${st.labels?.[k] || `option ${k + 1}`}.`, { seat: job.seat, kind: 'effect' });
      return true;
    }
    job.waitKey = 'chooseOne';
    return rt.ask(s, job, { op: 'chooseOne', choices: st.labels || st.options.map((o, k) => `Option ${k + 1}`), prompt: 'choose one.' });
  }
  static say(st, sayStep) { return `choose one: ${st.options.map((o, i) => `(${i + 1}) ${o.map(sayStep).join(', ')}`).join('  ')}`; }
}
