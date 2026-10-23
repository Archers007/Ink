// "named Ariel", "named Flotsam or Jetsam" · "the named card" / "with that name" (the name a "Name a card" effect chose)
import { Classifier } from './Classifier.js';

// CR 5.2.6.1–5.2.6.3: "Flotsam & Jetsam" is named Flotsam, Jetsam and Flotsam & Jetsam; Chip 'n' Dale counts as having the ampersand
export const namesOf = (def) => {
  const n = String(def.name || '');
  const parts = n.split(/\s+(?:&|'n')\s+/i);
  return [n, ...(parts.length > 1 ? parts : [])].map((x) => x.toLowerCase());
};
export class Named extends Classifier {
  static id = 'named';
  static test(x, card, def) { const ns = namesOf(def); return x.named.some((n) => ns.includes(n.toLowerCase())); }
  static say(x) { return `named ${x.named.join(' or ')}`; }
  static is(x) { return `is ${this.say(x)}`; }
}
// the name chosen by the "Name a card" step that ran last (effects/name.js keeps it in s.named)
export class NamedCard extends Classifier {
  static id = 'namedCard';
  static parseWith(s) { const m = s.match(/^that name\b/i); return m ? [{ namedCard: true }, m[0].length] : null; }
  static test(x, card, def, env) { const n = env.s?.named?.name; return !!n && namesOf(def).includes(n.toLowerCase()); }
  static say() { return 'with the named name'; }
  static is() { return 'is the named card'; }
}
