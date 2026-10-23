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
import { parseReplace } from '../rulebook/replace.js';
import { PLAY_FROM_TAIL } from './effects/playFrom.js';
import { KINDS, KeywordLine, KEYWORD_START, Action, Activated, Triggered, Static } from './kinds/index.js';
import { SUPPORT } from './support.js';
import { PLAYER_RX, playerOf, playerIf } from './phrases/player.js';

export { Miss };
const SONG_REMINDER = /^\(?(?:a|an) character with cost \d+ or more can \{exert\} to sing this song for free\.?\)?$/i;
const SING_TOGETHER = /^sing together \d+\s*/i;
// "<cost> to <effect>": the left side must read as a cost — one of these verbs — and compile; the right side is the effect
const COST_VERB = /^(?:you may )?(?:pay|exert|\{exert\}|banish|discard|choose and discard|put|return|reveal|shuffle|deal|remove|move|give|choose)\b/i;

// "draws 2 cards and gains 2 lore" → "draw 2 cards and gain 2 lore"; their → your
const VERB3 = /\b(draws|loses|gains|puts|discards|chooses|exerts|shuffles|reveals|pays|returns|deals|banishes|readies|plays|removes|moves|looks|gets|takes|mills)\b/gi;
export function secondPerson(t) {
  return t.replace(VERB3, (v) => (/ies$/i.test(v) ? v.slice(0, -3) + 'y' : /(sh|ch|ss|x)es$/i.test(v) ? v.slice(0, -2) : v.slice(0, -1)))
    .replace(/\btheir\b/gi, 'your').replace(/\btheirs\b/gi, 'yours').replace(/\bthey have\b/gi, 'you have').replace(/\bthey\b/gi, 'you');
}

