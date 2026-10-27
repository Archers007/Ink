// Ink ▸ Play — glue between the lobby UI, the socket, and the 3D board.
import { Net } from './net.js';
import { Board } from './board.js';
import { IMG } from './textures.js';
import { install, installable } from '../pwa.js';
import * as account from '../account.js';
import {
  LORE_TO_WIN, KEYWORD_HELP, KEYWORD_LABEL, cardLabel, prettyText, effectiveKeywords,
  questBlocker, attackerBlocker, defenderBlocker, challengeDamage, singerBlocker, singValue,
  shiftOptions, shiftTargetOk, shiftOntoOk, shiftOntoCount, shiftDiscardOk, parseActivatedCost, hasKw,
} from './rules.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAME_KEY = 'ink.play.name';
const DECK_KEY = 'ink.play.deck';

const S = {
  welcome: false,
  name: localStorage.getItem(NAME_KEY) || '',
  room: null,
  view: null,
  defs: {},
  demoDecks: [],
  chat: [],
  selected: null,       // iid of inspected card
  targeting: null,      // { prompt, valid:Set, multi, picked:Set, onPick, onDone, color }
  publicRooms: [],
  logSeen: 0,
  conn: 'connecting',
  myDecks: [],          // the builder's decks: the account's when signed in, else this browser's
  deckInfo: {},         // tile id → { size, inks, legal, problems, cover } (/api/play/deck-check)
  quickBot: false,      // "Play … vs bot": seat the deck, ready up and start as soon as the room exists
};

// ---------- network ----------
const net = new Net({
  onStatus(st) { S.conn = st; renderTopbar(); },
  onMessage(m) {
    switch (m.t) {
      case 'welcome':
        S.welcome = true;
        S.demoDecks = m.demoDecks || [];
        if (!S.name && m.name && m.name !== 'Player') S.name = m.name;
        maybeAutoJoin();
        refreshDecks();
        break;
      case 'room':
        S.room = m.room;
        if (m.room?.code) {
          const u = new URL(location.href);
          if (u.searchParams.get('room') !== m.room.code) { u.searchParams.set('room', m.room.code); history.replaceState(null, '', u); }
        } else {
          const u = new URL(location.href); u.searchParams.delete('room'); history.replaceState(null, '', u);
          S.view = null; board.render(null, {});
        }
        if (S.quickBot && m.room?.you >= 0 && !m.room.game) {
          S.quickBot = false;
          const d = deckChoice(chosenDeck());
          if (d) { net.send({ t: 'setDeck', deck: { name: d.name, cards: d.cards } }); net.send({ t: 'ready', ready: true }); net.send({ t: 'start' }); }
        }
        renderLobby(); renderAll();
        break;
      case 'game':
        Object.assign(S.defs, m.defs || {});
        if (!m.view) { S.view = null; board.render(null, {}); clearTargeting(); S.selected = null; renderAll(); renderLobby(); break; }
        S.view = m.view;
        board.render(S.view, S.defs, m.events || []);
        validateUi();
        renderAll();
        renderLobby();
        break;
      case 'err':
        if (m.rid == null) toast(m.msg, 'err');
        break;
      case 'chat':
        S.chat.push(m); if (S.chat.length > 100) S.chat.shift();
        renderChat();
        break;
      case 'rooms':
        S.publicRooms = m.rooms || [];
        renderLobby();
        break;
    }
  },
});
net.name = S.name;

let autoJoined = false;
function maybeAutoJoin() {
  const code = new URL(location.href).searchParams.get('room');
  if (autoJoined || !code) return;
  autoJoined = true;
  // hello already resumed us if we were seated; otherwise join (needs a name)
  setTimeout(() => {
    if (S.room?.code === code) return;
    if (!S.name) { $('#joinCode').value = code; $('#nameInput')?.focus(); toast('Pick a name, then hit Join to enter the room.'); return; }
    net.send({ t: 'join', code, name: S.name });
  }, 150);
}

async function act(a, { quiet = false } = {}) {
  const r = await net.act(a);
  if (!r.ok && !quiet) {
    if (/^Reckless/.test(r.error) && a.type === 'endTurn') {
      if (confirm(`${r.error}\n\nEnd your turn anyway?`)) return act({ ...a, force: true });
    } else toast(r.error, 'err');
  }
  return r;
}

// ---------- board ----------
const board = new Board($('#board'), {
  onClickCard: (info, ev) => clickCard(info, ev),
  onClickZone: (z) => clickZone(z),
  onClickEmpty: () => { if (!S.targeting) select(null); },
  onLongPress: (info) => { if (!S.targeting && info.iid) openDetails(info.iid); },   // hold a card → the full breakdown
  onDragStart: () => { if (S.quick) select(null); },                                  // the strip would float over a moving card
  onHover: (info) => hoverPreview(info),
  canDrag: (info) => canDrag(info),
  onDrop: (d) => dropCard(d),
});

// ---------- view helpers ----------
const V = () => S.view;
const you = () => V()?.you ?? -1;
const me = () => V()?.players[you()] || null;
const opp = () => V()?.players.find((p) => p.seat !== you()) || null;
const D = (cardId) => S.defs[cardId];
const myTurn = () => V()?.status === 'playing' && V().active === you() && !V().pending;
const readyInk = () => me()?.inkReady ?? 0;

function findCard(iid) {
  const v = V();
  if (!v || !iid) return null;
  for (const p of v.players) {
    const h = p.hand?.find((c) => c.iid === iid);
    if (h) return { c: h, def: D(h.cardId), zone: 'hand', seat: p.seat };
    const pl = p.play.find((c) => c.iid === iid);
    if (pl) return { c: pl, def: D(pl.cardId), zone: 'play', seat: p.seat };
    const ds = p.discard.find((c) => c.iid === iid);
    if (ds) return { c: ds, def: D(ds.cardId), zone: 'discard', seat: p.seat };
    const pk = p.peek?.find((c) => c.iid === iid);
    if (pk) return { c: pk, def: D(pk.cardId), zone: 'peek', seat: p.seat };
  }
  return null;
}
const sideOf = (seat) => V().players[seat].play.map((c) => ({ card: c, def: D(c.cardId) }));
const myChars = () => me().play.filter((c) => D(c.cardId)?.type === 'character');

// ---------- selection + targeting ----------
// tapping a hand card shows the quick options above it (S.quick); holding it, or ⓘ, opens the full breakdown
function select(iid) {
  S.selected = iid;
  if (iid) $('#preview').hidden = true;                                   // the panel shows it — no second copy from the hover preview
  board.setUi({ selected: iid });
  renderInspector();
}
function openDetails(iid) {
  S.quick = false;
  navigator.vibrate?.(8);
  select(iid);
}
function startTargeting(t) {
  S.targeting = { picked: new Set(), color: 0x6fa8ff, ...t };
  if (!S.targeting.valid.size) { toast('No valid targets.', 'err'); S.targeting = null; return; }
  board.setUi({ targets: S.targeting.valid, multi: S.targeting.picked, targetColor: S.targeting.color });
  $('#inspector').hidden = true;
  renderBanner();
}
function clearTargeting() {
  S.targeting = null;
  board.setUi({ targets: new Set(), multi: new Set() });
  renderBanner();
  renderInspector();
}
function validateUi() {
  if (S.selected && !findCard(S.selected)) S.selected = null;
  if (S.targeting) {
    for (const iid of S.targeting.valid) if (!findCard(iid)) S.targeting.valid.delete(iid);
    if (!S.targeting.valid.size) clearTargeting();
  }
  // Support is a server-side pending choice; drive it with targeting
  const pend = V()?.pending;
  if (pend?.type === 'support' && pend.seat === you() && !S.targeting) {
    const from = findCard(pend.from);
    const valid = new Set(V().players.flatMap((p) => p.play
      .filter((c) => D(c.cardId)?.type === 'character' && c.iid !== pend.from && (p.seat === you() || !hasKw(c, D(c.cardId), 'ward')))
      .map((c) => c.iid)));
    startTargeting({
      pendKey: 'support',
      prompt: `Support — ${from ? cardLabel(from.def) : 'your character'} quested. Add its ⚔️ ${from?.c.eff?.str ?? ''} to another character this turn?`,
      valid, skipLabel: 'Skip Support',
      onPick: (iid) => { clearTargeting(); act({ type: 'support', target: iid }); },
      onCancel: () => act({ type: 'support' }),
    });
  }
  // Automated card abilities: the server sends the legal choices
  const key = pend?.type === 'choose' ? `${pend.src}|${pend.op}|${pend.prompt}|${(pend.valid || []).join(',')}` : null;
  if (S.targeting?.pendKey?.startsWith('choose') && S.targeting.pendKey !== 'choose:' + key) clearTargeting();
  // options ("Choose one") and off-board picks (deck / discard / hand) use the banner, not 3D targeting
  if (key && pend.seat === you() && !S.targeting && !pend.confirm && !pend.choices && !pend.cards) {
    startTargeting({
      pendKey: 'choose:' + key,
      prompt: pend.prompt,
      valid: new Set(pend.valid),
      color: pend.harmful ? 0xff8f86 : 0x6fa8ff,
      skipLabel: pend.optional ? 'Skip' : null,
      mandatory: !pend.optional,
      onPick: (iid) => { clearTargeting(); act({ type: 'choose', target: iid }); },
      onCancel: () => act({ type: 'choose', skip: true }),
    });
  }
  if (key && pend.seat === you() && (pend.confirm || pend.choices || pend.cards)) renderBanner();
  board.setUi({ selected: S.selected });
}

