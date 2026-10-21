// Proc runtime — executes compiled procs (game/procs/compile.js) inside the engine.
//
// The shared building blocks live here, once:
//   filters      matches(F, card)          "damaged Villain character of yours with cost 3 or less"
//   selectors    targets(sel)              self · ref (it/them) · chosen (prompt, up to N) · all
//   amounts      amount(n) / count(per)    2 · their {strength} · for each X
//   conditions   test(cond)                you have X in play · this character has no damage · …
//   effects      FN[fn](…)                 draw · damage · banish · mod · look · discard · playFree · …
//   statics      statics()                 recomputed after every action (mods with until:'static')
//   triggers     fire(ev, info)            queues every matching triggered proc
//
// Jobs sit in s.fx (one per resolving ability). A step that needs a choice sets s.pending and returns
// false; answer() records the choice on the job and the pump re-enters the same step. Nothing is
// half-applied: the engine wraps each action in a snapshot/rollback.

import { SUPPORT } from './support.js';

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const DUR_UNTIL = { turn: 'eot', next: 'sot', theirNext: 'theirNext' };
const STAT_ICON = { str: '⚔️', wp: '🛡️', lore: '◆' };
const HARMFUL = new Set(['damage', 'banish', 'toHand', 'toDeckBottom', 'shuffleIn', 'exert', 'toInkwell']);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Reminder regexes for abilities the compiler couldn't parse (still shown in the log, like a real table)
const REMIND = {
  play: /\bwhen(?:ever)? you play this\b/i,
  quest: /\bwhen(?:ever)? this character quests\b/i,
  challenges: /\bwhen(?:ever)? (?:this character|he|she|they) challenges?\b/i,
  challenged: /\bwhen(?:ever)? this (?:character|location) is challenged\b/i,
  banished: /\bwhen(?:ever)? this (?:character|item|location) is banished\b/i,
  turnStart: /\bat the start of your turn\b/i,
  turnEnd: /\bat the end of (?:your|the) turn\b/i,
  moveHere: /\bwhenever (?:a character moves here|you move a character here)\b/i,
};

