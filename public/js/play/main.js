// Ink ▸ Play — glue between the lobby UI, the socket, and the 3D board.
import { Net } from './net.js';
import { Board } from './board.js';
import { IMG, CARD_W, CARD_H } from './textures.js';
import { install, installable } from '../pwa.js';
import * as account from '../account.js';
import { createCoach } from './coach.js';
import { createReview } from './review.js';
import { createOverlay } from './overlay.js';
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
  replay: null,         // watching a saved game: { id, data, i, timer, speed }
  myGames: [],          // this player's saved games (/api/replays)
  training: null,       // what the bot has learned from (/api/bot/training)
  quickBot: false,      // "Play … vs bot": seat the deck, ready up and start as soon as the room exists
  botLevel: localStorage.getItem('ink.play.bot') || 'hard',   // 'hard' = the search bot (game/searchbot.js), 'easy' = the quick heuristic one
  deckAll: false,       // the deck chooser shows every saved deck, not just the latest (#33)
  deckQ: '',            // … filtered by this name
  pasteDirty: false,    // the room's pasted list changed since it was put on the seat (#32)
  lastResult: null,     // the game this room just finished: { room, won, reason, turns, replay } (#68)
};

// ---------- network ----------
const net = new Net({
  onStatus(st) { S.conn = st; renderTopbar(); },
  onMessage(m) {
    switch (m.t) {
      case 'welcome':
        S.welcome = true;
        coach?.resume();                                      // a reconnect: the server has forgotten the coach was on
        S.demoDecks = m.demoDecks || [];
        if (!S.name && m.name && m.name !== 'Player') S.name = m.name;
        maybeAutoJoin();
        refreshDecks();
        break;
      case 'room':
        S.room = m.room;
        if (m.room?.replay && S.lastResult?.room === m.room.code) S.lastResult.replay = m.room.replay;   // saved a moment after the result shows (#65)
        if (m.room?.code) {
          const u = new URL(location.href);
          if (u.searchParams.get('room') !== m.room.code) { u.searchParams.set('room', m.room.code); history.replaceState(null, '', u); }
        } else {
          const u = new URL(location.href); u.searchParams.delete('room'); history.replaceState(null, '', u);
          if (!S.replay) { S.view = null; board.render(null, {}); }
        }
        if (S.quickBot && m.room?.you >= 0 && m.room.status !== 'playing') {
          S.quickBot = false;
          const d = deckChoice(chosenDeck({ paste: false }));
          if (d) { net.send({ t: 'setDeck', deck: { name: d.name, cards: d.cards } }); net.send({ t: 'ready', ready: true }); net.send({ t: 'start' }); }
          S.autoDeckFor = m.room.code;                        // sent already: the room screen mustn't send it again mid-game (#57)
        }
        renderLobby(); renderAll();
        break;
      case 'game':
        Object.assign(S.defs, m.defs || {});
        if (m.view) S.againFor = null;
        if (S.replay) break;                                  // watching a replay: the live table waits
        if (!m.view) { S.view = null; board.render(null, {}); clearTargeting(); S.selected = null; renderAll(); renderLobby(); break; }
        S.view = m.view;
        if (S.hint) { S.hint = null; renderHint(); }             // the position moved on
        board.render(S.view, S.defs, m.events || []);
        noteReveals(m.events || []);
        validateUi();
        renderAll();
        noteSpotlight(m.events || []);
        turnCues();
        coach?.onGame();
        renderLobby();
        break;
      case 'err':
        if (m.rid == null) toast(m.msg, 'err');
        if (S.againFor) { S.againFor = null; if (!S.view) renderLobby(); }   // Play again didn't start: show the room
        break;
      case 'chat':
        S.chat.push(m); if (S.chat.length > 100) S.chat.shift();
        renderChat();
        break;
      case 'hint':
        S.hintWait = false;
        if (m.current && V()?.status === 'playing') { S.hint = m; renderHint(); }
        else toast('The position changed while the engine was thinking.');
        renderHud();
        break;
      case 'coach': case 'coachState':
        coach?.onMessage(m);
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
  if (S.replay) return { ok: false, error: 'This is a replay.' };
  const r = await net.act(a);
  if (!r.ok && !quiet) {
    if (/^Reckless/.test(r.error) && a.type === 'endTurn') {
      if (confirm(`${r.error}\n\nEnd your turn anyway?`)) return act({ ...a, force: true });
    } else toast(r.error, 'err');
  }
  return r;
}

// ---------- board ----------
// admins only: the hard bot's suggestions for your own turns and choices, never played for you (coach.js)
let coach = null;
const board = new Board($('#board'), {
  onClickCard: (info, ev) => clickCard(info, ev),
  onClickZone: (z) => clickZone(z),
  onClickEmpty: () => { if (!S.targeting) select(null); },
  onLongPress: (info) => { if (!S.targeting && info.iid) openDetails(info.iid); },   // hold a card → the full breakdown
  onDragStart: () => { if (S.quick) select(null); },                                  // the strip would float over a moving card
  onHover: (info) => hoverPreview(info),
  canDrag: (info) => canDrag(info),
  onDrop: (d) => dropCard(d),
  onLoreGain: (g) => setTimeout(() => loreGain(g)),                      // after renderHud has redrawn the plates
});

const overlay = createOverlay({ $, esc, IMG, D: (id) => S.defs[id], cardLabel, isMobile, board });

// ---------- view helpers ----------
const V = () => S.view;
const you = () => V()?.you ?? -1;
const me = () => V()?.players[you()] || null;
const opp = () => V()?.players.find((p) => p.seat !== you()) || null;
const D = (cardId) => S.defs[cardId];
const myTurn = () => !S.replay && V()?.status === 'playing' && V().active === you() && !V().pending;
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
  clearTimeout(hoverTimer);                                               // a preview still pending from the hover mustn't open after the click (#81)
  if (iid && !S.quick) hidePreview();                                     // the panel shows it — no second copy (a hand card's options leave the preview up)
  board.setUi({ selected: iid });
  renderInspector();
}
function openDetails(iid) {
  S.quick = false;
  navigator.vibrate?.(8);
  select(iid);
}
function startTargeting(t) {
  S.targeting = { picked: new Set(), color: 0x6fa8ff, cardId: findCard(S.acting || S.selected)?.c.cardId, ...t };   // the card acting heads the bar (S.acting: one a key or the hover panel acted on)
  if (!S.targeting.valid.size) { toast('No valid targets.', 'err'); S.targeting = null; return; }
  // the arrow starts at the card that acts, also when a key or the hover panel started it (it isn't the selected one)
  board.setUi({ targets: S.targeting.valid, multi: S.targeting.picked, targetColor: S.targeting.color, arrowFrom: S.acting || null });
  $('#inspector').hidden = true;
  $('#quick').hidden = true;                                          // the pills over the hand card would sit on the targets (#22)
  renderBanner();
}
function clearTargeting() {
  S.targeting = null;
  board.setUi({ targets: new Set(), multi: new Set(), arrowFrom: null });
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
      pendKey: 'support', head: from ? `${cardLabel(from.def)} — Support` : 'Support', cardId: from?.c.cardId,
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
      ...((P) => ({ head: P.head, cardId: P.cardId, prompt: P.q }))(promptParts(pend)),
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
  if (document.body.classList.contains('pmode')) return false;   // portrait: tap a target instead (rotate prompt says so)
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
        <div class="disc">${pool.map((x) => `<div class="dc"><img src="${IMG(x.cardId)}" alt="${esc(cardLabel(D(x.cardId)))}" data-zoom="${x.cardId}" title="Enlarge"><div class="dca"><button class="sm" data-b="${x.iid}">pick</button></div></div>`).join('')}</div>
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
  if (S.replay) return { primary: [], manual: [] };                     // a replay only shows the board
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
    const now = c.cost ?? def.cost;                                   // what it costs right now, board discounts included (#19)
    const price = now === def.cost ? `${def.cost} ⬡` : `${now} ⬡ (was ${def.cost})`;
    const lacking = (n) => (ink < n ? `Needs ${n} ink — you have ${ink} ready.` : null);
    if (def.type === 'song' || def.type === 'action' || def.type === 'item' || def.type === 'location' || def.type === 'character') {
      P(`Play  ·  ${price}`, () => act({ type: 'play', iid: c.iid, mode: 'ink' }), lacking(now), { hot: true, key: 'p' });
    }
    const exertOpt = def.procs?.some((p) => p.kind === 'static' && p.effect?.fn === 'enterExertedOpt');   // "may enter play exerted [to …]"
    if (def.type === 'character' && (def.kw?.bodyguard || exertOpt)) {
      P(`Play exerted${def.kw?.bodyguard ? ' (Bodyguard)' : ''}  ·  ${price}`, () => act({ type: 'play', iid: c.iid, mode: 'ink', enterExerted: true }), lacking(now));
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
      P(label, () => startShift(c.iid, def, opt), why, { key: 'o' });
    }
    if (def.type === 'song') {
      const singers = new Set(myChars().filter((t) => !singerBlocker(t, D(t.cardId), def)).map((t) => t.iid));
      P('Sing with…  (free)', () => startTargeting({
        prompt: `Choose a character (cost ${def.cost}+) to exert and sing ${def.name}.`, valid: singers, color: 0xc7a2ff,
        onPick: (t) => act({ type: 'play', iid: c.iid, mode: 'sing', singers: [t] }),
      }), !singers.size ? `No ready, dry character with cost/Singer ${def.cost}+.` : null, { key: 's' });
      if (def.kw?.singTogether) {
        const any = new Set(myChars().filter((t) => !singerBlocker(t, D(t.cardId), null)).map((t) => t.iid));
        P(`Sing Together ${def.kw.singTogether}…`, () => startTargeting({
          prompt: `Sing Together: choose characters with total cost ${def.kw.singTogether}+.`, valid: any, multi: true, color: 0xc7a2ff,
          doneLabel: 'Sing!',
          status: (picked) => `Total: ${[...picked].reduce((n, iid) => n + singValue(findCard(iid).c, findCard(iid).def), 0)} / ${def.kw.singTogether}`,
          onDone: (picked) => act({ type: 'play', iid: c.iid, mode: 'singTogether', singers: [...picked] }),
        }), !any.size ? 'No ready, dry characters.' : null, { key: 't' });
      }
    }
    // "you may banish chosen item of yours to play this character for free" — the alternate cost
    (def.procs || []).forEach((p, i) => {
      if (p.kind !== 'activated' || p.from !== 'hand' || !p.exec) return;
      P('Play for free (alternate cost)…', () => act({ type: 'useAbility', iid: c.iid, index: i }), p.during === 'yours' && !turn ? 'Only during your turn.' : null, { title: prettyText(def.abilities[i]?.text || '') });
    });
    const inked = me().inkedThisTurn >= me().inkLimit;
    const inkable = def.inkable || me().rules?.handInkable;              // "All cards in your hand count as having {inkable}"
    P('Put into inkwell  ⬡', () => act({ type: 'ink', iid: c.iid }), !inkable ? 'No inkwell symbol — this card can\'t be inked.' : inked ? 'You already inked this turn.' : null, { key: 'i' });
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
      P(`Quest  ·  +${c.eff?.lore ?? def.lore} ◆`, () => act({ type: 'quest', iid: c.iid }), questBlocker(c, def), { hot: true, key: 'q' });
      const why = attackerBlocker(c, def);
      const targets = new Set();
      for (const p of V().players) if (p.seat !== you()) for (const t of p.play) if (!defenderBlocker(c, def, t, D(t.cardId), sideOf(p.seat))) targets.add(t.iid);
      P('Challenge…  ⚔️', () => startTargeting({
        prompt: `Choose who ${def.name} challenges. (Damage preview on hover.)`, valid: targets, color: 0xff8f86,
        preview: (t) => { const f = findCard(t); const d = challengeDamage(c, def, f.c, f.def); return `${def.name} deals ${d.toDefender}, takes ${d.toAttacker}`; },
        onPick: (t) => act({ type: 'challenge', attacker: c.iid, target: t }),
      }), why || (!targets.size ? 'No valid targets — only exerted characters (or locations) can be challenged.' : null), { key: 'c' });
      for (const l of me().play.filter((x) => D(x.cardId)?.type === 'location' && x.iid !== c.atLocation)) {
        const ld = D(l.cardId);
        // a "move here for free / pay less to move" static changes the cost — the server works it out
        const discounted = me().play.some((x) => D(x.cardId)?.procs?.some((p) => p.kind === 'static' && p.exec && p.effect?.fn === 'moveCost'));
        P(`Move to ${ld.name}  ·  ${discounted ? '≤' : ''}${ld.move ?? 0} ⬡`, () => act({ type: 'move', iid: c.iid, location: l.iid }), !discounted && readyInk() < (ld.move ?? 0) ? `Needs ${ld.move} ink.` : null, { key: 'm' });
      }
    }
    if (mine && typeof def.kw?.boost === 'number') {
      P(`Boost ${def.kw.boost}  ·  ${def.kw.boost} ⬡`, () => act({ type: 'boost', iid: c.iid }),
        c.boostedTurn === V().turn ? 'Already boosted this turn.' : readyInk() < def.kw.boost ? `Needs ${def.kw.boost} ink.` : null, { key: 'b' });
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
          P(`Use ${ab.name || 'ability'}${parts ? `  ·  ${parts}` : ''}`, () => act({ type: 'useAbility', iid: c.iid, index: i }), reason, { title: prettyText(ab.text), ability: true });
          return;
        }
        if (!cost) return;
        const parts = [cost.exert ? '⟳' : '', cost.ink ? `${cost.ink} ⬡` : ''].filter(Boolean).join(' + ');
        let reason = null;
        if (cost.exert && c.exerted) reason = 'Exerted.';
        else if (cost.exert && isChar && c.drying) reason = 'Still drying.';
        else if (cost.ink > readyInk()) reason = `Needs ${cost.ink} ink.`;
        P(`Use ${ab.name || 'ability'}  ·  ${parts}`, () => act({ type: 'useAbility', iid: c.iid, index: i }), reason, { title: prettyText(ab.text), ability: true });
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
        P(`Use granted: ${prettyText(cost.effect).slice(0, 40)}  ·  ${parts}`, () => act({ type: 'useAbility', iid: c.iid, index: g.index }), reason, { title: `From ${g.src}: ${prettyText(g.text)}`, ability: true });
      }
    }
    if (!mine && turn) {
      const attackers = new Set(myChars().filter((a) => !attackerBlocker(a, D(a.cardId)) && !defenderBlocker(a, D(a.cardId), c, def, sideOf(seat))).map((a) => a.iid));
      P('Challenge this with…  ⚔️', () => startTargeting({
        prompt: `Choose your character to challenge ${def.name}.`, valid: attackers, color: 0xff8f86,
        onPick: (a) => act({ type: 'challenge', attacker: a, target: c.iid }),
      }), !attackers.size ? (defenderBlocker(myChars()[0] || c, def, c, def, sideOf(seat)) || 'None of your characters can challenge it right now.') : null, { key: 'c' });
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
  // the keys (duels.ink's set): one per kind of action, the first of a kind only; abilities 1–9 in card order
  const used = new Set();
  let n = 0;
  for (const a of primary) {
    if (a.ability) a.key = n < 9 ? String(++n) : null;
    if (a.key && used.has(a.key)) a.key = null;
    if (a.key) used.add(a.key);
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
// ⬡ falls back to a font that draws it as a thin ring ("Play · 2 O"): a cost is a small hexagon chip with the number in it (#79)
const inkChips = (html) => html.replace(/(\d+)\s*⬡/g, '<i class="hxn">$1</i>').replace(/⬡/g, '<i class="hxn" title="ink"></i>');
const rich = (s) => inkChips(esc(s));
// the shortcut for an action, on the button (keyboards only: play.css hides it on phones)
const kbd = (a) => (a.key ? ` <kbd class="k">${a.key.toUpperCase()}</kbd>` : '');
// the options beside a tapped hand card: what you can play it as, and ⓘ for the breakdown
const shortLabel = (l) => l.replace(/\s+·\s+/g, ' · ').replace(/\s{2,}/g, ' ')
  .replace(/^Put into inkwell/, 'Ink').replace(/^Play exerted \(Bodyguard\)/, 'Play exerted').replace(/^Sing with…\s*\(free\)/, 'Sing…')
  .replace(/^Shift onto…/, 'Shift…').replace(/^(\w[\w ]*Shift) onto…/, '$1…').replace(/^Play for free \(alternate cost\)…/, 'Play free…');
// real buttons (#75): the one to press in gilt; one you can't use dashed, with its reason under the label
function renderQuick(f) {
  const el = $('#quick');
  const { primary } = actionsFor(f);
  el.innerHTML = `${primary.map((a, i) => `<button class="q ${a.hot && !a.reason ? 'hot' : ''}" data-q="${i}" ${a.reason ? 'disabled' : ''} title="${esc(a.title || '')}"><span>${rich(shortLabel(a.label))}${kbd(a)}</span>${a.reason ? `<small>${esc(a.reason)}</small>` : ''}</button>`).join('')}
    <button class="q info" data-info title="Full card breakdown (or hold the card)"><span>ⓘ Details</span></button>`;
  el.querySelectorAll('[data-q]').forEach((b) => { b.onclick = () => runAction(primary[b.dataset.q], f.c.iid); });
  el.querySelector('[data-info]').onclick = () => openDetails(f.c.iid);
  el.hidden = false;
  positionQuick(f.c.iid);
}
// where a card is heading on screen: the box around its four corners
function cardRect(iid) {
  const t = board.cards?.get(iid)?.target;
  if (!t) return null;
  const s = t.scale || 1, w = (CARD_W / 2) * s, h = (CARD_H / 2) * s, tilt = t.tilt || 0, y = t.y || 0;
  const pts = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => board.toScreen({ x: t.x + sx * w, y: y - sz * h * Math.sin(tilt), z: t.z + sz * h * Math.cos(tilt) })));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}
