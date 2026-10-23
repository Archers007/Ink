// Replacement effects (CR 6.5): an event that "would" happen happens differently, or not at all. Each one is
//   { fn: 'replace', event, who, do, may?, first?, once? }
//     event  'damage' | 'banish' | 'discard' | 'inkDrop'           — what the engine is about to do
//     who    'self' | 'otherYours' | 'you'                          — whose event, relative to the card it's on
//     do     'prevent' (it doesn't happen) · 'redirect' (the damage goes on this card as counters instead)
//            'inkwell' (into the inkwell facedown and exerted instead) · 'deckToInk' (top of deck → inkwell instead)
//     first  'turn' — only the first time each turn                 once — a one-shot granted to a card (a mod)
// Statics on cards in play, and { replace } mods granted to a card ("the next time they would be dealt damage"),
// both apply. replaceEvent() runs 6.5.5 (each replacement gets one chance at an event), 6.5.7 (the affected player
// picks the order — here: the card's own first, then the rest in board order) and 6.5.8 (instances of the same
// replacement apply once).
export const EVENTS = {
  damage: { cr: '6.5', say: 'would be dealt damage' },
  banish: { cr: '6.5', say: 'would be banished' },
  discard: { cr: '6.5', say: 'would discard' },
  inkDrop: { cr: '6.5', say: 'would get an ink drop' },
};
const PRON = String.raw`(?:she|he|it|they)`;
const STATIC = [
  // Lilo - Bundled Up: "the first time this character would take damage, she takes no damage instead"
  [new RegExp(String.raw`^(the first time )?this character would (?:take|be dealt) damage, ${PRON} takes? no damage instead$`, 'i'),
    (m) => ({ event: 'damage', who: 'self', do: 'prevent', ...(m[1] ? { first: 'turn' } : {}) })],
  // Beast - Selfless Protector
  [/^whenever one of your other characters would be dealt damage, put that many damage counters on this character instead$/i,
    () => ({ event: 'damage', who: 'otherYours', do: 'redirect' })],
  // Kronk - Laid Back · Magica De Spell - Cruel Sorceress
  [/^if an effect would cause you to discard one or more cards(?: from your hand)?, you don't discard$/i,
    () => ({ event: 'discard', who: 'you', do: 'prevent' })],
  // Mickey Mouse & Minnie Mouse - Adventuring Duo
  [/^if this character would be banished, put (?:them|him|her|it) into your inkwell facedown and exerted instead$/i,
    () => ({ event: 'banish', who: 'self', do: 'inkwell' })],
  // Baymax - Amped Up
  [/^if you would get an ink drop, (you may )?put the top card of your deck into your inkwell facedown and exerted instead$/i,
    (m) => ({ event: 'inkDrop', who: 'you', do: 'deckToInk', ...(m[1] ? { may: true } : {}) })],
];
export function parseReplace(text) {
  const t = String(text).replace(/\.$/, '').trim();
  for (const [rx, f] of STATIC) { const m = t.match(rx); if (m) return { fn: 'replace', ...f(m) }; }
  return null;
}
// granted by an effect: "the next time they would be dealt damage they take no damage instead" (Rapunzel)
export const GRANT_RX = new RegExp(String.raw`^the next time (${PRON}|that character|chosen character) would (?:be dealt|take) damage,? ${PRON} takes? no damage instead$`, 'i');

const WHAT = { prevent: "it doesn't happen", redirect: 'the damage goes on this card instead', inkwell: 'into the inkwell exerted instead', deckToInk: 'the top card of the deck goes into the inkwell instead' };
const WHO = { self: 'this character', otherYours: 'one of your other characters', you: 'you' };
export const replaceSay = (st) => `${st.first ? 'the first time each turn ' : st.once ? 'the next time ' : ''}if ${WHO[st.who] || st.who} ${EVENTS[st.event]?.say || st.event}, ${st.may ? 'you may have ' : ''}${WHAT[st.do]} [CR 6.5]`;

// Every replacement that can apply to `ev` = { event, iid?, seat } right now.
//   → [{ st, src (iid of the card it's on), key (6.5.8 identity), mod? }]
export function replacements(rt, s, ev) {
  const out = [];
  const subj = ev.iid != null ? s.cards[ev.iid] : null;
  const seat = ev.seat ?? subj?.owner;
  for (const p of s.players) for (const iid of p.play) {
    const src = s.cards[iid];
    for (const proc of rt.procsOf(s, src)) {
      const st = proc.effect;
      if (proc.kind !== 'static' || st?.fn !== 'replace' || st.event !== ev.event) continue;
      if (!rt.staticActive(s, proc, src.owner, iid)) continue;
      if (st.who === 'self' && ev.iid !== iid) continue;
      if (st.who === 'otherYours' && (!subj || subj.iid === iid || subj.owner !== src.owner || rt.E.D(s, subj).type !== 'character')) continue;
      if (st.who === 'you' && seat !== src.owner) continue;
      if (st.first === 'turn' && src.replUsed?.[proc.name || st.event] === s.turn) continue;
      out.push({ st, src: iid, key: `${rt.E.D(s, src).full}#${proc.name || st.event}`, used: () => { (src.replUsed ||= {})[proc.name || st.event] = s.turn; } });
    }
  }
  // one-shots granted to the card itself
  for (const m of subj?.mods || []) if (m.replace && m.replace.event === ev.event) out.push({ st: m.replace, src: subj.iid, key: `mod#${m.replace.event}`, used: () => { subj.mods = subj.mods.filter((x) => x !== m); } });
  return out;
}
// Apply replacements to `ev` until none can (6.5.7.3), each at most once (6.5.5), one instance per key (6.5.8).
// apply(r, ev) → the modified event (or null: it no longer happens). Returns the final event, or null.
export function replaceEvent(rt, s, ev, apply) {
  const tried = new Set();
  for (let guard = 0; ev && guard < 10; guard++) {
    const rs = replacements(rt, s, ev).filter((r) => !tried.has(r.key));
    if (!rs.length) break;
    const own = rs.find((r) => r.src === ev.iid) || rs[0];        // 6.5.6: a card's own replacement first
    tried.add(own.key);
    const next = apply(own, ev);
    if (next === undefined) continue;                              // declined ("you may")
    own.used();
    ev = next;
  }
  return ev;
}
