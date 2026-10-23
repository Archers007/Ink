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
import { Act } from '../triggers/act.js';
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
  statOf(s, c, stat) { const d = this.E.D(s, c); return stat === 'str' ? this.E.effStr(c, d) : stat === 'wp' ? this.E.effWp(c, d) : stat === 'lore' ? this.E.effLore(c, d) : 0; }
  procsOf(s, c, which = 'all') {
    const own = this.E.D(s, c).procs || [];
    const g = c.zone === 'play' ? c.mods.filter((m) => m.stat === 'grant') : c.leftGrants || [];
    if (!g.length) return which === 'granted-static' ? [] : own;
    if (which === 'own+temp') return [...own, ...g.filter((m) => m.until !== 'static').map((m) => m.proc)];
    if (which === 'granted-static') return g.filter((m) => m.until === 'static').map((m) => m.proc);
    return [...own, ...g.map((m) => m.proc)];
  }
  labelOf(s, c, proc) { return `${this.E.cardLabel(this.E.D(s, c))}${proc?.name ? ' — ' + proc.name : ''}`; }
  inPlay(s, seat) { return this.E.P(s, seat).play.map((id) => s.cards[id]); }
  tl(s, iid) { const c = s.cards[iid]; return `${this.E.nameOf(s, c.owner)}'s ${this.E.cardLabel(this.E.D(s, c))}`; }
  each(ids, f) { ids.forEach(f); return ids.length > 0; }
  who(s, job, w) {
    if (w === 'refOwner') return [s.cards[(job.ctx.it || [])[0]]?.owner].filter((x) => x != null);
    return w === 'each' ? s.players.filter((p) => !p.out).map((p) => p.seat) : w === 'opp' ? this.E.opponentsOf(s, job.seat) : [job.seat];
  }
  duringOk(s, proc, owner) { return !proc.during || (proc.during === 'yours' ? s.active === owner : s.active !== owner); }
  ask(s, job, spec) { return this.prompter.ask(s, job, spec); }
  targets(s, job, st, sel, key, o) { return this.prompter.targets(s, job, st, sel, key, o); }
  pickFrom(s, job, st, key, valid, spec) { return this.prompter.pickFrom(s, job, st, key, valid, spec); }

  addMods(s, job, st, iid, ev, mult = 1) {
    const c = s.cards[iid];
    const u = st.dur ? { until: DURATIONS[st.dur].until, by: st.dur === 'theirNext' ? c.owner : job.seat, setTurn: s.turn } : { until: 'static' };
    for (const m of st.mods || []) {
      // nOf: the size comes from a stat, read once as the effect resolves ("equal to this character's {lore}")
      const of = m.nOf && s.cards[m.nOf.of === 'target' ? iid : job.src];
      const base = m.nOf ? (of ? m.n * Math.max(0, this.statOf(s, of, m.nOf.stat)) : 0) : m.n;
      c.mods.push({ stat: m.stat, delta: base * mult, ...u, src: job.label });
      if (ev) ev.push({ k: 'mod', iid, stat: m.stat, delta: base * mult });
    }
    for (const k of st.kws || []) {
      if (k.kw === 'grant') {
        if (!c.mods.some((m) => m.stat === 'grant' && m.proc === k.proc && m.until === u.until)) c.mods.push({ stat: 'grant', proc: k.proc, ...u, src: job.label });
        continue;
      }
      c.mods.push({ stat: 'kw', kw: k.kw, delta: k.n ?? 1, ...(k.by ? { by: k.by } : {}), ...u, src: job.label });
      if (ev) ev.push({ k: 'mod', iid, stat: 'kw', delta: 1 });
    }
  }

  // ------------------------------------------------------------ queries & conditions
  matches(s, F, c, ctl, src, o = {}) { return !!c && Query.matches(F, c, this.E.D(s, c), { E: this.E, s, ctl, src }, o); }
  pool(s, F, ctl) {
    const zone = F.zone || 'play';
    const seats = F.owner === 'you' ? [ctl] : F.owner === 'opp' ? this.E.opponentsOf(s, ctl) : s.players.map((p) => p.seat);
    return seats.flatMap((seat) => this.E.P(s, seat)[zone] || []);
  }
  candidates(s, F, ctl, src) { return this.pool(s, F, ctl).filter((iid) => this.matches(s, F, s.cards[iid], ctl, src)); }
  test(s, C, ctl, src, job) { return testCondition(this, s, C, { ctl, src, job }); }

  // ------------------------------------------------------------ the bag
  makeJob(seat, src, label, steps, ctx = {}, extra = {}) { return Job.make(seat, src, label, steps, ctx, extra); }
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
    // per-turn history for "this turn" conditions (conditions/history.js)
    (s.turnLog ||= []).push({ ev, seat: info.seat ?? s.cards[info.iid]?.owner, iid: info.iid, ...(info.inChallenge ? { inChallenge: true } : {}),
      ...(info.other != null ? { other: info.other } : {}), ...(info.defending ? { defending: true } : {}), ...(info.to ? { to: info.to } : {}) });
    EVENTS[ev]?.(this, s, info, fireOn);
    Act.dispatch(this, s, ev, info, fireOn);                     // generic "whenever <subject> <verb>" triggers
    // delayed triggers: the same event, heard by each player's "this turn" triggers (once per event)
    const live = (s.delayed || []).filter((d) => d.turn === s.turn);
    if (live.length && EVENTS[ev]) {
      const heard = new Set();
      EVENTS[ev](this, s, info, (c, name, pass, it) => {
        for (const d of live) {
          if (!c || c.owner !== d.seat || heard.has(d)) continue;
          if (!d.proc.on.some((o) => o.ev === name && (!pass || pass(o)))) continue;
          heard.add(d);
          this.queue(s, d.seat, d.src, d.label, d.proc.do, { it: it || [] }, { cond: d.proc.cond || null });
        }
      });
    }
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
      // "… If X, <bigger version> instead" — decided once, as the step starts
      if (st.instead) {
        const { instead, ...base } = st;
        job.steps[job.i] = this.test(s, instead.cond, job.seat, job.src, job) ? { ...base, ...instead.step } : base;
        continue;
      }
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
      const before = JSON.stringify(job.ctx.it);
      const r = E.run(this, s, job, st, ev);
      if (r === null) return;                                  // waiting on a choice
      if (JSON.stringify(job.ctx.it) !== before) job.ctx.picked = true;
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
  playBlocked(s, seat, c) { return Static.playBlocked(this, s, seat, c); }
  costDelta(s, seat, c, consume = false) { return Static.costDelta(this, s, seat, c, consume); }
  onEnter(s, c) { Static.onEnter(this, s, c); }
  activate(s, seat, c, index, ev) { return Activated.activate(this, s, seat, c, index, ev); }
  castAction(s, seat, c) { return Action.cast(this, s, seat, c); }

  endOfTurnCleanup(s, seat) {
    if (s.delayed?.length) s.delayed = s.delayed.filter((d) => d.turn > s.turn);
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
