// Proc runtime — executes compiled procs inside the engine.
//
// The Runtime only orchestrates; the behaviour lives in the building blocks:
//   query.js + classifiers/   which cards           Runtime.matches / candidates
//   conditions/               is it true?           Runtime.test
//   effects/                  do one step           effects/<fn>.run(rt, s, job, st, ev)
//   triggers/                 who listens           Runtime.fire → triggers EVENTS → Triggered.fire
//   kinds/                    per-kind hooks        Static.apply / costDelta / onEnter, Activated.activate, Action.cast
//   runtime/Prompter          choices               ask / targets / pickFrom
//
// Jobs sit in s.fx (the bag, CR 7.7) — one per resolving ability. A step that needs a choice sets
// s.pending and returns null; answer() records the choice on the job and pump() re-enters that step.
// Nothing is half-applied: the engine wraps each action in a snapshot/rollback.

import { Query } from '../query.js';
import { EFFECT } from '../effects/index.js';
import { EVENTS } from '../triggers/index.js';
import { testCondition } from '../conditions/index.js';
import { Triggered, Static, Activated, Action } from '../kinds/index.js';
import { DURATIONS } from '../phrases/duration.js';
import { SUPPORT } from '../support.js';
import { Job } from './Job.js';
import { Prompter } from './Prompter.js';

// Reminders for unparsed abilities on common events (still shown in the log, like a real table)
const REMIND = {
  play: /\bwhen(?:ever)? you play this\b/i,
  quest: /\bwhen(?:ever)? this character quests\b/i,
  challenges: /\bwhen(?:ever)? (?:this character|he|she|they) challenges?\b/i,
  challenged: /\bwhen(?:ever)? this (?:character|location) is challenged\b/i,
  banished: /\bwhen(?:ever)? this (?:character|item|location) is banished\b/i,
  turnStart: /\bat the start of your turn\b/i,
  turnEnd: /\bat the end of (?:your|the) turn\b/i,
  moveHere: /\bwhenever (?:a character moves here|you move a character here)\b/i,
  sings: /\bwhenever this character sings\b/i,
};

export class Runtime {
  constructor(E) {
    this.E = E;
    this.prompter = new Prompter(this);
    for (const f of SUPPORT.fn) if (!EFFECT[f]?.run) throw new Error(`support lists fn "${f}" but effects/ has no executor`);
  }

  // ------------------------------------------------------------ helpers the building blocks share
  log(...a) { return this.E.log(...a); }
  effect(fn) { const E = EFFECT[fn]; if (!E) throw new Error(`no effect "${fn}"`); return E; }
  procsOf(s, c) { return this.E.D(s, c).procs || []; }
  labelOf(s, c, proc) { return `${this.E.cardLabel(this.E.D(s, c))}${proc?.name ? ' — ' + proc.name : ''}`; }
  inPlay(s, seat) { return this.E.P(s, seat).play.map((id) => s.cards[id]); }
  tl(s, iid) { const c = s.cards[iid]; return `${this.E.nameOf(s, c.owner)}'s ${this.E.cardLabel(this.E.D(s, c))}`; }
  each(ids, f) { ids.forEach(f); return ids.length > 0; }
  who(s, job, w) { return w === 'each' ? s.players.filter((p) => !p.out).map((p) => p.seat) : w === 'opp' ? this.E.opponentsOf(s, job.seat) : [job.seat]; }
  duringOk(s, proc, owner) { return !proc.during || (proc.during === 'yours' ? s.active === owner : s.active !== owner); }
  ask(s, job, spec) { return this.prompter.ask(s, job, spec); }
  targets(s, job, st, sel, key, o) { return this.prompter.targets(s, job, st, sel, key, o); }
  pickFrom(s, job, st, key, valid, spec) { return this.prompter.pickFrom(s, job, st, key, valid, spec); }

  addMods(s, job, st, iid, ev, mult = 1) {
    const c = s.cards[iid];
    const u = st.dur ? { until: DURATIONS[st.dur].until, by: st.dur === 'theirNext' ? c.owner : job.seat, setTurn: s.turn } : { until: 'static' };
    for (const m of st.mods || []) {
      c.mods.push({ stat: m.stat, delta: m.n * mult, ...u, src: job.label });
      if (ev) ev.push({ k: 'mod', iid, stat: m.stat, delta: m.n * mult });
    }
    for (const k of st.kws || []) {
      c.mods.push({ stat: 'kw', kw: k.kw, delta: k.n ?? 1, ...u, src: job.label });
      if (ev) ev.push({ k: 'mod', iid, stat: 'kw', delta: 1 });
    }
  }

  // ------------------------------------------------------------ queries & conditions
  matches(s, F, c, ctl, src, o = {}) { return !!c && Query.matches(F, c, this.E.D(s, c), { E: this.E, ctl, src }, o); }
  pool(s, F, ctl) {
    const zone = F.zone || 'play';
    const seats = F.owner === 'you' ? [ctl] : F.owner === 'opp' ? this.E.opponentsOf(s, ctl) : s.players.map((p) => p.seat);
    return seats.flatMap((seat) => this.E.P(s, seat)[zone] || []);
  }
  candidates(s, F, ctl, src) { return this.pool(s, F, ctl).filter((iid) => this.matches(s, F, s.cards[iid], ctl, src)); }
  test(s, C, ctl, src, job) { return testCondition(this, s, C, { ctl, src, job }); }

