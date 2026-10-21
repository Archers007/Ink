// The printed-card proc every card has, abilities or not: what it costs, whether it can be inked, and what
// its turn actions do (CR 4.3 ink · 4.3.4 play · 4.3.5 quest · 4.3.6 challenge · 4.3.7 move).
//   { kind:'base', type, cost, inkable, quest?:{do}, challenge?:{damage}, willpower?, location?:{lore, move} }
// cards.js reads the card's stats back out of it, so the engine runs on exactly what the proc says.
import { Kind } from './Kind.js';

const n0 = (v) => (v == null ? 0 : Number(v));           // a blank lore/strength in the DB is a printed 0

export class Base extends Kind {
  static kind = 'base';
  static build(d) {
    const type = String(d.type || '').toLowerCase();
    const p = { kind: 'base', type, cost: Number(d.cost) || 0, inkable: !!d.inkable };
    if (type === 'character') {
      p.quest = { do: [{ fn: 'gainLore', n: n0(d.lore) }] };            // exert → gain its {lore}
      p.challenge = { damage: n0(d.str) };                               // deals its {strength} in a challenge
      p.willpower = n0(d.wp);                                            // banished at that much damage
    } else if (type === 'location') {
      p.location = { lore: n0(d.lore), move: n0(d.move) };              // start of your turn: gain its {lore} · move cost
      p.willpower = n0(d.wp);
    } else if (type === 'item') p.stays = true;                          // stays in play
    else p.resolves = true;                                              // action / song: resolve, then discard
    p.exec = true;
    return p;
  }
  // the def stats this proc defines (what the engine reads)
  static stats(p) {
    const out = { cost: p.cost, inkable: p.inkable };
    if (p.quest) out.lore = p.quest.do[0].n;
    if (p.challenge) out.str = p.challenge.damage;
    if (p.willpower != null) out.wp = p.willpower;
    if (p.location) { out.lore = p.location.lore; out.move = p.location.move; }
    return out;
  }
  static explain(p, X) {
    const out = [X.tag('base'), `PLAY for ${p.cost} {ink}${p.inkable ? ' · inkable' : ' · not inkable'}`];
    if (p.quest) out.push(`QUEST → ${p.quest.do.map((st) => X.step(st)).join(', ')}`);
    if (p.challenge) out.push(`CHALLENGE → deal ${p.challenge.damage} damage`);
    if (p.location) out.push(`START OF YOUR TURN → gain ${p.location.lore} lore · MOVE here for ${p.location.move} {ink}`);
    if (p.willpower != null) out.push(`BANISHED at ${p.willpower} damage`);
    if (p.stays) out.push('stays in play');
    if (p.resolves) out.push('resolves, then goes to the discard');
    return out;
  }
}