export function createRuntime(E) {
  const { D, P, nameOf, log, cardLabel } = E;

  // ------------------------------------------------------------ filters

  function matches(s, F, c, ctl, src, o = {}) {
    if (!c) return false;
    const zone = F.zone || 'play';
    if (!o.anyZone && c.zone !== zone) return false;
    const d = D(s, c);
    if (F.types) {
      const t = d.type === 'song' ? ['song', 'action'] : [d.type];
      if (!F.types.some((x) => t.includes(x) || (x === 'song' && (d.classes || []).some((k) => /song/i.test(k))))) return false;
    }
    if (F.owner === 'you' && c.owner !== ctl) return false;
    if (F.owner === 'opp' && c.owner === ctl) return false;
    if (F.other && c.iid === src) return false;
    if (F.damaged && !c.damage) return false;
    if (F.undamaged && c.damage) return false;
    if (F.exerted && !c.exerted) return false;
    if (F.ready && c.exerted) return false;
    if (F.classes && !F.classes.some((k) => (d.classes || []).map((x) => String(x).toLowerCase()).includes(k))) return false;
    if (F.named && !F.named.some((n) => n.toLowerCase() === String(d.name).toLowerCase())) return false;
    if (F.cost && !cmp(d.cost, F.cost)) return false;
    if (F.str && !cmp(E.effStr(c, d), F.str)) return false;
    if (F.wp && !cmp(E.effWp(c, d), F.wp)) return false;
    if (F.lore && !cmp(E.effLore(c, d), F.lore)) return false;
    if (F.kw && !E.hasKw(c, d, F.kw)) return false;
    if (F.here && c.atLocation !== src) return false;
    if (F.atLocation && !c.atLocation) return false;
    return true;
  }
  const cmp = (v, r) => (r.lte == null || v <= r.lte) && (r.gte == null || v >= r.gte);

  function pool(s, F, ctl) {
    const zone = F.zone || 'play';
    const seats = F.owner === 'you' ? [ctl] : F.owner === 'opp' ? E.opponentsOf(s, ctl) : s.players.map((p) => p.seat);
    return seats.flatMap((seat) => P(s, seat)[zone] || []);
  }
  const candidates = (s, F, ctl, src) => pool(s, F, ctl).filter((iid) => matches(s, F, s.cards[iid], ctl, src));

  // ------------------------------------------------------------ amounts

  function count(s, per, ctl, src) {
    const c = per.count;
    const me = s.cards[src];
    if (c.under) return me ? me.under.length : 0;
    if (c.damageOnSelf) return me ? me.damage : 0;
    if (c.zone && !c.types && !c.classes && Object.keys(c).every((k) => ['zone', 'owner'].includes(k))) {
      const seats = c.owner === 'opp' ? E.opponentsOf(s, ctl) : [ctl];
      return seats.reduce((n, seat) => n + P(s, seat)[c.zone].length, 0);
    }
    return candidates(s, c, ctl, src).length;
  }
  function amount(s, job, n) {
    if (typeof n === 'number') return n;
    if (n && n.stat) {
      const id = n.of === 'self' ? job.src : (job.ctx.it || [])[0];
      const c = s.cards[id];
      if (!c) return 0;
      const d = D(s, c);
      return Math.max(0, n.stat === 'str' ? E.effStr(c, d) : n.stat === 'lore' ? E.effLore(c, d) : E.effWp(c, d));
    }
    return 0;
  }

  // ------------------------------------------------------------ conditions

  function test(s, C, ctl, src, job) {
    if (!C) return true;
    const me = s.cards[src];
    if (C.any) return C.any.some((x) => test(s, x, ctl, src, job));
    if (C.have) {
      const F = { ...C.have };
      if (!F.owner) F.owner = 'you';
      const n = candidates(s, F, ctl, src).length;
      return C.exactly ? n === C.n : n >= C.n;
    }
    if (C.self) {
      if (!me) return false;
      const d = D(s, me);
      const f = C.self;
      if (f.undamaged && me.damage) return false;
      if (f.damaged && !me.damage) return false;
      if (f.exerted && !me.exerted) return false;
      if (f.atLocation && !me.atLocation) return false;
      if (f.hasUnder && !me.under.length) return false;
      if (f.str && !cmp(E.effStr(me, d), f.str)) return false;
      if (f.wp && !cmp(E.effWp(me, d), f.wp)) return false;
      return true;
    }
    if (C.hand) return cmp(P(s, ctl).hand.length, C.hand);
    if (C.moreCardsThanOpp) return E.opponentsOf(s, ctl).every((o) => P(s, ctl).hand.length > P(s, o).hand.length);
    if (C.oppMoreLore) return E.opponentsOf(s, ctl).some((o) => P(s, o).lore > P(s, ctl).lore);
    if (C.youMoreLore) return E.opponentsOf(s, ctl).every((o) => P(s, ctl).lore > P(s, o).lore);
    if (C.playedThisTurn) return (P(s, ctl).playedThisTurn || []).some((iid) => iid !== src && matches(s, C.playedThisTurn, s.cards[iid], ctl, src, { anyZone: true }));
    if ('yourTurn' in C) return (s.active === ctl) === C.yourTurn;
    if (C.shifted) return !!me?.shifted;
    if (C.refIs) { const id = (job?.ctx.it || [])[0]; return !!id && matches(s, C.refIs, s.cards[id], ctl, src, { anyZone: true }); }
    return false;
  }
  const duringOk = (s, proc, owner) => !proc.during || (proc.during === 'yours' ? s.active === owner : s.active !== owner);

  // ------------------------------------------------------------ jobs

  function queue(s, seat, src, label, steps, ctx = {}, extra = {}) {
    s.fx ||= [];
    s.fx.push({ seat, src, label, steps: clone(steps), i: 0, ctx: { it: [], did: true, ...ctx }, tmp: {}, ...extra });
  }
  const labelOf = (s, c, proc) => `${cardLabel(D(s, c))}${proc?.name ? ' — ' + proc.name : ''}`;
  const procsOf = (d) => d.procs || [];

  // ------------------------------------------------------------ triggers

  // info: { iid: the card the event is about, seat, inChallenge, other (opponent card), at (location) }
  function fire(s, ev, info = {}) {
    const subject = info.iid ? s.cards[info.iid] : null;
    const fireOn = (c, evName, pass, ctxIt) => {
      const d = D(s, c);
      procsOf(d).forEach((proc, k) => {
        if (proc.kind === 'unparsed') {
          if (evName === ev && REMIND[ev]?.test(proc.text) && c.iid === info.iid) log(s, `↳ ${labelOf(s, c, proc)}: ${E.prettyText(proc.text)}`, { kind: 'effect' });
          return;
        }
        if (proc.kind !== 'triggered') return;
        const on = proc.on.find((o) => o.ev === evName && (!pass || pass(o)));
        if (!on) return;
        if (!proc.exec) { log(s, `↳ ${labelOf(s, c, proc)}: ${E.prettyText(proc.text)}`, { kind: 'effect' }); return; }
        if (!duringOk(s, proc, c.owner)) return;
        if (on.whileCond && !test(s, on.whileCond, c.owner, c.iid)) return;
        if (proc.once) {
          c.once ||= {};
          if (c.once[k] === s.turn) return;
          c.once[k] = s.turn;
        }
        queue(s, c.owner, c.iid, labelOf(s, c, proc), proc.do, { it: ctxIt || [] }, { cond: proc.cond || null });
      });
    };
    const inPlay = (seat) => P(s, seat).play.map((id) => s.cards[id]);
    const everyone = () => s.players.flatMap((p) => inPlay(p.seat));
    switch (ev) {
      case 'play': {
        if (subject && subject.zone === 'play') fireOn(subject, 'play');
        for (const c of inPlay(subject.owner)) {
          fireOn(c, 'playCard', (o) => matches(s, o.filter, subject, c.owner, c.iid, { anyZone: true }), [subject.iid]);
        }
        for (const o of E.opponentsOf(s, subject.owner)) for (const c of inPlay(o)) {
          fireOn(c, 'oppPlayCard', (on) => matches(s, on.filter, subject, subject.owner, c.iid, { anyZone: true }), [subject.iid]);
        }
        break;
      }
      case 'quest': {
        fireOn(subject, 'quest');
        for (const c of inPlay(subject.owner)) {
          fireOn(c, 'questAny', (o) => matches(s, o.filter, subject, c.owner, c.iid), [subject.iid]);
        }
        if (subject.atLocation && s.cards[subject.atLocation]) fireOn(s.cards[subject.atLocation], 'questHere', null, [subject.iid]);
        break;
      }
      case 'challenges': {
        const def = s.cards[info.other];
        fireOn(subject, 'challenges', (o) => !o.filter || matches(s, o.filter, def, subject.owner, subject.iid), [info.other]);
        for (const c of inPlay(subject.owner)) fireOn(c, 'challengesAny', (o) => matches(s, o.filter, subject, c.owner, c.iid), [subject.iid]);
        break;
      }
      case 'challenged': fireOn(subject, 'challenged', null, [info.other]); break;
      case 'banished': {
        fireOn(subject, 'banished', (o) => (!o.inChallenge || info.inChallenge) && (!o.defending || info.defending));
        for (const c of inPlay(subject.owner)) {
          fireOn(c, 'banishedAny', (o) => (!o.inChallenge || info.inChallenge) && matches(s, o.filter, subject, c.owner, c.iid, { anyZone: true }), [subject.iid]);
        }
        if (info.by && s.cards[info.by]?.zone === 'play') {
          const killer = s.cards[info.by];
          fireOn(killer, 'banishOther', null, [subject.iid]);
          for (const c of inPlay(killer.owner)) fireOn(c, 'banishOtherAny', (o) => matches(s, o.filter, killer, c.owner, c.iid), [subject.iid]);
        }
        break;
      }
      case 'turnStart': case 'turnEnd':
        for (const c of inPlay(info.seat)) {
          fireOn(c, ev);
          if (!procsOf(D(s, c)).some((p) => p.kind === 'triggered') && REMIND[ev]) {
            for (const proc of procsOf(D(s, c))) if (proc.kind === 'unparsed' && REMIND[ev].test(proc.text)) log(s, `↳ ${labelOf(s, c, proc)}: ${E.prettyText(proc.text)}`, { kind: 'effect' });
          }
        }
        break;
      case 'sings':
        fireOn(subject, 'sings', null, [info.song]);
        for (const c of inPlay(subject.owner)) fireOn(c, 'singsAny', (o) => matches(s, o.filter, subject, c.owner, c.iid), [subject.iid]);
        break;
      case 'inked':
        for (const c of inPlay(info.seat)) fireOn(c, 'inked');
        break;
      case 'moveHere':
        if (info.at && s.cards[info.at]) fireOn(s.cards[info.at], 'moveHere', null, [subject.iid]);
        break;
      default:
        void everyone;
    }
  }

  // ------------------------------------------------------------ choices

  function ask(s, job, spec) {
    s.pending = {
      type: 'choose', seat: spec.seat ?? job.seat, valid: spec.valid || [], optional: !!spec.optional,
      src: job.src, op: spec.op, prompt: `${job.label}: ${spec.prompt}`, harmful: !!spec.harmful,
      ...(spec.confirm ? { confirm: true } : {}),
      ...(spec.cards ? { cards: spec.cards } : {}),
      ...(spec.choices ? { choices: spec.choices } : {}),
    };
    return null;
  }
  // Generic target resolution for a selector. Returns iids, or null while waiting on a choice.
  function targets(s, job, st, sel, key = 'sel', o = {}) {
    const T = (job.tmp[key] ||= { acc: [] });
    if (!sel) return [];
    if (sel.self) return s.cards[job.src] ? [job.src] : [];
    if (sel.ref) return (job.ctx.it || []).filter((id) => s.cards[id]);
    if (sel.all) return candidates(s, sel.all, job.seat, job.src).filter(o.keep || (() => true));
    if (!sel.chosen) return [];
    if (job.answer && job.answer.key === key) {
      const a = job.answer; job.answer = null;
      if (a.skip) T.done = true; else T.acc.push(a.target);
    }
    const max = sel.upTo || 1;
    if (T.done || T.acc.length >= max) return T.acc;
    const chooser = job.seat;
    let valid = candidates(s, sel.chosen, job.seat, job.src)
      .filter((iid) => !T.acc.includes(iid))
      .filter((iid) => s.cards[iid].owner === chooser || !E.hasKw(s.cards[iid], D(s, s.cards[iid]), 'ward'));   // Ward (8.15)
    if (o.keep) valid = valid.filter(o.keep);
    if (!valid.length) {
      if (!T.acc.length) log(s, `↳ ${job.label}: no valid ${describe(sel.chosen)} — skipped.`, { kind: 'effect' });
      return T.acc;
    }
    job.waitKey = key;
    const zone = sel.chosen.zone || 'play';
    return ask(s, job, {
      valid, op: st.fn, harmful: HARMFUL.has(st.fn),
      optional: !!st.may || !!sel.upTo || T.acc.length > 0,
      prompt: `${o.verb || verbOf(s, job, st)} — choose ${sel.upTo ? `up to ${sel.upTo} ` : ''}${describe(sel.chosen)}${T.acc.length ? ` (${T.acc.length} picked)` : ''}.`,
      cards: zone === 'play' ? undefined : valid.map((iid) => ({ iid, cardId: s.cards[iid].cardId })),
    });
  }
  function pickFrom(s, job, st, key, valid, spec) {
    const T = (job.tmp[key] ||= { acc: [] });
    if (job.answer && job.answer.key === key) {
      const a = job.answer; job.answer = null;
      if (a.skip) T.done = true; else T.acc.push(a.target);
    }
    if (T.done || T.acc.length >= (spec.n || 1)) return T.acc;
    const v = valid.filter((iid) => !T.acc.includes(iid));
    if (!v.length) return T.acc;
    job.waitKey = key;
    return ask(s, job, { ...spec, valid: v, cards: v.map((iid) => ({ iid, cardId: s.cards[iid].cardId })), op: spec.op || st.fn });
  }

  // ------------------------------------------------------------ effects

  const who = (s, job, w) => (w === 'each' ? s.players.filter((p) => !p.out).map((p) => p.seat) : w === 'opp' ? E.opponentsOf(s, job.seat) : [job.seat]);
  const tl = (s, iid) => { const c = s.cards[iid]; return `${nameOf(s, c.owner)}'s ${cardLabel(D(s, c))}`; };
  const each = (ids, f) => { ids.forEach(f); return ids.length > 0; };
  const untilOf = (s, st, c, job) => (st.dur ? { until: DUR_UNTIL[st.dur], by: st.dur === 'theirNext' ? c.owner : job.seat, setTurn: s.turn } : { until: 'static' });

  function addMods(s, job, st, iid, ev, mult = 1) {
    const c = s.cards[iid];
    const u = untilOf(s, st, c, job);
    for (const m of st.mods || []) {
      c.mods.push({ stat: m.stat, delta: m.n * mult, ...u, src: job.label });
      if (ev) ev.push({ k: 'mod', iid, stat: m.stat, delta: m.n * mult });
    }
    for (const k of st.kws || []) {
      c.mods.push({ stat: 'kw', kw: k.kw, delta: k.n ?? 1, ...u, src: job.label });
      if (ev) ev.push({ k: 'mod', iid, stat: 'kw', delta: 1 });
    }
  }
  const modText = (s, st, job) => [
    ...(st.mods || []).map((m) => `${m.n > 0 ? '+' : ''}${m.n} ${STAT_ICON[m.stat]}`),
    ...(st.kws || []).map((k) => (E.KEYWORD_LABEL[k.kw] || k.kw) + (k.n ? ` +${k.n}` : '')),
  ].join(' and ') + (st.dur === 'next' ? ` until the start of ${nameOf(s, job.seat)}'s next turn` : st.dur === 'theirNext' ? ' during their next turn' : ' this turn');

  const FN = {
    draw(s, job, st, ev) {
      const n = amount(s, job, st.n);
      for (const seat of who(s, job, st.who)) {
        const { names } = E.drawCards(s, seat, n, ev);
        log(s, `↳ ${nameOf(s, seat)} drew ${plural(names.length, 'card')}.`, { seat, kind: 'effect', priv: names.length ? { seat, text: `↳ You drew ${names.join(', ')}.` } : undefined });
      }
      return true;
    },
    gainLore(s, job, st, ev) {
      const n = amount(s, job, st.n);
      E.gainLore(s, job.seat, n, ev);
      log(s, `↳ ${nameOf(s, job.seat)} gained ${n} lore (${P(s, job.seat).lore}/${E.LORE_TO_WIN}).`, { seat: job.seat, kind: 'effect' });
      return true;
    },
    loseLore(s, job, st, ev) {
      for (const o of who(s, job, 'opp')) {
        const before = P(s, o).lore;
        E.gainLore(s, o, -amount(s, job, st.n), ev);
        log(s, `↳ ${nameOf(s, o)} lost ${before - P(s, o).lore} lore.`, { seat: o, kind: 'effect' });
      }
      return true;
    },
    damage(s, job, st, ev) {
      const ids = targets(s, job, st, st.sel);
      if (!ids) return null;
      const n0 = amount(s, job, st.n);
      job.ctx.it = ids;
      return each(ids, (iid) => {
        const c = s.cards[iid]; const d = D(s, c);
        const n = st.put ? n0 : Math.max(0, n0 - E.kwVal(c, d, 'resist'));          // Resist (8.8) — not for "put damage"
        c.damage += n;
        if (n) ev.push({ k: 'damage', iid, n });
        log(s, `↳ ${st.put ? 'Put' : 'Dealt'} ${n} damage ${st.put ? 'on' : 'to'} ${tl(s, iid)}.`, { seat: job.seat, kind: 'effect' });
      });
    },
    heal(s, job, st, ev) {
      const ids = targets(s, job, st, st.sel, 'sel', { keep: (iid) => s.cards[iid].damage > 0 });
      if (!ids) return null;
      job.ctx.it = ids;
      job.ctx.healed = 0;
      return each(ids, (iid) => {
        const c = s.cards[iid];
        const n = Math.min(amount(s, job, st.n), c.damage);
        c.damage -= n; job.ctx.healed += n;
        if (n) ev.push({ k: 'damage', iid, n: -n });
        log(s, `↳ Removed ${n} damage from ${tl(s, iid)}.`, { seat: job.seat, kind: 'effect' });
      });
    },
    moveDamage(s, job, st, ev) {
      const from = targets(s, job, st, st.from, 'from', { keep: (iid) => s.cards[iid].damage > 0, verb: `move ${st.n} damage from` });
      if (!from) return null;
      if (!from.length) return false;
      const to = targets(s, job, st, st.to, 'to', { keep: (iid) => !from.includes(iid), verb: `move ${st.n} damage to` });
      if (!to) return null;
      if (!to.length) return false;
      const a = s.cards[from[0]]; const b = s.cards[to[0]];
      const n = Math.min(st.n, a.damage);
      a.damage -= n; b.damage += n;
      ev.push({ k: 'damage', iid: a.iid, n: -n }, { k: 'damage', iid: b.iid, n });
      log(s, `↳ Moved ${n} damage from ${tl(s, a.iid)} to ${tl(s, b.iid)}.`, { seat: job.seat, kind: 'effect' });
      job.ctx.it = [b.iid];
      return true;
    },
    banish(s, job, st, ev) {
      const ids = targets(s, job, st, st.sel);
      if (!ids) return null;
      job.ctx.it = ids;
      return each(ids.filter((iid) => s.cards[iid].zone === 'play'), (iid) => E.banish(s, iid, ev, job.label));
    },
    toHand(s, job, st, ev) {
      const ids = targets(s, job, st, st.sel);
      if (!ids) return null;
      job.ctx.it = ids;
      return each(ids, (iid) => { log(s, `↳ Returned ${tl(s, iid)} to their hand.`, { seat: job.seat, kind: 'effect' }); E.moveTo(s, iid, 'hand', ev, { reveal: true }); });
    },
    toDeckBottom(s, job, st, ev) {
      const ids = targets(s, job, st, st.sel);
      if (!ids) return null;
      return each(ids, (iid) => { log(s, `↳ Put ${tl(s, iid)} on the bottom of their deck.`, { seat: job.seat, kind: 'effect' }); E.moveTo(s, iid, 'deckBottom', ev); });
    },
    shuffleIn(s, job, st, ev) {
      const ids = targets(s, job, st, st.sel);
      if (!ids) return null;
      return each(ids, (iid) => {
        const owner = s.cards[iid].owner;
        log(s, `↳ Shuffled ${tl(s, iid)} into their deck.`, { seat: job.seat, kind: 'effect' });
        E.moveTo(s, iid, 'deckBottom', ev); E.shuffleArr(s, P(s, owner).deck); ev.push({ k: 'shuffle', seat: owner });
      });
    },
    toInkwell(s, job, st, ev) {
      const ids = targets(s, job, st, st.sel);
      if (!ids) return null;
      return each(ids, (iid) => { log(s, `↳ Put ${tl(s, iid)} into their inkwell.`, { seat: job.seat, kind: 'effect' }); E.moveTo(s, iid, 'inkwell', ev, { exerted: !!st.exerted }); });
    },
    inkTop(s, job, st, ev) {
      const p = P(s, job.seat);
      if (!p.deck.length) return false;
      E.moveTo(s, p.deck[0], 'inkwell', ev, { exerted: !!st.exerted });
      log(s, `↳ ${nameOf(s, job.seat)} put the top card of their deck into their inkwell.`, { seat: job.seat, kind: 'effect' });
      return true;
    },
    mill(s, job, st, ev) {
      const p = P(s, job.seat); const names = [];
      for (let k = 0; k < st.n && p.deck.length; k++) { names.push(cardLabel(D(s, s.cards[p.deck[0]]))); E.moveTo(s, p.deck[0], 'discard', ev); }
      log(s, `↳ ${nameOf(s, job.seat)} put ${names.join(', ') || 'nothing'} from the top of their deck into their discard.`, { seat: job.seat, kind: 'effect' });
      return names.length > 0;
    },
    exert(s, job, st, ev) {
      const ids = targets(s, job, st, st.sel, 'sel', { keep: (iid) => !s.cards[iid].exerted && D(s, s.cards[iid]).type !== 'location' });
      if (!ids) return null;
      job.ctx.it = ids;
      return each(ids, (iid) => { s.cards[iid].exerted = true; ev.push({ k: 'exert', iid }); log(s, `↳ Exerted ${tl(s, iid)}.`, { seat: job.seat, kind: 'effect' }); });
    },
    ready(s, job, st, ev) {
      const ids = targets(s, job, st, st.sel);
      if (!ids) return null;
      job.ctx.it = ids;
      return each(ids, (iid) => { s.cards[iid].exerted = false; ev.push({ k: 'ready', iid }); log(s, `↳ Readied ${tl(s, iid)}.`, { seat: job.seat, kind: 'effect' }); });
    },
    mod(s, job, st, ev) {
      const ids = targets(s, job, st, st.sel);
      if (!ids) return null;
      const mult = st.per ? count(s, st.per, job.seat, job.src) : 1;
      job.ctx.it = ids;
      return each(ids, (iid) => { addMods(s, job, st, iid, ev, mult); log(s, `↳ ${tl(s, iid)} ${st.kws && !st.mods ? 'gains' : 'gets'} ${modText(s, st, job)}.`, { seat: job.seat, kind: 'effect' }); });
    },
    discard(s, job, st, ev) {
      if (st.random) {
        for (const seat of who(s, job, st.who)) {
          const p = P(s, seat); const gone = [];
          for (let k = 0; k < st.n && p.hand.length; k++) {
            const iid = p.hand[Math.floor(E.rand(s) * p.hand.length)];
            gone.push(cardLabel(D(s, s.cards[iid]))); E.moveTo(s, iid, 'discard', ev);
          }
          log(s, `↳ ${nameOf(s, seat)} discarded ${gone.join(', ') || 'nothing'} at random.`, { seat, kind: 'effect' });
        }
        return true;
      }
      // one pick per card per player, each player chooses their own
      const T = (job.tmp.discard ||= { queue: who(s, job, st.who).flatMap((seat) => Array(st.n).fill(seat)), any: false });
      if (job.answer?.key === 'discard') {
        const a = job.answer; job.answer = null;
        const c = s.cards[a.target];
        E.moveTo(s, c.iid, 'discard', ev); T.any = true;
        log(s, `↳ ${nameOf(s, c.owner)} discarded ${cardLabel(D(s, c))}.`, { seat: c.owner, kind: 'effect' });
        T.queue.shift();
      }
      while (T.queue.length) {
        const seat = T.queue[0];
        const valid = P(s, seat).hand.filter((iid) => !st.filter || matches(s, { ...st.filter, zone: 'hand' }, s.cards[iid], seat, job.src));
        if (!valid.length) { log(s, `↳ ${nameOf(s, seat)} has nothing to discard.`, { kind: 'effect' }); T.queue.shift(); continue; }
        job.waitKey = 'discard';
        return ask(s, job, { seat, valid, op: seat === job.seat ? 'selfDiscard' : 'oppDiscardPick', harmful: false, prompt: `choose a card to discard.` });
      }
      return T.any;
    },
    oppChoose(s, job, st, ev) {
      const T = (job.tmp.opp ||= { queue: E.opponentsOf(s, job.seat), any: false });
      if (job.answer?.key === 'opp') {
        const a = job.answer; job.answer = null;
        const iid = a.target; const c = s.cards[iid];
        if (st.act === 'banish') E.banish(s, iid, ev, job.label);
        else if (st.act === 'exert') { c.exerted = true; ev.push({ k: 'exert', iid }); log(s, `↳ ${nameOf(s, c.owner)} exerted ${cardLabel(D(s, c))}.`, { kind: 'effect' }); }
        else if (st.act === 'toHand') { log(s, `↳ ${nameOf(s, c.owner)} returned ${cardLabel(D(s, c))} to their hand.`, { kind: 'effect' }); E.moveTo(s, iid, 'hand', ev, { reveal: true }); }
        else if (st.act === 'damage') { const n = Math.max(0, st.n - E.kwVal(c, D(s, c), 'resist')); c.damage += n; if (n) ev.push({ k: 'damage', iid, n }); log(s, `↳ ${nameOf(s, c.owner)} dealt ${n} damage to their ${cardLabel(D(s, c))}.`, { kind: 'effect' }); }
        T.any = true; T.queue.shift();
      }
      while (T.queue.length) {
        const o = T.queue[0];
        const F = { ...st.filter, owner: 'you' };
        const valid = P(s, o).play.filter((iid) => matches(s, F, s.cards[iid], o, null) && (st.act !== 'exert' || !s.cards[iid].exerted));
        if (!valid.length) { log(s, `↳ ${nameOf(s, o)} has nothing to choose.`, { kind: 'effect' }); T.queue.shift(); continue; }
        job.waitKey = 'opp';
        return ask(s, job, { seat: o, valid, op: `opp${st.act[0].toUpperCase()}${st.act.slice(1)}Pick`, harmful: true, prompt: `choose one of your ${describe(st.filter)} to ${st.act === 'toHand' ? 'return to your hand' : st.act === 'damage' ? `take ${st.n} damage` : st.act}.` });
      }
      return T.any;
    },
    fromDiscard(s, job, st, ev) {
      const valid = P(s, job.seat).discard.filter((iid) => matches(s, st.filter, s.cards[iid], job.seat, job.src));
      if (!valid.length) { log(s, `↳ ${job.label}: no ${describe(st.filter)} in the discard.`, { kind: 'effect' }); return false; }
      const picked = pickFrom(s, job, st, 'fromDiscard', valid, { n: st.n, optional: !!st.may || !!st.upTo, prompt: `return ${describe(st.filter)} from your discard to your hand.` });
      if (!picked) return null;
      job.ctx.it = picked;
      return each(picked, (iid) => { E.moveTo(s, iid, 'hand', ev, { reveal: true }); log(s, `↳ ${nameOf(s, job.seat)} returned ${cardLabel(D(s, s.cards[iid]))} from their discard to their hand.`, { seat: job.seat, kind: 'effect' }); });
    },
    look(s, job, st, ev) {
      const p = P(s, job.seat);
      const T = (job.tmp.look ||= { cards: p.deck.slice(0, st.n) });
      if (!T.logged) {
        T.logged = true;
        log(s, `↳ ${nameOf(s, job.seat)} looked at the top ${plural(T.cards.length, 'card')} of their deck.`, { seat: job.seat, kind: 'effect', priv: { seat: job.seat, text: `↳ Top of your deck: ${T.cards.map((i) => cardLabel(D(s, s.cards[i]))).join(', ')}.` } });
      }
      if (st.scry) {
        if (T.cards.length <= 1) {
          if (!T.cards.length) return false;
          if (job.answer?.key === 'scry') {
            const a = job.answer; job.answer = null;
            if (!a.skip) { E.moveTo(s, T.cards[0], 'deckBottom', ev); log(s, `↳ ${nameOf(s, job.seat)} put it on the bottom of their deck.`, { kind: 'effect' }); }
            else log(s, `↳ ${nameOf(s, job.seat)} left it on top of their deck.`, { kind: 'effect' });
            return true;
          }
          job.waitKey = 'scry';
          return ask(s, job, { confirm: true, optional: true, op: 'scry', cards: [{ iid: T.cards[0], cardId: s.cards[T.cards[0]].cardId }], prompt: `put ${cardLabel(D(s, s.cards[T.cards[0]]))} on the bottom of your deck? (No = keep it on top)` });
        }
        const top = pickFrom(s, job, st, 'scryTop', T.cards, { n: 1, optional: false, prompt: 'choose the card to keep on top (the other goes to the bottom).' });
        if (!top) return null;
        for (const iid of T.cards) if (!top.includes(iid)) E.moveTo(s, iid, 'deckBottom', ev);
        return true;
      }
      let picked = [];
      if (st.pick) {
        const valid = T.cards.filter((iid) => s.cards[iid].zone === 'deck' && matches(s, { ...st.pick.filter, zone: 'deck' }, s.cards[iid], job.seat, job.src));
        picked = pickFrom(s, job, st, 'lookPick', valid, { n: st.pick.n, optional: !!st.pick.may, prompt: `put ${st.pick.n > 1 ? `up to ${st.pick.n}` : 'a'} ${describe(st.pick.filter) || 'card'} into your hand.` });
        if (!picked) return null;
        for (const iid of picked) {
          E.moveTo(s, iid, 'hand', ev, { reveal: !!st.pick.reveal });
          log(s, `↳ ${nameOf(s, job.seat)} put ${st.pick.reveal ? cardLabel(D(s, s.cards[iid])) : 'a card'} into their hand.`, { seat: job.seat, kind: 'effect', priv: { seat: job.seat, text: `↳ You put ${cardLabel(D(s, s.cards[iid]))} into your hand.` } });
        }
      }
      const rest = T.cards.filter((iid) => !picked.includes(iid) && s.cards[iid].zone === 'deck');
      if (st.rest === 'bottom') for (const iid of rest) E.moveTo(s, iid, 'deckBottom', ev);
      if (st.rest === 'discard') for (const iid of rest) E.moveTo(s, iid, 'discard', ev);
      job.ctx.it = picked;
      return picked.length > 0 || !st.pick;
    },
    payInk(s, job, st) {
      const n = amount(s, job, st.n);
      if (E.readyInk(s, job.seat) < n) { log(s, `↳ ${job.label}: not enough ink to pay ${n}.`, { kind: 'effect' }); return false; }
      E.payInk(s, job.seat, n);
      log(s, `↳ ${nameOf(s, job.seat)} paid ${n} ink.`, { seat: job.seat, kind: 'effect' });
      return true;
    },
    chooseOne(s, job, st) {
      if (job.answer?.key === 'chooseOne') {
        const k = job.answer.option; job.answer = null;
        job.steps.splice(job.i + 1, 0, ...clone(st.options[k]));
        log(s, `↳ ${nameOf(s, job.seat)} chose: ${st.labels?.[k] || `option ${k + 1}`}.`, { seat: job.seat, kind: 'effect' });
        return true;
      }
      job.waitKey = 'chooseOne';
      return ask(s, job, { op: 'chooseOne', choices: st.labels || st.options.map((o, k) => `Option ${k + 1}`), prompt: 'choose one.' });
    },
    playFree(s, job, st, ev) {
      const valid = P(s, job.seat)[st.filter.zone || 'hand'].filter((iid) => matches(s, st.filter, s.cards[iid], job.seat, job.src));
      if (!valid.length) { log(s, `↳ ${job.label}: nothing to play for free.`, { kind: 'effect' }); return false; }
      const picked = pickFrom(s, job, st, 'playFree', valid, { n: 1, optional: !!st.may, prompt: `play ${describe(st.filter)} for free.` });
      if (!picked) return null;
      job.ctx.it = picked;
      return each(picked, (iid) => E.playFree(s, job.seat, iid, ev));
    },
    costMod(s, job, st) {
      P(s, job.seat).costMods.push({ n: st.n, filter: st.filter, next: !!st.next, turn: s.turn, src: job.label });
      log(s, `↳ ${nameOf(s, job.seat)} pays ${st.n} ink less for the next ${describe(st.filter)} this turn.`, { seat: job.seat, kind: 'effect' });
      return true;
    },
    shuffle(s, job, st, ev) { E.shuffleArr(s, P(s, job.seat).deck); ev.push({ k: 'shuffle', seat: job.seat }); return true; },
    // internal: challenge damage happens after the challenge triggers resolve (CR 4.6.5–4.6.6)
    _challengeDamage(s, job, st, ev) { E.challengeDamageStep(s, st.a, st.t, ev); return true; },
    _endTurn(s, job, st, ev) { E.finishEndTurn(s, st.seat, ev); return true; },
  };
  for (const f of SUPPORT.fn) if (!FN[f]) throw new Error(`support.js lists fn "${f}" but runtime.js has no executor`);

  function verbOf(s, job, st) {
    switch (st.fn) {
      case 'damage': return `deal ${typeof st.n === 'number' ? st.n : 'that much'} damage`;
      case 'heal': return `remove up to ${st.n} damage`;
      case 'banish': return 'banish';
      case 'toHand': return 'return to hand';
      case 'toDeckBottom': return 'put on the bottom of the deck';
      case 'toInkwell': return 'put into the inkwell';
      case 'exert': return 'exert';
      case 'ready': return 'ready';
      case 'mod': return modText(s, st, job);
      default: return st.fn;
    }
  }

  // ------------------------------------------------------------ the pump

  function stepText(s, job, st) {
    switch (st.fn) {
      case 'draw': return `draw ${plural(amount(s, job, st.n), 'card')}`;
      case 'gainLore': return `gain ${amount(s, job, st.n)} lore`;
      case 'payInk': return `pay ${st.n} ink`;
      case 'discard': return `discard ${plural(st.n, 'card')}`;
      case 'look': return `look at the top ${plural(st.n, 'card')} of your deck`;
      case 'inkTop': return 'put the top card of your deck into your inkwell';
      case 'mill': return `put the top ${plural(st.n, 'card')} of your deck into your discard`;
      case 'fromDiscard': return `return ${describe(st.filter)} from your discard`;
      case 'playFree': return `play ${describe(st.filter)} for free`;
      default: return verbOf(s, job, st);
    }
  }
  const choosesTarget = (st) => (st.sel && st.sel.chosen) || ['fromDiscard', 'playFree'].includes(st.fn);

  function pump(s, ev) {
    s.fx ||= [];
    for (let guard = 0; guard < 500 && !s.pending && s.fx.length && s.status === 'playing'; guard++) {
      const job = s.fx[0];
      if (job.i === 0 && job.cond !== undefined && !job.condChecked) {
        job.condChecked = true;
        if (job.cond && !test(s, job.cond, job.seat, job.src, job)) { s.fx.shift(); continue; }
      }
      const st = job.steps[job.i];
      if (!st) { s.fx.shift(); continue; }
      const skip = () => { job.i++; job.tmp = {}; job.answer = null; };
      // gates
      if ((st.linked && job.ctx.declined) || (st.ifDid && !job.ctx.did) || (st.otherwise && job.ctx.did)) { job.ctx.did = false; skip(); continue; }
      if (st.cond && !test(s, st.cond, job.seat, job.src, job)) { job.ctx.did = false; job.ctx.declined = false; skip(); continue; }
      // "you may …" without a target choice → yes/no first
      if (st.may && !choosesTarget(st) && !job.tmp.mayOk) {
        if (job.answer?.key === 'may') {
          const a = job.answer; job.answer = null;
          if (a.skip) { log(s, `↳ ${nameOf(s, job.seat)} chose not to (${job.label}).`, { seat: job.seat, kind: 'effect' }); job.ctx.did = false; job.ctx.declined = true; skip(); continue; }
          job.tmp.mayOk = true;
        } else {
          job.waitKey = 'may';
          ask(s, job, { confirm: true, optional: true, op: st.fn, prompt: `${stepText(s, job, st)}?` });
          return;
        }
      }
      const r = FN[st.fn](s, job, st, ev);
      if (r === null) return;                                  // waiting on a choice
      const declined = st.may && choosesTarget(st) && Object.values(job.tmp).some((t) => t && t.done && !t.acc?.length);
      job.ctx.did = !!r;
      job.ctx.declined = declined;
      if (declined) log(s, `↳ ${nameOf(s, job.seat)} chose not to (${job.label}).`, { seat: job.seat, kind: 'effect' });
      skip();
      E.gameStateCheck(s, ev);
    }
  }

  // H.choose → record the answer on the job; the pump re-enters the waiting step.
  function answer(s, seat, a) {
    const pend = s.pending;
    if (!pend || pend.type !== 'choose' || pend.seat !== seat) throw E.RE('There is nothing for you to choose right now.');
    const job = s.fx[0];
    if (!job) throw E.RE('Nothing is resolving.');
    if (pend.choices) {
      const k = Math.trunc(Number(a.option));
      if (!(k >= 0 && k < pend.choices.length)) throw E.RE('Pick one of the options.');
      job.answer = { key: job.waitKey, option: k };
    } else if (pend.confirm) {
      job.answer = { key: job.waitKey, skip: !!a.skip };
    } else if (a.skip) {
      if (!pend.optional) throw E.RE("This isn't optional — pick one of the highlighted cards.");
      job.answer = { key: job.waitKey, skip: true };
    } else {
      if (!pend.valid.includes(a.target)) throw E.RE('Pick one of the highlighted cards.');
      job.answer = { key: job.waitKey, target: a.target };
    }
    s.pending = null;
  }

  // ------------------------------------------------------------ statics, costs, activated

  function statics(s) {
    for (const p of s.players) for (const iid of p.play) {
      const c = s.cards[iid];
      if (c.mods.some((m) => m.until === 'static')) c.mods = c.mods.filter((m) => m.until !== 'static');
    }
    for (const p of s.players) for (const iid of p.play) {
      const c = s.cards[iid];
      procsOf(D(s, c)).forEach((proc) => {
        if (proc.kind !== 'static' || !proc.exec || proc.effect.fn !== 'mod') return;
        if (!duringOk(s, proc, c.owner) || !test(s, proc.cond, c.owner, c.iid)) return;
        const st = proc.effect;
        const job = { seat: c.owner, src: c.iid, label: labelOf(s, c, proc), ctx: { it: [] }, tmp: {} };
        const ids = st.sel.self ? [c.iid] : st.sel.all ? candidates(s, st.sel.all, c.owner, c.iid) : [];
        const mult = st.per ? count(s, st.per, c.owner, c.iid) : 1;
        for (const id of ids) addMods(s, job, st, id, null, mult);
      });
    }
  }

  // Ink cost change for playing `c` (in hand) — its own "you pay N less" plus board/effect cost mods.
  function costDelta(s, seat, c, consume = false) {
    const d = D(s, c);
    let delta = 0;
    procsOf(d).forEach((proc) => {
      if (proc.kind === 'static' && proc.exec && proc.effect.fn === 'selfCost' && test(s, proc.cond, seat, c.iid)) {
        delta -= proc.effect.n * (proc.effect.per ? count(s, proc.effect.per, seat, c.iid) : 1);
      }
      if (proc.kind === 'action' && proc.playCost && proc.exec && test(s, proc.playCost.cond, seat, c.iid)) delta -= proc.playCost.n;
    });
    for (const iid of P(s, seat).play) {
      const src = s.cards[iid];
      procsOf(D(s, src)).forEach((proc) => {
        if (proc.kind === 'static' && proc.exec && proc.effect.fn === 'costMod' && duringOk(s, proc, seat) && test(s, proc.cond, seat, iid)
          && matches(s, proc.effect.filter, c, seat, iid, { anyZone: true })) delta -= proc.effect.n;
      });
    }
    const p = P(s, seat);
    p.costMods = (p.costMods || []).filter((m) => m.turn === s.turn);
    for (const m of [...p.costMods]) {
      if (!matches(s, m.filter, c, seat, null, { anyZone: true })) continue;
      delta -= m.n;
      if (consume && m.next) p.costMods.splice(p.costMods.indexOf(m), 1);
    }
    return delta;
  }

  function onEnter(s, c) {
    for (const proc of procsOf(D(s, c))) {
      if (proc.kind === 'static' && proc.exec && proc.effect.fn === 'enters') {
        if (proc.effect.exerted) c.exerted = true;
        if (proc.effect.damage) c.damage += proc.effect.damage;
      }
    }
  }

  // Activated ability with a compiled proc → pay costs and queue it. Returns false if the proc isn't runnable.
  function activate(s, seat, c, index, ev) {
    const d = D(s, c);
    const proc = procsOf(d)[index];
    if (!proc || proc.kind !== 'activated' || !proc.exec) return false;
    const cost = proc.cost;
    if (proc.once) { c.once ||= {}; if (c.once[index] === s.turn) throw E.RE('This ability can only be used once per turn.'); }
    if (cost.exert) {
      if (d.type === 'location') throw E.RE("Locations can't exert.");
      if (c.exerted) throw E.RE('It is exerted — this ability costs ⟳.');
      if (d.type === 'character' && c.drying) throw E.RE("Characters can't ⟳ the turn they're played (drying).");
    }
    if (cost.discard && !P(s, seat).hand.some((iid) => matches(s, { ...cost.discard, zone: 'hand' }, s.cards[iid], seat, c.iid))) throw E.RE('You have no card to discard for this cost.');
    E.payInk(s, seat, cost.ink || 0);
    const paid = [];
    if (cost.exert) { c.exerted = true; paid.push('⟳'); }
    if (cost.ink) paid.push(`${cost.ink} ink`);
    if (proc.once) c.once[index] = s.turn;
    const label = labelOf(s, c, proc);
    log(s, `${nameOf(s, seat)} used ${cardLabel(d)}'s ${proc.name || 'ability'}${paid.length ? ` (paid ${paid.join(' + ')})` : ''}.`, { seat, kind: 'play' });
    ev.push({ k: 'ability', iid: c.iid, index });
    const steps = [...(cost.discard ? [{ fn: 'discard', who: 'you', n: 1, filter: cost.discard }] : []), ...proc.do];
    if (cost.banishSelf) { log(s, `↳ ${cardLabel(d)} was banished to pay for it.`, { kind: 'effect' }); E.banish(s, c.iid, ev, 'cost'); }
    queue(s, seat, c.iid, label, steps);
    return true;
  }

  // An action/song from hand: queue its compiled procs (all must be runnable) — else false (manual)
  function castAction(s, seat, c) {
    const procs = procsOf(D(s, c)).filter((p) => p.kind !== 'reminder' && p.kind !== 'keyword');
    if (!procs.length || !procs.every((p) => p.exec && p.kind === 'action')) return false;
    queue(s, seat, c.iid, cardLabel(D(s, c)), procs.flatMap((p) => p.do));
    return true;
  }

  function endOfTurnCleanup(s, seat) {
    for (const p of s.players) for (const iid of p.play) {
      const c = s.cards[iid];
      if (c.mods.length) c.mods = c.mods.filter((m) => m.until !== 'eot' && !(m.until === 'theirNext' && m.by === seat && s.turn > m.setTurn));
    }
    P(s, seat).costMods = [];
  }

  return { fire, pump, answer, statics, costDelta, onEnter, activate, castAction, queue, endOfTurnCleanup, matches, candidates, test, FN };
}

// Human description of a filter ("damaged opposing Villain character with cost 3 or less")
export function describe(F = {}) {
  const bits = [];
  if (F.other) bits.push('other');
  if (F.owner === 'opp') bits.push('opposing');
  if (F.damaged) bits.push('damaged');
  if (F.undamaged) bits.push('undamaged');
  if (F.exerted) bits.push('exerted');
  if (F.ready) bits.push('ready');
  if (F.classes) bits.push(F.classes.map((k) => k.replace(/\b\w/g, (x) => x.toUpperCase())).join('/'));
  bits.push(F.types ? F.types.join(' or ') : 'card');
  if (F.owner === 'you') bits.push('of yours');
  if (F.named) bits.push(`named ${F.named.join(' or ')}`);
  const r = (x) => (x.lte != null ? `${x.lte} or less` : `${x.gte} or more`);
  if (F.cost) bits.push(`with cost ${r(F.cost)}`);
  if (F.str) bits.push(`with ${r(F.str)} ⚔️`);
  if (F.wp) bits.push(`with ${r(F.wp)} 🛡️`);
  if (F.kw) bits.push(`with ${F.kw}`);
  if (F.here) bits.push('here');
  return bits.join(' ');
}
