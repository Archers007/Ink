// A trigger is the "when/whenever/at" head of a triggered ability.  Proc JSON: on: [{ ev, …filters }]
//
// Each subclass owns:
//   ev                     its id in proc JSON
//   runs                   false = understood but the engine never raises this event yet (→ manual)
//   rules                  [[regex, (m, P) => [on…]], …]  head text → one or more `on` entries
//   say(o)                 read-back words
//
// Engine events (R.fire(s, name, info)) are dispatched by `events` exported from each family file:
//   events[name](rt, s, info, fireOn)   fireOn(card, ev, pass?, it?) queues that card's matching triggers
export class Trigger {
  static ev = '';
  static runs = true;
  static rules = [];
  static say(o) { return this.ev; }
}
export const other = (F, m) => (m ? { ...F, other: true } : F);
export const SUBJECT = String.raw`(?:this character|he|she|it|they)`;
