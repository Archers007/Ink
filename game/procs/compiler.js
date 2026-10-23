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
import { PLAYER_RX, playerOf } from './phrases/player.js';

export { Miss };
const SONG_REMINDER = /^\(?(?:a|an) character with cost \d+ or more can \{exert\} to sing this song for free\.?\)?$/i;
const SING_TOGETHER = /^sing together \d+\s*/i;
const COST_THEN = /^(you may )?(pay \d+ \{ink\}|exert .+?|banish .+?|discard a card|choose and discard a card|put .+? into your inkwell facedown|return .+? to your hand) to (.+)$/i;

// "draws 2 cards and gains 2 lore" → "draw 2 cards and gain 2 lore"; their → your
const VERB3 = /\b(draws|loses|gains|puts|discards|chooses|exerts|shuffles|reveals|pays|returns|deals|banishes|readies|plays|removes|moves|looks|gets|takes|mills)\b/gi;
export function secondPerson(t) {
  return t.replace(VERB3, (v) => (/ies$/i.test(v) ? v.slice(0, -3) + 'y' : /(sh|ch|ss|x)es$/i.test(v) ? v.slice(0, -2) : v.slice(0, -1)))
    .replace(/\btheir\b/gi, 'your').replace(/\bthey have\b/gi, 'you have').replace(/\bthey\b/gi, 'you');
}

export class Compiler {
  // phrase helpers handed to every rule:  P.sel("chosen character"), P.filter("Hero character"), P.D(step)…
  P(at, ctx = {}, dur = null) {
    return {
      at, ctx, dur,
      sel: (x) => Selector.parse(x, at),
      filter: (x) => filter(x, at),
      forEach: (x) => Amount.forEach(x, at),
      miss: (why) => miss(why, at),
      ability: (tok) => this.ability({ text: unquote(tok) }, 'character'),
      D: (o) => (dur ? { ...o, dur } : o.dur || ctx.static ? o : miss('needs a duration (this turn / until …)', at)),
    };
  }
  filter(x, at) { return filter(x, at); }
  forEach(x, at) { return Amount.forEach(x, at); }
  condition(x, at) { return parseCondition(x, at); }
  miss(why, at) { miss(why, at); }

  // one imperative clause → one step
  clause(raw, ctx = {}) {
    let s = raw.trim().replace(/[.!]$/, '').trim();
    let may = false;
    let m;
    if ((m = s.match(/^you may (.+)$/i))) { may = true; s = m[1]; }
    s = lc(s);
    s = s.replace(/ (this turn|until the start of your next turn) (for each .+)$/i, ' $2 $1');
    let dur;
    [s, dur] = Duration.take(s);
    // "for each X, <clause>" → the clause's amount/mod is multiplied
    const fe = s.match(/^for each (.+?), (.+)$/i);
    if (fe) {
      const st = this.clause(fe[2], ctx);
      const per = Amount.forEach(fe[1], raw);
      if (st.fn === 'mod') return { ...st, per, ...(may ? { may: true } : {}) };
      if (typeof st.n === 'number') return { ...st, n: { n: st.n, per }, ...(may ? { may: true } : {}) };
      miss(`for each: "${s}"`, raw);
    }
    const P = this.P(raw, ctx, dur);
    for (const E of EFFECTS) for (const [rx, f] of E.rules) {
      const mm = s.match(rx);
      if (!mm) continue;
      const st = f(mm, P);
      if (st) return may ? { ...st, may: true } : st;
    }
    // "each player draws 2 cards and gains 2 lore" · "chosen opponent reveals their hand" · "the challenging player
    // chooses and discards a card" · "have each opponent choose and discard a card" → the clause in the 2nd
    // person, run as that player (phrases/player.js)
    let ep;
    if ((ep = s.match(PLAYER_RX))) {
      const steps = this.effects(`${ep[2] ? 'you may ' : ''}${/^have /i.test(s) ? ep[3] : secondPerson(ep[3])}`, ctx);
      return { fn: 'eachPlayer', who: playerOf(ep[1]), do: steps, ...(may ? { may: true } : {}) };
    }
    // "<effect> unless <condition>"
    if ((ep = s.match(/^(.+?) unless (.+)$/i))) {
      const st = this.clause(ep[1], ctx);
      return { ...st, cond: { not: this.condition(ep[2], raw) }, ...(may ? { may: true } : {}) };
    }
    miss(`effect: "${s}"`, raw);
  }

