// A proc kind is the top-level shape of one ability. Each subclass owns:
//   parse(t, c)                 ability text → proc | null     (c = compiler: c.effects(), c.condition(), c.P(at)…)
//   check(proc, missing, S)     add reasons the engine can't run it (S = SUPPORT)
//   explain(proc, X)            read-back lines (X = { step, cond, tag })
// …and its own runtime hook (Triggered.fire, Activated.activate, Static.apply, Action.cast).
export class Kind {
  static kind = '';
  static parse(t, c) { return null; }
  static check(proc, missing, S) {}
  static explain(proc, X) { return [X.tag(this.kind)]; }
}
export const modsOf = (p) => ({ ...(p.once ? { once: true } : {}), ...(p.during ? { during: p.during } : {}) });
export const sayDuring = (p) => `${p.during ? ` — during ${p.during === 'yours' ? 'your' : "an opponent's"} turn` : ''}${p.once ? ` — ${p.once === 2 ? 'twice' : 'once'} per turn` : ''}`;
