// Comparisons with another card — the card the ability is on, the card it just acted on, or every card of a group:
//   "with more {strength} than each opposing character"     { cmp: { stat:'str', op:'gt', vs:{ maxOf: Query } } }
//   "with less {strength} than that character"              { cmp: { stat:'str', op:'lt', vs:{ of:'ref', stat:'str' } } }
//   "with cost equal to or less than this character's {strength}"  { cmp: { stat:'cost', op:'lte', vs:{ of:'self', stat:'str' } } }
//   "with the same name as that character"                  { sameName: 'ref' }
// env.it is what the ability last acted on (Runtime passes it in), env.src the card the ability is on.
import { Classifier } from './Classifier.js';
import { Query } from '../query.js';          // used at run time only (query.js imports the classifier registry)

const STAT = { '{strength}': 'str', '{willpower}': 'wp', '{lore}': 'lore', cost: 'cost', strength: 'str', willpower: 'wp', lore: 'lore' };
const SAY = { str: '{strength}', wp: '{willpower}', lore: '{lore}', cost: 'cost' };
const REF = String.raw`(?:that character|the chosen character|the banished character|the exerted character|that card|him|her|it|them)`;
const SELF = String.raw`(?:this character|this card)`;
const statOf = (E, card, def, stat) => (stat === 'cost' ? def.cost : stat === 'str' ? E.effStr(card, def) : stat === 'wp' ? E.effWp(card, def) : E.effLore(card, def));
const OPS = { gt: (a, b) => a > b, lt: (a, b) => a < b, lte: (a, b) => a <= b, gte: (a, b) => a >= b };
const refCard = (env) => { const id = (env.it || [])[0]; return id != null && env.s ? env.s.cards[id] : null; };

export class Compare extends Classifier {
  static id = 'cmp';
  static reg = null;                     // { filter } — set by filter.js (no import cycle)
  // every card in play the group query names, seen from the same controller
  static group(env, F) {
    if (!env.s) return [];
    const out = [];
    for (const p of env.s.players) for (const iid of p[F.zone || 'play'] || []) {
      const c = env.s.cards[iid];
      if (Query.matches(F, c, env.E.D(env.s, c), env)) out.push(iid);
    }
    return out;
  }
  static parseWith(s) {
    let m;
    if ((m = s.match(/^(more|less) (\{strength\}|\{willpower\}|\{lore\}) than each (.+)$/i))) {
      return [{ cmp: { stat: STAT[m[2]], op: /more/i.test(m[1]) ? 'gt' : 'lt', vs: { maxOf: Compare.reg.filter(m[3]), stat: STAT[m[2]] } } }, m[0].length];
    }
    if ((m = s.match(new RegExp(String.raw`^(more|less) (\{strength\}|\{willpower\}|\{lore\}) than (${REF}|${SELF})`, 'i')))) {
      return [{ cmp: { stat: STAT[m[2]], op: /more/i.test(m[1]) ? 'gt' : 'lt', vs: { of: new RegExp(`^${SELF}$`, 'i').test(m[3]) ? 'self' : 'ref', stat: STAT[m[2]] } } }, m[0].length];
    }
    // "cost equal to or less than this character's {strength}" · "{strength} equal to or less than the {strength} he had in play"
    if ((m = s.match(new RegExp(String.raw`^(cost|\{strength\}|\{willpower\}|\{lore\}) equal to or (less|more) than (?:(${SELF})'s|(${REF})'s|his|her|their|its|the) (cost|\{strength\}|\{willpower\}|\{lore\})(?: (?:he|she|it|they) had in play)?`, 'i')))) {
      const self = !!m[3];
      return [{ cmp: { stat: STAT[m[1].toLowerCase()], op: /less/i.test(m[2]) ? 'lte' : 'gte', vs: { of: self ? 'self' : 'ref', stat: STAT[m[5].toLowerCase()] } } }, m[0].length];
    }
    return null;
  }
  static test(x, card, def, env) {
    const c = x.cmp;
    const mine = statOf(env.E, card, def, c.stat);
    if (c.vs.maxOf) {
      const others = Compare.group(env, c.vs.maxOf).filter((id) => id !== card.iid);
      return others.every((id) => { const o = env.s.cards[id]; return OPS[c.op](mine, statOf(env.E, o, env.E.D(env.s, o), c.stat)); });
    }
    const other = c.vs.of === 'self' ? env.s?.cards[env.src] : refCard(env);
    if (!other) return false;
    return OPS[c.op](mine, statOf(env.E, other, env.E.D(env.s, other), c.vs.stat));
  }
  static say(x) {
    const c = x.cmp;
    const op = { gt: 'more', lt: 'less', lte: 'equal to or less', gte: 'equal to or more' }[c.op];
    return `with ${op} ${SAY[c.stat]} than ${c.vs.maxOf ? 'each other' : c.vs.of === 'self' ? "this card's" : "that card's"}${c.vs.maxOf ? '' : ` ${SAY[c.vs.stat]}`}`;
  }
}
export class SameName extends Classifier {
  static id = 'sameName';
  static parseWith(s) {
    const m = s.match(new RegExp(String.raw`^the same name(?: as (${REF}|${SELF}))?`, 'i'));     // bare "the same name" = as the card just picked
    return m ? [{ sameName: m[1] && new RegExp(`^${SELF}$`, 'i').test(m[1]) ? 'self' : 'ref' }, m[0].length] : null;
  }
  static test(x, card, def, env) {
    const other = x.sameName === 'self' ? env.s?.cards[env.src] : refCard(env);
    return !!other && other.iid !== card.iid && env.E.D(env.s, other).name === def.name;
  }
  static say(x) { return `with the same name as ${x.sameName === 'self' ? 'this card' : 'that card'}`; }
}
// "the item you played has a different name than each other item you have in play" — no other matching card of yours shares it
export class UniqueName extends Classifier {
  static id = 'uniqueName';
  static test(x, card, def, env) {
    if (!env.s) return false;
    return !env.E.P(env.s, env.ctl).play.some((iid) => iid !== card.iid && env.E.D(env.s, env.s.cards[iid]).name === def.name
      && (!x.uniqueName.types || x.uniqueName.types.includes(env.E.D(env.s, env.s.cards[iid]).type)));
  }
  static say(x) { return `with a different name than each other ${x.uniqueName.types?.join('/') || 'card'} you have in play`; }
}
// "a character in play with the highest cost, or tied for highest cost" — among every character in play
export class HighestCost extends Classifier {
  static id = 'highestCost';
  static parseWith(s) { const m = s.match(/^the highest cost(?:,? or tied for (?:the )?highest cost)?/i); return m ? [{ highestCost: true }, m[0].length] : null; }
  static test(x, card, def, env) {
    if (!env.s) return false;
    let max = -Infinity;
    for (const p of env.s.players) for (const iid of p.play) { const d = env.E.D(env.s, env.s.cards[iid]); if (d.type === 'character') max = Math.max(max, d.cost); }
    return def.cost >= max;
  }
  static say() { return 'with the highest cost (or tied)'; }
}
