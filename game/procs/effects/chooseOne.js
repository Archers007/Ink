// "Choose one: • … • …" — the chosen option's steps are spliced in after this step
import { Effect } from './Effect.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
export class ChooseOne extends Effect {
  static fn = 'chooseOne';
  static run(rt, s, job, st) {
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
