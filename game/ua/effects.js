// Union Arena effect interpreter: runs the ops game/ua/compile.js produces, one job (an ability resolving) at a time.
//
// A job holds a stack of frames ({ ops, i }); nested ops (if / may / modal / forEach) push frames. An op that needs a
// player's choice sets s.pending (type 'choose' or 'yesno', with job: <id>) and returns 'wait'; the engine's choose /
// yesno action writes the answer into job.ctx and the same op runs again and takes it.
//
// Targets: ctx.it is the last chosen (or affected) set of cards, which later "it" / "them" sentences act on.
// Filters (matches()): { kind: 'character'|'site'|'event'|'card', who: 'self'|'opp'|'any', zones: [...],
//   bpMax, bpMin, energyMax, energyMin, apMax, affinity: [..], name: [..], color: [..], other: true, rested, active,
//   raided, hasTrigger, notName }

import { P, C, D, other, onField, cardName, bpOf, log, moveCard, sideline, drawCards, dealDamage, LINE_MAX, energyOf, apActive, nameOf, shuffle, fire } from './engine.js';

const nk = (x) => String(x || '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

// names a card counts as (its own + "This card is also treated as <N>")
export function namesOf(s, c) {
  const d = D(s, c);
  return [d.name, ...(s.compiled[c.no]?.aliases || [])].map(nk);
}

let staticDepth = 0;
export function matches(s, c, f, seat) {
  if (!c) return false;
  if (!f) return true;
  const d = D(s, c);
  if (f.iid && c.iid !== f.iid) return false;
  if (f.kind && f.kind !== 'card' && d.type !== f.kind) return false;
  if (f.kinds && !f.kinds.includes(d.type)) return false;
  if (f.who === 'self' && c.owner !== seat) return false;
  if (f.who === 'opp' && c.owner === seat) return false;
  if (f.zones && !f.zones.includes(c.zone)) return false;
  if (f.other && c.iid === f.other) return false;
  if (f.name && !f.name.some((n) => namesOf(s, c).includes(nk(n)))) return false;
  if (f.notName && f.notName.some((n) => namesOf(s, c).includes(nk(n)))) return false;
  if (f.affinity && !f.affinity.some((a) => (d.affinities || []).map(nk).includes(nk(a)))) return false;
  if (f.nameOrAffinity) {
    const ok = f.nameOrAffinity.some((x) => (x.name ? namesOf(s, c).includes(nk(x.name)) : (d.affinities || []).map(nk).includes(nk(x.affinity))));
    if (!ok) return false;
  }
  if (f.color && !f.color.includes(d.color)) return false;
  if (f.energyMax != null && (d.energy ?? 0) > f.energyMax) return false;
  if (f.energyMin != null && (d.energy ?? 0) < f.energyMin) return false;
  if (f.apMax != null && (d.ap ?? 0) > f.apMax) return false;
  if (f.rested === true && !c.rest) return false;
  if (f.active === true && c.rest) return false;
  if (f.raided && !(onField(c) && c.under.length)) return false;
  if (f.hasTrigger && !d.trigger) return false;
  if (f.noAffinity && (d.affinities || []).length) return false;
  if (f.triggerType && d.trigger?.type !== f.triggerType) return false;
  if (f.bpMax != null || f.bpMin != null) {
    const bp = onField(c) && staticDepth < 2 ? bpOf(s, c) : d.bp;
    if (bp == null) return false;
    if (f.bpMax != null && bp > f.bpMax) return false;
    if (f.bpMin != null && bp < f.bpMin) return false;
  }
  return true;
}

// every card a filter can see, from `seat`'s point of view
export function findCards(s, f, seat) {
  const zones = f.zones || ['front', 'energy'];
  const seats = f.who === 'self' ? [seat] : f.who === 'opp' ? [other(seat)] : [seat, other(seat)];
  const out = [];
  for (const st of seats) for (const z of zones) for (const iid of P(s, st)[z] || []) if (matches(s, C(s, iid), f, seat)) out.push(iid);
  return out;
}

// ---------- conditions ----------
export function evalCond(s, cond, ctx) {
  if (!cond) return true;
  const seat = ctx.seat;
  const src = ctx.src ? C(s, ctx.src) : null;
  switch (cond.k) {
    case 'and': return cond.all.every((x) => evalCond(s, x, ctx));
    case 'or': return cond.any.some((x) => evalCond(s, x, ctx));
    case 'not': return !evalCond(s, cond.c, ctx);
    case 'front': return src?.zone === 'front';
    case 'energy': return src?.zone === 'energy';
    case 'yourTurn': return s.active === seat;
    case 'oppTurn': return s.active !== seat;
    case 'selfActive': return !!src && !src.rest;
    case 'selfRested': return !!src && src.rest;
    case 'raided': return !!src && src.under.length > 0;
    case 'count': {
      const f = { ...cond.f };
      if (f.other) f.other = ctx.src;
      const n = findCards(s, f, seat).length;
      return cmp(n, cond.op, cond.n);
    }
    case 'uniqueNames': {
      const names = new Set(findCards(s, cond.f, seat).map((iid) => D(s, C(s, iid)).name));
      return cmp(names.size, cond.op, cond.n);
    }
    case 'life': return cmp(P(s, cond.who === 'opp' ? other(seat) : seat).life.length, cond.op, cond.n);
    case 'hand': return cmp(P(s, cond.who === 'opp' ? other(seat) : seat).hand.length, cond.op, cond.n);
    case 'side': return cmp(P(s, cond.who === 'opp' ? other(seat) : seat).side.length, cond.op, cond.n);
    case 'removal': return cmp(P(s, cond.who === 'opp' ? other(seat) : seat).removal.length, cond.op, cond.n);
    case 'gen': return cmp(energyOf(s, seat).any, cond.op, cond.n);
    case 'apActive': return cmp(apActive(s, seat), cond.op, cond.n);
    case 'playedThisTurn': return !!src && src.enteredTurn === s.turnNo;
    case 'sidelinedThisTurn': return (s.sidelinedTurn?.[seat] || 0) === s.turnNo;
    case 'did': return !!ctx.job?.ctx?.did;
    case 'addedToHand': return !!ctx.job?.ctx?.added;
    case 'chosenMatches': return (ctx.job?.ctx?.it || []).some((iid) => matches(s, C(s, iid), cond.f, seat));
    case 'lookedMatches': return (ctx.job?.ctx?.look || []).some((iid) => matches(s, C(s, iid), cond.f, seat));
    case 'battling': return !!s.battle && (s.battle.att === ctx.src || s.battle.blocker === ctx.src || s.battle.target === ctx.src);
    case 'selfBp': return !!src && onField(src) && cmp(bpOf(s, src), cond.op, cond.n);
    case 'sidelinedCount': return cmp(s.sidelinedCount?.turn === s.turnNo ? s.sidelinedCount.n : 0, cond.op, cond.n);
    case 'usedEvent': return (s.usedEvent?.[seat] || 0) === s.turnNo;
    case 'playedByAbility': return !!ctx.info?.byAbility;
    case 'true': return true;
    default: return false;
  }
}
const cmp = (a, op, b) => (op === '>=' ? a >= b : op === '<=' ? a <= b : op === '>' ? a > b : op === '<' ? a < b : a === b);

// ---------- static abilities ----------
// Every static ability on the field whose condition holds, applied to card c → mod objects ({ bp, kw, gen, cantAttack, … }).
export function staticMods(s, c) {
  if (staticDepth > 2 || !onField(c)) return [];
  staticDepth++;
  try {
    const out = [];
    for (const seat of [0, 1]) {
      for (const iid of [...P(s, seat).front, ...P(s, seat).energy]) {
        const src = C(s, iid);
        const st = s.compiled[src.no]?.statics;
        if (!st?.length) continue;
        for (const a of st) {
          if (a.target === 'self' ? src.iid !== c.iid : !matches(s, c, { ...a.target, other: a.target.other ? src.iid : undefined }, src.owner)) continue;
          if (a.cond && !evalCond(s, a.cond, { src: src.iid, seat: src.owner })) continue;
          const m = { ...a.mod, static: true };
          if (a.perCard) {
            const n = a.perCard === 'under' ? src.under.length : findCards(s, a.perCard, src.owner).length;
            if (m.bp) m.bp *= n;
          }
          out.push(m);
        }
      }
    }
    return out;
  } finally { staticDepth--; }
}

// ---------- the interpreter ----------
const frameOf = (job) => {
  job.frames ||= [{ ops: job.ops || [], i: 0 }];
  return job.frames[job.frames.length - 1];
};

export function runOps(s, job, ev) {
  for (let guard = 0; guard < 500; guard++) {
    if (s.winner != null) return 'done';
    const fr = frameOf(job);
    if (fr.i >= fr.ops.length) {
      if (job.frames.length === 1) return 'done';
      job.frames.pop();
      continue;
    }
    const op = fr.ops[fr.i];
    const fn = OPS[op.op];
    if (!fn) { log(s, `(${cardName(s, C(s, job.src))}: "${op.op}" isn't automated; skipped)`, ev); fr.i++; continue; }
    const r = fn(s, job, op, ev);
    if (r === 'wait') return 'wait';
    if (r === 'push') continue;          // the op pushed a frame and advanced itself
    if (r === 'stop') { job.frames = [{ ops: [], i: 0 }]; return 'done'; }
    fr.i++;
  }
  throw new Error('UA effects: op loop did not settle');
}

const seatOf = (job, who) => (who === 'opp' ? other(job.seat) : job.seat);
const takeAnswer = (job) => { const a = job.ctx.answer; job.ctx.answered = false; job.ctx.answer = undefined; return a; };
function ask(s, job, pend) {
  s.pending = { ...pend, job: job.id, card: job.src };
  return 'wait';
}
// resolve a target spec to card ids: 'it' (last chosen), 'self', or a filter (all matching)
function targetsOf(s, job, t) {
  if (!t || t === 'it') return (job.ctx.it || []).filter((iid) => C(s, iid));
  if (t === 'self') return [job.src];
  if (t === 'attacker') return s.battle?.att ? [s.battle.att] : [];
  if (t === 'battling') {
    const b = s.battle;
    if (!b) return [];
    const opp = b.att === job.src ? (b.blocker || b.target) : b.att;
    return opp ? [opp] : [];
  }
  return findCards(s, withOther(t, job), job.seat);
}
const withOther = (f, job) => (f && f.other === true ? { ...f, other: job.src } : f);

function untilOf(op, job) {
  return { until: op.until || 'eot', who: job.seat };
}

const OPS = {
  draw(s, job, op, ev) { drawCards(s, seatOf(job, op.who), op.n, ev); },
  // place n cards from hand into sideline (the player picks)
  discard(s, job, op, ev) {
    const seat = seatOf(job, op.who);
    const hand = P(s, seat).hand;
    if (job.ctx.answered) {
      const picks = takeAnswer(job);
      for (const iid of picks) moveCard(s, iid, 'side', ev);
      if (picks.length) log(s, `${nameOf(s, seat)} places ${picks.map((i) => cardName(s, C(s, i))).join(', ')} from hand into the sideline.`, ev);
      job.ctx.did = picks.length > 0;
      return;
    }
    const opts = op.f ? hand.filter((iid) => matches(s, C(s, iid), op.f, seat)) : [...hand];
    const n = Math.min(op.n, opts.length);
    if (!n || (op.f && opts.length < op.n && !op.upTo)) { job.ctx.did = false; return; }
    const min = op.upTo || op.may ? 0 : n;
    return ask(s, job, { type: 'choose', seat, prompt: `Place ${op.upTo ? 'up to ' : ''}${op.n} card${op.n > 1 ? 's' : ''} from your hand into your sideline.`, options: opts, min, max: n, zone: 'hand' });
  },
  mill(s, job, op, ev) {
    const seat = seatOf(job, op.who);
    const p = P(s, seat);
    const n = Math.min(op.n, p.deck.length);
    const names = [];
    for (let i = 0; i < n; i++) { const iid = p.deck[0]; names.push(cardName(s, C(s, iid))); moveCard(s, iid, 'side', ev); }
    if (n) log(s, `${nameOf(s, seat)} places the top ${n} card${n > 1 ? 's' : ''} of their deck into the sideline: ${names.join(', ')}.`, ev);
  },
  // look at the top n: they stay on the deck, tracked in ctx.look
  look(s, job, op, ev) {
    const p = P(s, job.seat);
    job.ctx.look = p.deck.slice(0, op.n);
    if (op.public) log(s, `${nameOf(s, job.seat)} reveals the top of their deck: ${job.ctx.look.map((i) => cardName(s, C(s, i))).join(', ')}.`, ev, { reveal: job.ctx.look });
    else log(s, `${nameOf(s, job.seat)} looks at the top ${job.ctx.look.length} card${job.ctx.look.length === 1 ? '' : 's'} of their deck.`, ev);
  },
  // reveal up to max matching looked-at cards and add them to hand
  takeLook(s, job, op, ev) {
    const look = (job.ctx.look || []).filter((iid) => C(s, iid).zone === 'deck');
    if (job.ctx.answered) {
      const picks = takeAnswer(job);
      for (const iid of picks) moveCard(s, iid, op.to || 'hand', ev);
      job.ctx.look = look.filter((iid) => !picks.includes(iid));
      job.ctx.added = picks.length > 0;
      job.ctx.it = picks;
      if (picks.length) log(s, `${nameOf(s, job.seat)} reveals ${picks.map((i) => cardName(s, C(s, i))).join(', ')} and adds ${picks.length > 1 ? 'them' : 'it'} to their ${op.to === 'side' ? 'sideline' : 'hand'}.`, ev, { reveal: picks });
      return;
    }
    const ok = look.filter((iid) => matches(s, C(s, iid), op.f, job.seat));
    if (!ok.length) { job.ctx.added = false; return; }
    return ask(s, job, { type: 'choose', seat: job.seat, prompt: op.prompt || `Reveal up to ${op.max} card${op.max > 1 ? 's' : ''} and add ${op.max > 1 ? 'them' : 'it'} to your hand.`, options: ok, min: op.min || 0, max: Math.min(op.max, ok.length), looked: look, zone: 'deck' });
  },
  // the looked-at cards that are left: to the bottom (any order), top, or sideline
  restLook(s, job, op, ev) {
    const look = (job.ctx.look || []).filter((iid) => C(s, iid).zone === 'deck');
    if (!look.length) return;
    if (op.to === 'side') for (const iid of look) moveCard(s, iid, 'side', ev);
    else if (op.to === 'top') { for (const iid of [...look].reverse()) moveCard(s, iid, 'deckTop', ev); }
    else for (const iid of look) moveCard(s, iid, 'deckBottom', ev);
    log(s, `${nameOf(s, job.seat)} places ${look.length} card${look.length > 1 ? 's' : ''} on the ${op.to === 'top' ? 'top' : op.to === 'side' ? 'sideline' : 'bottom of their deck'}.`, ev);
    job.ctx.look = [];
  },
  // look at the top n, put any number back on top and the rest on the bottom (or sideline)
  arrange(s, job, op, ev) {
    const p = P(s, job.seat);
    if (job.ctx.answered) {
      const keep = takeAnswer(job);
      const look = job.ctx.look.filter((iid) => C(s, iid).zone === 'deck');
      const rest = look.filter((iid) => !keep.includes(iid));
      for (const iid of rest) moveCard(s, iid, op.rest === 'side' ? 'side' : 'deckBottom', ev);
      for (const iid of [...keep].reverse()) moveCard(s, iid, 'deckTop', ev);
      log(s, `${nameOf(s, job.seat)} keeps ${keep.length} on top and puts ${rest.length} ${op.rest === 'side' ? 'into the sideline' : 'on the bottom'}.`, ev);
      job.ctx.look = [];
      return;
    }
    job.ctx.look = p.deck.slice(0, op.n);
    if (!job.ctx.look.length) return;
    return ask(s, job, { type: 'choose', seat: job.seat, prompt: `Top ${job.ctx.look.length} of your deck: choose the cards to keep on top (the rest go ${op.rest === 'side' ? 'into your sideline' : 'to the bottom'}).`, options: [...job.ctx.look], min: 0, max: job.ctx.look.length, zone: 'deck', looked: [...job.ctx.look] });
  },
  // choose cards on the field (or elsewhere) → ctx.it
  choose(s, job, op, ev) {
    const f = withOther(op.f, job);
    if (job.ctx.answered) {
      const picks = takeAnswer(job);
      job.ctx.it = picks;
      job.ctx.chose = picks.length;
      if (picks.length) log(s, `${nameOf(s, job.seat)} chooses ${picks.map((i) => cardName(s, C(s, i))).join(', ')}.`, ev, { chose: picks });
      return;
    }
    const chooser = op.chooser === 'opp' ? other(job.seat) : job.seat;
    const opts = findCards(s, f, job.seat).filter((iid) => !(op.chosable && flagCantChoose(s, iid, job.seat)));
    const max = Math.min(op.max, opts.length);
    const min = Math.min(op.min, max);
    if (!max) { job.ctx.it = []; job.ctx.chose = 0; if (op.min > 0 && op.required) return 'stop'; return; }
    if (min === max && opts.length === max && !op.always) {        // forced: no real choice
      job.ctx.it = [...opts];
      job.ctx.chose = opts.length;
      log(s, `${cardName(s, C(s, job.src))} chooses ${opts.map((i) => cardName(s, C(s, i))).join(', ')}.`, ev, { chose: opts });
      return;
    }
    return ask(s, job, { type: 'choose', seat: chooser, prompt: op.prompt || 'Choose.', options: opts, min, max, public: true });
  },
  // act on targets: sideline / rest / active / hand / deckBottom / deckTop / removal / life / bp / kw / flags
  act(s, job, op, ev) {
    const ids = targetsOf(s, job, op.t);
    let n = 0;
    const REMOVING = new Set(['sideline', 'hand', 'deckBottom', 'deckTop', 'removal', 'side', 'life']);
    for (const iid of ids) {
      const c = C(s, iid);
      if (!c) continue;
      const d = D(s, c);
      if (REMOVING.has(op.do) && onField(c) && c.owner !== job.seat && [...(c.mods || []), ...staticMods(s, c)].some((m) => m.cantBeRemoved)) {
        log(s, `${d.name} can't be removed from the field by an opponent's ability.`, ev);
        continue;
      }
      switch (op.do) {
        case 'sideline': if (sideline(s, iid, ev, `${cardName(s, C(s, job.src))}`)) n++; break;
        case 'rest': if (onField(c) && !c.rest) { c.rest = true; n++; log(s, `${d.name} switches to resting.`, ev); } break;
        case 'active': if (onField(c) && c.rest) { if (c.mods.some((m) => m.stayRested)) { c.mods = c.mods.filter((m) => !m.stayRested); log(s, `${d.name} stays resting.`, ev); break; } c.rest = false; n++; log(s, `${d.name} switches to active.`, ev); } break;
        case 'hand': moveCard(s, iid, 'hand', ev); n++; log(s, `${d.name} returns to ${nameOf(s, c.owner)}'s hand.`, ev); break;
        case 'deckBottom': moveCard(s, iid, 'deckBottom', ev); n++; log(s, `${d.name} goes to the bottom of ${nameOf(s, c.owner)}'s deck.`, ev); break;
        case 'deckTop': moveCard(s, iid, 'deckTop', ev); n++; log(s, `${d.name} goes on top of ${nameOf(s, c.owner)}'s deck.`, ev); break;
        case 'removal': moveCard(s, iid, 'removal', ev); n++; log(s, `${d.name} goes to ${nameOf(s, c.owner)}'s removal area.`, ev); break;
        case 'side': moveCard(s, iid, 'side', ev); n++; log(s, `${d.name} is placed into the sideline.`, ev); break;
        case 'life': moveCard(s, iid, 'lifeTop', ev); n++; log(s, `A card is added to ${nameOf(s, c.owner)}'s life.`, ev); break;
        case 'front': case 'energy': {
          if (!onField(c) || c.zone === op.do) break;
          const p = P(s, c.owner);
          if (p[op.do].length >= LINE_MAX) break;
          p[c.zone].splice(p[c.zone].indexOf(iid), 1); p[op.do].push(iid); c.zone = op.do; n++;
          log(s, `${d.name} moves to the ${op.do === 'front' ? 'front line' : 'energy line'}.`, ev);
          break;
        }
        case 'otherLine': {
          if (!onField(c) || d.type !== 'character') break;
          const to = c.zone === 'front' ? 'energy' : 'front';
          const p = P(s, c.owner);
          if (p[to].length >= LINE_MAX) break;
          p[c.zone].splice(p[c.zone].indexOf(iid), 1); p[to].push(iid); c.zone = to; n++;
          log(s, `${d.name} moves to the ${to === 'front' ? 'front line' : 'energy line'}.`, ev);
          break;
        }
        case 'mod': {
          if (!onField(c)) break;
          const m = { ...op.mod, ...untilOf(op, job) };
          if (op.mod.bp && op.perCard) m.bp = op.mod.bp * (job.ctx.count || 0);
          if (m.bp && m.bp < 0 && modsOfIgnoreReduce(s, c)) break;
          if (m.grantDelayed) {
            (s.delayed ||= []).push({ at: m.grantDelayed.at, seat: c.owner, src: c.iid, uid: c.uid, ops: m.grantDelayed.ops, text: m.grantDelayed.text, turn: s.turnNo });
            delete m.grantDelayed;
          }
          c.mods.push(m);
          n++;
          const bits = [];
          if (m.bp) bits.push(`${m.bp > 0 ? '+' : ''}${m.bp} BP`);
          if (m.kw) bits.push(Object.keys(m.kw).join(', '));
          if (m.gen) bits.push(`${m.gen.join('/')} energy`);
          if (m.cantAttack) bits.push("can't attack");
          if (m.cantBlock) bits.push("can't block");
          if (m.stayRested) bits.push('stays resting');
          log(s, `${d.name}: ${bits.join(', ') || 'modified'}${m.until === 'eot' ? ' until end of turn' : m.until === 'sont' ? ' until the start of your next turn' : m.until === 'battle' ? ' for this battle' : ''}.`, ev);
          break;
        }
        default: break;
      }
    }
    job.ctx.did = n > 0;
    job.ctx.count = n;
    if (op.keepIt !== false) job.ctx.it = ids;
  },
  // AP cards: switch up to n to active (or resting)
  ap(s, job, op, ev) {
    const p = P(s, seatOf(job, op.who));
    let n = 0;
    for (let i = 0; i < p.ap.length && n < op.n; i++) if (p.ap[i] !== op.active) { p.ap[i] = op.active; n++; }
    if (n) log(s, `${nameOf(s, seatOf(job, op.who))} switches ${n} AP card${n > 1 ? 's' : ''} to ${op.active ? 'active' : 'resting'}.`, ev);
    job.ctx.did = n > 0;
  },
  payAp(s, job, op, ev) {
    const p = P(s, job.seat);
    if (apActive(s, job.seat) < op.n) { job.ctx.did = false; return; }
    for (let i = 0, left = op.n; i < p.ap.length && left; i++) if (p.ap[i]) { p.ap[i] = false; left--; }
    job.ctx.did = true;
    log(s, `${nameOf(s, job.seat)} pays ${op.n} AP.`, ev);
  },
  // if / else on a condition
  if(s, job, op) {
    const fr = frameOf(job);
    fr.i++;
    const ok = evalCond(s, op.cond, { src: job.src, seat: job.seat, info: job.ctx.info, job });
    const ops = ok ? op.then : op.else;
    if (ops?.length) job.frames.push({ ops, i: 0 });
    return 'push';
  },
  // "you may …": ask, then run the ops (ctx.did = yes and the ops did something)
  may(s, job, op) {
    if (job.ctx.answered) {
      const yes = takeAnswer(job);
      const fr = frameOf(job);
      fr.i++;
      job.ctx.did = false;
      if (yes) job.frames.push({ ops: op.ops, i: 0 });
      return 'push';
    }
    if (op.need && !evalCond(s, op.need, { src: job.src, seat: job.seat, job })) { job.ctx.did = false; return; }
    return ask(s, job, { type: 'yesno', seat: job.seat, prompt: op.prompt || 'Do it?' });
  },
  // choose one (or up to n) of the following
  modal(s, job, op) {
    if (job.ctx.answered) {
      const picks = takeAnswer(job).map(Number);
      const fr = frameOf(job);
      fr.i++;
      for (const i of [...picks].sort((a, b) => b - a)) if (op.options[i]) job.frames.push({ ops: op.options[i].ops, i: 0 });
      return 'push';
    }
    return ask(s, job, { type: 'choose', seat: job.seat, prompt: 'Choose one of the following:', options: op.options.map((_, i) => String(i)), labels: op.options.map((o) => o.text), min: op.min ?? 1, max: op.max ?? 1, modal: true });
  },
  // play this card from wherever it is (a trigger: "Play this character set to active onto your field.")
  playSelf(s, job, op, ev) {
    const c = C(s, job.src);
    const d = D(s, c);
    const seat = c.owner;
    if (d.type === 'site') {
      if (P(s, seat).energy.length >= LINE_MAX) { log(s, `No room on the energy line for ${d.name}.`, ev); return; }
      moveCard(s, c.iid, 'energy', ev, { active: op.active });
    } else {
      if (job.ctx.answered) {
        const [line] = takeAnswer(job);
        moveCard(s, c.iid, line, ev, { active: op.active });
        log(s, `${d.name} is played onto the ${line === 'front' ? 'front line' : 'energy line'}${op.active ? ' set to active' : ''}.`, ev, { play: c.iid });
        fire(s, 'played', { iid: c.iid, seat }, ev);
        return;
      }
      const lines = ['front', 'energy'].filter((l) => P(s, seat)[l].length < LINE_MAX);
      if (!lines.length) { log(s, `No room on the field for ${d.name}.`, ev); return; }
      if (lines.length === 1) { job.ctx.answered = true; job.ctx.answer = lines; return OPS.playSelf(s, job, op, ev); }
      return ask(s, job, { type: 'choose', seat, prompt: `Play ${d.name} onto which line?`, options: lines, labels: ['Front line', 'Energy line'], min: 1, max: 1, lines: true });
    }
    log(s, `${d.name} is played onto the field${op.active ? ' set to active' : ''}.`, ev, { play: c.iid });
    fire(s, 'played', { iid: c.iid, seat }, ev);
  },
  // add cards from the sideline (or removal) to hand
  fromZone(s, job, op, ev) {
    const seat = job.seat;
    const zone = op.zone || 'side';
    if (job.ctx.answered) {
      const picks = takeAnswer(job);
      for (const iid of picks) moveCard(s, iid, op.to || 'hand', ev);
      job.ctx.added = picks.length > 0;
      job.ctx.did = picks.length > 0;
      job.ctx.it = picks;
      if (picks.length) log(s, `${nameOf(s, seat)} adds ${picks.map((i) => cardName(s, C(s, i))).join(', ')} from their ${zone === 'side' ? 'sideline' : zone} to their ${op.to === 'deckBottom' ? 'deck' : 'hand'}.`, ev);
      return;
    }
    const opts = P(s, seat)[zone].filter((iid) => matches(s, C(s, iid), op.f, seat));
    if (!opts.length) { job.ctx.did = false; return; }
    const max = Math.min(op.max, opts.length);
    return ask(s, job, { type: 'choose', seat, prompt: op.prompt || `Choose up to ${op.max} from your ${zone === 'side' ? 'sideline' : zone}.`, options: opts, min: Math.min(op.min || 0, max), max, zone, public: true });
  },
  // top of deck to life / life to hand
  lifeFromDeck(s, job, op, ev) {
    const p = P(s, job.seat);
    for (let i = 0; i < op.n && p.deck.length; i++) moveCard(s, p.deck[0], 'lifeTop', ev);
    log(s, `${nameOf(s, job.seat)} adds ${op.n} card${op.n > 1 ? 's' : ''} from their deck to their life.`, ev);
  },
  lifeTo(s, job, op, ev) {
    const p = P(s, job.seat);
    let n = 0;
    for (let i = 0; i < op.n && p.life.length; i++) { moveCard(s, p.life[0], op.to || 'side', ev); n++; }
    job.ctx.did = n > 0;
    if (n) log(s, `${nameOf(s, job.seat)} places ${n} life card${n > 1 ? 's' : ''} into the sideline.`, ev);
  },
  lifeToHand(s, job, op, ev) {
    const p = P(s, seatOf(job, op.who));
    let n = 0;
    for (let i = 0; i < op.n && p.life.length; i++) { moveCard(s, p.life[0], 'hand', ev); n++; }
    if (n) log(s, `${nameOf(s, seatOf(job, op.who))} adds ${n} card${n > 1 ? 's' : ''} from their life to their hand.`, ev);
    job.ctx.did = n > 0;
  },
  damage(s, job, op, ev) {
    dealDamage(s, seatOf(job, op.who || 'opp'), op.n, ev, { by: job.src });
  },
  shuffle(s, job, op, ev) { shuffle(s, P(s, job.seat).deck); log(s, `${nameOf(s, job.seat)} shuffles their deck.`, ev); },
  // a delayed ability: "At the end of the main phase, sideline this character."
  delayed(s, job, op) {
    (s.delayed ||= []).push({ at: op.at, seat: job.seat, src: job.src, uid: C(s, job.src).uid, ops: op.ops, text: op.text, turn: s.turnNo });
  },
  // the opponent's cost reduction / your cost reduction this turn (rare)
  costMod(s, job, op) {
    P(s, job.seat).costMods.push({ ...op.mod, until: op.until || 'eot', who: job.seat });
  },
  // count something into ctx.count (for "for each" BP)
  count(s, job, op) {
    job.ctx.count = op.what === 'it' ? (job.ctx.it || []).length : findCards(s, op.f, job.seat).length;
  },
  log(s, job, op, ev) { log(s, op.text, ev); },
  underToSide(s, job, op, ev) {
    const c = C(s, job.src);
    if (!onField(c) || c.under.length < op.n) { job.ctx.did = false; return; }
    for (let i = 0; i < op.n; i++) {
      const iid = c.under.pop();
      const u = C(s, iid);
      u.parent = null; u.faceDown = false; u.zone = 'side';
      P(s, u.owner).side.push(iid);
    }
    job.ctx.did = true;
    log(s, `${nameOf(s, job.seat)} places ${op.n} card${op.n > 1 ? 's' : ''} from under ${cardName(s, c)} into the sideline.`, ev);
  },
  discardAll(s, job, op, ev) {
    const p = P(s, job.seat);
    const n = p.hand.length;
    for (const iid of [...p.hand]) moveCard(s, iid, 'side', ev);
    job.ctx.did = n > 0;
    job.ctx.count = n;
    log(s, `${nameOf(s, job.seat)} places their whole hand (${n}) into the sideline.`, ev);
  },
  // n cards from hand to the top/bottom of the deck, or face down under this character
  handTo(s, job, op, ev) {
    const p = P(s, job.seat);
    if (job.ctx.answered) {
      const picks = takeAnswer(job);
      for (const iid of picks) {
        if (op.to === 'under') {
          const c = C(s, job.src);
          if (!onField(c)) break;
          const u = C(s, iid);
          p.hand.splice(p.hand.indexOf(iid), 1);
          u.zone = 'under'; u.parent = c.iid; u.faceDown = true; c.under.push(iid);
        } else moveCard(s, iid, op.to, ev);
      }
      job.ctx.did = picks.length > 0;
      if (picks.length) log(s, `${nameOf(s, job.seat)} puts ${op.reveal ? picks.map((i) => cardName(s, C(s, i))).join(', ') : `${picks.length} card${picks.length > 1 ? 's' : ''}`} from hand ${op.to === 'under' ? 'under ' + cardName(s, C(s, job.src)) : op.to === 'deckTop' ? 'on top of their deck' : 'on the bottom of their deck'}.`, ev);
      return;
    }
    const n = Math.min(op.n, p.hand.length);
    if (!n) { job.ctx.did = false; return; }
    return ask(s, job, { type: 'choose', seat: job.seat, prompt: `Choose ${n} card${n > 1 ? 's' : ''} from your hand.`, options: [...p.hand], min: n, max: n, zone: 'hand' });
  },
  // place n cards from your sideline into your removal area (you pick)
  sideToRemoval(s, job, op, ev) {
    const side = P(s, job.seat).side;
    if (job.ctx.answered) {
      const picks = takeAnswer(job);
      for (const iid of picks) moveCard(s, iid, 'removal', ev);
      job.ctx.did = picks.length === op.n;
      job.ctx.count = picks.length;
      if (picks.length) log(s, `${nameOf(s, job.seat)} places ${picks.length} card${picks.length > 1 ? 's' : ''} from the sideline into the removal area.`, ev);
      return;
    }
    if (side.length < op.n) { job.ctx.did = false; return; }
    if (side.length === op.n) { job.ctx.answered = true; job.ctx.answer = [...side]; return OPS.sideToRemoval(s, job, op, ev); }
    return ask(s, job, { type: 'choose', seat: job.seat, prompt: `Place ${op.n} card${op.n > 1 ? 's' : ''} from your sideline into your removal area.`, options: [...side], min: op.n, max: op.n, zone: 'side', public: true });
  },
  // place up to n cards from the top of your deck into your sideline: how many is the choice
  millUpTo(s, job, op, ev) {
    if (job.ctx.answered) {
      const [k] = takeAnswer(job).map(Number);
      return OPS.mill(s, job, { n: k }, ev);
    }
    const n = Math.min(op.n, P(s, job.seat).deck.length);
    if (!n) return;
    return ask(s, job, { type: 'choose', seat: job.seat, prompt: 'How many cards from the top of your deck go into your sideline?', options: Array.from({ length: n + 1 }, (_, i) => String(i)), labels: Array.from({ length: n + 1 }, (_, i) => String(i)), min: 1, max: 1, count: true });
  },
  // the top card(s) of your deck, face down, under this character
  underTop(s, job, op, ev) {
    const c = C(s, job.src);
    const p = P(s, job.seat);
    if (!onField(c)) return;
    let n = 0;
    for (let i = 0; i < op.n && p.deck.length; i++) {
      const iid = p.deck.shift();
      const u = C(s, iid);
      u.zone = 'under'; u.parent = c.iid; u.faceDown = true;
      c.under.push(iid);
      n++;
    }
    if (n) log(s, `${nameOf(s, job.seat)} places ${n} card${n > 1 ? 's' : ''} face down under ${cardName(s, c)}.`, ev);
  },
  // play a card from hand or sideline (no cost) that matches a filter
  playFrom(s, job, op, ev) {
    const seat = job.seat;
    const p = P(s, seat);
    if (job.ctx.answered && job.ctx.playStage === 'line') {
      const [line] = takeAnswer(job);
      const iid = job.ctx.playing;
      job.ctx.playStage = null;
      putOnField(s, job, iid, line, op, ev);
      return;
    }
    if (job.ctx.answered) {
      const picks = takeAnswer(job);
      if (!picks.length) { job.ctx.did = false; return; }
      const iid = picks[0];
      const d = D(s, C(s, iid));
      const lines = d.type === 'site' ? ['energy'] : op.line ? [op.line] : ['front', 'energy'];
      const open = lines.filter((l) => p[l].length < LINE_MAX);
      if (!open.length) { job.ctx.did = false; log(s, `No room on the field for ${d.name}.`, ev); return; }
      if (open.length === 1) { putOnField(s, job, iid, open[0], op, ev); return; }
      job.ctx.playing = iid;
      job.ctx.playStage = 'line';
      return ask(s, job, { type: 'choose', seat, prompt: `Play ${d.name} onto which line?`, options: open, labels: open.map((l) => (l === 'front' ? 'Front line' : 'Energy line')), min: 1, max: 1, lines: true });
    }
    const opts = p[op.zone].filter((iid) => matches(s, C(s, iid), op.f, seat) && D(s, C(s, iid)).type !== 'event');
    if (!opts.length) { job.ctx.did = false; return; }
    return ask(s, job, { type: 'choose', seat, prompt: `Choose a card to play from your ${op.zone === 'side' ? 'sideline' : 'hand'}${op.active ? ' set to active' : ''}.`, options: opts, min: Math.min(op.min, 1), max: 1, zone: op.zone, public: op.zone !== 'hand' });
  },
};

function putOnField(s, job, iid, line, op, ev) {
  const d = D(s, C(s, iid));
  moveCard(s, iid, line, ev, { active: op.active });
  job.ctx.did = true;
  job.ctx.it = [iid];
  log(s, `${nameOf(s, job.seat)} plays ${d.name} onto the ${line === 'front' ? 'front line' : 'energy line'}${op.active ? ' set to active' : ''}.`, ev, { play: iid });
  fire(s, 'played', { iid, seat: job.seat, byAbility: true }, ev);
}

function flagCantChoose(s, iid, seat) {
  const c = C(s, iid);
  return c.owner !== seat && [...(c.mods || []), ...staticMods(s, c)].some((m) => m.cantBeChosen);
}
function modsOfIgnoreReduce(s, c) {
  return [...(c.mods || []), ...staticMods(s, c)].some((m) => m.noBpReduce);
}

export { OPS };
