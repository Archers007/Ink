import { Effect } from './Effect.js';
import { Amount } from '../phrases/amount.js';

export class GainLore extends Effect {
  static fn = 'gainLore';
  static rules = [
    [/^(?:you )?gain (\d+) lore$/i, (m) => ({ fn: 'gainLore', n: +m[1] })],
    [/^gain lore equal to (?:the|that|their|his|her|its) (?:character's |chosen character's )?\{lore\}$/i, () => ({ fn: 'gainLore', n: { stat: 'lore', of: 'ref' } })],
    [/^gain lore equal to (?:the damage removed|the amount of damage removed)$/i, () => ({ fn: 'gainLore', n: { healed: true } })],
    // "each opponent loses 1 lore and you gain lore equal to the lore lost [this way]"
    [/^(?:you )?gain lore equal to the lore lost(?: this way)?$/i, () => ({ fn: 'gainLore', n: { last: true } })],
    [/^(?:you )?gain (\d+) lore for each (.+)$/i, (m, P) => ({ fn: 'gainLore', n: { n: +m[1], per: Amount.forEach(m[2], P.at) } })],
    // "gain lore equal to the {lore} of a character card in your discard" — pick the card, then read it ("that card" next)
    [/^gain lore equal to the \{lore\} of (?:a|an) (.+?) in your discard$/i, (m, P) => ({ fn: 'gainLore', n: { stat: 'lore', of: 'ref' }, pick: { ...P.filter(m[1]), zone: 'discard', owner: 'you' } })],
  ];
  static chooses(st) { return !!st.pick; }
  static run(rt, s, job, st, ev) {
    if (st.pick) {
      const valid = rt.E.P(s, job.seat).discard.filter((iid) => rt.matches(s, st.pick, s.cards[iid], job.seat, job.src, { anyZone: true }));
      if (!valid.length) return false;
      const picked = rt.pickFrom(s, job, st, 'gainLorePick', valid, { n: 1, optional: !!st.may, prompt: 'choose a card in your discard.' });
      if (!picked) return null;
      if (!picked.length) return false;
      job.ctx.it = picked;
    }
    const n = Amount.value(rt, s, job, st.n);
    rt.E.gainLore(s, job.seat, n, ev);
    rt.log(s, `↳ ${rt.E.nameOf(s, job.seat)} gained ${n} lore (${rt.E.P(s, job.seat).lore}/${rt.rule(s, 'winLore', job.seat)}).`, { seat: job.seat, kind: 'effect' });
    return true;
  }
  static verb(rt, s, job, st) { return `gain ${Amount.value(rt, s, job, st.n)} lore`; }
  static say(st) { return st.n?.per ? `gain ${st.n.n} lore for each ${Amount.sayPer(st.n.per)}` : `gain ${Amount.say(st.n)} lore`; }
}
export class LoseLore extends Effect {
  static fn = 'loseLore';
  static rules = [
    [/^(?:each|chosen|all) opponents? loses? (\d+) lore$/i, (m) => ({ fn: 'loseLore', n: +m[1], who: 'opp' })],
    [/^(?:you )?lose (\d+) lore$/i, (m) => ({ fn: 'loseLore', n: +m[1], who: 'you' })],             // as the player an eachPlayer runs
    [/^(?:each|chosen) opponent loses lore equal to (?:that|their|his|her|its) (?:character's )?\{lore\}$/i, () => ({ fn: 'loseLore', n: { stat: 'lore', of: 'ref' }, who: 'opp' })],
  ];
  static run(rt, s, job, st, ev) {
    job.ctx.n = 0;
    for (const o of rt.who(s, job, st.who === 'you' ? 'you' : 'opp')) {
      const before = rt.E.P(s, o).lore;
      rt.E.gainLore(s, o, -Amount.value(rt, s, job, st.n), ev);
      job.ctx.n += before - rt.E.P(s, o).lore;
      rt.log(s, `↳ ${rt.E.nameOf(s, o)} lost ${before - rt.E.P(s, o).lore} lore.`, { seat: o, kind: 'effect' });
    }
    return true;
  }
  static say(st) { return `${st.who === 'you' ? 'you lose' : 'each opponent loses'} ${Amount.say(st.n)} lore`; }
}
