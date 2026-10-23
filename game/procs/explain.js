import { kwLabel } from './classifiers/index.js';
// Proc → plain-English read-back lines. Every block says its own words (effects/*.say, triggers/*.say, …).
import { KINDS } from './kinds/index.js';
import { EFFECT } from './effects/index.js';
import { sayCondition } from './conditions/index.js';
import { Amount } from './phrases/amount.js';

function step(st) {
  const gate = st.ifDid ? 'if you did, ' : st.ifAny ? 'if you did either, ' : st.otherwise ? 'otherwise, ' : st.linked ? 'then ' : '';
  const E = EFFECT[st.fn];
  const body = E ? E.say(st, step) : st.fn;
  const alt = st.instead ? ` — instead, if ${sayCondition(st.instead.cond)}: ${step({ fn: st.fn, sel: st.sel, ...st.instead.step })}` : '';
  // abilities inside this step (a granted "…" ability, a delayed trigger) are read back in full, not as their quoted text
  const inner = [...(st.kws || []).filter((k) => k.kw === 'grant' && k.proc?.kind).map((k) => k.proc), ...(st.fn === 'delayed' && st.proc ? [st.proc] : [])];
  const nested = inner.map((p) => ` [${explain(p).slice(1).join('; ')}]`).join('');
  const flags = [st.cost ? ' (as a cost)' : '', st.repeat ? ` — once for each ${Amount.sayPer(st.repeat)}` : '', st.once ? ' (once)' : ''].join('');
  return `${gate}${st.cond ? `if ${sayCondition(st.cond)}, ` : ''}${st.may ? 'may ' : ''}${body}${alt}${flags}${nested}`;
}

export function explain(p) {
  const X = { step, cond: sayCondition, tag: (k) => (p.exec ? `⚡ ${k}` : `✋ ${k} (manual)`) };
  const K = KINDS[p.kind];
  const out = K ? K.explain(p, X) : [p.kind];
  if (p.also) out.push(`+ keyword ${p.also.map((k) => kwLabel(k.kw, k.n)).join(', ')}`);
  if (p.alsoProc) out.push(`+ ${explain(p.alsoProc).join(' ')}`);   // "When you discard this card, …" on an action
  if (p.exec === false && p.kind !== 'unparsed' && p.why) out.push(`why manual: ${p.why}`);
  return out;
}