function clickCard(info) {
  if (S.targeting) {
    const t = S.targeting;
    if (info.iid && t.valid.has(info.iid)) {
      if (t.multi) {
        t.picked.has(info.iid) ? t.picked.delete(info.iid) : t.picked.add(info.iid);
        board.setUi({ multi: t.picked });
        renderBanner();
      } else {
        clearTargeting();
        t.onPick(info.iid);
      }
    } else toast('Not a valid choice — pick a glowing card, or press Esc to cancel.');
    return;
  }
  if (info.zone === 'discard') { openDiscard(info.seat); return; }
  if (info.zone === 'inkwell') { toast(`${V().players[info.seat].name}'s inkwell: ${V().players[info.seat].inkReady} ready of ${V().players[info.seat].inkTotal}.`); return; }
  if (info.zone === 'under') { if (info.parent) select(info.parent); return; }
  if (!info.iid) {
    if (info.zone === 'hand') toast(`${V().players[info.seat].name} has ${V().players[info.seat].handCount} cards in hand.`);
    return;
  }
  if (S.selected === info.iid) { select(null); return; }
  S.quick = info.zone === 'hand' && info.seat === you();                 // my hand: options first, details on hold / ⓘ
  select(info.iid);
}
function clickZone(z) {
  if (S.targeting) return;
  if (z.zone === 'discard') openDiscard(z.seat);
  else if (z.zone === 'deck' && z.seat === you()) openTools();
  else if (z.zone === 'deck') toast(`${V().players[z.seat].name}'s deck: ${V().players[z.seat].deckCount} cards.`);
  else if (z.zone === 'lore') toast(`${V().players[z.seat].name}: ${V().players[z.seat].lore} / ${LORE_TO_WIN} lore.`);
}

function canDrag(info) {
  if (!myTurn() || S.targeting || info.seat !== you() || !info.iid) return false;
  if (info.zone === 'hand') return true;
  return info.zone === 'play' && D(info.cardId)?.type === 'character';
}
// Shift by its spec: pick what it goes on top of (one card, or two for Duo / Combo), then any discard cost, then play
function startShift(iid, def, opt, onto = null) {
  const shift = shiftOptions(def).findIndex((o) => o.spec === opt.spec);
  const play = (targets, discard, bottom) => act({ type: 'play', iid, mode: 'shift', shift, targets, ...(discard ? { discard } : {}), ...(bottom ? { bottom } : {}) });
  const pay = (targets) => {
    const cost = opt.spec.cost;
    if (cost.bottomFromDiscard != null) {                               // "put 5 character cards from your discard on the bottom of your deck in any order"
      const pool = me().discard.filter((x) => !cost.type || D(x.cardId)?.type === cost.type);
      const order = [];
      openModal(`<h3>${esc(opt.label)}: choose ${cost.bottomFromDiscard} ${esc(cost.type || '')} cards</h3><p class="muted">They go on the bottom of your deck in the order you pick them.</p>
        <div class="disc">${pool.map((x) => `<div class="dc"><img src="${IMG(x.cardId)}" alt="${esc(cardLabel(D(x.cardId)))}"><div class="dca"><button class="sm" data-b="${x.iid}">pick</button></div></div>`).join('')}</div>
        <div class="modal-actions"><span id="bN">0 / ${cost.bottomFromDiscard}</span><button id="bGo" disabled>Shift</button><button data-close>Cancel</button></div>`, (el) => {
        el.querySelectorAll('[data-b]').forEach((b) => b.onclick = () => {
          const i = order.indexOf(b.dataset.b);
          if (i >= 0) order.splice(i, 1); else if (order.length < cost.bottomFromDiscard) order.push(b.dataset.b);
          el.querySelectorAll('[data-b]').forEach((x) => { const k = order.indexOf(x.dataset.b); x.textContent = k >= 0 ? `#${k + 1}` : 'pick'; });
          $('#bN').textContent = `${order.length} / ${cost.bottomFromDiscard}`; $('#bGo').disabled = order.length !== cost.bottomFromDiscard;
        });
        $('#bGo').onclick = () => { closeModal(); play(targets, null, [...order]); };
      });
      return;
    }
    if (cost.discard == null) return play(targets);
    const valid = new Set(me().hand.filter((h) => h.iid !== iid && shiftDiscardOk({ spec: { cost: { ...cost, discard: 1 } } }, [D(h.cardId)])).map((h) => h.iid));
    startTargeting({
      prompt: `${opt.label}: ${opt.cost} from your hand.`, valid, multi: true, doneLabel: 'Discard & shift',
      status: (picked) => `${picked.size} / ${cost.discard}`,
      onDone: (picked) => (shiftDiscardOk(opt, [...picked].map((x) => D(findCard(x).c.cardId))) ? play(targets, [...picked]) : toast(`Pick exactly ${cost.discard}.`, 'err')),
    });
  };
  const [lo, hi] = shiftOntoCount(opt);
  if (onto && lo === 1) return pay([onto]);
  const valid = new Set(me().play.filter((t) => shiftTargetOk(opt, def, D(t.cardId))).map((t) => t.iid));
  const what = opt.spec.onto.by === 'item' ? 'item' : 'character';
  if (hi === 1) return startTargeting({ prompt: `Choose a ${what} to shift ${def.name} onto (${opt.label}).`, valid, onPick: (t) => pay([t]) });
  startTargeting({
    prompt: `${opt.label}: choose ${lo === 2 ? 'two characters, one of each name' : 'one character, or two — one of each name'}.`,
    valid, multi: true, doneLabel: 'Shift', status: (picked) => `${picked.size} / ${hi}`,
    onDone: (picked) => {
      const ts = [...picked];
      if (!shiftOntoOk(opt, def, ts.map((x) => D(findCard(x).c.cardId)))) return toast(`${opt.label} can't go on top of those.`, 'err');
      pay(ts);
    },
  });
  if (onto) { S.targeting?.picked.add(onto); board.setUi({ multi: S.targeting?.picked }); renderBanner(); }
}

function dropCard({ info, over, point }) {
  const def = D(info.cardId);
  if (info.zone === 'hand') {
    const overInk = over?.zone === 'inkwell' && over.seat === you();
    const inInkArea = point && point.x > -45 && point.x < -25 && point.z > 10 && point.z < 24;
    if (overInk || inInkArea) { act({ type: 'ink', iid: info.iid }); return; }
    if (over?.iid && over.zone === 'play' && over.seat === you()) {
      const tgt = D(over.cardId);
      const opt = shiftOptions(def).find((o) => shiftTargetOk(o, def, tgt));
      if (opt) { startShift(info.iid, def, opt, over.iid); return; }
    }
    if (point && point.z > -2 && point.z < 26) {
      if (def.type === 'song') { select(info.iid); toast('Songs: pay ink with "Play", or pick "Sing with…" in the card panel.'); return; }
      act({ type: 'play', iid: info.iid, mode: 'ink' });
    }
    return;
  }
  if (info.zone === 'play' && over?.iid) {
    if (over.seat !== you() && over.zone === 'play') act({ type: 'challenge', attacker: info.iid, target: over.iid });
    else if (over.seat === you() && D(over.cardId)?.type === 'location') act({ type: 'move', iid: info.iid, location: over.iid });
  }
}