// the buttons stack beside the lifted card (#76, #62), top-aligned with it so they stay clear of the rest of the hand,
// on whichever side keeps them off the log column, the plates and the End turn rail; above the card only as a last resort
function positionQuick(iid) {
  const el = $('#quick');
  if (el.hidden) return;
  const r = cardRect(iid);
  if (!r) { el.hidden = true; return; }
  // portrait: no room beside the card, so a row along the bottom over the resting hand (play.css), off the lanes (#62)
  el.classList.toggle('row', isPortraitPlay());
  if (isPortraitPlay()) { el.style.left = el.style.top = el.style.maxWidth = ''; return; }
  const pad = 8, gap = 12, topMin = isMobile() ? pad : 52;
  const blockers = ['#plateMe', '#plateOpp', '#controls', ...(isMobile() ? [] : ['#side'])]
    .map((s) => [$(s)?.getBoundingClientRect(), s === '#controls' ? 4 : 1]).filter(([b]) => b?.width);   // never over End turn
  const overlap = (x, y, w, h) => blockers.reduce((n, [b, k]) => n + k * Math.max(0, Math.min(x + w, b.right) - Math.max(x, b.left)) * Math.max(0, Math.min(y + h, b.bottom) - Math.max(y, b.top)), 0);
  el.style.maxWidth = '';
  const natW = el.offsetWidth;
  const spots = [];
  const measure = (maxW) => { el.style.maxWidth = `${maxW}px`; return [el.offsetWidth, el.offsetHeight]; };
  for (const side of ['right', 'left']) {
    const room = side === 'right' ? innerWidth - pad - (r.right + gap) : r.left - gap - pad;
    if (room < 120) continue;
    const [w, h] = measure(Math.min(natW, room));
    const x = side === 'right' ? r.right + gap : r.left - gap - w;
    const y = Math.max(topMin, Math.min(innerHeight - pad - h, r.top));
    spots.push({ x, y, maxW: Math.min(natW, room), cost: overlap(x, y, w, h) + (w < natW ? 400 : 0) });
  }
  {
    const maxW = Math.min(natW, innerWidth - 2 * pad);
    const [w, h] = measure(maxW);
    const x = Math.max(pad, Math.min(innerWidth - pad - w, (r.left + r.right) / 2 - w / 2));
    const y = Math.max(topMin, r.top - gap - h);
    spots.push({ x, y, maxW, cost: overlap(x, y, w, h) + 20000 });   // over the board: only if both sides are worse
  }
  const best = spots.reduce((a, b) => (b.cost < a.cost ? b : a));
  el.style.maxWidth = `${best.maxW}px`;
  el.style.left = `${Math.round(best.x)}px`;
  el.style.top = `${Math.round(best.y)}px`;
}
// a card's live numbers and state: stats against the printed ones, exerted / drying / damage, what it gained
function cardFacts({ c, def, zone }) {
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
    ...(c.granted || []).map((g) => `<span class="chip mod" title="${esc(g.src || '')}">+“${rich(prettyText(g.text))}”${g.until === 'eot' ? ' (turn)' : ''}</span>`),
    ...(c.mods || []).map((m) => `<span class="chip mod">${m.stat === 'kw' ? `${m.delta > 0 ? '+' : '−'}${KEYWORD_LABEL[m.kw]}` : `${m.delta > 0 ? '+' : ''}${m.delta} ${{ str: '⚔️', wp: '🛡️', lore: '◆', sing: '♪' }[m.stat]}`}${m.until === 'eot' ? ' (turn)' : ''}</span>`),
  ].join('') : '';
  return { kws, stats, status };
}
const kwChips = (kws) => Object.entries(kws || {}).map(([k, v]) => `<span class="kw" title="${esc(KEYWORD_HELP[k] || '')}">${KEYWORD_LABEL[k] || k}${typeof v === 'number' && !['evasive', 'rush', 'ward', 'support', 'bodyguard', 'reckless', 'alert', 'vanish'].includes(k) ? ` ${['challenger', 'resist'].includes(k) ? '+' : ''}${v}` : ''}</span>`).join('');
function renderInspector() {
  const el = $('#inspector');
  const q = $('#quick');
  const f = findCard(S.selected);
  if (!f || !f.def || S.targeting) { el.hidden = true; q.hidden = true; return; }
  if (S.quick && f.zone === 'hand' && f.seat === you()) { el.hidden = true; renderQuick(f); return; }
  q.hidden = true;
  const { c, def, zone, seat } = f;
  const { kws, stats, status } = cardFacts(f);
  const { primary, manual } = actionsFor(f);
  const owner = V().players[seat].name;
  const classes = (def.classes || []).filter((x) => x.toLowerCase() !== String(def.type).toLowerCase());   // an action is classed "Action" again (#86)
  const autos = def.abilities.map((a, i) => (def.auto?.[i] ? a.name || 'ability' : null)).filter(Boolean);
  // the image already carries the rules text (#80): it folds away under the actions, its ⚡ auto markers still showing;
  // phones open it, as their image is small
  const textOpen = S.textOpen ?? isMobile();
  el.innerHTML = `
    <button class="x" data-close-insp title="Close (Esc)" aria-label="Close">✕</button>
    <button class="insp-imgwrap ${def.type === 'location' ? 'land' : ''}" data-zoom="${esc(def.id)}" title="Show it full size" aria-label="Show ${esc(cardLabel(def))} full size"><img class="insp-img" src="${IMG(def.id)}" alt=""></button>
    <div class="insp-body">
      <div class="insp-name">${esc(def.name)}${def.title ? `<small>${esc(def.title)}</small>` : ''}</div>
      <div class="insp-meta">
        <span class="cost ${def.inkable ? 'inkable' : ''} ${c.cost != null && c.cost !== def.cost ? 'disc' : ''}" title="${def.inkable ? 'Inkable' : 'Not inkable'}${c.cost != null && c.cost !== def.cost ? ` · costs ${c.cost} right now (printed ${def.cost})` : ''}">${c.cost ?? def.cost}</span>
        <span>${esc(def.type)}${classes.length ? ' · ' + esc(classes.join(' · ')) : ''}</span>
        <span class="inks">${def.inks.map((i) => `<i class="ink ${i}" title="${i}"></i>`).join('')}</span>
        ${stats ? `<span class="insp-stats">${stats}</span>` : ''}
      </div>
      ${primary.length ? `<div class="acts">${primary.map((a, i) => `<button class="act ${a.hot && !a.reason ? 'hot' : ''}" data-p="${i}" ${a.reason ? 'disabled' : ''} title="${esc(a.title || '')}"><span>${rich(a.label)}${kbd(a)}</span>${a.reason ? `<small>${esc(a.reason)}</small>` : ''}</button>`).join('')}</div>` : ''}
      ${status ? `<div class="insp-status">${status}</div>` : ''}
      ${Object.keys(kws || {}).length ? `<div class="insp-kw">${kwChips(kws)}</div>` : ''}
      ${def.abilities.length ? `<details class="insp-text" ${textOpen ? 'open' : ''}><summary>Card text${autos.length ? ` <i class="auto-tag" title="Resolved automatically by the game">⚡ auto</i><span class="auto-names">${esc(autos.join(' · '))}</span>` : ''}</summary>
        ${def.abilities.map((a, i) => `<p${def.auto?.[i] ? ' class="auto" title="Resolved automatically by the game"' : ''}>${def.auto?.[i] ? '<i class="auto-tag">⚡ auto</i> ' : ''}${a.name ? `<b>${esc(a.name)}</b> ` : ''}${rich(prettyText(a.text))}</p>`).join('')}</details>` : ''}
      <div class="insp-foot"><span class="insp-owner">${esc(zone)} · ${esc(owner)}</span>${def.abilities.length ? `<a class="insp-proc" href="/rules?card=${encodeURIComponent(def.full)}" target="_blank" rel="noopener" title="This card's rules, keywords and official FAQ">📖 Rules</a>` : ''}</div>
      ${manual.length && V().status === 'playing' && you() >= 0 ? `<details class="manual" ${S.manualOpen ? 'open' : ''}><summary>Effects &amp; manual tools</summary><div class="mgrid">${manual.map((a, i) => `<button class="${a.small ? 'sm' : ''}" data-m="${i}" ${a.disabled ? 'disabled' : ''}>${rich(a.label)}</button>`).join('')}</div></details>` : ''}
    </div>`;
  el.hidden = false;
  el.querySelector('[data-close-insp]').onclick = () => select(null);
  el.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => runAction(primary[b.dataset.p], c.iid));
  el.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => manual[b.dataset.m].run());
  const det = el.querySelector('details.manual');
  if (det) det.ontoggle = () => { S.manualOpen = det.open; };
  const tx = el.querySelector('details.insp-text');
  if (tx) tx.ontoggle = () => { S.textOpen = tx.open; };
}

// ---------- DOM: hover preview ----------
// One place for every hover (#77, #83): the full-size card image, about half the window tall, docked in the right column
// where the card panel lives (just left of the panel while it's open), so it never covers the board or the hand. Your
// own hand cards get it too: their 3D lift alone leaves the text a few pixels tall.
// A card on the table also lists what it can do right now under the picture (duels.ink's hover panel): its live stats
// and state, and a button per action with its key. The buttons run the same actions as the card panel; the keys work
// on whatever card the pointer is over (see the keydown handler). Leaving the card for the panel keeps it open.
let hoverTimer = null, hideTimer = null, overPreview = false;
function hoverPreview(info) {
  clearTimeout(hoverTimer);
  S.hover = info?.iid ? info : null;                                       // the card the keys act on
  if (S.targeting?.preview && info?.iid && S.targeting.valid.has(info.iid)) {
    $('#bannerPreview').textContent = S.targeting.preview(info.iid);
  } else if ($('#bannerPreview')) $('#bannerPreview').textContent = '';
  if (!info?.cardId) {
    clearTimeout(hideTimer);
    if ($('#preview').classList.contains('acts')) hideTimer = setTimeout(() => { if (!overPreview) hidePreview(); }, 280);   // time to reach its buttons
    else hidePreview();
    return;
  }
  hoverTimer = setTimeout(() => showPreview(info.cardId, info.iid), 120);
}
function showPreview(cardId, iid = null) {
  const el = $('#preview');
  const insp = $('#inspector');
  clearTimeout(hideTimer);
  // nothing hovers on a touch screen; the open panel already shows its own card (#81)
  if (isMobile() || !cardId || (iid && iid === S.selected && !insp.hidden)) { hidePreview(); return; }
  if (el.dataset.card !== cardId) {
    el.innerHTML = `<div class="pv-card ${D(cardId)?.type === 'location' ? 'land' : ''}"><img src="${IMG(cardId)}" alt=""></div><div class="pv-info"></div>`;
    el.dataset.card = cardId;
  }
  el.dataset.iid = iid || '';
  previewInfo(el, iid);
  el.style.right = insp.hidden ? '' : `${Math.round(innerWidth - insp.getBoundingClientRect().left + 10)}px`;
  el.hidden = false;
}
// the live part of the hover panel: stats, state, and the actions with their keys
function previewInfo(el, iid) {
  const box = el.querySelector('.pv-info');
  const f = iid ? findCard(iid) : null;
  if (!box) return;
  if (!f?.def || !['play', 'hand'].includes(f.zone)) { box.innerHTML = ''; el.classList.remove('acts'); return; }
  const { kws, stats, status } = cardFacts(f);
  const live = V()?.status === 'playing' && you() >= 0 && !S.replay && !S.targeting;
  // a hand card whose options are already open beside it doesn't list them twice
  const quickOpen = iid === S.selected && !$('#quick').hidden;
  const primary = live && !quickOpen ? actionsFor(f).primary : [];
  const kw = f.zone === 'play' ? kwChips(kws) : '';
  box.innerHTML = `${stats || status || kw ? `<div class="pv-facts">${stats ? `<span class="insp-stats">${stats}</span>` : ''}${status}${kw}</div>` : ''}
    ${primary.length ? `<div class="pv-acts">${primary.map((a, i) => `<button class="act ${a.hot && !a.reason ? 'hot' : ''}" data-pv="${i}" ${a.reason ? 'disabled' : ''} title="${esc(a.reason || a.title || '')}"><span>${rich(shortLabel(a.label))}</span>${a.key ? `<kbd class="k">${a.key.toUpperCase()}</kbd>` : ''}</button>`).join('')}</div>` : ''}`;
  box.querySelectorAll('[data-pv]').forEach((b) => { b.onclick = () => { runAction(primary[b.dataset.pv], iid); hidePreview(); }; });
  el.classList.toggle('acts', primary.length > 0);
}
// the panel follows the game: a hovered card's numbers and options change as things happen
function refreshPreview() {
  const el = $('#preview');
  if (el.hidden || !el.dataset.iid) return;
  if (!findCard(el.dataset.iid)) { hidePreview(); return; }
  previewInfo(el, el.dataset.iid);
}
function hidePreview() { clearTimeout(hoverTimer); clearTimeout(hideTimer); overPreview = false; $('#preview').hidden = true; $('#preview').classList.remove('acts'); }
$('#preview').addEventListener('pointerenter', () => { overPreview = true; clearTimeout(hideTimer); });
$('#preview').addEventListener('pointerleave', () => { overPreview = false; if (!S.hover) hidePreview(); });
// one way to act, whichever button or key started it: the card's own action from actionsFor; S.acting names the card
// for a target prompt it opens (a hovered card isn't the selected one)
function runAction(a, iid) {
  if (!a) return;
  if (a.reason) { toast(a.reason, 'err'); return; }
  S.acting = iid;
  try { a.run(); } finally { S.acting = null; }
}
// cards drawn in the DOM (the revealed strip, a prompt's cards) preview like the ones on the table
document.addEventListener('mouseover', (e) => {
  const c = e.target.closest?.('#hud [data-card]');
  if (c) { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => showPreview(c.dataset.card), 120); }
});
document.addEventListener('mouseout', (e) => { if (e.target.closest?.('#hud [data-card]')) hidePreview(); });

