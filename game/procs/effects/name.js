// "Name a card" (CR 5.2.6): the player names a card; "the named card" / "with that name" match it (classifiers/named.js).
// The choices are the names of the cards in this game, most common in the player's own deck and discard first.
import { Effect } from './Effect.js';

export class NameCard extends Effect {
  static fn = 'nameCard';
  static rules = [[/^name a card$/i, () => ({ fn: 'nameCard' })]];
  static options(rt, s, seat) {
    const n = new Map();
    const add = (iid, w) => { const name = rt.E.D(s, s.cards[iid]).name; n.set(name, (n.get(name) || 0) + w); };
    const p = rt.E.P(s, seat);
    for (const iid of [...p.deck, ...p.discard]) add(iid, 1);
    for (const iid of Object.keys(s.cards)) add(iid, 0);
    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
  }
  static run(rt, s, job) {
    const names = job.tmp.names ||= NameCard.options(rt, s, job.seat);
    if (job.answer?.key === 'nameCard') {
      const name = names[job.answer.option]; job.answer = null;
      if (name == null) return false;
      s.named = { name, seat: job.seat };
      job.ctx.named = name;
      rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} named ${name}.`, { seat: job.seat, kind: 'effect' });
      return true;
    }
    job.waitKey = 'nameCard';
    return rt.ask(s, job, { op: 'nameCard', choices: names, prompt: 'name a card.' });
  }
  static say() { return 'name a card'; }
}
