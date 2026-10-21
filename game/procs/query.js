// Query — "which cards?" A query is a base set narrowed by classifiers:
//
//   { zone?, owner?: 'you'|'opp', types?: [...], other?: true, with?: [classifier…] }
//
//   "songs with Sing Together"                 { types:['song'], with:[{ kw:'singTogether' }] }
//   "damaged opposing Villain characters
//    with cost 3 or less"                      { types:['character'], owner:'opp',
//                                                with:[{ damaged:true }, { class:['villain'] }, { cost:{ lte:3 } }] }
//
// `with` is the query proc: it ANDs its classifiers (classifiers/). zone defaults to 'play'.
// owner/other are relative to whoever controls the ability (env.ctl) and the card it's on (env.src).

import { classify, sayClassifier, preClassifier } from './classifiers/index.js';

export class Query {
  // Does this card belong to the query's set? env = { E, ctl, src }. o.anyZone ignores the zone (cards being played/moved).
  static matches(F, card, def, env, o = {}) {
    if (!card || !def) return false;
    if (F.any) return F.any.some((G) => Query.matches({ zone: F.zone, owner: F.owner, other: F.other, ...G }, card, def, env, o));
    if (!o.anyZone && card.zone !== (F.zone || 'play')) return false;
    if (F.types && !Query.typeOk(F.types, def)) return false;
    if (F.owner === 'you' && card.owner !== env.ctl) return false;
    if (F.owner === 'opp' && card.owner === env.ctl) return false;
    if (F.other && card.iid === env.src) return false;
    for (const x of F.with || []) if (!classify(x, card, def, env)) return false;
    return true;
  }

  // songs are actions too (CR 6.3.2); "song" also matches action cards whose classification says Song
  static typeOk(types, def) {
    const mine = def.type === 'song' ? ['song', 'action'] : [def.type];
    return types.some((t) => mine.includes(t) || (t === 'song' && (def.classes || []).some((k) => /song/i.test(k))));
  }

  // Human words: "other damaged opposing Villain character with cost 3 or less"
  static describe(F = {}) {
    if (F.any) return F.any.map((G) => Query.describe({ ...G, owner: F.owner, other: F.other })).join(' or ');
    const pre = [];
    const post = [];
    if (F.other) pre.push('other');
    if (F.owner === 'opp') pre.push('opposing');
    for (const x of F.with || []) (preClassifier(x) ? pre : post).push(sayClassifier(x));
    if (F.owner === 'you') post.unshift('of yours');
    if (F.zone && F.zone !== 'play') post.push(`in ${F.owner === 'opp' ? "an opponent's" : F.owner === 'you' ? 'your' : 'a'} ${F.zone}`);
    return [...pre, F.types ? F.types.join(' or ') : 'card', ...post].join(' ');
  }

  // All classifiers a query (or any proc fragment) uses — for coverage stats / search
  static classifiersIn(x, out = []) {
    if (Array.isArray(x)) x.forEach((v) => Query.classifiersIn(v, out));
    else if (x && typeof x === 'object') {
      if (Array.isArray(x.with)) out.push(...x.with);
      if (Array.isArray(x.self)) out.push(...x.self);
      for (const [k, v] of Object.entries(x)) if (k !== 'with' && k !== 'self') Query.classifiersIn(v, out);
    }
    return out;
  }
}

export const describe = (F) => Query.describe(F);