// ---------- actions for a card ----------
function actionsFor(found) {
  const { c, def, zone, seat } = found;
  const mine = seat === you();
  const turn = myTurn();
  const primary = [];
  const manual = [];
  const notTurn = 'Wait for your turn.';
  const P = (label, run, reason = null, extra = {}) => primary.push({ label, run, reason: turn ? reason : notTurn, ...extra });
  const M = (label, run, extra = {}) => manual.push({ label, run, ...extra });

  if (zone === 'hand' && mine) {
    const ink = readyInk();
    const lacking = (n) => (ink < n ? `Needs ${n} ink — you have ${ink} ready.` : null);
    if (def.type === 'song' || def.type === 'action' || def.type === 'item' || def.type === 'location' || def.type === 'character') {
      P(`Play  ·  ${def.cost} ⬡`, () => act({ type: 'play', iid: c.iid, mode: 'ink' }), lacking(def.cost), { hot: true });
    }
    const exertOpt = def.procs?.some((p) => p.kind === 'static' && p.effect?.fn === 'enterExertedOpt');   // "may enter play exerted [to …]"
    if (def.type === 'character' && (def.kw?.bodyguard || exertOpt)) {
      P(`Play exerted${def.kw?.bodyguard ? ' (Bodyguard)' : ''}  ·  ${def.cost} ⬡`, () => act({ type: 'play', iid: c.iid, mode: 'ink', enterExerted: true }), lacking(def.cost));
    }
    for (const opt of shiftOptions(def)) {
      const valid = me().play.filter((t) => shiftTargetOk(opt, def, D(t.cardId)));
      const cost = opt.spec.cost;
      const label = `${opt.label} onto…  ·  ${typeof opt.cost === 'number' ? `${opt.cost} ⬡` : opt.cost}`;
      const why = !valid.length ? `No ${opt.spec.onto.by === 'item' ? 'matching item' : 'matching character'} of yours in play.`
        : cost.ink != null ? lacking(cost.ink)
        : cost.inkDrops != null ? ((me().inkDrops || 0) < cost.inkDrops ? `Needs ${cost.inkDrops} ink drops — you have ${me().inkDrops || 0}.` : null)
        : cost.bottomFromDiscard != null ? (me().discard.filter((x) => !cost.type || D(x.cardId)?.type === cost.type).length < cost.bottomFromDiscard ? `Needs ${cost.bottomFromDiscard} ${cost.type || ''} cards in your discard.` : null)
        : me().hand.filter((h) => h.iid !== c.iid && shiftDiscardOk({ spec: { cost: { ...cost, discard: 1 } } }, [D(h.cardId)])).length < cost.discard ? `Needs ${opt.cost} in hand.` : null;
      P(label, () => startShift(c.iid, def, opt), why);
    }
    if (def.type === 'song') {
      const singers = new Set(myChars().filter((t) => !singerBlocker(t, D(t.cardId), def)).map((t) => t.iid));
      P('Sing with…  (free)', () => startTargeting({
        prompt: `Choose a character (cost ${def.cost}+) to exert and sing ${def.name}.`, valid: singers, color: 0xc7a2ff,
        onPick: (t) => act({ type: 'play', iid: c.iid, mode: 'sing', singers: [t] }),
      }), !singers.size ? `No ready, dry character with cost/Singer ${def.cost}+.` : null);
      if (def.kw?.singTogether) {
        const any = new Set(myChars().filter((t) => !singerBlocker(t, D(t.cardId), null)).map((t) => t.iid));
        P(`Sing Together ${def.kw.singTogether}…`, () => startTargeting({
          prompt: `Sing Together: choose characters with total cost ${def.kw.singTogether}+.`, valid: any, multi: true, color: 0xc7a2ff,
          doneLabel: 'Sing!',
          status: (picked) => `Total: ${[...picked].reduce((n, iid) => n + singValue(findCard(iid).c, findCard(iid).def), 0)} / ${def.kw.singTogether}`,
          onDone: (picked) => act({ type: 'play', iid: c.iid, mode: 'singTogether', singers: [...picked] }),
        }), !any.size ? 'No ready, dry characters.' : null);
      }
    }
    // "you may banish chosen item of yours to play this character for free" — the alternate cost
    (def.procs || []).forEach((p, i) => {
      if (p.kind !== 'activated' || p.from !== 'hand' || !p.exec) return;
      P('Play for free (alternate cost)…', () => act({ type: 'useAbility', iid: c.iid, index: i }), p.during === 'yours' && !turn ? 'Only during your turn.' : null, { title: prettyText(def.abilities[i]?.text || '') });
    });
    const inked = me().inkedThisTurn >= me().inkLimit;
    const inkable = def.inkable || me().rules?.handInkable;              // "All cards in your hand count as having {inkable}"
    P('Put into inkwell  ⬡', () => act({ type: 'ink', iid: c.iid }), !inkable ? 'No inkwell symbol — this card can\'t be inked.' : inked ? 'You already inked this turn.' : null);
    M('Play for free', () => act({ type: 'play', iid: c.iid, mode: 'free' }));
    M('Play with cost change…', () => {
      const n = prompt(`Cost adjustment for ${def.name} (e.g. -2 or 1):`, '-1');
      if (n != null && n.trim() !== '') act({ type: 'play', iid: c.iid, mode: 'ink', costAdjust: Number(n) });
    });
    M('Reveal to opponent', () => act({ type: 'reveal', iid: c.iid }));
    M('Discard', () => act({ type: 'moveCard', iid: c.iid, to: 'discard' }));
    M('Put on top of deck', () => act({ type: 'moveCard', iid: c.iid, to: 'deckTop' }));
    M('Put on bottom of deck', () => act({ type: 'moveCard', iid: c.iid, to: 'deckBottom' }));
    M('Inkwell (by effect, facedown)', () => act({ type: 'moveCard', iid: c.iid, to: 'inkwell' }));
  }

  if (zone === 'play') {
    const isChar = def.type === 'character';
    const isLoc = def.type === 'location';
    if (mine && isChar) {
      P(`Quest  ·  +${c.eff?.lore ?? def.lore} ◆`, () => act({ type: 'quest', iid: c.iid }), questBlocker(c, def), { hot: true });
      const why = attackerBlocker(c, def);
      const targets = new Set();
      for (const p of V().players) if (p.seat !== you()) for (const t of p.play) if (!defenderBlocker(c, def, t, D(t.cardId), sideOf(p.seat))) targets.add(t.iid);
      P('Challenge…  ⚔️', () => startTargeting({
        prompt: `Choose who ${def.name} challenges. (Damage preview on hover.)`, valid: targets, color: 0xff8f86,
        preview: (t) => { const f = findCard(t); const d = challengeDamage(c, def, f.c, f.def); return `${def.name} deals ${d.toDefender}, takes ${d.toAttacker}`; },
        onPick: (t) => act({ type: 'challenge', attacker: c.iid, target: t }),
      }), why || (!targets.size ? 'No valid targets — only exerted characters (or locations) can be challenged.' : null));
      for (const l of me().play.filter((x) => D(x.cardId)?.type === 'location' && x.iid !== c.atLocation)) {
        const ld = D(l.cardId);
        // a "move here for free / pay less to move" static changes the cost — the server works it out
        const discounted = me().play.some((x) => D(x.cardId)?.procs?.some((p) => p.kind === 'static' && p.exec && p.effect?.fn === 'moveCost'));
        P(`Move to ${ld.name}  ·  ${discounted ? '≤' : ''}${ld.move ?? 0} ⬡`, () => act({ type: 'move', iid: c.iid, location: l.iid }), !discounted && readyInk() < (ld.move ?? 0) ? `Needs ${ld.move} ink.` : null);
      }
    }
    if (mine && typeof def.kw?.boost === 'number') {
      P(`Boost ${def.kw.boost}  ·  ${def.kw.boost} ⬡`, () => act({ type: 'boost', iid: c.iid }),
        c.boostedTurn === V().turn ? 'Already boosted this turn.' : readyInk() < def.kw.boost ? `Needs ${def.kw.boost} ink.` : null);
    }
    if (mine) {
      def.abilities.forEach((ab, i) => {
        const cost = parseActivatedCost(ab.text);
        // an ability you use that isn't written "cost — effect" ("Once during your turn, you may move him …" · "you may
        // banish this location to …")
        const proc = def.procs?.[i];
        if (!cost && proc?.kind === 'activated' && proc.exec && proc.from !== 'hand') {
          const parts = [proc.cost.exert ? '⟳' : '', proc.cost.ink ? `${proc.cost.ink} ⬡` : '', proc.cost.banishSelf ? 'banish this' : ''].filter(Boolean).join(' + ');
          const reason = proc.cost.ink > readyInk() ? `Needs ${proc.cost.ink} ink.` : null;   // the server checks once-per-turn and conditions
          P(`Use ${ab.name || 'ability'}${parts ? `  ·  ${parts}` : ''}`, () => act({ type: 'useAbility', iid: c.iid, index: i }), reason, { title: prettyText(ab.text) });
          return;
        }
        if (!cost) return;
        const parts = [cost.exert ? '⟳' : '', cost.ink ? `${cost.ink} ⬡` : ''].filter(Boolean).join(' + ');
        let reason = null;
        if (cost.exert && c.exerted) reason = 'Exerted.';
        else if (cost.exert && isChar && c.drying) reason = 'Still drying.';
        else if (cost.ink > readyInk()) reason = `Needs ${cost.ink} ink.`;
        P(`Use ${ab.name || 'ability'}  ·  ${parts}`, () => act({ type: 'useAbility', iid: c.iid, index: i }), reason, { title: prettyText(ab.text) });
      });
      // abilities granted by other cards ("your characters gain \"{exert} — Draw a card\" this turn")
      for (const g of c.granted || []) {
        const cost = g.kind === 'activated' && parseActivatedCost(g.text);
        if (!cost) continue;
        const parts = [cost.exert ? '⟳' : '', cost.ink ? `${cost.ink} ⬡` : ''].filter(Boolean).join(' + ');
        let reason = null;
        if (cost.exert && c.exerted) reason = 'Exerted.';
        else if (cost.exert && isChar && c.drying) reason = 'Still drying.';
        else if (cost.ink > readyInk()) reason = `Needs ${cost.ink} ink.`;
        P(`Use granted: ${prettyText(cost.effect).slice(0, 40)}  ·  ${parts}`, () => act({ type: 'useAbility', iid: c.iid, index: g.index }), reason, { title: `From ${g.src}: ${prettyText(g.text)}` });
      }
    }
    if (!mine && turn) {
      const attackers = new Set(myChars().filter((a) => !attackerBlocker(a, D(a.cardId)) && !defenderBlocker(a, D(a.cardId), c, def, sideOf(seat))).map((a) => a.iid));
      P('Challenge this with…  ⚔️', () => startTargeting({
        prompt: `Choose your character to challenge ${def.name}.`, valid: attackers, color: 0xff8f86,
        onPick: (a) => act({ type: 'challenge', attacker: a, target: c.iid }),
      }), !attackers.size ? (defenderBlocker(myChars()[0] || c, def, c, def, sideOf(seat)) || 'None of your characters can challenge it right now.') : null);
    }
    if (isChar || isLoc) {
      M('−1 damage', () => act({ type: 'damage', iid: c.iid, delta: -1 }), { small: true, disabled: !c.damage });
      M('+1 damage', () => act({ type: 'damage', iid: c.iid, delta: 1 }), { small: true });
    }
    if (!isLoc) M(c.exerted ? 'Ready' : 'Exert', () => act({ type: 'exert', iid: c.iid, exerted: !c.exerted }), { small: true });
    if (isChar) {
      M('⚔️ +1', () => act({ type: 'mod', iid: c.iid, stat: 'str', delta: 1 }), { small: true });
      M('⚔️ −1', () => act({ type: 'mod', iid: c.iid, stat: 'str', delta: -1 }), { small: true });
      M('🛡️ +1', () => act({ type: 'mod', iid: c.iid, stat: 'wp', delta: 1 }), { small: true });
      M('🛡️ −1', () => act({ type: 'mod', iid: c.iid, stat: 'wp', delta: -1 }), { small: true });
      M('◆ +1', () => act({ type: 'mod', iid: c.iid, stat: 'lore', delta: 1 }), { small: true });
      M('◆ −1', () => act({ type: 'mod', iid: c.iid, stat: 'lore', delta: -1 }), { small: true });
      M('Gains keyword…', () => grantKeyword(c, def), { small: true });
      if (c.mods?.length) M('Clear modifiers', () => act({ type: 'clearMods', iid: c.iid }), { small: true });
    }
    M('Banish → discard', () => act({ type: 'moveCard', iid: c.iid, to: 'discard' }));
    M("Return to owner's hand", () => act({ type: 'moveCard', iid: c.iid, to: 'hand' }));
    M('Top of deck', () => act({ type: 'moveCard', iid: c.iid, to: 'deckTop' }), { small: true });
    M('Bottom of deck', () => act({ type: 'moveCard', iid: c.iid, to: 'deckBottom' }), { small: true });
    M('Into inkwell', () => act({ type: 'moveCard', iid: c.iid, to: 'inkwell', exerted: true }), { small: true });
  }
  return { primary, manual };
}

