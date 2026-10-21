// A classifier is a named yes/no question about one card: "has Sing Together", "is a Hero",
// "costs 3 or less", "is damaged". Queries narrow a set of cards with `with: [classifier…]`
// (see ../query.js); the `with` list is ANDed.
//
// In proc JSON a classifier is a small object whose identifying key is the classifier id:
//   { "kw": "singTogether" }   { "class": ["hero", "princess"] }   { "cost": { "lte": 3 } }   { "damaged": true }
//
// Every subclass owns all three faces of its question, so a classifier can't be parsed but not run,
// or run but not shown:
//   parseWith(s) / adjectives   text → classifier         (compile.js: "with …", "damaged …")
//   test(x, card, def, env)     does this card pass?      (runtime; env = { E, ctl, src })
//   say(x) / is(x)              words for the read-back   ("with cost 3 or less" / "has cost 3 or less")

export class Classifier {
  static id = '';
  static pre = false;            // adjective before the noun ("damaged character") vs after ("character with Evasive")
  static adjectives = [];        // single words that mean this classifier in front of a noun

  static test(x, card, def, env) { throw new Error(`classifier ${this.id}: test() not implemented`); }
  static say(x) { return this.id; }
  static is(x) { return `is ${this.say(x)}`; }
  // "with <phrase>" → [classifier, chars consumed] when the phrase starts with this classifier
  static parseWith(s) { return null; }
  static fromAdjective(word) { return this.adjectives.includes(word.toLowerCase()) ? { [this.id]: true } : null; }
}

// numeric ranges: { lte } | { gte } | { eq }
export const inRange = (v, r) => (r.eq == null || v === r.eq) && (r.lte == null || v <= r.lte) && (r.gte == null || v >= r.gte);
export const sayRange = (r) => (r.eq != null ? `${r.eq}` : r.lte != null ? `${r.lte} or less` : `${r.gte} or more`);
export const range = (n, word) => (word == null ? { eq: +n } : { [/less/i.test(word) ? 'lte' : 'gte']: +n });
export const cap = (w) => String(w).replace(/\b\w/g, (c) => c.toUpperCase());
