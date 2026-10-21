// An effect is one step of a proc: { fn, ...args, may?, linked?, cond?, ifDid?, otherwise? }.
//
// Each subclass owns all four faces of its fn, so it can't be compiled but not run (or run but not shown):
//   rules            [[regex, (m, P) => step], …]   clause text → step; P = { sel, filter, amount, dur, D, at, ctx }
//   run(rt, s, job, st, ev)   → true (did it) · false (couldn't / nothing happened) · null (waiting on a choice)
//   verb(rt, s, job, st)      prompt words ("deal 2 damage")
//   say(st)                   read-back words
//   check(st, missing)        add reasons the engine can't run this exact step (e.g. an unsupported keyword)
export class Effect {
  static fn = '';
  static harmful = false;
  static staticOnly = false;       // only meaningful as a static ability's effect (selfCost, enters)
  static rules = [];
  static chooses(st) { return !!st.sel?.chosen; }
  static run(rt, s, job, st, ev) { throw new Error(`effect ${this.fn}: run() not implemented`); }
  static verb(rt, s, job, st) { return this.fn; }
  static say(st) { return this.fn; }
  static check(st, missing) {}
}
