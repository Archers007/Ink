// Structural effects that wrap other steps:
//   choose       "choose an opposing character" — pick, remember as `it` for the next steps
//   eachPlayer   "each player draws 2 cards" · "chosen opponent reveals their hand" — the inner steps run
//                once per player, as that player (their choices, their "you"), before the rest of this ability
import { Effect } from './Effect.js';
import { Query } from '../query.js';
import { Selector } from '../phrases/selector.js';
import { PLAYER_SAY, playerPasses } from '../phrases/player.js';

export class Choose extends Effect {
  static fn = 'choose';
  static rules = [
    [/^choose (an?|another|up to \d+|one of your|one of their) (.+)$/i, (m, P) => {
      const w = m[1].toLowerCase();
      const phrase = w === 'one of your' || w === 'one of their' ? `one of your ${m[2]}` : /^up to/.test(w) ? `${w} chosen ${m[2]}` : `${w === 'another' ? 'another' : 'a'} chosen ${m[2]}`;
      return { fn: 'choose', sel: P.sel(phrase) };
    }],
    // "choose 2 of your characters" · "Choose 2 characters of yours" — exactly that many (fewer only if you have fewer)
    [/^choose (\d+) (?:of your (.+)|(.+?) of yours)$/i, (m, P) => {
      const F = P.filter(`your ${m[2] || m[3]}`);
      return { fn: 'choose', sel: { chosen: F, upTo: +m[1], exactly: true } };
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
    if (st.whoIf) seats = seats.filter((x) => playerPasses(rt, s, x, job.seat, st.whoIf));   // "each opponent with more lore than you"
    // "Choose any number of players": you, an opponent, or both (CR 1.3)
    if (st.who === 'anyPlayers') {
      const opts = [seats, [job.seat], rt.E.opponentsOf(s, job.seat), []];
      if (job.answer?.key !== 'players') {
        job.waitKey = 'players';
        return rt.ask(s, job, { op: 'eachPlayer', choices: ['Everyone', 'Just you', 'Just your opponent(s)', 'No one'], prompt: 'choose any number of players.' });
      }
      seats = opts[job.answer.option] || []; job.answer = null;
    }
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
    // tally: who declined a "may" ("For each opponent who doesn't, …" · "If they don't, …")
    const tally = (job.ctx.tally = { didnt: [] });
    const jobs = order.map((seat) => rt.makeJob(seat, job.src, job.label, st.do, { it: job.ctx.it, tally }));
    s.fx.splice(0, 0, ...jobs);                       // ahead of this job → they resolve before its next step
    return true;
  }
  static say(st, sayStep) { return `${PLAYER_SAY[st.who] || st.who}${st.whoIf ? ` (${Object.keys(st.whoIf).join(', ')})` : ''}: ${st.do.map(sayStep).join(', then ')}`; }
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

// "Count the number of characters you have in play." — that number is "that amount" / "that number" for what follows
export class Count extends Effect {
  static fn = 'count';
  static rules = [[/^count the number of (.+?)(?: you have)? in play$/i, (m, P) => ({ fn: 'count', filter: { ...P.filter(/you have/i.test(m[0]) ? `your ${m[1]}` : m[1]) } })]];
  static run(rt, s, job, st) {
    job.ctx.n = rt.candidates(s, st.filter, job.seat, job.src).length;
    rt.log(s, `↳ ${job.label}: counted ${job.ctx.n}.`, { seat: job.seat, kind: 'effect' });
    return true;
  }
  static say(st) { return `count ${Query.describe(st.filter)}`; }
}