// ---------- DOM: a card full screen ----------
// Tap the card panel's image, a revealed card, or ⤢ / a long hold on a dialog's card (#49 #50 #82). Any tap closes it.
function zoomCard(cardId) {
  const el = $('#zoom');
  const d = D(cardId);
  el.innerHTML = `<div class="zc ${d?.type === 'location' ? 'land' : ''}"><img src="${IMG(cardId)}" alt="${esc(d ? cardLabel(d) : '')}"></div><button class="zx" aria-label="Close">✕</button>`;
  el.hidden = false;
  hidePreview();
}
function closeZoom() { $('#zoom').hidden = true; }
$('#zoom').onclick = closeZoom;
// capture phase, so the click opens the card instead of reaching what's under it (a mulligan pick, the dialog backdrop)
document.addEventListener('click', (e) => {
  const z = e.target.closest?.('[data-zoom]');
  if (z && !(holdFired && z.closest('[data-hold]'))) { e.preventDefault(); e.stopPropagation(); zoomCard(z.dataset.zoom); }
}, true);
// hold a dialog card ([data-hold]) to see it full size; the click that ends the hold doesn't also pick it
let holdTimer = null, holdFired = false;
document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest?.('[data-hold]');
  clearTimeout(holdTimer);
  holdFired = false;
  if (!h) return;
  const x0 = e.clientX, y0 = e.clientY;
  holdTimer = setTimeout(() => { holdFired = true; navigator.vibrate?.(8); zoomCard(h.dataset.hold); }, 450);
  const stop = (ev) => { if (ev.type !== 'pointermove' || Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) { clearTimeout(holdTimer); off(); } };
  const off = () => ['pointerup', 'pointercancel', 'pointermove'].forEach((t) => removeEventListener(t, stop, true));
  ['pointerup', 'pointercancel', 'pointermove'].forEach((t) => addEventListener(t, stop, true));
}, true);
document.addEventListener('click', (e) => { if (holdFired && e.target.closest?.('[data-hold]')) { holdFired = false; e.preventDefault(); e.stopPropagation(); } }, true);

