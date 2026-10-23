// "Choose one: • … • …" — the chosen option's steps are spliced in after this step
import { Effect } from './Effect.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
export class ChooseOne extends Effect {
  static fn = 'chooseOne';
  // "choose and discard either 2 cards or 1 action card" — a forced choice between two discards (CR 6.1.5.2)
  static rules = [[/^choose and discard either (.+?) or (.+)$/i, (m, P) => ({
    fn: 'chooseOne', labels: [m[1], m[2]], options: [P.effects(`choose and discard ${m[1]}`), P.effects(`choose and discard ${m[2]}`)],
  })],
  // "Otherwise, put it on either the top or the bottom of your deck"
  [/^put (?:it|that card) on either the top or the bottom of your deck$/i, () => ({
    fn: 'chooseOne', labels: ['Top of your deck', 'Bottom of your deck'], options: [[{ fn: 'toDeckTop', sel: { ref: true } }], [{ fn: 'toDeckBottom', sel: { ref: true } }]],
  })]];
  // CR 1.7.7: an option that can't be done isn't a legal choice ("choose and discard a card or banish this character")
  static feasible(rt, s, job, steps) {
    const st = steps[0];
    if (!st) return true;
    if (st.sel?.chosen) return rt.candidates(s, st.sel.chosen, job.seat, job.src).length > 0;
    if (st.fn === 'discard' && (!st.who || st.who === 'you')) {
      const hand = rt.E.P(s, job.seat).hand;
      return st.filter ? hand.some((iid) => rt.matches(s, st.filter, s.cards[iid], job.seat, job.src, { anyZone: true })) : hand.length > 0;
    }
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
      rt.log(s, `↳ ${rt.E.nameOf(s, st.by === 'opp' ? job.ctx.chooser ?? job.seat : job.seat)} chose: ${st.labels?.[k] || `option ${k + 1}`}.`, { seat: job.seat, kind: 'effect' });
      return true;
    }
    job.waitKey = 'chooseOne';
    // "Chosen opponent chooses one" — they answer; "they …" in the options is them
    const by = st.by === 'opp' ? (job.ctx.chooser ??= rt.E.opponentsOf(s, job.seat)[0]) : job.seat;
    return rt.ask(s, job, { seat: by, op: 'chooseOne', choices: st.labels || st.options.map((o, k) => `Option ${k + 1}`), prompt: 'choose one.' });
  }
  static say(st, sayStep) { return `${st.by === 'opp' ? 'chosen opponent chooses' : 'choose'} one: ${st.options.map((o, i) => `(${i + 1}) ${o.map(sayStep).join(', ')}`).join('  ')}`; }
}