function grantKeyword(c, def) {
  const keys = ['evasive', 'rush', 'ward', 'resist', 'challenger', 'support', 'bodyguard', 'reckless', 'alert', 'singer'];
  openModal(`<h3>${esc(def.name)} gains…</h3>
    <div class="kw-grid">${keys.map((k) => `<button data-k="${k}" title="${esc(KEYWORD_HELP[k])}">${KEYWORD_LABEL[k]}</button>`).join('')}</div>
    <label class="row">Amount (Resist/Challenger/Singer) <input id="kwAmt" type="number" value="1" min="1" max="10"></label>
    <label class="row"><input id="kwPerm" type="checkbox"> while in play (otherwise: this turn)</label>
    <div class="modal-actions"><button data-close>Cancel</button></div>`, (el) => {
    el.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => {
      const k = b.dataset.k;
      const amt = ['resist', 'challenger', 'singer'].includes(k) ? Math.max(1, Number($('#kwAmt', el).value) || 1) : 1;
      act({ type: 'mod', iid: c.iid, stat: 'kw', kw: k, delta: amt, until: $('#kwPerm', el).checked ? 'perm' : 'eot' });
      closeModal();
    });
  });
}

// ---------- DOM: inspector ----------
// the options fanned around a tapped hand card: what you can play it as, and ⓘ for the breakdown
const shortLabel = (l) => l.replace(/\s+·\s+/g, ' · ').replace(/\s{2,}/g, ' ')
  .replace(/^Put into inkwell/, 'Ink').replace(/^Play exerted \(Bodyguard\)/, 'Play exerted').replace(/^Sing with…\s*\(free\)/, 'Sing…')
  .replace(/^Shift onto…/, 'Shift…').replace(/^(\w[\w ]*Shift) onto…/, '$1…').replace(/^Play for free \(alternate cost\)…/, 'Play free…');
function renderQuick(f) {
  const el = $('#quick');
  const { primary } = actionsFor(f);
  el.innerHTML = `${primary.map((a, i) => `<button class="q ${a.hot ? 'hot' : ''} ${a.reason ? 'off' : ''}" data-q="${i}" title="${esc(a.reason || a.title || '')}">${esc(shortLabel(a.label))}</button>`).join('')}
    <button class="q info" data-info title="Full card breakdown (or hold the card)">ⓘ</button>`;
  el.querySelectorAll('[data-q]').forEach((b) => { b.onclick = () => { const a = primary[b.dataset.q]; if (a.reason) toast(a.reason); else a.run(); }; });
  el.querySelector('[data-info]').onclick = () => openDetails(f.c.iid);
  el.hidden = false;
  positionQuick(f.c.iid);
}
// pills along an arc over the card: the radius grows with their total width so they never overlap, the fan never
// wraps past the card's sides, and each pill leans with the curve
function positionQuick(iid) {
  const el = $('#quick');
  if (el.hidden) return;
  const a = board.cardAnchor(iid);
  if (!a) { el.hidden = true; return; }
  const pills = [...el.children];
  const gap = 10;
  const widths = pills.map((b) => b.offsetWidth);
  const total = widths.reduce((s, w) => s + w, 0) + gap * (pills.length - 1);
  const rBase = (a.center.y - a.top.y) + 24;                      // just outside the card's top edge
  let r = Math.max(rBase, total / (Math.PI * 0.7));
  r = Math.min(r, Math.max(60, a.center.y - 28));                 // the top pill stays on screen
  let ang = -total / (2 * r);
  pills.forEach((b, i) => {
    const w = widths[i];
    const mid = ang + (w / 2) / r;
    const x = a.center.x + r * Math.sin(mid);
    const y = a.center.y - r * Math.cos(mid);
    b.style.left = `${Math.max(8 + w / 2, Math.min(innerWidth - 8 - w / 2, x))}px`;
    b.style.top = `${Math.max(22, y)}px`;
    b.style.setProperty('--a', `${(mid * 0.45).toFixed(3)}rad`);
    ang += (w + gap) / r;
  });
}
function renderInspector() {
  const el = $('#inspector');
  const q = $('#quick');
  const f = findCard(S.selected);
  if (!f || !f.def || S.targeting) { el.hidden = true; q.hidden = true; return; }
  if (S.quick && f.zone === 'hand' && f.seat === you()) { el.hidden = true; renderQuick(f); return; }
  q.hidden = true;
  const { c, def, zone, seat } = f;
  const kws = zone === 'play' ? effectiveKeywords(c, def) : def.kw;
  const eff = c.eff || {};
  const stat = (icon, v, base) => v == null ? '' : `<span class="st ${v > base ? 'up' : v < base ? 'down' : ''}">${icon} ${v}</span>`;
  const stats = def.type === 'character'
    ? stat('⚔️', eff.str ?? def.str, def.str) + stat('🛡️', eff.wp ?? def.wp, def.wp) + stat('◆', eff.lore ?? def.lore, def.lore)
    : def.type === 'location' ? stat('🛡️', eff.wp ?? def.wp, def.wp) + stat('◆', eff.lore ?? def.lore, def.lore) + stat('⇢', def.move, def.move) : '';
  const status = zone === 'play' ? [
    c.exerted ? '<span class="chip ex">Exerted</span>' : (def.type !== 'location' ? '<span class="chip">Ready</span>' : ''),
    c.drying ? '<span class="chip dry">Drying</span>' : '',
    c.damage ? `<span class="chip dmg">${c.damage} damage</span>` : '',
    c.under?.length ? `<span class="chip">${c.under.length} card${c.under.length > 1 ? 's' : ''} under</span>` : '',
    ...(c.granted || []).map((g) => `<span class="chip mod" title="${esc(g.src || '')}">+“${esc(prettyText(g.text))}”${g.until === 'eot' ? ' (turn)' : ''}</span>`),
    ...(c.mods || []).map((m) => `<span class="chip mod">${m.stat === 'kw' ? `${m.delta > 0 ? '+' : '−'}${KEYWORD_LABEL[m.kw]}` : `${m.delta > 0 ? '+' : ''}${m.delta} ${{ str: '⚔️', wp: '🛡️', lore: '◆', sing: '♪' }[m.stat]}`}${m.until === 'eot' ? ' (turn)' : ''}</span>`),
  ].join('') : '';
  const { primary, manual } = actionsFor(f);
  const owner = V().players[seat].name;
  el.innerHTML = `
    <button class="x" data-close-insp title="Close (Esc)">✕</button>
    <div class="insp-imgwrap ${def.type === 'location' ? 'land' : ''}"><img class="insp-img" src="${IMG(def.id)}" alt=""></div>
    <div class="insp-body">
      <div class="insp-name">${esc(def.name)}${def.title ? `<small>${esc(def.title)}</small>` : ''}</div>
      <div class="insp-meta">
        <span class="cost ${def.inkable ? 'inkable' : ''}" title="${def.inkable ? 'Inkable' : 'Not inkable'}">${def.cost}</span>
        <span>${esc(def.type)}${def.classes?.length ? ' · ' + esc(def.classes.join(' · ')) : ''}</span>
        <span class="inks">${def.inks.map((i) => `<i class="ink ${i}" title="${i}"></i>`).join('')}</span>
      </div>
      ${stats ? `<div class="insp-stats">${stats}</div>` : ''}
      ${status ? `<div class="insp-status">${status}</div>` : ''}
      ${Object.keys(kws || {}).length ? `<div class="insp-kw">${Object.entries(kws).map(([k, v]) => `<span class="kw" title="${esc(KEYWORD_HELP[k] || '')}">${KEYWORD_LABEL[k] || k}${typeof v === 'number' && !['evasive', 'rush', 'ward', 'support', 'bodyguard', 'reckless', 'alert', 'vanish'].includes(k) ? ` ${['challenger', 'resist'].includes(k) ? '+' : ''}${v}` : ''}</span>`).join('')}</div>` : ''}
      ${def.abilities.length ? `<a class="insp-proc" href="/procs?card=${encodeURIComponent(def.full)}" target="_blank" rel="noopener" title="How the engine runs this card">⚡ proc</a>` : ''}
      ${def.abilities.length ? `<div class="insp-text">${def.abilities.map((a, i) => `<p${def.auto?.[i] ? ' class="auto" title="Resolved automatically by the game"' : ''}>${def.auto?.[i] ? '<i class="auto-tag">⚡ auto</i> ' : ''}${a.name ? `<b>${esc(a.name)}</b> ` : ''}${esc(prettyText(a.text))}</p>`).join('')}</div>` : ''}
      <div class="insp-owner">${esc(zone)} · ${esc(owner)}</div>
      ${primary.length ? `<div class="acts">${primary.map((a, i) => `<button class="act ${a.hot ? 'hot' : ''}" data-p="${i}" ${a.reason ? 'disabled' : ''} title="${esc(a.reason || a.title || '')}">${esc(a.label)}${a.reason ? `<small>${esc(a.reason)}</small>` : ''}</button>`).join('')}</div>` : ''}
      ${manual.length && V().status === 'playing' && you() >= 0 ? `<details class="manual" ${S.manualOpen ? 'open' : ''}><summary>Effects &amp; manual tools</summary><div class="mgrid">${manual.map((a, i) => `<button class="${a.small ? 'sm' : ''}" data-m="${i}" ${a.disabled ? 'disabled' : ''}>${esc(a.label)}</button>`).join('')}</div></details>` : ''}
    </div>`;
  el.hidden = false;
  el.querySelector('[data-close-insp]').onclick = () => select(null);
  el.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => primary[b.dataset.p].run());
  el.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => manual[b.dataset.m].run());
  const det = el.querySelector('details.manual');
  if (det) det.ontoggle = () => { S.manualOpen = det.open; };
}