// ---------- DOM: HUD ----------
function plate(p, isMe) {
  if (!p) return '';
  const active = V().status === 'playing' && V().active === p.seat;
  const inks = Array.from({ length: p.inkTotal }, (_, i) => `<i class="${i < p.inkReady - (p.inkDrops || 0) ? 'on' : ''}"></i>`).join('');
  const pct = Math.min(100, (p.lore / LORE_TO_WIN) * 100);
  return `
    <div class="pl-head">
      <span class="dial ${isMe ? 'mine' : ''} ${p.lore >= 15 ? 'close' : ''}" style="--p:${pct}" title="Lore — first to ${LORE_TO_WIN} wins"><b>${p.lore}</b></span>
      <div class="pl-who"><span class="pl-name">${esc(p.name)}</span><span class="pl-sub">${p.lore} / ${LORE_TO_WIN} lore${V().starting === p.seat ? '<span class="first" title="Went first"> · 1st</span>' : ''}</span></div>
      ${active ? '<span class="turn-tag">Turn</span>' : ''}
    </div>
    <div class="inkbar" title="Ink ready / total">${inks}<span class="ink-n">Ink <b>${p.inkReady}</b>/${p.inkTotal}${p.inkDrops ? ` <em title="Ink drops — each pays 1 ink">+${p.inkDrops}</em>` : ''}</span></div>
    <div class="counts">
      <span title="Cards in hand">Hand <b>${p.handCount}</b></span>
      <span title="Cards left in deck" class="${p.deckCount <= 5 ? 'warn' : ''}">Deck <b>${p.deckCount}</b></span>
      <span title="Discard pile" class="click" data-discard="${p.seat}">Discard <b>${p.discard.length}</b></span>
    </div>
    ${isMe && active && !S.replay ? `<div class="pl-note ${p.inkedThisTurn >= p.inkLimit ? 'ok' : ''}">${p.inkedThisTurn >= p.inkLimit ? '✓ Inked this turn' : 'You can ink 1 card'}</div>` : ''}
    ${p.deckTop ? `<div class="pl-note" title="Top card of the deck is face up">Top: ${esc(D(p.deckTop.cardId)?.full || D(p.deckTop.cardId)?.name || '?')}</div>` : ''}`;
}
function renderHud() {
  const v = V();
  document.body.classList.toggle('replaying', !!S.replay);   // a replay has its own bar: no turn controls, plate hints or chat (#67)
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
  endBtn.disabled = v.status === 'over' ? false : !myTurn();
  // their turn (or a choice they're making): an hourglass, so it reads as waiting rather than a dead button
  const waiting = v.status === 'playing' && !myTurn() && !S.replay;
  endBtn.classList.toggle('waiting', waiting);
  const glass = '<span class="hg" aria-hidden="true">⏳</span> ';
  endBtn.innerHTML = v.status === 'over' ? 'Game over · result' : myTurn() ? 'End turn <kbd class="k">Space</kbd>' : v.status === 'mulligan' ? 'Mulligan…'
    : v.pending ? `${waiting ? glass : ''}Waiting…` : `${waiting ? glass : ''}${v.active === you() ? 'Your turn' : you() >= 0 ? "Opponent's turn" : `${esc(v.players[v.active].name)}'s turn`}`;
  endBtn.title = v.status === 'over' ? 'Show the result again' : myTurn() ? 'End your turn (Space or Enter)' : '';
  overlay.title(myTurn() || (v.status === 'playing' && !S.replay && v.pending?.seat === you() && you() >= 0));
  $('#toolsBtn').disabled = v.status !== 'playing' || you() < 0 || !!S.replay;
  const myChoice = !S.replay && v.status === 'playing' && (v.pending ? v.pending.seat === you() : v.active === you());
  $('#hintBtn').hidden = !(S.room?.seats?.some((x) => x?.bot) && you() >= 0 && !S.replay);
  $('#hintBtn').disabled = !myChoice || S.hintWait;
  $('#hintBtn').textContent = S.hintWait ? '💡 Thinking…' : '💡 Hint';
  const questers = myTurn() ? questable().length : 0;
  $('#questAllBtn').hidden = !S.questAll && questers < 2;
  $('#questAllBtn').textContent = S.questAll ? '■ Stop questing' : `◆ Quest all (${questers})`;
  renderTopbar();
  renderBanner();
}
function renderTopbar() {
  const el = $('#topbar');
  if (!el) return;
  const v = V();
  const r = S.room;
  const turn = v ? (v.status === 'mulligan' ? 'Mulligan' : v.status === 'over' ? 'Game over' : `Turn ${v.turn} · ${v.active === you() ? '<b class="mine">Your turn</b>' : esc(v.players[v.active].name) + "'s turn"}`) : '';
  const mid = $('#midline');
  if (mid) mid.textContent = v ? (v.status === 'mulligan' ? 'Mulligan' : v.status === 'over' ? 'Game over' : `${v.active === you() ? 'Your turn' : `${v.players[v.active].name}'s turn`} · ${v.turn}`) : '';
  el.innerHTML = `
    <a href="/" class="brand" title="Back to the deck builder">Ink ▸ Play</a>
    ${r ? `<span class="code" title="Room code">Room <b>${r.code}</b></span><button class="ghost" id="copyInvite">🔗 Copy invite</button>` : ''}
    <span class="turn">${turn}</span>
    <span class="conn ${S.conn}">${S.conn === 'online' ? '● online' : '○ reconnecting…'}</span>
    ${r?.spectators?.length ? `<span class="spec">👁 ${r.spectators.length}</span>` : ''}
    <a class="ghost" href="https://files.disneylorcana.com/CRUpdate_EN_Oct-2026.pdf" target="_blank" rel="noopener">📖 Rules</a>
    <button class="ghost" id="helpBtn">?</button>
    ${v && v.status !== 'over' && you() >= 0 && !S.replay ? '<button class="ghost danger" id="concedeBtn">Concede</button>' : ''}`;
  $('#copyInvite')?.addEventListener('click', copyInvite);
  $('#helpBtn')?.addEventListener('click', openHelp);
  $('#concedeBtn')?.addEventListener('click', () => { if (confirm('Concede this game?')) act({ type: 'concede' }); });
}
// The prompt to resolve sits in the middle of the screen (#100), in one of two forms:
//  - a slim bar along the table's middle line when you click cards on the board (targets, singers, Shift, Support),
//    central without covering the two rows being picked from;
//  - a centred panel when it only needs an answer (yes / no, one of several options, one of the cards it shows), or
//    while the other player chooses.
// Both lead with whose ability it is: the card's picture, its name and the ability's, then the question in words.
// "Card — Ability: question" (the engine's pending.prompt) → the heading, the question, and the card for its picture
function promptParts(pd) {
  const text = String(pd?.prompt || '');
  const f = pd?.src ? findCard(pd.src) : null;
  const lbl = f?.def ? cardLabel(f.def) : '';
  const cut = lbl && text.startsWith(lbl) ? text.indexOf(': ', lbl.length) : text.indexOf(': ');
  const cap = (q) => q.charAt(0).toUpperCase() + q.slice(1);
  if (cut < 0 || cut > 140) return { head: lbl, q: cap(text), cardId: f?.c.cardId };
  return { head: text.slice(0, cut), q: cap(text.slice(cut + 2)), cardId: f?.c.cardId };
}
const promptHead = ({ head, cardId }) => (head || cardId ? `<div class="bp-head">${cardId ? `<button class="bp-src" data-zoom="${cardId}" data-card="${cardId}" title="Show it full size"><img src="${IMG(cardId)}" alt=""></button>` : ''}
  <div class="bp-who"><span class="lbl">Ability</span><b>${esc(head || cardLabel(D(cardId)))}</b></div></div>` : '');
// a yes / no in words where the question allows it: "Draw 2 cards?" → "Yes, draw 2 cards"; "(No = keep it on top)" → "No, keep it on top"
function confirmWords(q) {
  let no = 'No';
  const m = q.match(/\s*\(No = ([^)]+)\)\s*$/);
  if (m) { q = q.slice(0, m.index); no = `No, ${m[1]}`; }
  const ask = q.replace(/\?\s*$/, '');
  const yes = ask.length <= 34 && /\?\s*$/.test(q) ? `Yes, ${ask.charAt(0).toLowerCase()}${ask.slice(1)}` : 'Yes';
  return { q, yes, no };
}
function renderBanner() {
  const el = $('#banner');
  const t = S.targeting;
  const v = V();
  // the card you're choosing for, large at the right edge (duels.ink's targeting panel); the bar keeps the question
  overlay.source(t?.cardId, t?.pendKey ? 'Its ability asks' : 'Choosing for', t ? (t.head || (D(t.cardId) ? cardLabel(D(t.cardId)) : '')) : '');
  const show = (mode, html) => {
    el.className = mode;
    el.innerHTML = html;
    el.hidden = false;
    document.body.classList.toggle('tbar', mode === 'bar');
    placeBanner();
  };
  if (t) {
    const src = t.head ? { head: t.head, cardId: t.cardId } : { head: '', cardId: t.cardId };
    const count = t.status ? t.status(t.picked) : t.multi ? `${t.picked.size} picked` : '0 / 1';
    show('bar', `${promptHead(src)}<div class="bt-q"><span>${rich(t.prompt)}</span><span id="bannerPreview" class="pv"></span></div>
      <b class="bt-n">${esc(count)}</b>
      <div class="bp-acts">${t.multi ? `<button id="tDone" class="hot" ${t.picked.size ? '' : 'disabled'}>${esc(t.doneLabel || 'Done')}</button>` : ''}
      ${t.mandatory ? '' : `<button id="tCancel">${esc(t.skipLabel || 'Cancel')} <kbd>Esc</kbd></button>`}</div>`);
    $('#tCancel')?.addEventListener('click', cancelTargeting);
    $('#tDone')?.addEventListener('click', () => { const picked = new Set(t.picked); clearTargeting(); t.onDone(picked); });
    return;
  }
  const pd = v?.pending;
  const mine = pd?.type === 'choose' && pd.seat === you();
  const P = mine ? promptParts(pd) : null;
  if (mine && pd.choices && pd.choices.length > 8) {                       // "Name a card": a long list
    show('panel', `${promptHead(P)}<p class="bp-q">${rich(P.q)}</p>
      <select id="pOpt">${pd.choices.map((c, i) => `<option value="${i}">${esc(c)}</option>`).join('')}</select>
      <div class="bp-acts"><button id="pOk" class="hot">Choose this</button></div>`);
    $('#pOk').onclick = () => act({ type: 'choose', option: +$('#pOpt').value });
    return;
  }
  if (mine && pd.choices) {
    show('panel', `${promptHead(P)}<p class="bp-q">${rich(P.q)}</p>
      <div class="bp-opts">${pd.choices.map((c, i) => `<button data-opt="${i}">${rich(prettyText(c))}</button>`).join('')}</div>`);
    el.querySelectorAll('[data-opt]').forEach((b) => { b.onclick = () => act({ type: 'choose', option: +b.dataset.opt }); });
    return;
  }
  if (mine && pd.cards && !pd.confirm) {
    show('panel', `${promptHead(P)}<p class="bp-q">${rich(P.q)}</p>
      <div class="pick">${pd.cards.map((c) => `<span class="pcw"><button class="pc" data-pick="${c.iid}" data-card="${c.cardId}" data-hold="${c.cardId}" title="${esc(cardLabel(D(c.cardId)))}"><img src="${IMG(c.cardId)}" alt="${esc(cardLabel(D(c.cardId)))}"></button><button class="zb" data-zoom="${c.cardId}" title="Enlarge" aria-label="Enlarge ${esc(cardLabel(D(c.cardId)))}">⤢</button></span>`).join('')}</div>
      <p class="bp-hint muted">Click a card to choose it. ⤢ or hold to enlarge.</p>
      ${pd.optional ? '<div class="bp-acts"><button id="pNo">Skip</button></div>' : ''}`);
    el.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => act({ type: 'choose', target: b.dataset.pick }); });
    $('#pNo')?.addEventListener('click', () => act({ type: 'choose', skip: true }));
    return;
  }
  if (mine && pd.confirm) {
    const w = confirmWords(P.q);
    show('panel', `${promptHead(P)}<p class="bp-q">${rich(w.q)}</p>${shownCards(pd)}
      <div class="bp-acts"><button id="pYes" class="hot">${rich(w.yes)}</button><button id="pNo">${rich(w.no)}</button></div>`);
    $('#pYes').onclick = () => act({ type: 'choose', confirm: true });
    $('#pNo').onclick = () => act({ type: 'choose', skip: true });
    return;
  }
  if (pd && pd.seat !== you()) {
    const W = promptParts(pd);
    show('panel wait', `${promptHead(W)}<p class="bp-q">Waiting for ${esc(v.players[pd.seat].name)} to choose…</p>${W.q ? `<p class="muted bp-sub">${rich(W.q)}</p>` : ''}${shownCards(pd)}`);
    return;
  }
  el.hidden = true;
  el.className = '';
  document.body.classList.remove('tbar');
}
// the bar runs along the table's middle line; the panel sits at the middle of the table. Both stay on screen (and out
// of a phone's notch: play.css keeps them inside the safe area).
function placeBanner() {
  const el = $('#banner');
  if (el.hidden) return;
  const mid = board.toScreen({ x: 0, y: 0, z: 0 });
  const w = el.offsetWidth, h = el.offsetHeight;
  const cs = getComputedStyle($('#modal'));                            // the dialog layer's padding: 8–20px, or the safe area
  const [pt, pr, pb, pl] = ['Top', 'Right', 'Bottom', 'Left'].map((k) => Math.min(48, parseFloat(cs[`padding${k}`]) || 8));
  // clear of the revealed strip docked in the left rail (#85), unless the prompt is too wide to fit beside it
  const rv = $('#revealed');
  const left = !rv.hidden && !isMobile() ? Math.max(pl, rv.getBoundingClientRect().right + 12) : pl;
  const lo = left + w / 2, hi = innerWidth - pr - w / 2;
  const x = lo <= hi ? Math.max(lo, Math.min(hi, mid.x)) : Math.max(pl + w / 2, Math.min(innerWidth - pr - w / 2, mid.x));
  let y = el.classList.contains('bar') ? mid.y : innerHeight / 2;
  if (el.classList.contains('bar') && V()) {
    // in the gap between the two front rows where there is one (the table's centre line can run through a row)
    const rows = (p) => p.play.map((c) => cardRect(c.iid)).filter(Boolean);
    const theirs = rows(opp() || V().players[1]), mine = rows(me() || V().players[0]);
    const above = Math.max(...theirs.map((b) => b.bottom)), below = Math.min(...mine.map((b) => b.top));
    const seats = new Set([...(S.targeting?.valid || [])].map((iid) => findCard(iid)?.seat));
    if (theirs.length && mine.length && below - above >= h / 2) y = (above + below) / 2;   // a bar may overlap a card edge a little
    else if (theirs.length && !mine.length) y = Math.max(y, above + h / 2 + 6);
    else if (mine.length && !theirs.length) y = Math.min(y, below - h / 2 - 6);
    else if (theirs.length && !seats.has(you())) {
      // rows too close for it (portrait): beyond the row being chosen from, so it covers none of the choices
      const top = Math.min(...theirs.map((b) => b.top)), plate = $('#plateOpp').getBoundingClientRect().bottom;
      y = Math.max(plate + h / 2 + 4, top - h / 2 - 6);
    } else if (mine.length && !seats.has(opp()?.seat)) y = Math.max(...mine.map((b) => b.bottom)) + h / 2 + 6;
    else if (below > above) y = (above + below) / 2;
  }
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(Math.max(pt + h / 2, Math.min(innerHeight - pb - h / 2, y)))}px`;
}
// the card(s) a prompt is about, e.g. the one Prophetic Vision just revealed (the server only sends them when you may see
// them): big enough to read, hover / tap to see one full size
function shownCards(pd) {
  if (!pd.cards?.length) return '';
  return `<div class="pick">${pd.cards.map((c) => `<button class="pc" data-card="${c.cardId}" data-zoom="${c.cardId}" title="${esc(cardLabel(D(c.cardId)))} — show it full size"><img src="${IMG(c.cardId)}" alt="${esc(cardLabel(D(c.cardId)))}"></button>`).join('')}</div>`;
}

// ---------- DOM: revealed / looked-at cards (#20) ----------
// Both players see what a reveal turned up ("reveal the top 3 cards …"), with the card(s) the effect then used
// marked: one that went to a hand or into play, or an action it played. A look ("look at the top 4 cards") shows
// the looker their cards turning over whether or not any is choosable — it's a card game — while the other player
// sees that many card backs. Stays up until the next turn or a click. The flips can be turned off (Tools / lobby).
const FLIPS_KEY = 'ink.play.flips';
const flipsOn = () => localStorage.getItem(FLIPS_KEY) !== 'off';
function noteReveals(events) {
  const zoneOf = (z) => (typeof z === 'string' ? z : z?.zone);           // move events carry { seat, zone }
  // an action or song being played is shown by the board's cast pose; a reveal strip for it would only cover that
  const cast = new Set(events.filter((e) => e.k === 'move' && e.iid && zoneOf(e.to) === 'play' && /^(action|song)$/.test(D(e.cardId)?.type || '')).map((e) => e.iid));
  const rv = events.filter((e) => e.k === 'reveal' && e.cardId && e.iid && !cast.has(e.iid));
  const lk = events.find((e) => e.k === 'look');
  const cur = S.revealed;
  if (rv.length && !(cur && rv.every((e) => cur.cards.some((c) => c.iid === e.iid)))) {
    const seen = new Set();
    S.revealed = { kind: 'reveal', seat: rv[0].seat, cards: rv.filter((e) => !seen.has(e.iid) && seen.add(e.iid)).map((e) => ({ iid: e.iid, cardId: e.cardId, picked: false })) };
  } else if (rv.length && cur) {
    for (const e of rv) { const c = cur.cards.find((x) => x.iid === e.iid); if (c) c.picked = true; }   // played from the reveal: shown again as it's cast
  } else if (lk && flipsOn()) {
    // the looker gets the cards; the other player only a count (face-down backs)
    S.revealed = { kind: 'look', seat: lk.seat, of: lk.of, n: lk.n, cards: (lk.cards || Array.from({ length: lk.n }, () => ({}))).map((c) => ({ ...c, picked: false })) };
  } else if (cur && events.some((e) => e.k === 'turn')) S.revealed = null;
  const r = S.revealed;
  if (r) for (const e of events) {
    if (e.k === 'move' && e.iid && ['hand', 'play'].includes(zoneOf(e.to))) { const c = r.cards.find((x) => x.iid === e.iid); if (c) c.picked = true; }
    if (e.k === 'move' && e.iid && zoneOf(e.from) === 'deck' && zoneOf(e.to) === 'deck') { const c = r.cards.find((x) => x.iid === e.iid); if (c) c.down = true; }   // sent to the bottom
  }
  renderRevealed(true);
}
function renderRevealed(fresh = false) {
  const el = $('#revealed');
  const r = S.revealed;
  const v = V();
  if (!el) return;
  if (!r || !v || v.status !== 'playing') { el.hidden = true; placeBanner(); return; }
  const label = (id) => { const d = D(id); return d ? cardLabel(d) : ''; };
  const me = r.seat === you();
  const who = me ? 'You' : v.players[r.seat]?.name || 'They';
  const whose = r.kind === 'look' ? (r.of === r.seat ? (me ? 'your' : 'their') : `${esc(v.players[r.of]?.name || '')}'s`) : '';
  const title = r.kind === 'look' ? `${esc(who)} ${me ? 'look' : 'looks'} at the top ${r.n === 1 ? 'card' : `${r.n} cards`} of ${whose} deck` : `${esc(who)} revealed`;
  const choosable = new Set(v.pending?.seat === you() ? v.pending.valid || [] : []);
  const anim = fresh && flipsOn() && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const anyPicked = r.cards.some((c) => c.picked);
  // full strength with a caption, not faded (#82); hover previews it like a table card, a click / tap shows it full size
  el.innerHTML = `<div class="rv-head"><span>${title}</span><button class="x" data-close-rv title="Dismiss" aria-label="Dismiss">✕</button></div>
    <div class="pick ${anim ? 'flip' : ''}">${r.cards.map((c, i) => {
      if (!c.cardId) return `<span class="rc" style="--i:${i}"><span class="back" title="A card ${esc(who)} is looking at"></span></span>`;
      const note = c.picked ? 'chosen' : c.down ? 'to the bottom' : choosable.has(c.iid) ? 'you may choose' : anyPicked ? 'not chosen' : '';
      return `<button class="rc ${c.picked ? 'picked' : ''} ${c.down ? 'down' : ''} ${choosable.has(c.iid) ? 'can' : ''}" style="--i:${i}" data-card="${c.cardId}" data-zoom="${c.cardId}" title="${esc(label(c.cardId))}"><img src="${IMG(c.cardId)}" alt="${esc(label(c.cardId))}">${note ? `<small>${note}</small>` : ''}</button>`;
    }).join('')}</div>`;
  el.hidden = false;
  if (!isMobile()) {
    // the left rail between the plates is free: docked under the opponent's plate, neither the strip nor the prompt
    // banner covers their side of the table (#85)
    const po = $('#plateOpp').getBoundingClientRect(), pm = $('#plateMe').getBoundingClientRect();
    el.style.top = `${Math.round(po.bottom + 10)}px`;
    el.style.maxHeight = `${Math.round(Math.max(150, pm.top - po.bottom - 20))}px`;
  } else {
    // phones: across the top. A prompt panel in the middle shows the cards it's about itself, and there's no room for both
    const b = $('#banner');
    if (!b.hidden && b.classList.contains('panel')) el.hidden = true;
    el.style.top = el.style.maxHeight = '';
  }
  el.querySelector('[data-close-rv]').onclick = () => { S.revealed = null; renderRevealed(); placeBanner(); };
  placeBanner();
}
// ---------- turn cues + the opponent's spotlight ----------
// A big "Your turn" across the middle of the table as a turn starts (and a quieter one for theirs); the tab title says
// so too (overlay.title, from renderHud). Only on a change seen live: not when the page opens mid-game.
function turnCues() {
  const v = V();
  if (!v || S.replay) { S.turnKey = undefined; return; }
  const key = v.status === 'playing' ? `${v.turn}:${v.active}` : v.status;
  if (S.turnKey !== undefined && key !== S.turnKey && v.status === 'playing') {
    const mine = v.active === you();
    overlay.turnCue(mine ? 'Your turn' : you() >= 0 ? "Opponent's turn" : `${v.players[v.active].name}'s turn`, mine);
  }
  S.turnKey = key;
}
// what the other player just played or used, large at the side for a moment (the log says it in words)
function noteSpotlight(events) {
  const v = V();
  if (!v || v.status !== 'playing') return;
  const zoneOf = (z) => (typeof z === 'string' ? z : z?.zone);
  let last = null;
  for (const e of events) {
    if (e.k === 'move' && e.cardId && zoneOf(e.to) === 'play' && ['hand', 'discard', 'deck', 'inkwell'].includes(zoneOf(e.from)) && e.to?.seat != null) {
      last = { seat: e.to.seat, cardId: e.cardId, verb: /^(action|song)$/.test(D(e.cardId)?.type || '') ? 'cast' : 'played', sub: '' };
    } else if (e.k === 'ability' && e.iid) {
      const f = findCard(e.iid);
      if (f?.def) last = { seat: f.seat, cardId: f.c.cardId, verb: 'used', sub: f.def.abilities?.[e.index]?.name || 'an ability' };
    }
    if (last && last.seat === you()) last = null;                       // your own moves need no spotlight
  }
  if (last && D(last.cardId)) overlay.spotlight(last.cardId, `${v.players[last.seat]?.name || 'Opponent'} ${last.verb}`, last.sub || cardLabel(D(last.cardId)));
}

// "+N" rising off a player's lore dial as they gain lore (the board shows it on the table too; on phones the plates
// are where you look)
function loreGain({ n, mine }) {
  const dial = $(`${mine ? '#plateMe' : '#plateOpp'} .dial`);
  const r = dial?.getBoundingClientRect();
  if (!r?.width || !n) return;
  const el = document.createElement('div');
  el.className = 'lore-gain';
  el.textContent = `+${n} ◆`;
  el.style.left = `${Math.round(r.left + r.width / 2)}px`;
  el.style.top = `${Math.round(r.top)}px`;
  $('#hud').append(el);
  setTimeout(() => el.remove(), 1500);
}

// ---------- ending the turn ----------
// The commonest slip against the bot is ending the turn with a character that could still quest: ask first when
// something is left (a quest, or the ink for the turn), unless the player turned the question off.
const ENDASK_KEY = 'ink.play.endAsk';
const endAskOn = () => { try { return localStorage.getItem(ENDASK_KEY) !== 'off'; } catch { return true; } };
function endTurnLeft() {
  const m = me();
  if (!m) return [];
  const left = [];
  const q = questable();
  if (q.length) left.push(`${q.length === 1 ? `${cardLabel(D(q[0].cardId))} can` : `${q.length} characters can`} still quest (${q.reduce((n, c) => n + (c.eff?.lore ?? D(c.cardId)?.lore ?? 0), 0)} ◆).`);
  if (m.inkedThisTurn < m.inkLimit && m.hand?.some((h) => D(h.cardId)?.inkable || m.rules?.handInkable)) left.push("You haven't put a card into your inkwell this turn.");
  return left;
}
function requestEndTurn() {
  if (!myTurn()) return;
  const left = endAskOn() ? endTurnLeft() : [];
  if (!left.length) { act({ type: 'endTurn' }); return; }
  openModal(`<h3>End your turn?</h3>
    <ul class="end-left">${left.map((l) => `<li>${rich(l)}</li>`).join('')}</ul>
    <label class="check"><input type="checkbox" id="endAskOff"> Don't ask again on this device</label>
    <div class="modal-actions"><button data-close>Keep playing <kbd class="k">Esc</kbd></button>${questable().length ? '<button id="endQuest">◆ Quest all first</button>' : ''}<button class="hot" id="endGo">End turn <kbd class="k">Space</kbd></button></div>`, (el) => {
    const off = () => { if ($('#endAskOff', el).checked) { try { localStorage.setItem(ENDASK_KEY, 'off'); } catch { /* private mode */ } } };
    $('#endGo', el).onclick = () => { off(); closeModal(); act({ type: 'endTurn' }); };
    $('#endQuest', el)?.addEventListener('click', () => { off(); closeModal(); questAll(); });
    $('#endGo', el).focus();
  }, 'endturn');
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
  el.innerHTML = `<div class="modal-card ${key ? `m-${key}` : ''}">${html}</div>`;
  el.hidden = false;
  modalFor = key;
  el.querySelectorAll('[data-close]').forEach((b) => b.onclick = closeModal);
  el.onclick = (e) => { if (e.target === el && key !== 'mulligan' && key !== 'peek') closeModal(); };
  bind?.(el);
}
function closeModal() { if (modalFor === 'over') S.overDismissed = true; $('#modal').hidden = true; modalFor = null; }   // "Look at the board": the result stays a click away (#23)

