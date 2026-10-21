// Ability text → proc (a small JSON program the engine runs). Deterministic, no AI.
//
//   L0  normalize.js         canonical spelling
//   L1  kinds/               keyword line | cost — effect | trigger, effect | static | action
//   L2  phrases/ + classifiers/ + conditions/ + triggers/     noun phrases, "with …", conditions, trigger heads
//   L3  Compiler.effects()   sentences → steps; "you may", "then", "if you do", "Choose one", look tails
//       Compiler.clause()    one imperative → one step, by asking each effects/ class in priority order
//
// Every parser returns a value or throws Miss(reason, clause). Abilities compile all-or-nothing:
// one clause we don't understand → { kind:'unparsed', why, at } and the engine leaves it manual.

import { canon, stripReminders } from './normalize.js';
import { Miss, miss, lc, sentences } from './phrases/text.js';
import { filter } from './phrases/filter.js';
import { Selector } from './phrases/selector.js';
import { Amount } from './phrases/amount.js';
import { Duration } from './phrases/duration.js';
import { parseCondition, conditionOf } from './conditions/index.js';
import { EFFECTS, EFFECT, Look } from './effects/index.js';
import { KINDS, KeywordLine, KEYWORD_START, Action, Activated, Triggered, Static } from './kinds/index.js';
import { SUPPORT } from './support.js';

export { Miss };
const SONG_REMINDER = /^\(?(?:a|an) character with cost \d+ or more can \{exert\} to sing this song for free\.?\)?$/i;
const SING_TOGETHER = /^sing together \d+\s*/i;
const COST_THEN = /^(you may )?(pay \d+ \{ink\}|exert .+?|banish .+?|discard a card|choose and discard a card|put .+? into your inkwell facedown|return .+? to your hand) to (.+)$/i;

export class Compiler {
  // phrase helpers handed to every rule:  P.sel("chosen character"), P.filter("Hero character"), P.D(step)…
  P(at, ctx = {}, dur = null) {
    return {
      at, ctx, dur,
      sel: (x) => Selector.parse(x, at),
      filter: (x) => filter(x, at),
      forEach: (x) => Amount.forEach(x, at),
      miss: (why) => miss(why, at),
      D: (o) => (dur ? { ...o, dur } : ctx.static ? o : miss('needs a duration (this turn / until …)', at)),
    };
  }
  filter(x, at) { return filter(x, at); }
  condition(x, at) { return parseCondition(x, at); }
  miss(why, at) { miss(why, at); }

  // one imperative clause → one step
  clause(raw, ctx = {}) {
    let s = raw.trim().replace(/[.!]$/, '').trim();
    let may = false;
    let m;
    if ((m = s.match(/^you may (.+)$/i))) { may = true; s = m[1]; }
    s = lc(s);
    let dur;
    [s, dur] = Duration.take(s);
    const P = this.P(raw, ctx, dur);
    for (const E of EFFECTS) for (const [rx, f] of E.rules) {
      const mm = s.match(rx);
      if (!mm) continue;
      const st = f(mm, P);
      if (st) return may ? { ...st, may: true } : st;
    }
    miss(`effect: "${s}"`, raw);
  }

  // effect text → steps
  effects(text, ctx = {}) {
    const steps = [];
    const at = text;
    const chooseAt = text.search(/choose one: • /i);
    if (chooseAt >= 0) {
      const before = text.slice(0, chooseAt).trim();
      const opts = text.slice(chooseAt).replace(/^choose one: • /i, '').split(/ • /);
      if (before) steps.push(...this.effects(before, ctx));
      steps.push({ fn: 'chooseOne', labels: opts.map((o) => o.trim().replace(/\.$/, '')), options: opts.map((o) => this.effects(o.trim(), ctx)) });
      return steps;
    }
    for (const sent of sentences(text)) {
      const last = steps[steps.length - 1];
      if (last?.fn === 'look' && Look.tail(sent, last, at)) continue;
      let s = sent.replace(/[.!]$/, '').trim();
      let ifDid = false;
      let cond = null;
      let m;
      if ((m = s.match(/^then,? (.+)$/i))) s = m[1];
      if ((m = s.match(/^if you do,? (.+)$/i))) { ifDid = true; s = m[1]; }
      if ((m = s.match(/^if (.+?), (.+)$/i)) && !/^if you do/i.test(s)) { cond = parseCondition(m[1], at); s = m[2]; }
      if ((m = s.match(/^otherwise,? (.+)$/i))) { const st = this.effects(m[1], ctx); st[0].otherwise = true; steps.push(...st); continue; }
      s.split(/,? then,? /i).forEach((part, i) => {
        const pm = part.match(COST_THEN);
        if (pm) {
          // "you may pay 2 {ink} to draw a card" — the cost, then the rest only if it was paid
          steps.push(this.clause((pm[1] || '') + pm[2], ctx));
          const st = this.effects(pm[3], ctx);
          st.forEach((x) => { x.ifDid = true; });
          steps.push(...st);
          return;
        }
        const st = this.clause(part, ctx);
        if (i > 0) st.linked = true;
        if (i === 0 && ifDid) st.ifDid = true;
        if (i === 0 && cond) st.cond = cond;
        steps.push(st);
      });
    }
    if (!steps.length) miss('no effect', at);
    return steps;
  }