// ---------- DOM: hover preview ----------
let hoverTimer = null;
function hoverPreview(info) {
  const el = $('#preview');
  clearTimeout(hoverTimer);
  if (S.targeting?.preview && info?.iid && S.targeting.valid.has(info.iid)) {
    $('#bannerPreview').textContent = S.targeting.preview(info.iid);
  } else if ($('#bannerPreview')) $('#bannerPreview').textContent = '';
  if (isMobile()) { el.hidden = true; return; }                                       // nothing hovers on a touch screen
  // hand cards already zoom in 3D; the inspector already shows the selected card
  if (!info?.cardId || (info.zone === 'hand' && info.seat === you()) || info.iid === S.selected) { el.hidden = true; return; }
  hoverTimer = setTimeout(() => {
    el.innerHTML = `<img src="${IMG(info.cardId)}" alt="" class="${D(info.cardId)?.type === 'location' ? 'land' : ''}">`;
    el.hidden = false;
  }, 120);
}

// ---------- DOM: HUD ----------
function plate(p, isMe) {
  if (!p) return '';
  const active = V().status === 'playing' && V().active === p.seat;
  const inks = Array.from({ length: p.inkTotal }, (_, i) => `<i class="${i < p.inkReady - (p.inkDrops || 0) ? 'on' : ''}"></i>`).join('');
  const pct = Math.min(100, (p.lore / LORE_TO_WIN) * 100);
  return `
    <div class="pl-head">
      <span class="dial ${isMe ? 'mine' : ''} ${p.lore >= 15 ? 'close' : ''}" style="--p:${pct}" title="Lore — first to ${LORE_TO_WIN} wins"><b>${p.lore}</b></span>
      <div class="pl-who"><span class="pl-name">${esc(p.name)}</span><span class="pl-sub">${p.lore} / ${LORE_TO_WIN} lore${V().starting === p.seat ? ' · <span class="first" title="Went first">1st</span>' : ''}</span></div>
      ${active ? '<span class="turn-tag">Turn</span>' : ''}
    </div>
    <div class="inkbar" title="Ink ready / total">${inks}<span class="ink-n">Ink <b>${p.inkReady}</b>/${p.inkTotal}${p.inkDrops ? ` <em title="Ink drops — each pays 1 ink">+${p.inkDrops}</em>` : ''}</span></div>
    <div class="counts">
      <span title="Cards in hand">Hand <b>${p.handCount}</b></span>
      <span title="Cards left in deck" class="${p.deckCount <= 5 ? 'warn' : ''}">Deck <b>${p.deckCount}</b></span>
      <span title="Discard pile" class="click" data-discard="${p.seat}">Discard <b>${p.discard.length}</b></span>
    </div>
    ${isMe && active ? `<div class="pl-note ${p.inkedThisTurn >= p.inkLimit ? 'ok' : ''}">${p.inkedThisTurn >= p.inkLimit ? '✓ Inked this turn' : 'You can ink 1 card'}</div>` : ''}
    ${p.deckTop ? `<div class="pl-note" title="Top card of the deck is face up">Top: ${esc(D(p.deckTop.cardId)?.full || D(p.deckTop.cardId)?.name || '?')}</div>` : ''}`;
}
function renderHud() {
  const v = V();
  const wasHidden = $('#hud').hidden;
  $('#hud').hidden = !v;
  $('#lobby').hidden = !!v;
  if (wasHidden !== !v) updateInsets();
  if (!v) return;
  const m = me() || v.players[0];
  const o = v.players.find((p) => p.seat !== m.seat);
  $('#plateMe').innerHTML = plate(m, you() >= 0);
  $('#plateOpp').innerHTML = plate(o, false);
  $('#plateMe').classList.toggle('active', v.status === 'playing' && v.active === m.seat);
  $('#plateOpp').classList.toggle('active', v.status === 'playing' && v.active === o?.seat);
  document.querySelectorAll('[data-discard]').forEach((b) => b.onclick = () => openDiscard(Number(b.dataset.discard)));
  const endBtn = $('#endTurn');
  endBtn.disabled = !myTurn();
  endBtn.textContent = v.status === 'over' ? 'Game over' : myTurn() ? 'End turn ⏎' : v.status === 'mulligan' ? 'Mulligan…' : v.pending ? 'Waiting…' : `${v.players[v.active].name}'s turn`;
  $('#toolsBtn').disabled = v.status !== 'playing' || you() < 0;
  renderTopbar();
  renderBanner();
}
function renderTopbar() {
  const el = $('#topbar');
  if (!el) return;
  const v = V();
  const r = S.room;
  const turn = v ? (v.status === 'mulligan' ? 'Mulligan' : v.status === 'over' ? 'Game over' : `Turn ${v.turn} · ${v.active === you() ? '<b class="mine">Your turn</b>' : esc(v.players[v.active].name) + "'s turn"}`) : '';
  el.innerHTML = `
    <a href="/" class="brand" title="Back to the deck builder">Ink ▸ Play</a>
    ${r ? `<span class="code" title="Room code">Room <b>${r.code}</b></span><button class="ghost" id="copyInvite">🔗 Copy invite</button>` : ''}
    <span class="turn">${turn}</span>
    <span class="conn ${S.conn}">${S.conn === 'online' ? '● online' : '○ reconnecting…'}</span>
    ${r?.spectators?.length ? `<span class="spec">👁 ${r.spectators.length}</span>` : ''}
    <a class="ghost" href="https://files.disneylorcana.com/CRUpdate_EN_Oct-2026.pdf" target="_blank" rel="noopener">📖 Rules</a>
    <button class="ghost" id="helpBtn">?</button>
    ${v && v.status !== 'over' && you() >= 0 ? '<button class="ghost danger" id="concedeBtn">Concede</button>' : ''}`;
  $('#copyInvite')?.addEventListener('click', copyInvite);
  $('#helpBtn')?.addEventListener('click', openHelp);
  $('#concedeBtn')?.addEventListener('click', () => { if (confirm('Concede this game?')) act({ type: 'concede' }); });
}
function renderBanner() {
  const el = $('#banner');
  const t = S.targeting;
  const v = V();
  if (t) {
    el.innerHTML = `<span>${esc(t.prompt)}</span>${t.status ? `<b>${esc(t.status(t.picked))}</b>` : ''}<span id="bannerPreview" class="pv"></span>
      ${t.multi ? `<button id="tDone" ${t.picked.size ? '' : 'disabled'}>${esc(t.doneLabel || 'Done')}</button>` : ''}
      ${t.mandatory ? '' : `<button id="tCancel" class="ghost">${esc(t.skipLabel || 'Cancel')} <kbd>Esc</kbd></button>`}`;
    el.hidden = false;
    $('#tCancel')?.addEventListener('click', cancelTargeting);
    $('#tDone')?.addEventListener('click', () => { const picked = new Set(t.picked); clearTargeting(); t.onDone(picked); });
    return;
  }
  const pd = v?.pending;
  if (pd?.type === 'choose' && pd.seat === you() && pd.choices && pd.choices.length > 8) {   // "Name a card": a long list
    el.innerHTML = `<span>${esc(pd.prompt)}</span><select id="pOpt">${pd.choices.map((c, i) => `<option value="${i}">${esc(c)}</option>`).join('')}</select><button id="pOk">OK</button>`;
    el.hidden = false;
    $('#pOk').onclick = () => act({ type: 'choose', option: +$('#pOpt').value });
    return;
  }
  if (pd?.type === 'choose' && pd.seat === you() && pd.choices) {
    el.innerHTML = `<span>${esc(pd.prompt)}</span>${pd.choices.map((c, i) => `<button data-opt="${i}">${esc(prettyText(c))}</button>`).join('')}`;
    el.hidden = false;
    el.querySelectorAll('[data-opt]').forEach((b) => { b.onclick = () => act({ type: 'choose', option: +b.dataset.opt }); });
    return;
  }
  if (pd?.type === 'choose' && pd.seat === you() && pd.cards && !pd.confirm) {
    el.innerHTML = `<span>${esc(pd.prompt)}</span><div class="pick">${pd.cards.map((c) => `<button class="pc" data-pick="${c.iid}" title="${esc(cardLabel(D(c.cardId)))}"><img src="${IMG(c.cardId)}" alt="${esc(cardLabel(D(c.cardId)))}"></button>`).join('')}</div>
      ${pd.optional ? '<button id="pNo" class="ghost">Skip</button>' : ''}`;
    el.hidden = false;
    el.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => act({ type: 'choose', target: b.dataset.pick }); });
    $('#pNo')?.addEventListener('click', () => act({ type: 'choose', skip: true }));
    return;
  }
  if (pd?.type === 'choose' && pd.confirm && pd.seat === you()) {
    el.innerHTML = `<span>${esc(pd.prompt)}</span>${pd.cards ? `<div class="pick">${pd.cards.map((c) => `<img src="${IMG(c.cardId)}" alt="">`).join('')}</div>` : ''}<button id="pYes">Yes</button><button id="pNo" class="ghost">No</button>`;
    el.hidden = false;
    $('#pYes').onclick = () => act({ type: 'choose', confirm: true });
    $('#pNo').onclick = () => act({ type: 'choose', skip: true });
    return;
  }
  if (v?.pending && v.pending.seat !== you()) { el.innerHTML = `<span>Waiting for ${esc(v.players[v.pending.seat].name)} to choose…${v.pending.prompt ? ` <span class="muted">(${esc(v.pending.prompt)})</span>` : ''}</span>`; el.hidden = false; return; }
  el.hidden = true;
}
function cancelTargeting() {
  const t = S.targeting;
  if (t?.mandatory) { toast('You have to choose one — pick a glowing card.'); return; }
  clearTargeting();
  t?.onCancel?.();
}