let mullSel = new Set();
function renderPhaseModals() {
  if (S.replay) { if (modalFor && modalFor !== 'replayEnd') closeModal(); return; }   // a replay just shows the board
  const v = V();
  if (!v) { if (modalFor) closeModal(); return; }
  const m = me();
  // mulligan
  if (v.status === 'mulligan' && m && !m.mulliganDone) {
    if (modalFor !== 'mulligan') mullSel = new Set();
    const goFirst = v.starting === you();
    const scrolled = modalFor === 'mulligan' ? $('#modal .mull')?.scrollLeft || 0 : 0;   // a phone's row keeps its place as you pick
    // cards sized to the screen (#50), and one short line of instructions so they get the height
    openModal(`<h3>Opening hand</h3>
      <p class="muted mull-note">${goFirst ? 'You go first (no draw on turn 1).' : `${esc(v.players[v.starting].name)} goes first — you're on the draw.`}
        Choose any to put on the bottom and draw that many. <span class="nowrap">⤢ or hold to enlarge.</span></p>
      <div class="mull">${m.hand.map((c) => { const d = D(c.cardId); return `<div class="mc ${mullSel.has(c.iid) ? 'sel' : ''}"><button class="mc-pick" data-i="${c.iid}" data-hold="${c.cardId}" title="${esc(cardLabel(d))}" aria-pressed="${mullSel.has(c.iid)}"><img src="${IMG(c.cardId)}" alt="${esc(cardLabel(d))}"><span>${mullSel.has(c.iid) ? '↓ bottom' : ''}</span></button><button class="mc-zoom" data-zoom="${c.cardId}" title="Enlarge" aria-label="Enlarge ${esc(cardLabel(d))}">⤢</button></div>`; }).join('')}</div>
      <div class="modal-actions"><button class="hot" id="mullGo">${mullSel.size ? `Put ${mullSel.size} on bottom &amp; redraw` : 'Keep all 7'}</button></div>`, (el) => {
      el.querySelector('.mull').scrollLeft = scrolled;
      el.querySelectorAll('.mc-pick').forEach((b) => b.onclick = () => { const i = b.dataset.i; mullSel.has(i) ? mullSel.delete(i) : mullSel.add(i); renderPhaseModals(); });
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
      <div class="peek">${plan.map((p, i) => { const c = m.peek.find((x) => x.iid === p.iid); return `<div class="pk"><img src="${IMG(c.cardId)}" alt="${esc(cardLabel(D(c.cardId)))}" data-zoom="${c.cardId}" title="Enlarge"><select data-i="${i}">${opts.map((o) => `<option ${o === p.to ? 'selected' : ''}>${o}</option>`).join('')}</select><div><button class="sm" data-up="${i}" ${i ? '' : 'disabled'}>◀</button><button class="sm" data-dn="${i}" ${i < plan.length - 1 ? '' : 'disabled'}>▶</button></div></div>`; }).join('')}</div>
      <div class="modal-actions"><button class="hot" id="peekGo">Done</button></div>`, (el) => {
      el.querySelectorAll('select').forEach((s) => s.onchange = () => { plan[s.dataset.i].to = s.value; });
      el.querySelectorAll('[data-up]').forEach((b) => b.onclick = () => { const i = +b.dataset.up; [plan[i - 1], plan[i]] = [plan[i], plan[i - 1]]; S.peekPlan = plan; renderPhaseModals(); });
      el.querySelectorAll('[data-dn]').forEach((b) => b.onclick = () => { const i = +b.dataset.dn; [plan[i + 1], plan[i]] = [plan[i], plan[i + 1]]; S.peekPlan = plan; renderPhaseModals(); });
      $('#peekGo', el).onclick = () => { act({ type: 'resolvePeek', placements: plan }); closeModal(); };
    }, 'peek');
    return;
  }
  if (modalFor === 'peek') closeModal();
  // game over — dismissable to look at the board; the "Game over · result" button brings it back (#23)
  if (v.status !== 'over') { S.overDismissed = false; S.overAt = 0; }
  if (v.status === 'over') {
    // the replay id comes in a room message a moment after the result (#65): "Saving replay…" until it does, redrawn then
    const replay = S.room?.replay || null;
    if (!S.overAt) { S.overAt = Date.now(); setTimeout(() => { if (modalFor === 'over') renderPhaseModals(); }, 8100); }
    const saving = !replay && Date.now() - S.overAt < 8000;
    const drawKey = `${replay}|${saving}`;
    const won = v.winner === you();
    if (S.room?.status === 'over' && you() >= 0) S.lastResult = { room: S.room.code, won, reason: v.endReason, turns: v.turn, replay };   // not once the rematch has cleared the room
    if ((modalFor !== 'over' && !S.overDismissed) || (modalFor === 'over' && S.overDrawn !== drawKey)) {
      S.overDrawn = drawKey;
      // against the bot, the next game is one click (#68): ready and start with the same deck; Change deck opens the room
      const vsBot = you() >= 0 && !!S.room?.seats?.some((s) => s?.bot);
      const rp = replay ? '<button id="watchReplay" title="The replay, with the engine rating both players\' moves">Game review</button>' : saving ? '<button id="watchReplay" disabled>Saving replay…</button>' : '';
      const next = you() < 0 || !S.room ? ''
        : vsBot ? '<button id="changeDeck">Change deck</button><button class="hot" id="playAgain">Play again</button>'
        : '<button class="hot" id="rematch">Back to room</button>';
      openModal(`<h2 class="${won ? 'win' : 'lose'}">${you() < 0 ? `${esc(v.players[v.winner].name)} wins!` : won ? 'You win! 🏆' : 'Defeat'}</h2>
        <p>${esc(v.endReason)}.</p>
        <p class="muted">Final lore: ${v.players.map((p) => `${esc(p.name)} ${p.lore}`).join(' · ')} — ${plural(v.turn, 'turn')}</p>
        <p class="muted small">Games are saved as replays and help train the bot.</p>
        <div class="modal-actions"><button data-close class="ghost">Look at the board</button>${rp}${next}</div>`, (el) => {
        $('#rematch', el)?.addEventListener('click', () => { net.send({ t: 'rematch' }); closeModal(); });
        $('#changeDeck', el)?.addEventListener('click', () => { net.send({ t: 'rematch' }); closeModal(); });
        $('#playAgain', el)?.addEventListener('click', () => {
          S.againFor = S.room.code;                                       // the room flashes past: show "Shuffling…" instead
          net.send({ t: 'rematch' }); net.send({ t: 'ready', ready: true }); net.send({ t: 'start' });
          closeModal();
        });
        $('#watchReplay', el)?.addEventListener('click', () => { closeModal(); loadReplay(replay); });
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
    ${p.discard.length ? `<div class="disc">${[...p.discard].reverse().map((c) => `<div class="dc"><img src="${IMG(c.cardId)}" alt="${esc(cardLabel(D(c.cardId)))}" data-zoom="${c.cardId}" title="Enlarge">${canAct ? `<div class="dca">
      <button class="sm" data-to="hand" data-i="${c.iid}">→ hand</button>
      ${mine ? `<button class="sm" data-to="play" data-i="${c.iid}" ${['action', 'song'].includes(D(c.cardId)?.type) ? 'disabled' : ''}>→ play</button>` : ''}
      <button class="sm" data-to="deckTop" data-i="${c.iid}">→ deck top</button>
      <button class="sm" data-to="deckBottom" data-i="${c.iid}">→ bottom</button>
      ${mine ? `<button class="sm" data-to="inkwell" data-i="${c.iid}">→ inkwell</button>` : ''}
      ${mine && p.rules?.inkFromDiscard && D(c.cardId)?.inkable ? `<button class="sm" data-ink="${c.iid}" title="Ink it (your ink for the turn)"><i class="hxn"></i> ink</button>` : ''}
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
      <fieldset class="lore"><legend>Lore</legend>
        <span class="lore-who">You</span><button data-a='{"type":"lore","delta":-1}' aria-label="You −1 lore">−1 ◆</button><button data-a='{"type":"lore","delta":1}' aria-label="You +1 lore">+1 ◆</button>
        <span class="lore-who">${esc(o.name)}</span><button data-a='{"type":"lore","delta":-1,"seat":${o.seat}}' aria-label="${esc(o.name)} −1 lore">−1 ◆</button><button data-a='{"type":"lore","delta":1,"seat":${o.seat}}' aria-label="${esc(o.name)} +1 lore">+1 ◆</button>
      </fieldset>
      <fieldset><legend>Ink</legend>
        <button data-a='{"type":"inkPay","delta":1}'>Pay 1 ink</button>
        <button data-a='{"type":"inkPay","delta":-1}'>Ready 1 ink</button>
        <button data-a='{"type":"extraInk"}' ${myTurn() ? '' : 'disabled'}>+1 ink drop this turn</button>
      </fieldset>
      <fieldset><legend>Opponent &amp; hand</legend>
        <button data-a='{"type":"mill","n":1,"seat":${o.seat}}'>Their top card → discard</button>
        <button data-a='{"type":"revealHand"}'>Reveal my hand</button>
      </fieldset>
      <fieldset class="wide"><legend>Table</legend>
        <label class="check"><input type="checkbox" id="flipsChk" ${flipsOn() ? 'checked' : ''}><span>Show looked-at and revealed cards turning over <span class="note">(off: only what you must choose from)</span></span></label>
        <label class="check"><input type="checkbox" id="signalsChk" ${board.opts?.auras !== false ? 'checked' : ''}><span>Glows and arrows on the table <span class="note">(what each card can do now, and the targeting arrow)</span></span></label>
      </fieldset>
    </div>
    <div class="modal-actions"><button data-close>Close</button></div>`, (el) => {
    el.querySelectorAll('[data-a]').forEach((b) => b.onclick = () => act(JSON.parse(b.dataset.a)));
    $('#peekBtn', el).onclick = () => { act({ type: 'peek', n: Number($('#peekN', el).value) || 1 }); closeModal(); };
    $('#signalsChk', el).onchange = (e) => {
      const on = e.target.checked;
      try { localStorage.setItem('ink.signals', on ? 'on' : 'off'); } catch { /* private window */ }
      board.setOptions({ auras: on, arrows: on });
    };
    $('#flipsChk', el).onchange = (e) => { localStorage.setItem(FLIPS_KEY, e.target.checked ? 'on' : 'off'); if (!e.target.checked && S.revealed?.kind === 'look') { S.revealed = null; renderRevealed(); } };
  }, 'tools');
}

function openHelp() {
  openModal(`<h3>How to play here</h3>
    <ul class="help">
      <li><b>Tap</b> a card in your hand for its play options (play, ink, shift, sing); <b>hold</b> it, or tap ⓘ, for the full breakdown. Click any other card to inspect it. Disabled buttons tell you <i>why</i>.</li>
      <li><b>Drag</b> a hand card onto the table to play it, onto your inkwell (left) to ink it, or onto a same-name character to Shift.</li>
      <li><b>Drag</b> one of your ready characters onto an exerted opposing character to challenge.</li>
      <li><b>Esc</b> cancels targeting / closes panels · <b>Space</b> or <b>Enter</b> ends your turn (it asks first if a character could still quest) · click your <b>deck</b> for draw/look/shuffle tools.</li>
      <li class="keys"><b>Keys on the card under the pointer:</b> <kbd>I</kbd> ink · <kbd>P</kbd> play · <kbd>S</kbd> sing · <kbd>T</kbd> sing together · <kbd>O</kbd> shift · <kbd>Q</kbd> quest · <kbd>C</kbd> challenge · <kbd>B</kbd> boost · <kbd>M</kbd> move to a location · <kbd>1</kbd>–<kbd>9</kbd> its abilities · <kbd>Shift</kbd>+<kbd>Q</kbd> quest with all. Hovering a card lists what it can do, with its keys.</li>
      <li>The engine enforces the turn structure, ink, drying, questing, challenges and all keywords (Evasive, Bodyguard, Rush, Resist, Challenger, Support, Shift, Singer, Sing Together, Reckless, Ward, Alert, Boost).</li>
      <li>Other card text shows up in the log as a <span class="l effect">↳ reminder</span>; resolve it with the <i>Effects &amp; manual tools</i> in the card panel or the deck tools — your opponent sees everything in the log.</li>
      <li>First to <b>${LORE_TO_WIN} lore</b> wins. Ending your turn with an empty deck loses.</li>
    </ul>
    <div class="modal-actions"><button data-close>Got it</button></div>`);
}

// ---------- lobby ----------
function deckTiles() {
  return [
    ...S.myDecks.map((d) => ({ id: 'saved:' + d.id, name: d.name, cards: d.cards, cover: d.cover || null, updated: d.updated || 0, mine: true })),
    ...S.demoDecks.map((d) => ({ id: 'demo:' + d.id, name: d.name.replace(/^Demo:\s*/, ''), cards: d.cards, demo: true })),
  ];
}
function deckChoice(id) {
  return deckTiles().find((d) => d.id === id) || null;
}
// the remembered deck; "paste" only counts in a room, where the decklist box is
function chosenDeck({ paste = true } = {}) {
  const tiles = deckTiles();
  const want = localStorage.getItem(DECK_KEY);
  if ((paste && want === 'paste') || tiles.some((t) => t.id === want)) return want;
  return [...tiles].filter((t) => t.mine).sort((a, b) => lastUsed(b) - lastUsed(a)).find((t) => S.deckInfo[t.id]?.legal)?.id
    || tiles.find((t) => t.demo)?.id || tiles[0]?.id || '';
}
async function refreshExtras() {
  const get = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [g, t] = await Promise.all([get('/api/replays'), get('/api/bot/training')]);
  S.myGames = g?.games || [];
  S.training = t;
  if (!S.view) renderLobby();
}
async function refreshDecks() {
  try { S.myDecks = await account.listDecks(); } catch (e) { S.myDecks = []; toast(`Couldn't load your decks: ${e.message}`, 'err'); }
  const tiles = deckTiles().filter((t) => !S.deckInfo[t.id]);
  if (tiles.length) {
    try {
      const r = await fetch('/api/play/deck-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decks: tiles.map(({ id, cards, cover }) => ({ id, cards, cover })) }) });
      if (r.ok) Object.assign(S.deckInfo, await r.json());
    } catch { /* tiles show without counts */ }
  }
  if (!S.view) renderLobby();
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 60) return 'just now';
  if (s < 3600) return rtf.format(-Math.floor(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), 'hour');
  if (s < 7 * 86400) return rtf.format(-Math.floor(s / 86400), 'day');
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: s > 300 * 86400 ? 'numeric' : undefined });
}
// a saved game names the deck it was played with: the deck's last game, or its last edit, whichever is later
const lastPlayed = (t) => S.myGames.reduce((m, g) => (g.deck === t.name && g.finished > m ? g.finished : m), 0);
const lastUsed = (t) => Math.max(t.updated || 0, lastPlayed(t));
function usedNote(t) {
  const played = lastPlayed(t);
  if (!played && !t.updated) return '';
  return played >= (t.updated || 0) ? `Played ${ago(played)}` : `Edited ${ago(t.updated)}`;
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
  const note = t.mine ? usedNote(t) : '';
  return `<button class="dtile ${on ? 'on' : ''}" data-deck="${esc(t.id)}" aria-pressed="${on}">
    <span class="dt-art">${art}</span>
    <span class="dt-meta"><b title="${esc(t.name)}">${esc(t.name)}</b>
      <span class="dt-inks">${(info?.inks || []).map((x) => `<i class="hexi ${x}" title="${x}"></i>`).join('')}${t.demo ? '<span class="dt-tag">Starter</span>' : ''}</span>
      ${deckStatus(info)}${note ? `<span class="dt-sub when">${esc(note)}</span>` : ''}</span>
  </button>`;
}
// The deck chooser, in the lobby and in a room (#33 #32): most recently played or edited first. The selected deck and
// the four latest show; the rest wait behind "Show all N decks" (with a name filter past 8), so the page stays short.
// The starter decks fold into one row of chips once you have decks of your own. In a room, "Paste a decklist" is a tile.
const decksShown = (room) => (room ? 4 : 5);           // a room adds the Paste tile: still one row
function deckPickHtml(chosen, { room = false } = {}) {
  const tiles = deckTiles();
  const mine = tiles.filter((t) => t.mine).sort((a, b) => lastUsed(b) - lastUsed(a));
  const demos = tiles.filter((t) => t.demo);
  const sel = tiles.find((t) => t.id === chosen);
  const all = S.deckAll && mine.length > decksShown(room);
  const paste = room ? `<button class="dtile add paste ${chosen === 'paste' ? 'on' : ''}" data-deck="paste" aria-pressed="${chosen === 'paste'}"><span class="plus">⎘</span><span class="dt-sub">Paste a decklist</span></button>` : '';
  const filter = all && mine.length > 8
    ? `<input id="deckQ" class="field-in deck-q" type="search" placeholder="Filter ${mine.length} decks by name" aria-label="Filter decks by name" value="${esc(S.deckQ)}" autocomplete="off">` : '';
  const more = mine.length > decksShown(room) ? `<button class="btn btn-quiet btn-sm" id="deckAll" aria-expanded="${all}">${all ? 'Show fewer ▴' : `Show all ${mine.length} decks ▾`}</button>` : '';
  const chips = mine.length && demos.length ? `<div class="starters"><span class="lbl">Starter decks</span>${demos.map((t) => {
    const info = S.deckInfo[t.id];
    return `<button class="schip ${t.id === chosen ? 'on' : ''}" data-deck="${esc(t.id)}" aria-pressed="${t.id === chosen}" title="${esc(t.name)}${info ? ` · ${info.size} cards` : ''}">${(info?.inks || []).map((x) => `<i class="hexi ${x}"></i>`).join('')}<span>${esc(t.name)}</span></button>`;
  }).join('')}</div>` : '';
  return `${filter}<div class="dtiles ${room ? 'compact' : ''}" id="deckGrid">${deckGridHtml(chosen, { room, mine, demos, sel, all })}${paste}</div>
    ${more || chips ? `<div class="deck-foot">${more}${chips}</div>` : ''}`;
}
function deckGridHtml(chosen, { room, mine, demos, sel, all }) {
  const q = S.deckQ.trim().toLowerCase();
  let list;
  if (!mine.length) list = demos;                                     // nothing saved yet: the starters are the choice
  else if (all) list = mine.filter((t) => !q || t.name.toLowerCase().includes(q));
  else list = [...(sel ? [sel] : []), ...mine.filter((t) => t !== sel)].slice(0, decksShown(room));
  const none = all && q && !list.length ? `<p class="note empty">No deck called “${esc(S.deckQ.trim())}”.</p>` : '';
  const add = !room && !mine.length ? '<a class="dtile add" href="/"><span class="plus">+</span><span class="dt-sub">Build or import a list</span></a>' : '';
  return list.map((t) => deckTile(t, t.id === chosen)).join('') + none + add;
}
// onPick(id) runs for a tile or a starter chip; the filter only redraws the grid, so typing keeps its focus
function bindDeckPick(el, chosen, onPick, { room = false } = {}) {
  const bindTiles = (root) => root.querySelectorAll('[data-deck]').forEach((b) => b.onclick = () => onPick(b.dataset.deck));
  bindTiles(el);
  $('#deckAll', el)?.addEventListener('click', () => { S.deckAll = !S.deckAll; if (!S.deckAll) S.deckQ = ''; renderLobby(); });
  $('#deckQ', el)?.addEventListener('input', (e) => {
    S.deckQ = e.target.value;
    const tiles = deckTiles();
    const mine = tiles.filter((t) => t.mine).sort((a, b) => lastUsed(b) - lastUsed(a));
    const grid = $('#deckGrid', el);
    const paste = grid.querySelector('.paste')?.outerHTML || '';
    grid.innerHTML = deckGridHtml(chosen, { room, mine, demos: tiles.filter((t) => t.demo), sel: tiles.find((t) => t.id === chosen), all: true }) + paste;
    bindTiles(grid);
  });
}
function accountSide() {
  const u = account.user();
  if (!u) return '';
  return `<div class="who">
      ${u.avatar ? `<img class="avatar lg" src="${esc(u.avatar)}" alt="">` : `<span class="avatar lg">${esc(u.name.slice(0, 1).toUpperCase())}</span>`}
      <div><div class="who-name">${esc(u.name)}</div><div class="note">${u.email ? `Signed in as ${esc(u.email)}` : `Signed in with ${u.providers.map((p) => p[0].toUpperCase() + p.slice(1)).join(' + ')}`}. Your decks follow you between devices.</div></div>
    </div>`;
}
function accountFoot() {
  const u = account.user();
  const install = installable() ? '<button class="btn btn-quiet" id="installBtn">Install the app</button>' : '';
  const ios = /iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone ? '<p class="note">On iPhone or iPad: Share → “Add to Home Screen” installs Ink as an app.</p>' : '';
  if (u) return `<div class="side-foot"><div class="side-actions"><a class="btn btn-quiet" href="/">Open the deck builder</a><button class="btn btn-quiet" id="signOutBtn">Sign out</button>${install}</div>${ios}</div>`;
  return `<div class="side-foot"><div class="side-copy">
      <h2 class="display">Sign in to keep your decks</h2>
      <p>Your decks follow you between phone and desktop.</p>
    </div>
    ${account.signInForm({ next: '/play', name: S.name })}
    <p class="note">Playing as a guest, your decks are saved on Ink for this device. Create an account and they come with you.</p>
    <div class="side-actions">${install}</div>${ios}</div>`;
}
// "Start a match" (#71): the guest's name right above the main button, which stays off until there is one; labels
// beside their controls; "List publicly" beside Create room, the only thing it applies to. It heads the side column,
// which stays put while the deck list scrolls (#33).
function startPanel(pick, pickOk) {
  const guest = !account.user();
  const named = !guest || !!S.name;
  return `<div class="panel lob-panel start-panel">
    <span class="lbl">Start a match</span>
    ${guest ? `<label class="field name-field">Your name <input id="nameInput" class="field-in" maxlength="24" placeholder="e.g. Mickey" autocomplete="nickname" value="${esc(S.name)}"></label>` : ''}
    <button class="btn btn-gold btn-lg" id="botBtn" ${pickOk && named ? '' : 'disabled'}>${pickOk ? `Play ${esc(pick.name)} vs bot` : pick ? `${esc(pick.name)} is empty` : 'Pick a deck'}</button>
    <p class="note need-name" id="needName" ${named ? 'hidden' : ''}>Enter your name to play.</p>
    <div class="seg" role="radiogroup" aria-label="Bot level"><span class="seg-lbl">Bot</span>
      <label class="seg-opt"><input type="radio" name="botLevel" value="hard" ${S.botLevel !== 'easy' ? 'checked' : ''}><span>Hard <small>plans ahead</small></span></label>
      <label class="seg-opt"><input type="radio" name="botLevel" value="easy" ${S.botLevel === 'easy' ? 'checked' : ''}><span>Easy</span></label></div>
    <div class="or"><span>or play a friend</span></div>
    <div class="lob-row2 create-row"><button class="btn" id="createBtn" ${named ? '' : 'disabled'}>Create room</button>
      <label class="check"><input type="checkbox" id="publicChk"> List it publicly</label></div>
    <span class="joinbox"><input id="joinCode" class="field-in" maxlength="5" placeholder="CODE" aria-label="Room code" value="${esc(new URL(location.href).searchParams.get('room') || '')}"><button class="btn btn-quiet" id="joinBtn" ${named ? '' : 'disabled'}>Join</button></span>
    <label class="check flips"><input type="checkbox" id="flipsLobby" ${flipsOn() ? 'checked' : ''}> Show looked-at and revealed cards turning over</label>
    ${S.training?.model ? `<p class="note">The bots have learned from ${S.training.model.games.toLocaleString()} saved games${S.training.model.humanGames ? `, ${S.training.model.humanGames.toLocaleString()} played by people` : ''}.</p>` : ''}
  </div>`;
}
// a re-render (a room update, the open-rooms list) mustn't take the caret out of the field being typed in
function keepFocus(el, draw) {
  const a = document.activeElement;
  const k = a?.id && el.contains(a) ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
  draw();
  const x = k && document.getElementById(k.id);
  if (!x) return;
  x.focus({ preventScroll: true });
  try { if (k.s != null) x.setSelectionRange(k.s, k.e); } catch { /* not a text field */ }
}

function renderLobby() {
  const el = $('#lobby');
  if (S.view) { el.hidden = true; return; }
  el.hidden = false;
  keepFocus(el, () => (!S.room ? drawLobby(el) : S.againFor === S.room.code ? drawStarting(el) : drawRoom(el)));
}
function drawLobby(el) {
  const chosen = chosenDeck({ paste: false });
  const pick = deckChoice(chosen);
  const pickOk = !!pick && S.deckInfo[pick.id]?.size !== 0;
  const u = account.user();
  el.innerHTML = `<div class="lobby">
    <aside class="lob-side"><a class="brandmark" href="/">Ink</a>${accountSide()}${startPanel(pick, pickOk)}${accountFoot()}</aside>
    <main class="lob-main">
      <div class="lob-top">
        <nav class="tabs"><a class="on" href="/play">Play</a><a href="/">Decks</a><a href="/rules" title="Every card's rules text, keywords and official FAQ">Card rules</a></nav>
        ${u ? `<span class="chip-user">${u.avatar ? `<img class="avatar" src="${esc(u.avatar)}" alt="">` : `<span class="avatar">${esc(u.name.slice(0, 1).toUpperCase())}</span>`}${esc(u.name)}</span>` : ''}
      </div>
      <section class="deck-sec">
        <div class="sec-head"><span class="lbl">Choose a deck</span><a class="link" href="/">+ New deck</a></div>
        ${deckPickHtml(chosen)}
      </section>
      <div class="lob-grid">
        <div class="panel lob-panel">
          <div class="sec-head"><span class="lbl">Open rooms</span><button class="btn btn-quiet btn-sm" id="refreshRooms" aria-label="Refresh">↻</button></div>
          ${S.publicRooms.length ? S.publicRooms.map((x) => `<button class="room-row" data-code="${x.code}"><span class="avatar">${esc((x.host || '?').slice(0, 1).toUpperCase())}</span><span class="rr-name">${esc(x.host)}'s room<small>${x.code}</small></span><span class="rr-join">Join</span></button>`).join('') : '<div class="note">No open rooms right now. Create one and tick “List it publicly”.</div>'}
        </div>
        ${S.myGames.length ? `<div class="panel lob-panel games-panel">
          <div class="sec-head"><span class="lbl">Your games</span><span class="note">replays</span></div>
          ${S.myGames.slice(0, 8).map((g) => `<button class="room-row" data-replay="${esc(g.id)}"><span class="res ${g.won ? 'w' : 'l'}">${g.won ? 'Won' : 'Lost'}</span><span class="rr-name">${esc(g.deck || 'Deck')} vs ${esc(g.oppBot ? `${g.opponent} (bot)` : g.opponent)}<small>${new Date(g.finished).toLocaleString()} · ${plural(g.turns, 'turn')}</small></span><span class="rr-join">Watch</span></button>`).join('')}
        </div>` : ''}
      </div>
      <p class="note foot">${S.welcome ? '' : 'Connecting to the server… '}Card data and images from dreamborn.ink. Unofficial fan project, not affiliated with Disney or Ravensburger.</p>
    </main>
    <div class="lob-dock" id="lobDock" hidden><button class="btn btn-gold btn-lg" id="dockBtn"></button></div>
  </div>`;
  const nameOk = () => {
    if (account.user()) { S.name = account.user().name; net.name = S.name; return true; }
    const inp = $('#nameInput');
    S.name = inp.value.trim(); localStorage.setItem(NAME_KEY, S.name); net.name = S.name;
    if (!S.name) { toast('Enter a name first.', 'err'); inp.focus(); }
    return !!S.name;
  };
  // the buttons wait for a name; typing one turns them on without redrawing the page
  $('#nameInput')?.addEventListener('input', (e) => {
    S.name = e.target.value.trim(); localStorage.setItem(NAME_KEY, S.name); net.name = S.name;
    $('#botBtn').disabled = !(pickOk && S.name);
    $('#createBtn').disabled = $('#joinBtn').disabled = !S.name;
    $('#needName').hidden = !!S.name;
    syncDock();
  });
  $('#nameInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#botBtn').disabled) $('#botBtn').click(); });
  bindDeckPick(el, chosen, (id) => { localStorage.setItem(DECK_KEY, id); renderLobby(); });
  el.querySelectorAll('[name=botLevel]').forEach((r) => r.onchange = () => { S.botLevel = r.value; localStorage.setItem('ink.play.bot', r.value); });
  $('#flipsLobby')?.addEventListener('change', (e) => localStorage.setItem(FLIPS_KEY, e.target.checked ? 'on' : 'off'));
  $('#botBtn').onclick = () => { if (!nameOk()) return; S.quickBot = true; net.send({ t: 'create', name: S.name, vsBot: true, botLevel: S.botLevel === 'easy' ? 'easy' : 'hard' }); };
  $('#createBtn').onclick = () => nameOk() && net.send({ t: 'create', name: S.name, public: $('#publicChk').checked });
  $('#joinBtn').onclick = () => nameOk() && net.send({ t: 'join', code: $('#joinCode').value.trim(), name: S.name });
  $('#joinCode').onkeydown = (e) => { if (e.key === 'Enter') $('#joinBtn').click(); };
  $('#refreshRooms').onclick = () => net.send({ t: 'rooms' });
  $('#installBtn')?.addEventListener('click', install);
  account.bindSignInForm(el, () => location.reload());
  $('#signOutBtn')?.addEventListener('click', async () => { await account.signOut(); S.deckInfo = {}; refreshDecks(); });
  el.querySelectorAll('.room-row[data-code]').forEach((b) => b.onclick = () => nameOk() && net.send({ t: 'join', code: b.dataset.code, name: S.name }));
  el.querySelectorAll('[data-replay]').forEach((b) => b.onclick = () => loadReplay(b.dataset.replay));
  // one column (a narrow window, a phone held upright): the main button scrolls away above the deck list, so a copy of it
  // docks at the bottom while it's out of sight (#33)
  $('#dockBtn').onclick = () => $('#botBtn').click();
  dockObserver?.disconnect();
  dockObserver = new IntersectionObserver(([e]) => { dockSeen = e.isIntersecting; syncDock(); }, { root: el });
  dockObserver.observe($('#botBtn'));
}
let dockObserver = null, dockSeen = true;
// Play again (#68): between the rematch and the new deal the room is only a flash, so it isn't drawn
function drawStarting(el) {
  dockObserver?.disconnect();
  el.innerHTML = '<div class="lobby room"><main class="lob-main narrow starting"><p class="display">Shuffling up…</p></main></div>';
  clearTimeout(drawStarting.t);
  drawStarting.t = setTimeout(() => { if (S.againFor) { S.againFor = null; if (!S.view) renderLobby(); } }, 6000);
}
function syncDock() {
  const dock = $('#lobDock'), b = $('#botBtn');
  if (!dock || !b) return;
  dock.hidden = dockSeen;
  $('#dockBtn').textContent = b.textContent;
  $('#dockBtn').disabled = b.disabled;
}

function drawRoom(el) {
  dockObserver?.disconnect();
  const r = S.room;
  const mySeat = r.you;
  const meSeat = mySeat >= 0 ? r.seats[mySeat] : null;
  const chosen = chosenDeck();
  const vsBot = r.seats.some((s) => s?.bot);
  const bot = r.seats.find((s) => s?.bot);
  const invite = inviteUrl();
  // a pasted list counts once "Use this list" has put it on the seat (#32): until then Ready would ready the old deck
  const pasteWaiting = chosen === 'paste' && (S.pasteDirty || meSeat?.deck?.name !== 'Pasted deck');
  const deckOk = !!meSeat?.deck && !pasteWaiting;
  const allReady = r.seats.every((s) => s?.ready && s.deck);
  const last = S.lastResult?.room === r.code ? S.lastResult : null;
  const deckName = (n) => esc(String(n).replace(/^Demo:\s*/, ''));
  // a game against the bot (#68): no invite or chat, and Start readies you as well. Otherwise one gold button: Ready
  // until you are, then Start once everyone is
  const startOk = vsBot ? deckOk : allReady && !pasteWaiting;
  el.innerHTML = `<div class="lobby room">
    <main class="lob-main narrow">
      <div class="lob-top"><a class="brandmark" href="/">Ink</a><button class="btn btn-quiet btn-sm" id="leaveBtn">Leave room</button></div>
      <h1 class="display room-title">${vsBot ? `You vs ${esc(bot.name)}` : `Room <b class="bigcode">${r.code}</b>`}<span>${r.status === 'over' ? 'Game finished' : vsBot ? 'Pick a deck and start' : 'Waiting to start'}</span></h1>
      ${last ? `<div class="last-game"><span class="res ${last.won ? 'w' : 'l'}">${last.won ? 'Won' : 'Lost'}</span><span>Last game: ${esc(last.reason)} · ${plural(last.turns, 'turn')}</span>${last.replay ? '<button class="btn btn-quiet btn-sm" id="lastReplay">Watch replay</button>' : ''}</div>` : ''}
      ${vsBot ? '' : `<div class="invite"><input readonly class="field-in" value="${esc(invite)}" id="inviteInput" aria-label="Invite link"><button class="btn" id="copyBtn">Copy invite link</button></div>`}
      <div class="seats">${r.seats.map((s, i) => `<div class="seat ${i === mySeat ? 'me' : ''}">
        ${s ? `<div class="seat-name">${esc(s.name)} ${s.bot ? '<em>bot</em>' : ''}${i === mySeat ? '<em>you</em>' : ''} ${s.bot ? '' : `<span class="dot ${s.online ? 'on' : ''}" title="${s.online ? 'online' : 'offline'}"></span>`}</div>
          <div class="seat-deck">${s.deck ? `${deckName(s.deck.name)} · ${s.deck.size} cards ${s.deck.inks.map((x) => `<i class="hexi ${x}" title="${x}"></i>`).join('')} ${s.deck.legal ? '' : `<span class="bad" title="${esc(s.deck.problems.join('\n'))}">not tournament-legal</span>`}` : '<span class="muted">choosing a deck…</span>'}</div>
          ${vsBot ? '' : `<div class="seat-ready ${s.ready ? 'ok' : ''}">${s.ready ? '✓ Ready' : 'Not ready'}</div>`}`
        : '<div class="seat-empty">Empty seat. Send the invite link.</div>'}
      </div>`).join('<div class="vs">vs</div>')}</div>
      ${meSeat ? `<section class="deckpick">
        <div class="sec-head"><span class="lbl">Your deck</span><a class="link" href="/" target="_blank" rel="noopener">+ New deck</a></div>
        ${deckPickHtml(chosen, { room: true })}
        ${chosen === 'paste' ? `<textarea id="pasteDeck" class="field-in" aria-label="Decklist" placeholder="4 Mickey Mouse - Brave Little Tailor&#10;4 Let It Go&#10;…">${esc(localStorage.getItem('ink.play.paste') || '')}</textarea>` : ''}
        <div class="lob-row room-acts">
          ${chosen === 'paste' ? `<button class="btn ${pasteWaiting ? 'btn-gold' : ''}" id="useDeck">${pasteWaiting ? 'Use this list' : '✓ Using this list'}</button>` : ''}
          ${vsBot ? '' : `<button class="btn ${!meSeat.ready && deckOk ? 'btn-gold' : ''}" id="readyBtn" ${deckOk ? '' : 'disabled'} title="${pasteWaiting ? 'Use the pasted list first' : ''}">${meSeat.ready ? 'Not ready' : '✓ Ready'}</button>`}
          ${r.isHost ? `<button class="btn ${startOk ? 'btn-gold' : ''} btn-lg" id="startBtn" ${startOk ? '' : 'disabled'} title="${startOk ? '' : pasteWaiting ? 'Use the pasted list first' : 'Both players need a deck and Ready'}">Start game</button>` : '<span class="muted">The host starts the game.</span>'}
        </div>
      </section>` : '<p class="muted">You are spectating.</p>'}
      ${vsBot ? '' : '<div class="chatbox"><div class="chat-msgs"></div><form class="chat-form"><input class="field-in" placeholder="Say hi…" maxlength="280" aria-label="Chat"><button class="btn">Send</button></form></div>'}
    </main>
  </div>`;
  $('#copyBtn')?.addEventListener('click', copyInvite);
  $('#leaveBtn').onclick = () => net.send({ t: 'leave' });
  $('#lastReplay')?.addEventListener('click', () => loadReplay(last.replay));
  const chat = el.querySelector('.chat-form');
  if (chat) { bindChat(chat); renderChat(); }
  if (!meSeat) return;
  bindDeckPick(el, chosen, (id) => {
    localStorage.setItem(DECK_KEY, id);
    if (id === 'paste') { S.pasteDirty = true; renderLobby(); $('#pasteDeck')?.focus(); return; }
    sendDeck();
    renderLobby();
  }, { room: true });
  $('#pasteDeck')?.addEventListener('input', (e) => {
    localStorage.setItem('ink.play.paste', e.target.value);
    if (!S.pasteDirty) { S.pasteDirty = true; renderLobby(); }       // an edited list has to be used again
  });
  $('#useDeck')?.addEventListener('click', () => { S.pasteDirty = false; sendDeck(); });
  $('#readyBtn')?.addEventListener('click', () => net.send({ t: 'ready', ready: !meSeat.ready }));
  $('#startBtn')?.addEventListener('click', () => {
    if (vsBot && !meSeat.ready) net.send({ t: 'ready', ready: true });
    net.send({ t: 'start' });
  });
  // auto-submit the remembered deck the first time we sit down
  if (!meSeat.deck && r.status !== 'playing' && S.autoDeckFor !== r.code) { S.autoDeckFor = r.code; if (chosen !== 'paste') sendDeck(); }
}
function sendDeck() {
  const v = chosenDeck();
  if (v === 'paste') {
    const text = $('#pasteDeck')?.value ?? localStorage.getItem('ink.play.paste') ?? '';
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

// ---------- the engine's hint (games against a bot) ----------
function renderHint() {
  const el = $('#hintBox');
  const h = S.hint;
  if (!h) { el.hidden = true; return; }
  const fmt = (x) => (x >= 150 ? 'wins' : x <= -150 ? 'loses' : `${x > 0 ? '+' : ''}${x.toFixed(1)}`);
  el.innerHTML = `<div class="hb-head"><span class="lbl">Engine</span><b class="hb-eval ${h.eval >= 0 ? 'up' : 'down'}">${fmt(h.eval)}</b><span class="muted small">lore ahead by your next turn · ${h.samples} samples</span><button class="sm ghost" id="hintX" aria-label="Close">✕</button></div>
    <ol>${h.moves.map((mv, i) => `<li><span>${esc(mv.label)}</span><b>${fmt(mv.score)}</b>${i === 0 ? '<button class="sm hot" id="hintDo">Play it</button>' : ''}</li>`).join('')}</ol>`;
  el.hidden = false;
  $('#hintX').onclick = () => { S.hint = null; renderHint(); };
  $('#hintDo')?.addEventListener('click', () => { const a = S.hint?.moves[0]?.action; S.hint = null; renderHint(); if (a) act(a); });
}
$('#hintBtn').onclick = () => { S.hintWait = true; renderHud(); net.send({ t: 'hint' }); setTimeout(() => { if (S.hintWait) { S.hintWait = false; renderHud(); } }, 8000); };

// ---------- replays ----------
// A saved game played back on the table, from one seat's side (the hand that seat held; the other stays hidden).
async function loadReplay(id, seat = null) {
  try {
    const r = await fetch(`/api/replays/${encodeURIComponent(id)}${seat != null ? `?seat=${seat}` : ''}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Could not load that replay.');
    stopReplay();
    if (S.room) net.send({ t: 'leave' });
    S.replay = { id, data: j, i: 0, timer: null, speed: 1 };
    Object.assign(S.defs, j.defs || {});
    const u = new URL(location.href); u.searchParams.set('replay', id); u.searchParams.delete('room'); history.replaceState(null, '', u);
    clearTargeting(); S.selected = null; closeModal(); overlay.clear(); S.turnKey = undefined;
    showFrame(0);
    review.open(S.replay);                                            // starts the engine if the game isn't reviewed yet
    if (j.error) toast(j.error, 'err');
  } catch (e) { toast(e.message, 'err'); }
}
function showFrame(i, step = false) {
  const R = S.replay;
  if (!R) return;
  R.i = Math.max(0, Math.min(R.data.frames.length - 1, i));
  const f = R.data.frames[R.i];
  S.view = f.view;
  board.render(S.view, S.defs, step ? f.events : []);
  renderAll();
  if (step) noteSpotlight(f.events || []);
  renderReplayBar();
}
function stopReplay() { if (S.replay?.timer) { clearInterval(S.replay.timer); S.replay.timer = null; } }
function playReplay() {
  const R = S.replay;
  if (!R) return;
  if (R.timer) { stopReplay(); renderReplayBar(); return; }
  if (R.i >= R.data.frames.length - 1) R.i = 0;
  R.timer = setInterval(() => { if (R.i >= R.data.frames.length - 1) { stopReplay(); renderReplayBar(); return; } showFrame(R.i + 1, true); }, 700 / R.speed);
  renderReplayBar();
}
// jump to the first frame of the previous / next turn
function turnJump(dir) {
  const R = S.replay, fr = R.data.frames, t = fr[R.i].view.turn;
  let k = R.i;
  if (dir > 0) { while (k < fr.length - 1 && fr[k].view.turn === t) k++; }
  else { while (k > 0 && fr[k].view.turn === t) k--; const t2 = fr[k].view.turn; while (k > 0 && fr[k - 1].view.turn === t2) k--; }
  showFrame(k);
}
function exitReplay() {
  stopReplay();
  S.replay = null; S.view = null; S.turnKey = undefined; overlay.clear();
  board.render(null, {});
  const u = new URL(location.href); u.searchParams.delete('replay'); history.replaceState(null, '', u);
  $('#replayBar').hidden = true;
  renderAll(); renderLobby(); refreshExtras();
}
// the game review: both players' accuracy, the eval graph and each move rated (./review.js, lib/replays.js)
// the engine names a by-hand move by its action type ("mill"): the Tools dialog's words instead (#73)
const HAND_MOVES = {
  mill: 'Top card → discard', draw: 'Draw (Tools)', shuffle: 'Shuffle', lore: 'Lore ±1 (Tools)', inkPay: 'Pay / ready ink (Tools)',
  extraInk: '+1 ink drop this turn', revealHand: 'Reveal my hand', peek: 'Look at top', resolvePeek: 'Put the looked-at cards back',
  moveCard: 'Move a card by hand', damage: 'Damage ±1 (by hand)', exert: 'Exert / ready (by hand)', mod: 'Change a stat (by hand)',
  clearMods: 'Clear modifiers', reveal: 'Reveal to opponent',
};
const moveName = (s) => HAND_MOVES[s] || s || '?';
const review = createReview({ replay: () => S.replay, showFrame, stopReplay, isMobile, esc, moveName, toast, onChange: () => renderReplayBar() });

function renderReplayBar() {
  const R = S.replay, el = $('#replayBar');
  if (!R) { el.hidden = true; return; }
  const fr = R.data.frames, f = fr[R.i];
  const seats = R.data.seats;
  el.hidden = false;
  el.innerHTML = `<span class="rp-title">Replay · ${esc(seats[0].name)} vs ${esc(seats[1].name)}</span>
    <button class="sm" data-rp="first" aria-label="Start">⏮</button><button class="sm" data-rp="pturn" title="Previous turn">« Turn</button><button class="sm" data-rp="prev" aria-label="Back one move">◀</button>
    <button class="sm hot" data-rp="play">${R.timer ? '❚❚ Pause' : '▶ Play'}</button>
    <button class="sm" data-rp="next" aria-label="Forward one move">▶</button><button class="sm" data-rp="nturn" title="Next turn">Turn »</button><button class="sm" data-rp="last" aria-label="End">⏭</button>
    <input type="range" min="0" max="${fr.length - 1}" value="${R.i}" aria-label="Move">
    <span class="rp-pos">Move ${R.i} of ${fr.length - 1} · turn ${f.view.turn}</span>
    <select aria-label="Speed"><option value="0.5">½×</option><option value="1" ${R.speed === 1 ? 'selected' : ''}>1×</option><option value="2" ${R.speed === 2 ? 'selected' : ''}>2×</option><option value="4" ${R.speed === 4 ? 'selected' : ''}>4×</option></select>
    <button class="sm" data-rp="seat" title="Watch from the other player's side">View as ${esc(seats[1 - R.data.seat].name)}</button>
    <button class="sm" data-rp="review" title="The engine rates every move both players made, with a graph of the game">${{ done: R.showReview === false ? 'Show review' : 'Hide review', running: 'Reviewing…', failed: 'Review', none: 'Review' }[review.state(R)]}</button>
    <button class="sm ghost" data-rp="exit">Exit</button>`;
  el.querySelectorAll('[data-rp]').forEach((b) => b.onclick = () => {
    const k = b.dataset.rp;
    if (k === 'play') return playReplay();
    stopReplay();
    if (k === 'first') showFrame(0);
    if (k === 'last') showFrame(fr.length - 1);
    if (k === 'prev') showFrame(R.i - 1);
    if (k === 'next') showFrame(R.i + 1, true);
    if (k === 'pturn') turnJump(-1);
    if (k === 'nturn') turnJump(1);
    if (k === 'seat') loadReplay(R.id, 1 - R.data.seat).then(() => showFrame(Math.min(R.i, S.replay.data.frames.length - 1)));
    if (k === 'exit') exitReplay();
    if (k === 'review') review.toggle();
  });
  review.render();
  el.querySelector('input[type=range]').oninput = (e) => { stopReplay(); showFrame(+e.target.value); };
  el.querySelector('select').onchange = (e) => { R.speed = +e.target.value; if (R.timer) { stopReplay(); playReplay(); } };
}

// ---------- toasts ----------
// toasts sit near the top of the screen (#84), not over the hand where you're looking; under the replay bar when that's up
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  const box = $('#toasts');
  const under = ['#replayBar', '#hud > #reviewBox'].map((q) => $(q)).filter((e) => e && !e.hidden && !$('#hud').hidden).map((e) => e.getBoundingClientRect().bottom);
  box.style.setProperty('--toast-top', under.length ? `${Math.round(Math.max(...under) + 8)}px` : '0px');
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

// ---------- wiring ----------
function renderAll() {
  renderHud();
  coach?.render();
  renderInspector();
  renderLog();
  renderPhaseModals();
  renderRevealed();
  refreshPreview();
}
$('#endTurn').onclick = () => { if (V()?.status === 'over') { S.overDismissed = false; renderPhaseModals(); } else requestEndTurn(); };
$('#questAllBtn').onclick = () => { if (S.questAll) S.questAll.stop = true; else questAll(); };
coach = createCoach({ net, board, view: V, you, esc, isAdmin: () => account.user()?.role === 'admin' });
coach.button($('#coachBtn'));
account.onChange(() => coach.render());

// ---------- quest all (#28) ----------
// my characters that can quest now, rightmost first
function questable(skip = new Set()) {
  if (!me()) return [];
  return [...myChars()].reverse().filter((c) => !skip.has(c.iid) && !questBlocker(c, D(c.cardId)));
}
// quest with each of them in turn; when an ability asks something (a "may", a target), wait for the player to answer
// it on the board as usual, then carry on. Clicking the button again stops after the current one.
async function questAll() {
  const run = (S.questAll = { stop: false });
  const skip = new Set();
  let n = 0;
  renderHud();
  const settled = async () => {                                     // until nobody has a choice to make (or we're told to stop)
    for (let t = 0; t < 2400 && !run.stop && V()?.status === 'playing' && V().pending; t++) await new Promise((r) => setTimeout(r, 250));
  };
  try {
    for (let guard = 0; guard < 40 && !run.stop; guard++) {
      await settled();
      const v = V();
      if (run.stop || !v || v.status !== 'playing' || v.active !== you() || v.pending) break;
      const next = questable(skip)[0];
      if (!next) break;
      const r = await act({ type: 'quest', iid: next.iid }, { quiet: true });
      if (r.ok) n++; else skip.add(next.iid);                      // one the server won't let quest: leave it, try the rest
    }
  } finally {
    if (S.questAll === run) S.questAll = null;
    renderHud();
    if (n) toast(`Quested with ${n} character${n > 1 ? 's' : ''}.`);
  }
}
$('#toolsBtn').onclick = openTools;
// phones: log / chat / tools live in a drawer behind ☰
const drawer = (open) => document.body.classList.toggle('drawer', open);
$('#scrim').onclick = () => drawer(false);                                  // a tap beside the drawer closes it, not the board (#58)
$('#menuBtn').onclick = () => drawer(!document.body.classList.contains('drawer'));
$('#drawerClose').onclick = () => drawer(false);
$('#drawerTools').onclick = () => { drawer(false); openTools(); };
$('#drawerHelp').onclick = () => { drawer(false); openHelp(); };
$('#drawerReport').onclick = () => { drawer(false); window.open(`/report?from=${encodeURIComponent(location.href)}`, '_blank', 'noopener'); };
$('#drawerLeave').onclick = () => { drawer(false); net.send({ t: 'leave' }); };
$('#drawerConcede').onclick = () => { drawer(false); if (confirm('Concede this game?')) act({ type: 'concede' }); };
window.addEventListener('ink:installable', () => { if (!S.view) renderLobby(); });
bindChat($('#gameChat'));
window.addEventListener('keydown', (e) => {
  if (e.target.matches?.('input, textarea, select')) return;
  if (S.replay) {
    if (e.key === 'ArrowRight') showFrame(S.replay.i + 1, true);
    else if (e.key === 'ArrowLeft') showFrame(S.replay.i - 1);
    else if (e.key === ' ') { e.preventDefault(); playReplay(); }
    else if (e.key === 'Escape') exitReplay();
    return;
  }
  if (e.key === 'Escape') {
    if (!$('#zoom').hidden) closeZoom();
    else if (document.body.classList.contains('drawer')) drawer(false);
    else if (S.targeting) cancelTargeting();
    else if (!$('#modal').hidden && modalFor !== 'mulligan' && modalFor !== 'peek') closeModal();
    else select(null);
  } else if ((e.key === 'Enter' || e.key === ' ') && modalFor === 'endturn') {
    e.preventDefault();
    $('#endGo')?.click();                                                // the confirm: Space (or Enter) again ends it
  } else if ((e.key === 'Enter' || e.key === ' ') && myTurn() && $('#modal').hidden && !S.targeting) {
    if (e.key === ' ' && e.target.closest?.('button, a, summary')) return;   // Space on a focused button presses it
    e.preventDefault();
    requestEndTurn();
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && $('#modal').hidden && $('#zoom').hidden && !S.targeting) {
    cardKey(e);
  }
});
// the keys on the card under the pointer (or the open one on a touch screen): I ink · P play · S sing · T sing together
// · O shift · Q quest · C challenge · B boost · M move · 1–9 an ability · Shift+Q quest all. Each runs that card's own
// action, exactly as its button does.
function cardKey(e) {
  const k = e.key.toLowerCase();
  if (e.shiftKey && k === 'q') {
    if (!$('#questAllBtn').hidden) { e.preventDefault(); $('#questAllBtn').click(); }
    return;
  }
  if (!/^[ipstoqcbm1-9]$/.test(k) || e.shiftKey || you() < 0 || V()?.status !== 'playing') return;
  const iid = S.hover?.iid || S.selected;
  const f = iid && findCard(iid);
  if (!f?.def) return;
  const all = actionsFor(f).primary.filter((a) => a.key === k);
  if (!all.length) return;
  e.preventDefault();
  hidePreview();
  runAction(all.find((a) => !a.reason) || all[0], iid);
}
function updateInsets() {
  const hud = !$('#hud').hidden;
  document.body.classList.toggle('ingame', hud);
  // the plates fill in (and grow a line) after the HUD appears: refit when they change size — the board keeps its
  // framing while it's still clear, so this doesn't make the camera hop
  if (!updateInsets.ro && window.ResizeObserver) {
    updateInsets.ro = new ResizeObserver(() => { cancelAnimationFrame(updateInsets.raf); updateInsets.raf = requestAnimationFrame(updateInsets); });
    for (const s of ['#plateOpp', '#plateMe', '#controls', '#side', '#topbar', '#pstrip']) if ($(s)) updateInsets.ro.observe($(s));
  }
  // The HUD panels no card may sit under: the board fits the table and the hand around them, closest first (#51 #55
  // #59 #78). left/right/top/bottom only say where to centre the table when there's room to spare.
  const avoid = (sels) => (hud ? sels : []).map((s) => {
    const el = $(s);
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight ? { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom } : null;
  }).filter(Boolean);
  const buttons = ['#coachBtn', '#hintBtn', '#toolsBtn', '#questAllBtn', '#endTurn'];
  // the notch and home indicator (env(safe-area-inset-*)), read off a hidden probe: no card goes under them either
  if (!updateInsets.probe) {
    updateInsets.probe = document.createElement('div');
    updateInsets.probe.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.append(updateInsets.probe);
  }
  const ps = getComputedStyle(updateInsets.probe);
  const safe = { top: parseFloat(ps.paddingTop) || 0, right: parseFloat(ps.paddingRight) || 0, bottom: parseFloat(ps.paddingBottom) || 0, left: parseFloat(ps.paddingLeft) || 0 };
  if (isPortraitPlay()) {
    const top = ($('#plateOpp').getBoundingClientRect().bottom || 120) + 6;
    document.body.style.setProperty('--ptop', `${top}px`);
    const plate = $('#plateMe').getBoundingClientRect();
    const bottom = plate.height ? innerHeight - plate.top + 6 : 0;   // my plate sits over the hand's band: the hand goes above it (#55)
    board.setInsets(hud ? { top, bottom, clamp: true, safe, avoid: avoid(['#plateOpp', '#plateMe', '#pstrip', ...buttons]) } : {});
    placeMidline();
    return;
  }
  if (isMobile()) { board.setInsets(hud ? { left: 124, right: 112, safe, avoid: avoid(['#topbar', '#plateOpp', '#plateMe', '#menuBtn', ...buttons]) } : { left: 0, right: 0 }); return; }   // the two rails (play.css)
  const narrow = innerWidth < 1100;
  board.setInsets(hud ? { left: narrow ? 216 : 262, right: narrow ? 248 : 318, safe, avoid: avoid(['#topbar', '#plateOpp', '#plateMe', '#side', ...buttons]) } : { left: 0, right: 0 });
}
// phones (a coarse pointer, or a short window): the MTG Arena-style layout in play.css (body.mobile).
// Portrait asks to rotate; "Play in portrait anyway" switches to the reduced lane layout (body.pmode, board.setPortrait).
const mobileMq = matchMedia('(pointer: coarse) and (max-width: 1100px), (max-height: 520px)');
const portraitMq = matchMedia('(orientation: portrait)');
const PORTRAIT_ALWAYS = 'ink.portrait.always';
const PORTRAIT_SESSION = 'ink.portrait.ok';
const STRIP_SESSION = 'ink.portrait.strip';
const portraitAccepted = () => { try { return localStorage.getItem(PORTRAIT_ALWAYS) === '1' || sessionStorage.getItem(PORTRAIT_SESSION) === '1'; } catch { return false; } };
function isMobile() { return document.body.classList.contains('mobile'); }
function isPortraitPlay() { return document.body.classList.contains('pmode'); }
function applyDevice() {
  const mob = mobileMq.matches, por = portraitMq.matches;
  document.body.classList.toggle('mobile', mob);
  document.body.classList.toggle('portrait', por);
  // only a phone (short side under 600px) held upright is asked to rotate; a tablet in portrait gets the portrait table (#53)
  const phone = Math.min(innerWidth, innerHeight) < 600;
  const pm = mob && por && (!phone || portraitAccepted());
  document.body.classList.toggle('pmode', pm);
  let strip = false;
  try { strip = pm && phone && sessionStorage.getItem(STRIP_SESSION) !== '1'; } catch { strip = pm && phone; }
  document.body.classList.toggle('pstrip', strip);
  board.setMobile(mob);
  board.setPortrait(pm);
  updateInsets();
  if (S.replay) review.render();                                      // the review moves between the side column and the floating panel
}
// the midline pill ("Your turn · 7") sits on the table's centre line
function placeMidline() {
  const el = $('#midline');
  if (!el || !isPortraitPlay()) return;
  el.style.top = `${board.toScreen({ x: 0, y: 0, z: 0 }).y}px`;
}
$('#portraitOk').onclick = () => {
  try { sessionStorage.setItem(PORTRAIT_SESSION, '1'); if ($('#portraitAlways').checked) localStorage.setItem(PORTRAIT_ALWAYS, '1'); } catch { /* private mode: this page only */ }
  applyDevice();
};
$('#pstripX').onclick = () => { try { sessionStorage.setItem(STRIP_SESSION, '1'); } catch { /* fine */ } document.body.classList.remove('pstrip'); updateInsets(); };
window.addEventListener('resize', () => { applyDevice(); if (S.selected) positionQuick(S.selected); placeBanner(); });
// the portrait strip's height places the opponent's plate: measured whenever it changes size, not once while the HUD
// may still be hidden (it read 0 then and the strip covered the plate, #54)
new ResizeObserver(() => {
  const h = $('#pstrip').offsetHeight;
  if (h) { document.body.style.setProperty('--strip-h', `${h}px`); updateInsets(); }
}).observe($('#pstrip'));
mobileMq.addEventListener('change', applyDevice);
portraitMq.addEventListener('change', applyDevice);
applyDevice();
renderLobby();
renderTopbar();
account.load().then(({ user, migrated, signin }) => {
  if (user) { S.name = user.name; net.name = user.name; }
  if (signin === 'failed') toast("Sign-in didn't go through. Try again, or play as a guest.", 'err');
  else if (migrated) toast(`Moved ${migrated} deck${migrated === 1 ? '' : 's'} saved in this browser to ${account.signedIn() ? 'your account' : 'your guest account on the Ink server'}.`);
  refreshDecks();
  refreshExtras();
  const rp = new URL(location.href).searchParams.get('replay');
  if (rp) loadReplay(rp);
});
// debug handle for automated tests
window.__ink = { S, board, net, act };