  // ability text → proc (no exec info)
  text(text, cardType, named) {
    if (!text) return { kind: 'reminder' };
    const spell = cardType === 'action' || cardType === 'song';
    // songs: "Sing Together N" and the "sing this for free" reminder are rules the engine already knows
    let t = text.replace(SING_TOGETHER, (m) => (spell ? '' : m)).trim();
    if (spell && SONG_REMINDER.test(stripReminders(t) === '' ? t : t.match(/^\([^)]*\)/)?.[0] || '')) t = t.replace(/^\([^)]*\)\s*/, '');
    if (!t) return { kind: 'reminder' };
    if (!named || KEYWORD_START.test(t)) {
      const kw = KeywordLine.parse(t);
      if (kw) return kw;
    }
    t = stripReminders(t);
    if (!t) return { kind: 'reminder' };
    if (spell) return Action.parse(t, this);

    // modifiers that wrap the rest
    let once = false; let during = null; let m;
    for (let guard = 0; guard < 3; guard++) {
      if ((m = t.match(/^once (?:during your|per) turn,? (.+)$/i))) { once = true; t = m[1]; continue; }
      if ((m = t.match(/^during your turn,? (.+)$/i))) { during = 'yours'; t = m[1]; continue; }
      if ((m = t.match(/^during (?:an opponent's turn|opponents' turns|each opponent's turn),? (.+)$/i))) { during = 'opp'; t = m[1]; continue; }
      break;
    }
    const mods = { ...(once ? { once } : {}), ...(during ? { during } : {}) };
    return Activated.parse(t, this, mods) || Triggered.parse(t, this, mods) || Static.parse(t, this, mods);
  }

  // can the engine run it?  → { exec } | { exec:false, why }
  check(proc) {
    const missing = new Set();
    KINDS[proc.kind]?.check(proc, missing, SUPPORT);
    if (proc.kind !== 'keyword' && proc.kind !== 'reminder') {
      walk(proc, (st) => {
        if (st.fn && st !== proc.effect) {
          const E = EFFECT[st.fn];
          if (!E || !SUPPORT.fn.has(st.fn)) missing.add(`fn ${st.fn}`);
          else E.check(st, missing, SUPPORT);
        }
        if (st === proc.effect) EFFECT[st.fn]?.check(st, missing, SUPPORT);
        const C = st !== proc && conditionOf(st);
        if (C && !SUPPORT.cond.has(C.key) && !(C.key === 'self' && st.self === true)) missing.add(`cond ${C.key}`);
        if (st.dur && !SUPPORT.dur.has(st.dur)) missing.add(`duration ${st.dur}`);
      });
    }
    return missing.size ? { exec: false, why: `engine can't run: ${[...missing].join(', ')}` } : { exec: true };
  }

  ability(ab, cardType) {
    const name = ab.name || null;
    let text = canon(ab.text ?? ab.description ?? '');
    text = text.replace(/^[A-Z0-9][A-Z0-9'!?,.\- ]{2,}\s+(?=[A-Z][a-z])/, (h) => (name && h.trim().toUpperCase() === name.toUpperCase() ? '' : h));
    const base = { name, text };
    try {
      const proc = this.text(text, cardType, !!name);
      return { ...base, ...proc, ...this.check(proc) };
    } catch (e) {
      if (!(e instanceof Miss)) throw e;
      return { ...base, kind: 'unparsed', why: e.message, at: e.at, exec: false };
    }
  }
}

function walk(proc, visit) {
  const seen = (st) => {
    if (!st || typeof st !== 'object') return;
    visit(st);
    for (const v of Object.values(st)) {
      if (Array.isArray(v)) v.forEach((x) => (Array.isArray(x) ? x.forEach(seen) : seen(x)));
      else if (v && typeof v === 'object') seen(v);
    }
  };
  seen(proc);
}

const COMPILER = new Compiler();
export const compileAbility = (ab, cardType) => COMPILER.ability(ab, cardType);
export const compileCard = (card) => (card.abilities || []).map((ab) => COMPILER.ability(ab, (card.type || '').toLowerCase()));
export const execInfo = (proc) => COMPILER.check(proc);
export const clause = (raw, ctx) => COMPILER.clause(raw, ctx);
export const effects = (text, ctx) => COMPILER.effects(text, ctx);
export const condition = (x, at) => parseCondition(x, at);
export const selector = (x, at) => Selector.parse(x, at);
export { filter };
