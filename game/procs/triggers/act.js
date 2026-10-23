// The generic trigger: "whenever <subject> <verb> [<object>] [while …]" for any subject and any verb in the act
// table (phrases/acts.js). The specific triggers (quest.js, challenge.js, …) keep their own wording; whatever they
// don't read lands here, so "Whenever one of your Hyena characters challenges a damaged character", "Whenever an
// opposing character quests" and "Whenever a character here challenges another character" are one class.
//
//   on: { ev:'act', act, who?: Query, self?: true, obj?: Query, whileCond? }
//   who / obj are relative to the card listening (its owner is "your", the card itself is "this character").
import { Trigger } from './Trigger.js';
import { Query } from '../query.js';
import { ACTS, ACT, ACT_EVENTS, actFlagsOk, subject } from '../phrases/acts.js';
import { parseCondition } from '../conditions/index.js';
import { tryFilter } from '../phrases/filter.js';
import { Miss } from '../phrases/text.js';

const VERBS = new RegExp(String.raw`^(.+?) (${ACTS.map((a) => `(?:${a.now})`).join('|')})(?: (?:another|a|an) (.+?))?$`, 'i');
const actOf = (verb) => ACTS.find((a) => new RegExp(`^(?:${a.now})$`, 'i').test(verb));

function parseAct(head, P) {
  let h = head.replace(/^when(?:ever)? /i, '');
  if (h === head) return null;
  // "… while here" / "… while at a location" narrow the subject; any other "while …" is checked as the event fires
  let narrow = null, whileCond = null, m;
  if ((m = h.match(/^(.+?) while (here|at a location)$/i))) { narrow = /here/i.test(m[2]) ? { here: true } : { atLocation: true }; h = m[1]; }
  else if ((m = h.match(/^(.+?) while (.+)$/i))) { whileCond = parseCondition(m[2], P.at); h = m[1]; }
  // "quests or challenges" — either verb
  const verbs = h.match(new RegExp(String.raw`^(.+?) ((?:${ACTS.map((a) => a.now).join('|')})) or ((?:${ACTS.map((a) => a.now).join('|')}))$`, 'i'));
  const parts = verbs ? [[verbs[1], verbs[2], null], [verbs[1], verbs[3], null]] : [];
  if (!parts.length) { const v = h.match(VERBS); if (!v) return null; parts.push([v[1], v[2], v[3]]); }
  return parts.map(([subj, verb, obj]) => {
    const a = actOf(verb);
    if (!a) P.miss(`trigger verb: "${verb}"`);
    const S = subject(subj, P.at);
    if (narrow && S.F) (S.F.with ||= []).push(narrow);
    let O = null;
    if (obj) { O = a.obj ? tryFilter(obj) : null; if (!O) P.miss(`trigger object: "${obj}"`); }
    return { ev: 'act', act: a.id, ...(S.self ? { self: true } : {}), ...(S.F ? { who: S.F } : {}), ...(O ? { obj: O } : {}), ...(whileCond ? { whileCond } : {}) };
  });
}

export class Act extends Trigger {
  static ev = 'act';
  static rules = [];                                   // tried last, by parseTrigger (after every specific wording)
  static parse(head, P) { try { return parseAct(head, P); } catch (e) { if (e instanceof Miss) return null; throw e; } }
  static say(o) {
    const who = [o.self ? 'this character' : '', o.who ? Query.describe(o.who) : ''].filter(Boolean).join(' or ');
    return `${who} ${ACT[o.act]?.now.replace(/\(\?:([^)|]*)[^)]*\)/g, '$1').split('|')[0] || o.act}${o.obj ? ` ${Query.describe(o.obj)}` : ''}`;
  }
  // every engine event the act table watches → every card in play hears it, and its own `on` decides
  static dispatch(rt, s, ev, info, fireOn) {
    if (!ACT_EVENTS.has(ev) || !info.iid) return;
    const actor = s.cards[info.iid];
    if (!actor) return;
    const other = info.other != null ? s.cards[info.other] : null;
    for (const p of s.players) {
      for (const x of rt.inPlay(s, p.seat)) {
        fireOn(x, 'act', (o) => {
          const a = ACT[o.act];
          if (!a || a.ev !== ev || !actFlagsOk(a, info)) return false;
          const isSelf = actor.iid === x.iid;
          const who = (o.self && isSelf) || (o.who && rt.matches(s, o.who, actor, x.owner, x.iid, { anyZone: true }));
          if (!who) return false;
          return !o.obj || (other && rt.matches(s, o.obj, other, x.owner, x.iid, { anyZone: true }));
        }, [actor.iid]);
      }
    }
  }
}