// ---------- DOM: log + chat ----------
function renderLog() {
  const el = $('#log');
  const v = V();
  if (!v) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = v.log.map((l) => `<div class="l ${l.kind} ${l.seat === you() ? 'me' : l.seat != null ? 'them' : ''}">${esc(l.text)}</div>`).join('');
  if (atBottom || v.log.at(-1)?.n !== S.logSeen) el.scrollTop = el.scrollHeight;
  S.logSeen = v.log.at(-1)?.n;
  const t = $('#ticker');                                                             // phones: the latest line, under the top bar
  if (t) t.textContent = v.log.at(-1)?.text || '';
}
function renderChat() {
  for (const box of document.querySelectorAll('.chat-msgs')) {
    box.innerHTML = S.chat.map((c) => `<div><b>${esc(c.from)}:</b> ${esc(c.text)}</div>`).join('');
    box.scrollTop = box.scrollHeight;
  }
}
function bindChat(form) {
  form.onsubmit = (e) => {
    e.preventDefault();
    const inp = form.querySelector('input');
    if (inp.value.trim()) net.send({ t: 'chat', text: inp.value });
    inp.value = '';
  };
}

// ---------- modals ----------
let modalFor = null;
function openModal(html, bind, key = null) {
  const el = $('#modal');
  el.innerHTML = `<div class="modal-card">${html}</div>`;
  el.hidden = false;
  modalFor = key;
  el.querySelectorAll('[data-close]').forEach((b) => b.onclick = closeModal);
  el.onclick = (e) => { if (e.target === el && key !== 'mulligan' && key !== 'peek') closeModal(); };
  bind?.(el);
}
function closeModal() { $('#modal').hidden = true; modalFor = null; }