  // ------------------------------------------------------------ the bag
  queue(s, seat, src, label, steps, ctx = {}, extra = {}) { (s.fx ||= []).push(Job.make(seat, src, label, steps, ctx, extra)); }

  // engine event → every listening trigger queues
  fire(s, ev, info = {}) {
    const fireOn = (c, name, pass, it) => {
      if (!c) return;
      Triggered.fire(this, s, c, name, pass, it);
      if (name === ev && REMIND[ev] && (c.iid === info.iid || ev === 'turnStart' || ev === 'turnEnd')) {
        for (const proc of this.procsOf(s, c)) if (proc.kind === 'unparsed' && REMIND[ev].test(proc.text)) this.log(s, `↳ ${this.labelOf(s, c, proc)}: ${this.E.prettyText(proc.text)}`, { kind: 'effect' });
      }
    };
    if (info.iid && !s.cards[info.iid]) return;
    EVENTS[ev]?.(this, s, info, fireOn);
  }

  pump(s, ev) {
    s.fx ||= [];
    for (let guard = 0; guard < 500 && !s.pending && s.fx.length && s.status === 'playing'; guard++) {
      const job = s.fx[0];
      if (job.i === 0 && job.cond !== undefined && !job.condChecked) {
        job.condChecked = true;
        if (job.cond && !this.test(s, job.cond, job.seat, job.src, job)) { s.fx.shift(); continue; }
      }
      const st = job.steps[job.i];
      if (!st) { s.fx.shift(); continue; }
      const E = this.effect(st.fn);
      const skip = () => Job.next(job);
      // gates
      if ((st.linked && job.ctx.declined) || (st.ifDid && !job.ctx.did) || (st.otherwise && job.ctx.did)) { job.ctx.did = false; skip(); continue; }
      if (st.cond && !this.test(s, st.cond, job.seat, job.src, job)) { job.ctx.did = false; job.ctx.declined = false; skip(); continue; }
      // "you may …" without a target choice → yes/no first
      if (st.may && !E.chooses(st) && !job.tmp.mayOk) {
        if (job.answer?.key === 'may') {
          const a = job.answer; job.answer = null;
          if (a.skip) { this.log(s, `↳ ${this.E.nameOf(s, job.seat)} chose not to (${job.label}).`, { seat: job.seat, kind: 'effect' }); job.ctx.did = false; job.ctx.declined = true; skip(); continue; }
          job.tmp.mayOk = true;
        } else {
          job.waitKey = 'may';
          this.ask(s, job, { confirm: true, optional: true, op: st.fn, prompt: `${E.verb(this, s, job, st)}?` });
          return;
        }
      }
      const r = E.run(this, s, job, st, ev);
      if (r === null) return;                                  // waiting on a choice
      const declined = st.may && E.chooses(st) && Object.values(job.tmp).some((t) => t && t.done && !t.acc?.length);
      job.ctx.did = !!r;
      job.ctx.declined = declined;
      if (declined) this.log(s, `↳ ${this.E.nameOf(s, job.seat)} chose not to (${job.label}).`, { seat: job.seat, kind: 'effect' });
      skip();
      this.E.gameStateCheck(s, ev);
    }
  }

  // H.choose → record the answer on the job; the pump re-enters the waiting step
  answer(s, seat, a) {
    const { RE } = this.E;
    const pend = s.pending;
    if (!pend || pend.type !== 'choose' || pend.seat !== seat) throw RE('There is nothing for you to choose right now.');
    const job = s.fx[0];
    if (!job) throw RE('Nothing is resolving.');
    if (pend.choices) {
      const k = Math.trunc(Number(a.option));
      if (!(k >= 0 && k < pend.choices.length)) throw RE('Pick one of the options.');
      job.answer = { key: job.waitKey, option: k };
    } else if (pend.confirm) {
      job.answer = { key: job.waitKey, skip: !!a.skip };
    } else if (a.skip) {
      if (!pend.optional) throw RE("This isn't optional — pick one of the highlighted cards.");
      job.answer = { key: job.waitKey, skip: true };
    } else {
      if (!pend.valid.includes(a.target)) throw RE('Pick one of the highlighted cards.');
      job.answer = { key: job.waitKey, target: a.target };
    }
    s.pending = null;
  }

  // ------------------------------------------------------------ per-kind hooks
  statics(s) { Static.apply(this, s); }
  costDelta(s, seat, c, consume = false) { return Static.costDelta(this, s, seat, c, consume); }
  onEnter(s, c) { Static.onEnter(this, s, c); }
  activate(s, seat, c, index, ev) { return Activated.activate(this, s, seat, c, index, ev); }
  castAction(s, seat, c) { return Action.cast(this, s, seat, c); }

  endOfTurnCleanup(s, seat) {
    for (const p of s.players) for (const iid of p.play) {
      const c = s.cards[iid];
      if (c.mods.length) c.mods = c.mods.filter((m) => m.until !== 'eot' && !(m.until === 'theirNext' && m.by === seat && s.turn > m.setTurn));
    }
    this.E.P(s, seat).costMods = [];
  }

  // fn → (s, job, st, ev) executor table (tests / debugging)
  get FN() { return Object.fromEntries([...SUPPORT.fn].map((f) => [f, (s, job, st, ev) => EFFECT[f].run(this, s, job, st, ev)])); }
}

export const createRuntime = (E) => new Runtime(E);
export const describe = (F) => Query.describe(F);
