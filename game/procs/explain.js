// Proc → plain-English read-back lines. Every block says its own words (effects/*.say, triggers/*.say, …).
import { KINDS } from './kinds/index.js';
import { EFFECT } from './effects/index.js';
import { sayCondition } from './conditions/index.js';

function step(st) {
  const gate = st.ifDid ? 'if you did, ' : st.otherwise ? 'otherwise, ' : st.linked ? 'then ' : '';
  const E = EFFECT[st.fn];
  const body = E ? E.say(st, step) : st.fn;
  return `${gate}${st.cond ? `if ${sayCondition(st.cond)}, ` : ''}${st.may ? 'may ' : ''}${body}`;
}

export function explain(p) {
  const X = { step, cond: sayCondition, tag: (k) => (p.exec ? `⚡ ${k}` : `✋ ${k} (manual)`) };
  const K = KINDS[p.kind];
  const out = K ? K.explain(p, X) : [p.kind];
  if (p.exec === false && p.kind !== 'unparsed' && p.why) out.push(`why manual: ${p.why}`);
  return out;
}
