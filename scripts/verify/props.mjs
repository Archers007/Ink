// Properties that hold after every step of every game — checked by scripts/sim-games.mjs on top of
// engine.checkInvariants. Each names the rule it comes from; a violation throws with the step that caused it.
import { effWp } from '../../public/js/play/rules.js';

export const snap = (s) => ({ lore: s.players.map((p) => p.lore), logN: s.log.length });

// → [message, …] (empty = fine)
export function props(s, prev, a) {
  const out = [];
  const p = s.pending;
  // the prompt protocol: a prompt can always be answered, and always belongs to something resolving
  if (p && p.type === 'choose' && !p.confirm && !p.choices && !p.optional && !(p.valid || []).length && !(p.cards || []).length) out.push(`stuck prompt: ${p.prompt}`);
  if (p && p.type === 'choose' && !(s.fx || []).length) out.push(`prompt with nothing resolving: ${p.prompt}`);
  if (!p && (s.fx || []).length && s.status === 'playing') out.push(`bag not drained: ${s.fx[0].label}`);   // CR 6.2.3
  for (const pl of s.players) {
    if ((pl.inkDrops || 0) < 0) out.push('negative ink drops');                                            // CR 1.13.1.2
    for (const iid of pl.play) {
      const c = s.cards[iid]; const d = s.defs[c.cardId];
      // the game state check ran (CR 1.8.1.4: a character or location with damage ≥ willpower is banished) — unless an
      // ability is still resolving (waiting on a choice): the check comes once all its effects are done (CR 6.7.5, 1.8.5)
      const midAbility = !!s.pending && s.fx?.length > 0;
      if ((d.type === 'character' || d.type === 'location') && d.wp != null && c.damage >= effWp(c, d) && s.status === 'playing' && !midAbility) out.push(`${d.full} has ${c.damage} damage, {willpower} ${effWp(c, d)}`);
      if (c.damage < 0) out.push(`${d.full} has negative damage`);
      if (c.atLocation && !(s.cards[c.atLocation]?.zone === 'play' && s.cards[c.atLocation].owner === c.owner)) out.push(`${d.full} is at a location that isn't in play`);
      if (d.type === 'location' && c.exerted) out.push(`${d.full}: locations can't be exerted`);              // CR 5.6
    }
    // a card that leaves play carries nothing with it (CR 1.9.2.1 damage · 6.6 effects end)
    for (const z of ['hand', 'deck', 'discard', 'inkwell']) for (const iid of pl[z]) {
      const c = s.cards[iid]; const d = s.defs[c.cardId];
      if (c.damage) out.push(`${d.full} in ${z} has ${c.damage} damage`);
      if (c.mods?.length && z !== 'hand') out.push(`${d.full} in ${z} keeps a change: ${JSON.stringify(c.mods[0]).slice(0, 100)}`);
      if (c.atLocation) out.push(`${d.full} in ${z} is still at a location`);
      if (z !== 'inkwell' && c.exerted) out.push(`${d.full} is exerted in the ${z}`);
    }
  }
  // lore only goes down through an effect that says so (CR 1.11)
  if (prev && a.type !== 'lore' && [0, 1].some((k) => s.players[k].lore < prev.lore[k])
    && !s.log.slice(prev.logN).some((l) => /\blos(?:e|t|es)\b.*lore|lore.*\blost\b/i.test(l.text))) out.push(`lore went down with no "lose lore": ${s.log.slice(prev.logN).map((l) => l.text).join(' / ').slice(0, 200)}`);
  return out;
}