const INNER = new WeakMap();                                         // an eachPlayer step → its inner text (2nd person), for follow-up sentences
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
      effects: (x) => this.effects(x, ctx),
      // a change with no duration: on a card just acted on it lasts while that card is in play ("They gain Rush.")
      D: (o) => (dur ? { ...o, dur } : o.dur || ctx.static ? o : o.sel?.ref && !o.sel.pron ? { ...o, dur: 'perm' } : miss('needs a duration (this turn / until …)', at)),
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
    s = s.replace(/^you (?=(?:draw|look|reveal|return|banish|exert|ready|choose|put)\b)/i, '');   // "you draw a card" = "draw a card"
    s = s.replace(/ (this turn|until the start of your next turn) (for each .+)$/i, ' $2 $1');
    s = s.replace(/ damage each (to|from) /i, ' damage $1 ');
    s = s.replace(/( on the (?:top|bottom) of (?:your|their|their players'|its owner's|their player's) decks?) in any order$/i, '$1');   // CR 7.2.3: the player picks the order                // "deal 1 damage each to up to 2 chosen characters"
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
    // a "you" in the original text is still the controller ("each opponent loses 1 lore and you gain 1 lore") — the
    // compound splitter handles those, not the other player
    if ((ep = s.match(PLAYER_RX)) && !/\b(?:you|your|yours)\b/i.test(ep[4])) {
      const inner = `${ep[3] ? 'you may ' : ''}${/^have /i.test(s) ? ep[4] : secondPerson(ep[4])}`;
      const steps = this.effects(inner, ctx);
      const whoIf = playerIf(ep[2]);
      const st = { fn: 'eachPlayer', who: playerOf(ep[1]), ...(whoIf ? { whoIf } : {}), do: steps, ...(may ? { may: true } : {}) };
      INNER.set(st, inner);
      return st;
    }
    // "<effect> unless their player pays 1 {ink}" — the other player decides (effects/oppChoose.js UnlessOther)
    if ((ep = s.match(/^(.+?) unless (their player|that character's player|its player|the challenging player) (pays (\d+) \{ink\}|puts that card on the bottom of their deck)$/i))) {
      const st = this.clause(ep[1], ctx);
      const who = /challenging/i.test(ep[2]) || st.sel?.role === 'challenger' ? 'challenger' : 'refOwner';
      return { fn: 'unlessOther', who, pay: ep[4] ? { ink: +ep[4] } : { toDeckBottom: 'ref' }, text: ep[1], do: [st], ...(may ? { may: true } : {}) };
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
      // "for each character that sang this song, draw a card and gain 1 lore" — each amount is multiplied
      const fe = s0.match(/^for each (.+?), (.+)$/i);
      if (fe && / and /i.test(fe[2])) {
        const per = Amount.forEach(fe[1], part);
        const steps = this.compound(fe[2], ctx);
        if (steps.every((x) => typeof x.n === 'number')) return steps.map((x) => ({ ...x, n: { n: x.n, per } }));
      }
      const r = attempt(s, durTxt) || (durTxt ? attempt(s0, '') : null);
      if (r) return r;
      // "deal 1 damage to chosen opposing character, gain 1 lore, and draw a card" — a list of 3+ clauses
      const list = s0.match(/^(.+?), (.+), and (.+)$/i);
      if (list) {
        const parts = [list[1], ...list[2].split(/, /), list[3]];
        try { return parts.map((x) => this.clause(x, ctx)); } catch (e2) { if (!(e2 instanceof Miss)) throw e2; }
      }
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
    const target0 = steps[steps.length - 1];
    const durWords = target0?.dur ? ` ${Duration.say(target0.dur)}` : '';     // "they get +3 {strength} instead" — same duration
    for (const t of [altText, `${altText} to that character`, `${altText} from that character`, ...(durWords ? [`${altText}${durWords}`] : [])]) {
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

  // "<cost> to <effect>" — try every " to ": the first split whose left side reads as a cost and whose right side
  // compiles. "Deal 2 damage to chosen character of yours to draw 2 cards" splits at its second " to ";
  // "pay 1 {ink} and banish this item to deal 2 damage" pays both halves. → { cost: [steps], effect: [steps] } | null
  payTo(part, ctx) {
    const t = part.replace(/[.!]$/, '').trim();
    if (!COST_VERB.test(t)) return null;
    const may = /^you may /i.test(t);
    for (const m of t.matchAll(/ to (?=[a-z{])/gi)) {
      const left = t.slice(0, m.index).replace(/^you may /i, '').replace(/^\{exert\} /i, 'exert ');
      const right = t.slice(m.index + 4);
      if (!left || /\b(?:up|equal|or less|or more)$/i.test(left)) continue;        // "up to 2", "equal to"
      let cost, effect;
      try { cost = this.compound(left, ctx); effect = this.effects(right, ctx); } catch (e) { if (e instanceof Miss) continue; throw e; }
      if (may) cost[0].may = true;
      cost.slice(1).forEach((x) => { x.ifDid = true; });
      return { cost, effect };
    }
    return null;
  }

  // sentences that modify the step before them
  tail(sentence, last) {
    const t = sentence.replace(/[.!]$/, '').trim();
    if (/^this damage can't be reduced by resist$/i.test(t) && last.fn === 'damage') { last.noResist = true; return true; }
    // "…from your discard for free, then put it on the bottom of your deck instead of into your discard" — where the played action goes
    if (/^(?:if you do, )?put (?:it|that card|that action card|that song) on the bottom of your deck instead of into your discard$/i.test(t) && (last.fn === 'playFree' || last.fn === 'playIt')) { last.after = 'deckBottom'; return true; }
    return false;
  }

  // effect text → steps
  effects(text, ctx = {}) {
    const steps = [];
    const at = text;
    // "Choose any number of players. They discard their hands and draw 3 cards each."
    const anyp = text.match(/^choose any number of players\. they (.+?)(?: each)?\.?$/i);
    if (anyp) return [{ fn: 'eachPlayer', who: 'anyPlayers', do: this.effects(secondPerson(anyp[1]).replace(/\byour hands\b/gi, 'your hand'), ctx) }];
    // "Chosen opponent chooses one: • …" · "Chosen opponent chooses YES! or NO!: • YES! … • NO! …" — they pick; in an
    // option "they …" is that player, "you" is still the controller
    const oc = text.match(/^(?:chosen|each) opponent chooses (?:one|YES! or NO!): • (.+)$/i);
    if (oc) {
      const opts = oc[1].split(/ • /).map((o) => o.trim());
      const optSteps = (o) => sentences(o.replace(/^(?:YES|NO)! /i, '')).flatMap((sent) => {
        const they = sent.match(/^they (.+)$/i);
        if (!they) return this.effects(sent, ctx);
        const third = they[1].replace(/^(\w+)|(?<= and )(\w+)/g, (v) => (/(?:s|sh|ch|x)$/i.test(v) ? `${v}es` : `${v}s`));   // "reveal … and discard" → "reveals … and discards"
        const sts = this.effects(`chosen opponent ${third}`, ctx);
        return sts.map((x) => (x.fn === 'eachPlayer' && x.who === 'chosenOpp' ? { ...x, who: 'chooser' } : x));
      });
      return [{ fn: 'chooseOne', by: 'opp', labels: opts.map((o) => o.replace(/\.$/, '')), options: opts.map(optSteps) }];
    }
    // "Choose one: • …" · "you may choose one: • …" (neither is fine) · "choose one of the following. If X, choose both instead: • …"
    const CHOOSE = /(?:you may )?choose one(?: of the following)?(?:\. if (.+?), choose both instead)?: • /i;
    const chooseAt = text.search(CHOOSE);
    if (chooseAt >= 0) {
      const head = text.slice(chooseAt).match(CHOOSE);
      const before = text.slice(0, chooseAt).trim();
      const opts = text.slice(chooseAt + head[0].length).split(/ • /);
      if (before) steps.push(...this.effects(before, ctx));
      const may = /^you may/i.test(head[0]);
      steps.push({
        fn: 'chooseOne', labels: [...opts.map((o) => o.trim().replace(/\.$/, '')), ...(may ? ['Neither'] : [])], options: [...opts.map((o) => this.effects(o.trim(), ctx)), ...(may ? [[]] : [])],
        ...(head[1] ? { bothIf: parseCondition(head[1], at) } : {}),
      });
      return steps;
    }
    for (const sent of sentences(text)) {
      const last = steps[steps.length - 1];
      if (last?.fn === 'look' && Look.tail(sent, last, at)) continue;
      // "Reveal the top 2 cards of your deck. Put revealed character cards into your hand." — a reveal with a distribution
      if (last?.fn === 'reveal' && !last.sel && Look.distribute(sent.replace(/[.!]$/, ''), last, at)) { last.fn = 'look'; last.reveal = true; continue; }
      // "Each opponent reveals the top card of their deck. If it's a character card, they may put it into their hand.
      // Otherwise, they put it on the bottom of their deck." — the follow-ups are that player's too
      if (last?.fn === 'eachPlayer' && INNER.has(last) && last.do.some((x) => x.fn === 'reveal' || x.fn === 'look') && /^(?:if (?:it's|that card is) .+?, they |otherwise, (?:they )?put it .*\btheir\b|they )/i.test(sent)) {
        const inner = `${INNER.get(last)}. ${secondPerson(sent.replace(/[.!]$/, ''))}`;
        try { last.do = this.effects(inner, ctx); INNER.set(last, inner); continue; } catch (e) { if (!(e instanceof Miss)) throw e; }
      }
      let s = sent.replace(/[.!]$/, '').trim();
      if (last?.fn === 'grantPlayFrom' && PLAY_FROM_TAIL.test(s)) { last.exerted = true; if (PLAY_FROM_TAIL.exec(s)[1]) last.sameNameBan = true; continue; }
      let ifDid = false;
      let cond = null;
      let m;
      if ((m = s.match(/^then,? (.+)$/i))) s = m[1];
      // delayed trigger: "Whenever one of your characters quests this turn, …" · "For the rest of this turn, whenever …"
      // "At the end of the turn, banish them." — once, at the end of this turn, about what the ability acted on
      if ((m = s.match(/^at the end of (?:your|the|this) turn, (.+)$/i)) && steps.length) {
        const proc = Triggered.parse(`At the end of your turn, ${m[1]}`, this, {});
        if (proc) { steps.push({ fn: 'delayed', text: s, proc: { ...proc, ...this.check(proc) } }); continue; }
      }
      if ((m = s.match(/^(?:for the rest of this turn, |this turn, )(whenever .+)$/i)) || (m = s.match(/^(whenever [^,]+?) this turn(, .+)$/i))) {
        const t = m[2] ? `${m[1]}${m[2]}` : m[1];
        const proc = Triggered.parse(t, this, {});
        if (proc) { steps.push({ fn: 'delayed', text: t, proc: { ...proc, ...this.check(proc) } }); continue; }
      }
      if ((m = s.match(/^if you do and (.+?), (.+)$/i))) { ifDid = true; cond = parseCondition(m[1], at); s = m[2]; }
      else if ((m = s.match(/^if you do,? (.+)$/i))) { ifDid = true; s = m[1]; }
      if ((m = s.match(/^if (.+?), (.+?) instead$/i)) && steps.length) { this.instead(steps, m[1], m[2], ctx, at); continue; }
      if ((m = s.match(/^if (.+?), (.+)$/i)) && !/^if you do/i.test(s)) { cond = parseCondition(m[1], at); s = m[2]; }
      if ((m = s.match(/^otherwise,? (.+)$/i))) {
        const st = this.effects(m[1], ctx);
        // "otherwise, put it on …" only has an antecedent after a reveal / look
        if (st[0].sel?.ref && st[0].fn !== 'mod' && !steps.some((x) => x.fn === 'reveal' || x.fn === 'look')) miss(`otherwise: "${m[1]}" has nothing to refer to`, s);
        st[0].otherwise = true; steps.push(...st); continue;
      }
      s.split(/,? then,? /i).forEach((part, i) => {
        const prev = steps[steps.length - 1];
        if (i > 0 && prev?.fn === 'look' && Look.tail(part, prev, at)) return;      // "look at the top 2 …, then put one into your hand …"
        // "look at the top card of your deck and put it on either the top or the bottom of your deck"
        const lk = part.match(/^(look at the top .+? of (?:your|chosen player's) deck) and (put .+)$/i);
        if (lk) { const st = this.clause(lk[1], ctx); if (st.fn === 'look' && Look.tail(lk[2], st, at)) { steps.push(st); return; } }
        const paid = this.payTo(part, ctx);
        if (paid) {
          // "you may pay 2 {ink} to draw a card" — the cost, then the rest only if it was paid
          paid.effect.forEach((x) => { x.ifDid = true; });
          steps.push(...paid.cost, ...paid.effect);
          return;
        }
        if (steps.length && this.tail(part, steps[steps.length - 1])) return;
        const sts = this.compound(part, ctx);
        if (i > 0) sts[0].linked = true;
        if (i === 0 && ifDid) sts.forEach((x) => { x.ifDid = true; });
        if (i === 0 && cond) sts.forEach((x) => { x.cond = cond; });
        // "If a character sang this song, you may move them …" — them = the singers
        if (cond?.sang) sts.forEach((x) => { if (x.sel?.ref && !x.sel.pron) x.sel = { singers: true }; });
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
    if (spell) {
      // "Deal 2 damage to chosen character. During your turn, when you discard this card, you may play it from your
      // discard." — a triggered ability on the action card itself, apart from what it does when played
      const tr = t.match(/^(.+?[.!]) ((?:during your turn, )?when(?:ever)? you discard this card, .+)$/i);
      if (tr) return { ...Action.parse(tr[1], this), alsoProc: this.text(tr[2], 'character', named) };
      return Action.parse(t, this);
    }

    // modifiers that wrap the rest
    let once = false; let during = null; let m;
    for (let guard = 0; guard < 3; guard++) {
      if ((m = t.match(/^once (?:during your|per) turn,? (.+)$/i))) { once = true; t = m[1]; continue; }
      if ((m = t.match(/^during your turn,? (.+)$/i))) { during = 'yours'; t = m[1]; continue; }
      if ((m = t.match(/^during (?:an opponent's turn|opponents' turns|each opponent's turn),? (.+)$/i))) { during = 'opp'; t = m[1]; continue; }
      break;
    }
    const mods = { ...(once ? { once } : {}), ...(during ? { during } : {}) };
    // "While this character is exerted, whenever you draw a card, gain 1 lore." — a trigger that only listens while …
    if ((m = t.match(/^while (.+?), (whenever .+)$/i))) {
      const cond = this.condition(m[1], t);
      const tp = Triggered.parse(m[2], this, mods);
      if (tp) return { ...tp, on: tp.on.map((o) => ({ ...o, whileCond: o.whileCond ? { all: [o.whileCond, cond] } : cond })) };
    }
    const rep = parseReplace(t);                                    // "if … would …, … instead" (CR 6.5)
    if (rep) return { kind: 'static', ...mods, effect: rep };
    const proc = Activated.parse(t, this, mods) || Triggered.parse(t, this, mods);
    if (proc) return proc;
    // "Once during your turn, you may move him to another location for free. If you do, gain 1 lore." — something you
    // choose to do on your turn, once: a free activated ability
    if (once && /^you may /i.test(t)) return { kind: 'activated', cost: {}, once: true, during: 'yours', do: this.effects(t) };
    // "Once during your turn, if this character is at a location, you may move him …" — usable only while …
    if (once && (m = t.match(/^if (.+?), (you may .+)$/i))) return { kind: 'activated', cost: {}, once: true, during: 'yours', cond: this.condition(m[1], t), do: this.effects(m[2]) };
    return Static.parse(t, this, mods);
  }

  // can the engine run it?  → { exec } | { exec:false, why }
  check(proc) {
    const missing = new Set();
    KINDS[proc.kind]?.check(proc, missing, SUPPORT);
    if (proc.alsoProc) KINDS[proc.alsoProc.kind]?.check(proc.alsoProc, missing, SUPPORT);
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
