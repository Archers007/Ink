// Structural effects that wrap other steps:
//   choose       "choose an opposing character" — pick, remember as `it` for the next steps
//   eachPlayer   "each player draws 2 cards" · "chosen opponent reveals their hand" — the inner steps run
//                once per player, as that player (their choices, their "you"), before the rest of this ability
import { Effect } from './Effect.js';
import { Selector } from '../phrases/selector.js';
import { PLAYER_SAY } from '../phrases/player.js';

export class Choose extends Effect {
  static fn = 'choose';
  static rules = [
    [/^choose (an?|another|up to \d+|one of your|one of their) (.+)$/i, (m, P) => {
      const w = m[1].toLowerCase();
      const phrase = w === 'one of your' || w === 'one of their' ? `one of your ${m[2]}` : /^up to/.test(w) ? `${w} chosen ${m[2]}` : `${w === 'another' ? 'another' : 'a'} chosen ${m[2]}`;
      return { fn: 'choose', sel: P.sel(phrase) };
    }],
  ];
  static chooses() { return true; }
  static run(rt, s, job, st) {
    const ids = rt.targets(s, job, st, st.sel);
    if (!ids) return null;
    job.ctx.it = ids;
    return ids.length > 0;
  }
  static verb() { return 'choose'; }
  static say(st) { return `choose ${Selector.say(st.sel).replace(/^chosen /, '')}`; }
}

export class EachPlayer extends Effect {
  static fn = 'eachPlayer';
  static rules = [];                                  // built by the compiler (it needs to compile the inner clause)
  static run(rt, s, job, st) {
    let seats = rt.who(s, job, st.who);
    // "chosen player / chosen opponent": the controller picks one (no choice to make with only one candidate)
    if (st.who === 'chosenPlayer' || st.who === 'chosenOpp') {
      if (job.answer?.key === 'player') { seats = [seats[job.answer.option]].filter((x) => x != null); job.answer = null; }
      else if (seats.length > 1) {
        job.waitKey = 'player';
        return rt.ask(s, job, { op: 'eachPlayer', choices: seats.map((x) => rt.E.nameOf(s, x)), prompt: `choose a player.` });
      }
    }
    // turn order from the active player (CR 1.6.2)
    const order = [...seats].sort((a, b) => ((a - s.active + s.players.length) % s.players.length) - ((b - s.active + s.players.length) % s.players.length));
    const jobs = order.map((seat) => rt.makeJob(seat, job.src, job.label, st.do, { it: job.ctx.it }));
    s.fx.splice(0, 0, ...jobs);                       // ahead of this job → they resolve before its next step
    return true;
  }
  static say(st, sayStep) { return `${PLAYER_SAY[st.who] || st.who}: ${st.do.map(sayStep).join(', then ')}`; }
}

// "Whenever one of your characters quests this turn, gain 1 lore." — a trigger that lives on the player until
// end of turn; Runtime.fire offers every event to it as if one of the player's cards were listening.
export class Delayed extends Effect {
  static fn = 'delayed';
  static rules = [];                                  // built by the compiler (it needs to compile the inner trigger)
  static run(rt, s, job, st) {
    (s.delayed ||= []).push({ seat: job.seat, src: job.src, label: job.label, proc: st.proc, turn: s.turn, keep: [...(job.ctx.it || [])] });
    rt.log(s, `↳ ${job.label}: for the rest of this turn, ${rt.E.prettyText(st.text || '')}`, { seat: job.seat, kind: 'effect' });
    return true;
  }
  static check(st, missing) { if (!st.proc.exec) missing.add(`delayed trigger: ${(st.proc.why || '').replace(/^engine can't run: /, '')}`); }
  static say(st, sayStep) { return `for the rest of this turn: ${st.text}`; }
}