  // "draw a card and gain 1 lore" · "this character gains Bodyguard and can't quest" → one step per half
  compound(part, ctx) {
    try { return [this.clause(part, ctx)]; } catch (e) {
      if (!(e instanceof Miss)) throw e;
      const eq = this.equalTo(part, ctx);
      if (eq) return eq;
      const s0 = part.replace(/[.!]$/, '');
      const [core] = Duration.take(s0);
      const durTxt = core !== s0 && s0.startsWith(core) ? s0.slice(core.length) : '';
      const s = durTxt ? core : s0;
      const attempt = (s, durTxt) => {
        for (const m of s.matchAll(/,? and /gi)) {
          const a = s.slice(0, m.index); const b = s.slice(m.index + m[0].length);
          if (!a || !b) continue;
          let A;
          try { A = this.clause(a + durTxt, ctx); } catch (e2) { if (e2 instanceof Miss) continue; throw e2; }
          const subj = a.replace(/^you may /i, '').match(/^(.+?) (?:gets?|gains?|can't|cannot|can|loses?|takes?|enters?|is|are)\b/i)?.[1];
          const tries = [b + durTxt, ...(subj ? [`${subj} ${b}${durTxt}`] : [])];
          for (const t of tries) {
            try {
              const B = this.clause(t, ctx);
              if (A.may) B.ifDid = true;
              // "chosen character gains Rush and gets +1 {strength}" — one choice, two changes
              if (B.sel?.chosen && A.sel?.chosen && JSON.stringify(B.sel) === JSON.stringify(A.sel)) { B.sel = { ref: true }; B.linked = true; }
              return [A, B];
            } catch (e3) { if (!(e3 instanceof Miss)) throw e3; }
          }
        }
        return null;
      };
      const r = attempt(s, durTxt) || (durTxt ? attempt(s0, '') : null);
      if (r) return r;
      // "<verb> X or <verb> Y" — the player picks one
      for (const m of s0.matchAll(/ or (?=[a-z]+ )/g)) {
        const a = s0.slice(0, m.index); const b = s0.slice(m.index + 4);
        try {
          const A = this.compound(a, ctx); const B = this.compound(b, ctx);
          return [{ fn: 'chooseOne', labels: [a, b].map((x) => x.replace(/^\w/, (c) => c.toUpperCase())), options: [A, B] }];
        } catch (e2) { if (!(e2 instanceof Miss)) throw e2; }
      }
      throw e;
    }
  }

  // "gain lore equal to the {lore} of chosen opposing character" → [choose, gain {stat of it}]
  //  "draw cards equal to that location's {lore}" · "deal damage equal to her {strength} to chosen character"
  equalTo(part, ctx) {
    let s = part.replace(/[.!]$/, '').trim();
    // "deal damage to chosen character equal to X" → "deal damage equal to X to chosen character"
    const dm = s.match(/^(.*?\bdeal) damage (to .+?) equal to (.+)$/i);
    if (dm) s = `${dm[1]} damage equal to ${dm[3]} ${dm[2]}`;
    const m = s.match(/^(.*?)\b(lore|cards|damage) equal to (.+?)(?:, to a maximum of (\d+)(?: lore| cards?)?(?: each)?)?( to .+)?$/i);
    if (!m) return null;
    const STAT = { '{lore}': 'lore', '{strength}': 'str', '{willpower}': 'wp', cost: 'cost', damage: 'damage' };
    let r = m[3].trim(); let stat; let sel;
    let k;
    const noun0 = m[2].toLowerCase() === 'cards' ? '1 card' : `1 ${m[2].toLowerCase()}`;
    if ((k = r.match(/^the number of (.+)$/i))) {
      // "gain lore equal to the number of Titan characters you have in play" → 1 per match
      let st;
      try { st = this.clause(`${m[1]}${noun0}${m[5] || ''}`, ctx); } catch (e) { if (e instanceof Miss) return null; throw e; }
      if (st.n !== 1) return null;
      let per;
      try { per = Amount.forEach(k[1].replace(/s( you have in play| in play| here)?$/i, '$1').replace(/^(\S+?)ies\b/, '$1y'), part); } catch (e) { if (e instanceof Miss) return null; throw e; }
      return [{ ...st, n: { n: 1, per, ...(m[4] ? { max: +m[4] } : {}) } }];
    }
    if ((k = r.match(/^(her|his|its|their) (\{lore\}|\{strength\}|\{willpower\}|cost)$/i))) { stat = STAT[k[2].toLowerCase()]; sel = k[1].toLowerCase() === 'their' ? 'them' : 'her'; }
    else if ((k = r.match(/^the (\{lore\}|\{strength\}|\{willpower\}|cost) of (.+)$/i))) { stat = STAT[k[1].toLowerCase()]; sel = k[2]; }
    else if ((k = r.match(/^the (?:damage|number of damage counters) on (.+)$/i))) { stat = 'damage'; sel = k[1]; }
    else if ((k = r.match(/^(.+?)'s? (\{lore\}|\{strength\}|\{willpower\}|cost)$/i))) { stat = STAT[k[2].toLowerCase()]; sel = k[1]; }
    else return null;
    sel = sel.trim();
    const noun = m[2].toLowerCase() === 'cards' ? '1 card' : `1 ${m[2].toLowerCase()}`;
    let st;
    try { st = this.clause(`${m[1]}${noun}${m[5] || ''}`, ctx); } catch (e) { if (e instanceof Miss) return null; throw e; }
    if (st.n !== 1) return null;
    const max = m[4] ? { max: +m[4] } : {};
    if (/^(her|his|this character|this card|this location)$/i.test(sel)) return [{ ...st, n: { stat, of: 'self', ...max } }];
    if (/^(that|the) location$/i.test(sel)) return [{ ...st, n: { stat, of: 'loc', ...max } }];
    let S;
    try { S = this.P(part, ctx).sel(sel); } catch (e) { if (e instanceof Miss) return null; throw e; }
    if (S.self) return [{ ...st, n: { stat, of: 'self', ...max } }];
    if (S.ref) return [{ ...st, n: { stat, of: 'ref', ...max } }];
    if (S.chosen || S.yours) {
      const { may, ...rest } = st;                              // "you may draw cards equal to … of chosen X" → may choose
      return [{ fn: 'choose', sel: S, ...(may ? { may: true } : {}) }, { ...rest, n: { stat, of: 'ref', ...max }, linked: true }];
    }
    return null;
  }

  // "Chosen character gets +2 {strength}. If a Pirate character is chosen, they get +3 {strength} instead."
  // → the previous step gets  instead: { cond, step }  (swapped in when the step starts). A condition about the
  //   chosen card splits the step into choose + "that character" so the choice is made before the check.
  instead(steps, condText, altText, ctx, at) {
    const cond = parseCondition(condText, at);
    let alt;
    for (const t of [altText, `${altText} to that character`, `${altText} from that character`]) {
      try { alt = this.clause(t, ctx); break; } catch (e) { if (!(e instanceof Miss)) throw e; }
    }
    if (!alt) miss(`instead: "${altText}"`, at);
    let target = steps[steps.length - 1];
    if (JSON.stringify(cond).includes('"refIs"') && target.sel?.chosen) {
      const { may, cond: c0, ifDid, linked, otherwise, ...rest } = target;
      const gate = { ...(c0 ? { cond: c0 } : {}), ...(ifDid ? { ifDid } : {}), ...(linked ? { linked } : {}), ...(otherwise ? { otherwise } : {}) };
      target = { ...rest, sel: { ref: true }, linked: true };
      steps.splice(-1, 1, { fn: 'choose', sel: rest.sel, ...(may ? { may: true } : {}), ...gate }, target);
    }
    const step = { ...alt };
    if (!step.sel || step.sel.ref) delete step.sel;                  // same target as the original
    delete step.may;
    target.instead = { cond, step };
  }

  // sentences that modify the step before them
  tail(sentence, last) {
    const t = sentence.replace(/[.!]$/, '').trim();
    if (/^this damage can't be reduced by resist$/i.test(t) && last.fn === 'damage') { last.noResist = true; return true; }
    return false;
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
      // delayed trigger: "Whenever one of your characters quests this turn, …" · "For the rest of this turn, whenever …"
      if ((m = s.match(/^(?:for the rest of this turn, |this turn, )(whenever .+)$/i)) || (m = s.match(/^(whenever [^,]+?) this turn(, .+)$/i))) {
        const t = m[2] ? `${m[1]}${m[2]}` : m[1];
        const proc = Triggered.parse(t, this, {});
        if (proc) { steps.push({ fn: 'delayed', text: t, proc: { ...proc, ...this.check(proc) } }); continue; }
      }
      if ((m = s.match(/^if you do,? (.+)$/i))) { ifDid = true; s = m[1]; }
      if ((m = s.match(/^if (.+?), (.+?) instead$/i)) && steps.length) { this.instead(steps, m[1], m[2], ctx, at); continue; }
      if ((m = s.match(/^if (.+?), (.+)$/i)) && !/^if you do/i.test(s)) { cond = parseCondition(m[1], at); s = m[2]; }
      if ((m = s.match(/^otherwise,? (.+)$/i))) {
        const st = this.effects(m[1], ctx);
        // "otherwise, put it on …" only has an antecedent after a reveal / look
        if (st[0].sel?.ref && st[0].fn !== 'mod' && !steps.some((x) => x.fn === 'reveal' || x.fn === 'look')) miss(`otherwise: "${m[1]}" has nothing to refer to`, s);
        st[0].otherwise = true; steps.push(...st); continue;
      }
      s.split(/,? then,? /i).forEach((part, i) => {
        const pm = part.match(COST_THEN);
        let costStep = null;
        if (pm) { try { costStep = this.clause((pm[1] || '') + pm[2], ctx); } catch (e) { if (!(e instanceof Miss)) throw e; } }
        if (costStep) {
          // "you may pay 2 {ink} to draw a card" — the cost, then the rest only if it was paid
          steps.push(costStep);
          const st = this.effects(pm[3], ctx);
          st.forEach((x) => { x.ifDid = true; });
          steps.push(...st);
          return;
        }
        if (steps.length && this.tail(part, steps[steps.length - 1])) return;
        const sts = this.compound(part, ctx);
        if (i > 0) sts[0].linked = true;
        if (i === 0 && ifDid) sts.forEach((x) => { x.ifDid = true; });
        if (i === 0 && cond) sts.forEach((x) => { x.cond = cond; });
        steps.push(...sts);
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
    // leftovers of a name split across the text ("! When you play…", ", DUMBO! While…", "... Once during…", "I TRUST YOU Whenever…")
    if (name) text = text.replace(/^(?:[!?.,…]+\s*|,?\s*[A-Z][A-Z'\- ]*[!?]\s+|\.\.\.\s*)+(?=[A-Z{])/, '').replace(/^(?:[A-Z][A-Z']+ ){1,5}(?=(?:When|Whenever|While|During|Once|At|Your|This|If|You)\b)/, '');
    const base = { name, text };
    try {
      let also = null;
      let body = text;
      for (const m of text.matchAll(/[.!] (?=[A-Z])/g)) {
        const kw = KeywordLine.parse(text.slice(m.index + 2));
        if (kw) { also = kw.kws; body = text.slice(0, m.index + 1); break; }
      }
      const proc = this.text(quote(body), cardType, !!name);
      if (also) proc.also = also;
      return { ...base, ...proc, ...this.check(proc) };
    } catch (e) {
      if (!(e instanceof Miss)) throw e;
      return { ...base, kind: 'unparsed', why: e.message, at: e.at, exec: false };
    }
  }
}

// A quoted ability ("…gain \"{exert} — Draw a card\" this turn") is one token to every other rule: no sentence,
// comma or "and" splits inside it. A grant rule decodes it with unquote() and compiles it as a nested proc.
const quote = (t) => t.replace(/"([^"]+)"/g, (_, q) => `"q${Buffer.from(q).toString('hex')}"`);
export const unquote = (tok) => Buffer.from(tok.replace(/^"q|"$/g, ''), 'hex').toString();

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
