// "<who> gets +2 {strength} this turn" · "gains Evasive" · "can't quest" · "can challenge ready characters"
// Stat changes, keyword grants and restrictions are all mods on the card: { stat, delta, until } / { stat:'kw', kw }.
import { Effect } from './Effect.js';
import { STAT, STAT_WORD } from '../phrases/text.js';
import { Selector } from '../phrases/selector.js';
import { Amount } from '../phrases/amount.js';
import { Duration } from '../phrases/duration.js';
import { Keyword } from '../classifiers/keyword.js';
import { kwLabel, KEYWORD_ALT, RESTRICTIONS } from '../classifiers/index.js';
import { Query } from '../query.js';

// "Evasive and Ward" / "Resist +1, Challenger +2" → [{kw,n?}] or null
export function kwList(s, P) {
  const out = [];
  for (const part of s.split(/,? and |, /i)) {
    if (/^"q[0-9a-f]+"$/.test(part.trim())) {                       // a granted ability: nested proc
      if (!P) return null;
      const proc = P.ability(part.trim());
      out.push({ kw: 'grant', proc });
      continue;
    }
    const r = Keyword.parseWith(part.trim());
    if (!r || r[1] !== part.trim().length) return null;
    out.push(r[0]);
  }
  return out.length ? out : null;
}
const KW1 = String.raw`(?:(?:${KEYWORD_ALT})(?: \+?\d+)?|"q[0-9a-f]+")`;
const KWS = String.raw`${KW1}(?:(?:,|,? and) ${KW1})*`;
const CANT = { quest: 'cantQuest', challenge: 'cantChallenge', ready: 'cantReady', 'be challenged': 'cantBeChallenged', 'sing songs': 'cantSing', move: 'cantMove', 'move to locations': 'cantMove', 'exert to sing songs': 'cantSing', '{exert} to sing songs': 'cantSing' };
const VERBS = Object.keys(CANT).sort((a, b) => b.length - a.length).join('|');
const mods2 = (m, i) => [{ stat: STAT[m[i + 1]], n: +m[i] }];

