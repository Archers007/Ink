// "<who> gets +2 {strength} this turn" · "gains Evasive" · "can't quest" · "can challenge ready characters"
// Stat changes, keyword grants and restrictions are all mods on the card: { stat, delta, until } / { stat:'kw', kw }.
import { Effect } from './Effect.js';
import { STAT, STAT_WORD } from '../phrases/text.js';
import { Selector } from '../phrases/selector.js';
import { Amount } from '../phrases/amount.js';
import { Duration } from '../phrases/duration.js';
import { Keyword } from '../classifiers/keyword.js';
import { kwLabel, KEYWORD_ALT, RESTRICTIONS } from '../classifiers/index.js';

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
    [/^(.+?) (?:gets?|gains?) ([+-]\d+) \{(strength|willpower|lore)\}(?: and ([+-]\d+) \{(strength|willpower|lore)\})?(?: for each (.+))?$/i, (m, P) => {
      const st = { fn: 'mod', sel: P.sel(m[1]), mods: [...mods2(m, 2), ...(m[4] ? mods2(m, 4) : [])] };
      if (m[6]) st.per = P.forEach(m[6]);
      return P.D(st);
    }],
    [/^(.+?) (?:gets?|gains?) ([+-]\d+) \{(strength|willpower|lore)\} and gains? (.+)$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), mods: mods2(m, 2), kws: kwList(m[4], P) ?? P.miss(`keywords: "${m[4]}"`) })],
    [new RegExp(String.raw`^(.+?) (?:gains?|gets?) (${KWS})$`, 'i'), (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: kwList(m[2], P) ?? P.miss(`keywords: "${m[2]}"`) })],
    [new RegExp(String.raw`^(.+?) (?:can't|cannot) (${VERBS})(?: or (${VERBS}))?$`, 'i'), (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [m[2], m[3]].filter(Boolean).map((x) => ({ kw: CANT[x.toLowerCase()] })) })],
    // damage prevention
    [/^(.+?) takes? no damage from (?:the )?challenges?$/i, (m, P) => ({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'noChallengeDamage' }], ...(/the challenge$/i.test(m[0]) ? { dur: 'turn' } : P.dur ? { dur: P.dur } : {}) })],
    [/^(.+?) takes? no damage while challenging$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'noDamageChallenging' }] })],
    [/^(.+?) can't be dealt damage unless (?:he's|she's|they're|it's) being challenged$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'noEffectDamage' }] })],
    [/^(.+?) can't be dealt damage$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'noDamage' }] })],
    // "can't ready at the start of their next turn" = skip their next ready step
    [/^(.+?) (?:can't|cannot) ready at the start of (?:their|its|his|her|its player's) next turn$/i, (m, P) => ({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'skipReady' }], dur: 'theirNext' })],
    [/^(.+?) (?:can't|cannot) ready at the start of your turn$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'skipReady' }] })],
    [/^(.+?) (?:can|may) challenge ready characters$/i, (m, P) => P.D({ fn: 'mod', sel: P.sel(m[1]), kws: [{ kw: 'challengeReady' }] })],
  ];
  static run(rt, s, job, st, ev) {
    const ids = rt.targets(s, job, st, st.sel);
    if (!ids) return null;
    const mult = st.per ? Amount.count(rt, s, st.per, job.seat, job.src) : 1;
    job.ctx.it = ids;
    return rt.each(ids, (iid) => {
      rt.addMods(s, job, st, iid, ev, mult);
      rt.log(s, `↳ ${rt.tl(s, iid)} ${st.kws && !st.mods ? 'gains' : 'gets'} ${Mod.text(rt, s, job, st)}.`, { seat: job.seat, kind: 'effect' });
    });
  }
  static text(rt, s, job, st) {
    const what = [
      ...(st.mods || []).map((m) => `${m.n > 0 ? '+' : ''}${m.n} ${STAT_WORD[m.stat]}`),
      ...(st.kws || []).map((k) => (k.kw === 'grant' ? `"${k.proc.text}"` : kwLabel(k.kw, k.n))),
    ].join(' and ');
    return what + (st.dur === 'next' ? ` until the start of ${rt.E.nameOf(s, job.seat)}'s next turn` : st.dur === 'theirNext' ? ' during their next turn' : st.dur ? ' this turn' : '');
  }
  static verb(rt, s, job, st) { return Mod.text(rt, s, job, st); }
  static say(st) {
    const what = [...(st.mods || []).map((m) => `${m.n > 0 ? '+' : ''}${m.n} ${STAT_WORD[m.stat]}`), ...(st.kws || []).map((k) => (k.kw === 'grant' ? `"${k.proc.text}"` : kwLabel(k.kw, k.n)))].join(', ');
    return `${Selector.say(st.sel)} ${(st.kws || []).every((k) => RESTRICTIONS[k.kw]) && !st.mods ? '' : st.mods ? 'gets ' : 'gains '}${what}${st.per ? ` for each ${Amount.sayPer(st.per)}` : ''} ${st.dur ? Duration.say(st.dur) : '(while in play)'}`;
  }
  static check(st, missing, SUPPORT) {
    for (const k of st.kws || []) {
      if (k.kw === 'grant') { if (!k.proc.exec) missing.add(`granted ability: ${(k.proc.why || '').replace(/^engine can't run: /, '')}`); }
      else if (!SUPPORT.kw.has(k.kw)) missing.add(`keyword ${k.kw}`);
    }
  }
}
