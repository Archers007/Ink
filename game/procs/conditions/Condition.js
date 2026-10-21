// A condition is a yes/no question about the game ("you have a Villain in play", "this character is damaged").
// Proc JSON identifies it by its key:  { have: Query, n } · { self: [classifier…] } · { hand: {gte} } · { yourTurn } …
//
// Each subclass owns its three faces:
//   rules    [[regex, (m, at) => cond], …]   text → condition   (tried in registry order)
//   test     (rt, s, C, env) → bool          env = { ctl, src, job }
//   say      (C) → words                     read-back
export class Condition {
  static key = '';
  static runs = true;
  static rules = [];
  static test(rt, s, C, env) { throw new Error(`condition ${this.key}: test() not implemented`); }
  static say(C) { return this.key; }
}