export class Mod extends Effect {
  static fn = 'mod';
  static rules = [
    [/^give (.+?) ([+-]\d+) \{(strength|willpower|lore)\}$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), mods: mods2(m, 2) })],
    [/^give (.+?) ([+-]\d+) \{(strength|willpower|lore)\} and ([+-]\d+) \{(strength|willpower|lore)\}$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), mods: [...mods2(m, 2), ...mods2(m, 4)] })],
    [new RegExp(String.raw`^give (.+?) (${KWS})$`, 'i'), (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: kwList(m[2], P) ?? P.miss(`keywords: "${m[2]}"`) })],
    [new RegExp(String.raw`^give (.+?) ([+-]\d+) \{(strength|willpower|lore)\} and (${KWS})$`, 'i'), (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), mods: mods2(m, 2), kws: kwList(m[4], P) ?? P.miss(`keywords: "${m[4]}"`) })],
    [/^give (.+?) the ([A-Z][\w'-]*(?: [A-Z][\w'-]*)?) classification$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), cls: m[2].toLowerCase() })],
    [/^(.+?) (?:gets?|gains?) ([+-]\d+) \{(strength|willpower|lore)\}(?: and ([+-]\d+) \{(strength|willpower|lore)\})?(?: for each (.+))?$/i, (m, P) => {
      const st = { fn: 'mod', sel: P.sel(m[1]), mods: [...mods2(m, 2), ...(m[4] ? mods2(m, 4) : [])] };
      if (m[6]) st.per = P.forEach(m[6]);
      return P.D(st);
    }],
    [/^(.+?) (?:gets?|gains?) ([+-]\d+) \{(strength|willpower|lore)\} and gains? (.+)$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), mods: mods2(m, 2), kws: kwList(m[4], P) ?? P.miss(`keywords: "${m[4]}"`) })],
    [new RegExp(String.raw`^(.+?) (?:gains?|gets?) (${KWS})$`, 'i'), (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: kwList(m[2], P) ?? P.miss(`keywords: "${m[2]}"`) })],
    // "he gets +3 {strength}, +3 {willpower}, and +3 {lore}"
    [/^(.+?) (?:gets?|gains?) ((?:[+-]\d+ \{(?:strength|willpower|lore)\}(?:,? and |, )){2,}[+-]\d+ \{(?:strength|willpower|lore)\})$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), mods: [...m[2].matchAll(/([+-]\d+) \{(strength|willpower|lore)\}/gi)].map((x) => ({ stat: STAT[x[2].toLowerCase()], n: +x[1] })) })],
    // "this character gains Resist +1 for each other Knight character you have in play"
    [new RegExp(String.raw`^(.+?) gains? (${KWS}) for each (.+)$`, 'i'), (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: kwList(m[2], P) ?? P.miss(`keywords: "${m[2]}"`), per: P.forEach(m[3]) })],
    // "this character loses Reckless" · "characters named Peter Pan lose Evasive"
    [new RegExp(String.raw`^(.+?) loses? (${KWS})$`, 'i'), (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: (kwList(m[2], P) ?? P.miss(`keywords: "${m[2]}"`)).map((k) => ({ kw: k.kw, n: -99, lose: true })) })],
    // "this character can't be challenged by Pirate characters / by characters with 2 {strength} or greater"
    [/^(.+?) can't be challenged by (?:(\w+) characters|characters with (\d+) \{strength\} or (?:greater|more))$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'cantBeChallengedBy', by: m[2] ? { class: m[2].toLowerCase() } : { strGte: +m[3] } }] })],
    // "chosen opposing character can't challenge and must quest [during their next turn] if able"
    [/^(.+?) can't challenge and must quest(?: during their next turn)? if able(?: during their next turn)?$/i, (m, P) => P.D(({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'cantChallenge' }, { kw: 'mustQuest' }], ...(/next turn/i.test(m[0]) && !P.dur ? { dur: 'theirNext' } : {}) }))],
    [new RegExp(String.raw`^(.+?) (?:can't|cannot) (${VERBS})(?: or (${VERBS}))?$`, 'i'), (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [m[2], m[3]].filter(Boolean).map((x) => ({ kw: CANT[x.toLowerCase()] })) })],
    // "loses {strength} equal to this character's {lore}" · "gets +{strength} equal to their {willpower}"
    [/^(.+?) (loses |gets \+|gains \+)\{(strength|willpower|lore)\} equal to (this character's|her|his|their|its) \{(strength|willpower|lore)\}$/i, (m, P) => P.D({
      fn: 'mod', sel: P.sel(m[1]),
      mods: [{ stat: STAT[m[3]], n: /^loses/i.test(m[2]) ? -1 : 1, nOf: { stat: STAT[m[5]], of: /^(their|its)$/i.test(m[4]) ? 'target' : 'self' } }],
    })],
    // damage prevention
    [/^(.+?) takes? no damage from (?:the )?challenges?$/i, (m, P) => ({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'noChallengeDamage' }], ...(/the challenge$/i.test(m[0]) ? { dur: 'turn' } : P.dur ? { dur: P.dur } : {}) })],
    [/^(.+?) takes? no damage while challenging$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'noDamageChallenging' }] })],
    [/^(.+?) can't be dealt damage unless (?:he's|she's|they're|it's) being challenged$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'noEffectDamage' }] })],
    [/^(.+?) can't be dealt damage$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'noDamage' }] })],
    // "can't ready at the start of their next turn" = skip their next ready step
    [/^(.+?) (?:can't|cannot|doesn't|does not|don't) ready at the start of (?:their|its|his|her|its player's) next turn$/i, (m, P) => ({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'skipReady' }], dur: 'theirNext' })],
    [/^(.+?) (?:can't|cannot) ready at the start of your turn$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'skipReady' }] })],
    [/^(.+?) (?:can|may) challenge ready characters$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'challengeReady' }] })],
    // — the same restrictions, for any query —
    // "this character can (also) challenge ready damaged / Villain characters"
    [/^(.+?) (?:can|may) (?:also )?challenge ready (.+)$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [/^characters$/i.test(m[2]) ? { kw: 'challengeReady' } : { kw: 'challengeReadyOf', of: P.filter(m[2]) }] })],
    // "your locations can't be challenged by characters with cost 2 or less"
    [/^(.+?) can't be challenged by (.+)$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'cantBeChallengedBy', by: { q: P.filter(m[2]) } }] })],
    // "characters with cost 3 or less can't challenge this character" · "damaged characters can't challenge your characters"
    [/^(.+?) (?:can't|cannot) challenge (this character|this location|your characters|your locations|your characters or locations|them|him|her)$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[2].replace(/ or locations$/i, '')), kws: [{ kw: 'cantBeChallengedBy', by: { q: P.filter(m[1]) } }] })],
    // "opposing characters can't ready at the start of their turn" (every turn, while the static holds)
    [/^(.+?) (?:can't|cannot) ready at the start of (?:their|its|their players'|its player's) turns?$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'cantReady' }] })],
    // "chosen character counts as having +3 cost to sing songs"
    [/^(.+?) counts? as having \+(\d+) cost to sing songs$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), mods: [{ stat: 'sing', n: +m[2] }] })],
    // "your other characters gain the Detective classification"
    [/^(.+?) gains? the ([A-Z][\w'-]*(?: [A-Z][\w'-]*)?) classification$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), cls: m[2].toLowerCase() })],
    // "this character can quest the turn he's played"
    [/^(.+?) can quest the turn (?:he's|she's|they're|it's) played$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'questFresh' }] })],
  ];
  static run(rt, s, job, st, ev) {
    const ids = rt.targets(s, job, st, st.sel);
    if (!ids) return null;
    const mult = st.per ? Amount.count(rt, s, st.per, job.seat, job.src, job) : 1;
    job.ctx.it = ids;
    return rt.each(ids, (iid) => {
      rt.addMods(s, job, st, iid, ev, st.per?.count?.damageOnRef ? s.cards[iid].damage : mult);
      rt.log(s, `↳ ${rt.tl(s, iid)} ${st.kws && !st.mods ? 'gains' : 'gets'} ${Mod.text(rt, s, job, st)}.`, { seat: job.seat, kind: 'effect' });
    });
  }
  static text(rt, s, job, st) {
    const what = [
      ...(st.mods || []).map((m) => (m.nOf ? `${m.n > 0 ? '+' : '-'}${STAT_WORD[m.stat]} equal to ${m.nOf.of === 'self' ? "this card's" : 'its'} ${STAT_WORD[m.nOf.stat]}` : `${m.n > 0 ? '+' : ''}${m.n} ${STAT_WORD[m.stat]}`)),
      ...(st.kws || []).map((k) => (k.kw === 'grant' ? `"${k.proc.text}"` : k.lose ? `loses ${kwLabel(k.kw)}` : kwLabel(k.kw, k.n))),
      ...(st.cls ? [`the ${st.cls} classification`] : []),
    ].join(' and ');
    return what + (st.dur === 'next' ? ` until the start of ${rt.E.nameOf(s, job.seat)}'s next turn` : st.dur === 'theirNext' ? ' during their next turn' : st.dur ? ' this turn' : '');
  }
  static verb(rt, s, job, st) { return Mod.text(rt, s, job, st); }
  static say(st) {
    const what = [...(st.mods || []).map((m) => (m.nOf ? `${m.n > 0 ? '+' : '-'}${STAT_WORD[m.stat]} equal to ${m.nOf.of === 'self' ? "this card's" : 'its'} ${STAT_WORD[m.nOf.stat]}` : `${m.n > 0 ? '+' : ''}${m.n} ${STAT_WORD[m.stat]}`)), ...(st.kws || []).map((k) => (k.kw === 'grant' ? `"${k.proc.text}"` : k.by ? `can't be challenged by ${k.by.q ? Query.describe(k.by.q) : k.by.class ? `${k.by.class} characters` : `characters with ${k.by.strGte}+ {strength}`}` : k.of ? `can challenge ready ${Query.describe(k.of)}` : k.lose ? `loses ${kwLabel(k.kw)}` : kwLabel(k.kw, k.n))), ...(st.cls ? [`the ${st.cls} classification`] : [])].join(', ');
    return `${Selector.say(st.sel)} ${(st.kws || []).every((k) => RESTRICTIONS[k.kw] || k.lose) && !st.mods ? '' : st.mods ? 'gets ' : 'gains '}${what}${st.per ? ` for each ${Amount.sayPer(st.per)}` : ''} ${st.dur ? Duration.say(st.dur) : '(while in play)'}`;
  }
  static check(st, missing, SUPPORT) {
    for (const k of st.kws || []) {
      if (k.kw === 'grant') { if (!k.proc.exec) missing.add(`granted ability: ${(k.proc.why || '').replace(/^engine can't run: /, '')}`); }
      else if (!SUPPORT.kw.has(k.kw)) missing.add(`keyword ${k.kw}`);
    }
  }
}