let mullSel = new Set();
function renderPhaseModals() {
  const v = V();
  if (!v) { if (modalFor) closeModal(); return; }
  const m = me();
  // mulligan
  if (v.status === 'mulligan' && m && !m.mulliganDone) {
    if (modalFor !== 'mulligan') mullSel = new Set();
    const goFirst = v.starting === you();
    openModal(`<h3>Opening hand</h3>
      <p class="muted">${goFirst ? 'You go first (and skip your first draw).' : `${esc(v.players[v.starting].name)} goes first — you're on the draw.`}
      Pick any cards to put on the bottom of your deck; you'll draw that many, then shuffle. (CR 2.2.2)</p>
      <div class="mull">${m.hand.map((c) => { const d = D(c.cardId); return `<button class="mc ${mullSel.has(c.iid) ? 'sel' : ''}" data-i="${c.iid}" title="${esc(cardLabel(d))}"><img src="${IMG(c.cardId)}" alt="${esc(cardLabel(d))}"><span>${mullSel.has(c.iid) ? '↓ bottom' : ''}</span></button>`; }).join('')}</div>
      <div class="modal-actions"><button class="hot" id="mullGo">${mullSel.size ? `Put ${mullSel.size} on bottom &amp; redraw` : 'Keep all 7'}</button></div>`, (el) => {
      el.querySelectorAll('.mc').forEach((b) => b.onclick = () => { const i = b.dataset.i; mullSel.has(i) ? mullSel.delete(i) : mullSel.add(i); renderPhaseModals(); });
      $('#mullGo', el).onclick = () => { act({ type: 'mulligan', iids: [...mullSel] }); closeModal(); };
    }, 'mulligan');
    return;
  }
  if (v.status === 'mulligan' && m?.mulliganDone) {
    if (modalFor !== 'mullwait') openModal(`<h3>Waiting for ${esc(opp()?.name || 'opponent')}…</h3><p class="muted">They're choosing their opening hand.</p>`, null, 'mullwait');
    return;
  }
  if (modalFor === 'mulligan' || modalFor === 'mullwait') closeModal();
  // look at top N
  if (m?.peek?.length) {
    if (modalFor !== 'peek') S.peekPlan = m.peek.map((c) => ({ iid: c.iid, to: 'top' }));
    const plan = S.peekPlan.filter((p) => m.peek.some((c) => c.iid === p.iid));
    const opts = ['top', 'bottom', 'hand', 'discard', 'inkwell'];
    openModal(`<h3>Top of your deck</h3><p class="muted">Choose where each card goes. Cards staying on top are put back in the order listed (first = top).</p>
      <div class="peek">${plan.map((p, i) => { const c = m.peek.find((x) => x.iid === p.iid); return `<div class="pk"><img src="${IMG(c.cardId)}" alt=""><select data-i="${i}">${opts.map((o) => `<option ${o === p.to ? 'selected' : ''}>${o}</option>`).join('')}</select><div><button class="sm" data-up="${i}" ${i ? '' : 'disabled'}>◀</button><button class="sm" data-dn="${i}" ${i < plan.length - 1 ? '' : 'disabled'}>▶</button></div></div>`; }).join('')}</div>
      <div class="modal-actions"><button class="hot" id="peekGo">Done</button></div>`, (el) => {
      el.querySelectorAll('select').forEach((s) => s.onchange = () => { plan[s.dataset.i].to = s.value; });
      el.querySelectorAll('[data-up]').forEach((b) => b.onclick = () => { const i = +b.dataset.up; [plan[i - 1], plan[i]] = [plan[i], plan[i - 1]]; S.peekPlan = plan; renderPhaseModals(); });
      el.querySelectorAll('[data-dn]').forEach((b) => b.onclick = () => { const i = +b.dataset.dn; [plan[i + 1], plan[i]] = [plan[i], plan[i + 1]]; S.peekPlan = plan; renderPhaseModals(); });
      $('#peekGo', el).onclick = () => { act({ type: 'resolvePeek', placements: plan }); closeModal(); };
    }, 'peek');
    return;
  }
  if (modalFor === 'peek') closeModal();
  // game over
  if (v.status === 'over') {
    if (modalFor !== 'over') {
      const won = v.winner === you();
      openModal(`<h2 class="${won ? 'win' : 'lose'}">${you() < 0 ? `${esc(v.players[v.winner].name)} wins!` : won ? 'You win! 🏆' : 'Defeat'}</h2>
        <p>${esc(v.endReason)}.</p>
        <p class="muted">Final lore: ${v.players.map((p) => `${esc(p.name)} ${p.lore}`).join(' · ')} — ${v.turn} turns</p>
        <div class="modal-actions"><button data-close class="ghost">Look at the board</button><button class="hot" id="rematch">Back to room</button></div>`, (el) => {
        $('#rematch', el).onclick = () => { net.send({ t: 'rematch' }); closeModal(); };
      }, 'over');
    }
    return;
  }
  if (modalFor === 'discard') openDiscard(S.discardSeat, true);
}

function openDiscard(seat, refresh = false) {
  const v = V();
  if (!v) return;
  if (refresh && modalFor !== 'discard') return;
  S.discardSeat = seat;
  const p = v.players[seat];
  const mine = seat === you();
  const canAct = v.status === 'playing' && you() >= 0;
  openModal(`<h3>${esc(p.name)}'s discard <span class="muted">(${p.discard.length})</span></h3>
    ${p.discard.length ? `<div class="disc">${[...p.discard].reverse().map((c) => `<div class="dc"><img src="${IMG(c.cardId)}" alt="${esc(cardLabel(D(c.cardId)))}">${canAct ? `<div class="dca">
      <button class="sm" data-to="hand" data-i="${c.iid}">→ hand</button>
      ${mine ? `<button class="sm" data-to="play" data-i="${c.iid}" ${['action', 'song'].includes(D(c.cardId)?.type) ? 'disabled' : ''}>→ play</button>` : ''}
      <button class="sm" data-to="deckTop" data-i="${c.iid}">→ deck top</button>
      <button class="sm" data-to="deckBottom" data-i="${c.iid}">→ bottom</button>
      ${mine ? `<button class="sm" data-to="inkwell" data-i="${c.iid}">→ inkwell</button>` : ''}
      ${mine && p.rules?.inkFromDiscard && D(c.cardId)?.inkable ? `<button class="sm" data-ink="${c.iid}" title="Ink it (your ink for the turn)">⬡ ink</button>` : ''}
      ${mine && p.playableFrom?.includes(c.iid) ? `<button class="sm hot" data-playfrom="${c.iid}" title="An ability lets you play it from your discard (you pay its cost)">▶ play</button>` : ''}</div>` : ''}</div>`).join('')}</div>` : '<p class="muted">Empty.</p>'}
    <div class="modal-actions"><button data-close>Close</button></div>`, (el) => {
    el.querySelectorAll('[data-ink]').forEach((b) => b.onclick = () => act({ type: 'ink', iid: b.dataset.ink }));   // "You can ink cards from your discard"
    el.querySelectorAll('[data-playfrom]').forEach((b) => b.onclick = () => act({ type: 'play', iid: b.dataset.playfrom, mode: 'ink' }));   // "you may play characters from your discard"
    el.querySelectorAll('[data-to]').forEach((b) => b.onclick = () => act({ type: 'moveCard', iid: b.dataset.i, to: b.dataset.to, exerted: b.dataset.to === 'inkwell' }));
  }, 'discard');
}

function openTools() {
  const v = V();
  if (!v || v.status !== 'playing' || you() < 0) return;
  const o = opp();
  openModal(`<h3>Effect tools</h3>
    <p class="muted">For card text the engine doesn't automate. Everything here is logged for both players.</p>
    <div class="tools">
      <fieldset><legend>Your deck</legend>
        <button data-a='{"type":"draw","n":1}'>Draw 1</button>
        <button data-a='{"type":"draw","n":2}'>Draw 2</button>
        <span class="inline"><button id="peekBtn">Look at top</button><input id="peekN" type="number" min="1" max="10" value="3"></span>
        <button data-a='{"type":"shuffle"}'>Shuffle</button>
        <button data-a='{"type":"mill","n":1}'>Top card → discard</button>
      </fieldset>
      <fieldset><legend>Lore</legend>
        <button data-a='{"type":"lore","delta":1}'>You +1 ◆</button>
        <button data-a='{"type":"lore","delta":-1}'>You −1 ◆</button>
        <button data-a='{"type":"lore","delta":-1,"seat":${o.seat}}'>${esc(o.name)} −1 ◆</button>
        <button data-a='{"type":"lore","delta":1,"seat":${o.seat}}'>${esc(o.name)} +1 ◆</button>
      </fieldset>
      <fieldset><legend>Ink</legend>
        <button data-a='{"type":"inkPay","delta":1}'>Pay 1 ink</button>
        <button data-a='{"type":"inkPay","delta":-1}'>Ready 1 ink</button>
        <button data-a='{"type":"extraInk"}' ${myTurn() ? '' : 'disabled'}>+1 ink drop this turn</button>
      </fieldset>
      <fieldset><legend>Opponent</legend>
        <button data-a='{"type":"mill","n":1,"seat":${o.seat}}'>Their top card → discard</button>
      </fieldset>
      <fieldset><legend>Hand</legend>
        <button data-a='{"type":"revealHand"}'>Reveal my hand</button>
      </fieldset>
    </div>
    <div class="modal-actions"><button data-close>Close</button></div>`, (el) => {
    el.querySelectorAll('[data-a]').forEach((b) => b.onclick = () => act(JSON.parse(b.dataset.a)));
    $('#peekBtn', el).onclick = () => { act({ type: 'peek', n: Number($('#peekN', el).value) || 1 }); closeModal(); };
  }, 'tools');
}

function openHelp() {
  openModal(`<h3>How to play here</h3>
    <ul class="help">
      <li><b>Tap</b> a card in your hand for its play options (play, ink, shift, sing); <b>hold</b> it, or tap ⓘ, for the full breakdown. Click any other card to inspect it. Disabled buttons tell you <i>why</i>.</li>
      <li><b>Drag</b> a hand card onto the table to play it, onto your inkwell (left) to ink it, or onto a same-name character to Shift.</li>
      <li><b>Drag</b> one of your ready characters onto an exerted opposing character to challenge.</li>
      <li><b>Esc</b> cancels targeting / closes panels · <b>Enter</b> ends your turn · click your <b>deck</b> for draw/look/shuffle tools.</li>
      <li>The engine enforces the turn structure, ink, drying, questing, challenges and all keywords (Evasive, Bodyguard, Rush, Resist, Challenger, Support, Shift, Singer, Sing Together, Reckless, Ward, Alert, Boost).</li>
      <li>Other card text shows up in the log as a <span class="l effect">↳ reminder</span>; resolve it with the <i>Effects &amp; manual tools</i> in the card panel or the deck tools — your opponent sees everything in the log.</li>
      <li>First to <b>${LORE_TO_WIN} lore</b> wins. Ending your turn with an empty deck loses.</li>
    </ul>
    <div class="modal-actions"><button data-close>Got it</button></div>`);
}

// ---------- lobby ----------
function deckTiles() {
  return [
    ...S.myDecks.map((d) => ({ id: 'saved:' + d.id, name: d.name, cards: d.cards, mine: true })),
    ...S.demoDecks.map((d) => ({ id: 'demo:' + d.id, name: d.name.replace(/^Demo:\s*/, ''), cards: d.cards, demo: true })),
  ];
}
function deckChoice(id) {
  return deckTiles().find((d) => d.id === id) || null;
}
function chosenDeck() {
  const tiles = deckTiles();
  const want = localStorage.getItem(DECK_KEY);
  if (want === 'paste' || tiles.some((t) => t.id === want)) return want;
  return tiles.find((t) => t.mine && S.deckInfo[t.id]?.legal)?.id || tiles.find((t) => t.demo)?.id || tiles[0]?.id || '';
}
async function refreshDecks() {
  try { S.myDecks = await account.listDecks(); } catch (e) { S.myDecks = []; toast(`Couldn't load your decks: ${e.message}`, 'err'); }
  const tiles = deckTiles().filter((t) => !S.deckInfo[t.id]);
  if (tiles.length) {
    try {
      const r = await fetch('/api/play/deck-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decks: tiles.map(({ id, cards }) => ({ id, cards })) }) });
      if (r.ok) Object.assign(S.deckInfo, await r.json());
    } catch { /* tiles show without counts */ }
  }
  if (!S.view) renderLobby();
}
function deckStatus(info) {
  if (!info) return '<span class="dt-sub">…</span>';
  if (info.legal) return `<span class="dt-sub">${info.size} cards · legal</span>`;
  const short = info.size < 60 ? `needs ${60 - info.size}` : 'not legal';
  return `<span class="dt-sub bad" title="${esc(info.problems.join('\n'))}">${info.size} cards · ${short}</span>`;
}
function deckTile(t, on) {
  const info = S.deckInfo[t.id];
  const art = info?.cover != null ? `<img src="${IMG(info.cover)}" alt="" loading="lazy">` : '';
  return `<button class="dtile ${on ? 'on' : ''}" data-deck="${esc(t.id)}" aria-pressed="${on}">
    <span class="dt-art">${art}</span>
    <span class="dt-meta"><b>${esc(t.name)}</b>
      <span class="dt-inks">${(info?.inks || []).map((x) => `<i class="hexi ${x}" title="${x}"></i>`).join('')}${t.demo ? '<span class="dt-tag">Starter</span>' : ''}</span>
      ${deckStatus(info)}</span>
  </button>`;
}
function accountSide() {
  const u = account.user();
  const install = installable() ? '<button class="btn btn-quiet" id="installBtn">Install the app</button>' : '';
  const ios = /iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone ? '<p class="note">On iPhone or iPad: Share → “Add to Home Screen” installs Ink as an app.</p>' : '';
  if (u) {
    return `<div class="who">
        ${u.avatar ? `<img class="avatar lg" src="${esc(u.avatar)}" alt="">` : `<span class="avatar lg">${esc(u.name.slice(0, 1).toUpperCase())}</span>`}
        <div><div class="who-name">${esc(u.name)}</div><div class="note">Signed in with ${u.providers.map((p) => p[0].toUpperCase() + p.slice(1)).join(' + ')}. Your decks follow you between devices.</div></div>
      </div>
      <div class="side-actions"><a class="btn btn-quiet" href="/">Open the deck builder</a><button class="btn btn-quiet" id="signOutBtn">Sign out</button>${install}</div>${ios}`;
  }
  const buttons = account.signInButtons('/play');
  return `<div class="side-copy">
      <h1 class="display">${buttons ? 'Sign in to keep your decks' : 'Play Lorcana'}</h1>
      <p>${buttons ? 'Your decks follow you between phone and desktop. We only read your name and avatar.' : 'Every card runs on the rules engine. Pick a deck and play a friend or the bot.'}</p>
    </div>
    ${buttons ? `<div class="side-signin">${buttons}</div><div class="or"><span>or</span></div>` : ''}
    <label class="field">Play as a guest — your name <input id="nameInput" class="field-in" maxlength="24" placeholder="e.g. Mickey" value="${esc(S.name)}"></label>
    ${buttons ? '<p class="note">Guest decks live in this browser only. Sign in later and they move to your account.</p>' : ''}
    <div class="side-actions">${install}</div>${ios}`;
}

function renderLobby() {
  const el = $('#lobby');
  if (S.view) { el.hidden = true; return; }
  el.hidden = false;
  const r = S.room;
  if (!r) {
    const tiles = deckTiles();
    const chosen = chosenDeck();
    const pick = deckChoice(chosen);
    const pickOk = pick && S.deckInfo[pick.id]?.size !== 0;
    const u = account.user();
    el.innerHTML = `<div class="lobby">
      <aside class="lob-side"><a class="brandmark" href="/">Ink</a>${accountSide()}</aside>
      <main class="lob-main">
        <div class="lob-top">
          <nav class="tabs"><a class="on" href="/play">Play</a><a href="/">Decks</a><a href="/procs">Cards</a></nav>
          ${u ? `<span class="chip-user">${u.avatar ? `<img class="avatar" src="${esc(u.avatar)}" alt="">` : `<span class="avatar">${esc(u.name.slice(0, 1).toUpperCase())}</span>`}${esc(u.name)}</span>` : ''}
        </div>
        <section>
          <div class="sec-head"><span class="lbl">Choose a deck</span><a class="link" href="/">+ New deck</a></div>
          <div class="dtiles">${tiles.map((t) => deckTile(t, t.id === chosen)).join('')}
            <a class="dtile add" href="/"><span class="plus">+</span><span class="dt-sub">Build or import a list</span></a></div>
        </section>
        <div class="lob-grid">
          <div class="panel lob-panel">
            <span class="lbl">Start a match</span>
            <button class="btn btn-gold btn-lg" id="botBtn" ${pickOk ? '' : 'disabled'}>${pickOk ? `Play ${esc(pick.name)} vs bot` : pick ? `${esc(pick.name)} is empty` : 'Pick a deck'}</button>
            <div class="lob-row2"><button class="btn" id="createBtn">Create room</button>
              <span class="joinbox"><input id="joinCode" class="field-in" maxlength="5" placeholder="CODE" aria-label="Room code" value="${esc(new URL(location.href).searchParams.get('room') || '')}"><button class="btn btn-quiet" id="joinBtn">Join</button></span></div>
            <label class="check"><input type="checkbox" id="publicChk"> List my room publicly</label>
          </div>
          <div class="panel lob-panel">
            <div class="sec-head"><span class="lbl">Open rooms</span><button class="btn btn-quiet btn-sm" id="refreshRooms" aria-label="Refresh">↻</button></div>
            ${S.publicRooms.length ? S.publicRooms.map((x) => `<button class="room-row" data-code="${x.code}"><span class="avatar">${esc((x.host || '?').slice(0, 1).toUpperCase())}</span><span class="rr-name">${esc(x.host)}'s room<small>${x.code}</small></span><span class="rr-join">Join</span></button>`).join('') : '<div class="note">No open rooms right now. Create one and tick “List my room publicly”.</div>'}
          </div>
        </div>
        <p class="note foot">${S.welcome ? '' : 'Connecting to the server… '}Card data and images from dreamborn.ink. Unofficial fan project, not affiliated with Disney or Ravensburger.</p>
      </main>
    </div>`;
    const nameOk = () => {
      if (account.user()) { S.name = account.user().name; net.name = S.name; return true; }
      const inp = $('#nameInput');
      S.name = inp.value.trim(); localStorage.setItem(NAME_KEY, S.name); net.name = S.name;
      if (!S.name) { toast('Enter a name first.', 'err'); inp.focus(); }
      return !!S.name;
    };
    $('#nameInput')?.addEventListener('input', (e) => { S.name = e.target.value.trim(); localStorage.setItem(NAME_KEY, S.name); net.name = S.name; });
    el.querySelectorAll('[data-deck]').forEach((b) => b.onclick = () => { localStorage.setItem(DECK_KEY, b.dataset.deck); renderLobby(); });
    $('#botBtn').onclick = () => { if (!nameOk()) return; S.quickBot = true; net.send({ t: 'create', name: S.name, vsBot: true }); };
    $('#createBtn').onclick = () => nameOk() && net.send({ t: 'create', name: S.name, public: $('#publicChk').checked });
    $('#joinBtn').onclick = () => nameOk() && net.send({ t: 'join', code: $('#joinCode').value.trim(), name: S.name });
    $('#joinCode').onkeydown = (e) => { if (e.key === 'Enter') $('#joinBtn').click(); };
    $('#refreshRooms').onclick = () => net.send({ t: 'rooms' });
    $('#installBtn')?.addEventListener('click', install);
    $('#signOutBtn')?.addEventListener('click', async () => { await account.signOut(); S.deckInfo = {}; refreshDecks(); });
    el.querySelectorAll('.room-row').forEach((b) => b.onclick = () => nameOk() && net.send({ t: 'join', code: b.dataset.code, name: S.name }));
    return;
  }

  const mySeat = r.you;
  const meSeat = mySeat >= 0 ? r.seats[mySeat] : null;
  const chosen = chosenDeck();
  const tiles = deckTiles();
  const invite = inviteUrl();
  const allReady = r.seats.every((s) => s?.ready && s.deck);
  el.innerHTML = `<div class="lobby room">
    <main class="lob-main narrow">
      <div class="lob-top"><a class="brandmark" href="/">Ink</a><button class="btn btn-quiet btn-sm" id="leaveBtn">Leave room</button></div>
      <h1 class="display room-title">Room <b class="bigcode">${r.code}</b><span>${r.status === 'over' ? 'Game finished' : 'Waiting to start'}</span></h1>
      <div class="invite"><input readonly class="field-in" value="${esc(invite)}" id="inviteInput"><button class="btn" id="copyBtn">Copy invite link</button></div>
      <div class="seats">${r.seats.map((s, i) => `<div class="seat ${i === mySeat ? 'me' : ''}">
        ${s ? `<div class="seat-name">${esc(s.name)} ${s.bot ? '<em>bot</em>' : ''}${i === mySeat ? '<em>you</em>' : ''} <span class="dot ${s.online ? 'on' : ''}" title="${s.online ? 'online' : 'offline'}"></span></div>
          <div class="seat-deck">${s.deck ? `${esc(s.deck.name)} · ${s.deck.size} cards ${s.deck.inks.map((x) => `<i class="hexi ${x}" title="${x}"></i>`).join('')} ${s.deck.legal ? '' : `<span class="bad" title="${esc(s.deck.problems.join('\n'))}">not tournament-legal</span>`}` : '<span class="muted">choosing a deck…</span>'}</div>
          <div class="seat-ready ${s.ready ? 'ok' : ''}">${s.ready ? '✓ Ready' : 'Not ready'}</div>`
        : `<div class="seat-empty">Empty seat. Send the invite link.</div>`}
      </div>`).join('<div class="vs">vs</div>')}</div>
      ${meSeat ? `<div class="deckpick">
        <label class="field">Your deck
          <select id="deckSel" class="field-in">
            ${S.myDecks.length ? `<optgroup label="${account.user() ? 'My decks' : 'My decks (this browser)'}">${tiles.filter((t) => t.mine).map((d) => `<option value="${esc(d.id)}" ${chosen === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</optgroup>` : ''}
            <optgroup label="Starter decks">${tiles.filter((t) => t.demo).map((d) => `<option value="${esc(d.id)}" ${chosen === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</optgroup>
            <option value="paste" ${chosen === 'paste' ? 'selected' : ''}>Paste a decklist…</option>
          </select>
        </label>
        <textarea id="pasteDeck" class="field-in" placeholder="4 Mickey Mouse - Brave Little Tailor&#10;4 Let It Go&#10;…" ${chosen === 'paste' ? '' : 'hidden'}>${esc(localStorage.getItem('ink.play.paste') || '')}</textarea>
        <div class="lob-row">
          ${chosen === 'paste' ? '<button class="btn" id="useDeck">Use this list</button>' : ''}
          <button class="btn ${meSeat.ready || r.isHost ? '' : 'btn-gold'}" id="readyBtn" ${meSeat.deck ? '' : 'disabled'}>${meSeat.ready ? 'Not ready' : '✓ Ready'}</button>
          ${r.isHost ? `<button class="btn btn-gold btn-lg" id="startBtn" ${allReady ? '' : 'disabled'} title="${allReady ? '' : 'Both players need a deck and Ready'}">Start game</button>` : '<span class="muted">The host starts the game.</span>'}
        </div>
      </div>` : '<p class="muted">You are spectating.</p>'}
      <div class="chatbox"><div class="chat-msgs"></div><form class="chat-form"><input class="field-in" placeholder="Say hi…" maxlength="280"><button class="btn">Send</button></form></div>
    </main>
  </div>`;
  $('#copyBtn').onclick = copyInvite;
  $('#leaveBtn').onclick = () => net.send({ t: 'leave' });
  bindChat(el.querySelector('.chat-form'));
  renderChat();
  if (!meSeat) return;
  const sel = $('#deckSel');
  sel.onchange = () => { localStorage.setItem(DECK_KEY, sel.value); if (sel.value !== 'paste') sendDeck(); renderLobby(); };
  $('#useDeck')?.addEventListener('click', sendDeck);
  $('#readyBtn').onclick = () => net.send({ t: 'ready', ready: !meSeat.ready });
  $('#startBtn')?.addEventListener('click', () => net.send({ t: 'start' }));
  // auto-submit the remembered deck the first time we sit down
  if (!meSeat.deck && S.autoDeckFor !== r.code) { S.autoDeckFor = r.code; if (chosen !== 'paste') sendDeck(); }
}
function sendDeck() {
  const v = $('#deckSel')?.value || chosenDeck();
  localStorage.setItem(DECK_KEY, v);
  if (v === 'paste') {
    const text = $('#pasteDeck').value;
    localStorage.setItem('ink.play.paste', text);
    net.send({ t: 'setDeck', deck: { name: 'Pasted deck', text } });
    return;
  }
  const d = deckChoice(v);
  if (d) net.send({ t: 'setDeck', deck: { name: d.name, cards: d.cards } });
}
function inviteUrl() {
  const u = new URL('/play', location.origin);
  if (S.room) u.searchParams.set('room', S.room.code);
  return u.toString();
}
async function copyInvite() {
  try { await navigator.clipboard.writeText(inviteUrl()); toast('Invite link copied — send it to a friend!'); }
  catch { prompt('Copy this invite link:', inviteUrl()); }
}

// ---------- toasts ----------
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

// ---------- wiring ----------
function renderAll() {
  renderHud();
  renderInspector();
  renderLog();
  renderPhaseModals();
}
$('#endTurn').onclick = () => act({ type: 'endTurn' });
$('#toolsBtn').onclick = openTools;
// phones: log / chat / tools live in a drawer behind ☰
const drawer = (open) => document.body.classList.toggle('drawer', open);
$('#menuBtn').onclick = () => drawer(!document.body.classList.contains('drawer'));
$('#drawerClose').onclick = () => drawer(false);
$('#drawerTools').onclick = () => { drawer(false); openTools(); };
$('#drawerHelp').onclick = () => { drawer(false); openHelp(); };
$('#drawerLeave').onclick = () => { drawer(false); net.send({ t: 'leave' }); };
$('#drawerConcede').onclick = () => { drawer(false); if (confirm('Concede this game?')) act({ type: 'concede' }); };
window.addEventListener('ink:installable', () => { if (!S.view) renderLobby(); });
bindChat($('#gameChat'));
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'Escape') {
    if (S.targeting) cancelTargeting();
    else if (!$('#modal').hidden && modalFor !== 'mulligan' && modalFor !== 'peek') closeModal();
    else select(null);
  } else if (e.key === 'Enter' && myTurn() && $('#modal').hidden) {
    act({ type: 'endTurn' });
  }
});
function updateInsets() {
  const hud = !$('#hud').hidden;
  if (isMobile()) { board.setInsets(hud ? { left: 124, right: 112 } : { left: 0, right: 0 }); return; }   // the two rails (play.css)
  const narrow = innerWidth < 1100;
  board.setInsets(hud ? { left: narrow ? 216 : 262, right: narrow ? 248 : 318 } : { left: 0, right: 0 });
}
// phones (a coarse pointer, or a short window): the MTG Arena-style layout in play.css (body.mobile); portrait asks to rotate
const mobileMq = matchMedia('(pointer: coarse) and (max-width: 1100px), (max-height: 520px)');
const portraitMq = matchMedia('(orientation: portrait)');
function isMobile() { return document.body.classList.contains('mobile'); }
function applyDevice() {
  document.body.classList.toggle('mobile', mobileMq.matches);
  document.body.classList.toggle('portrait', portraitMq.matches);
  board.setMobile(mobileMq.matches);
  updateInsets();
}
window.addEventListener('resize', () => { applyDevice(); if (S.selected) positionQuick(S.selected); });
mobileMq.addEventListener('change', applyDevice);
portraitMq.addEventListener('change', applyDevice);
applyDevice();
renderLobby();
renderTopbar();
account.load().then(({ user, migrated, signin }) => {
  if (user) { S.name = user.name; net.name = user.name; }
  if (signin === 'failed') toast("Sign-in didn't go through. Try again, or play as a guest.", 'err');
  else if (migrated) toast(`Moved ${migrated} deck${migrated === 1 ? '' : 's'} from this browser into your account.`);
  refreshDecks();
});
// debug handle for automated tests
window.__ink = { S, board, net, act };
