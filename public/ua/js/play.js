// Union Arena table (/ua/play): lobby + board over /ws/ua (game/ua/lobby.js). The server runs the rules
// (game/ua/engine.js) and sends this seat's view with the actions it may take (view.legal); this page draws the view
// and turns clicks into those actions.

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TOKEN = 'ink.ua.token', NAME = 'ink.play.name';
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* */ } } };

const st = { ws: null, token: ls.get(TOKEN), room: null, view: null, defs: {}, titles: {}, myDecks: [], picks: new Set(), menu: null, chat: [], rid: 0, retry: 0, pendingReplace: null };

function notice(msg, bad = false) { const n = $('#notice'); n.textContent = msg; n.hidden = !msg; n.className = `notice${bad ? ' bad' : ''}`; if (msg) setTimeout(() => { if (n.textContent === msg) n.hidden = true; }, 6000); }

// ---------- socket ----------
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/ua`);
  st.ws = ws;
  $('#conn').textContent = 'connecting…';
  ws.onopen = () => { st.retry = 0; $('#conn').textContent = ''; send({ t: 'hello', token: st.token }); };
  ws.onclose = () => { $('#conn').textContent = 'reconnecting…'; setTimeout(connect, Math.min(8000, 500 * 2 ** st.retry++)); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'welcome') {
      st.token = m.token; ls.set(TOKEN, m.token); st.titles = m.titles || {};
      const q = new URLSearchParams(location.search);
      if (q.get('room') && !st.room) send({ t: 'join', code: q.get('room'), name: myName() });
      if (!m.ready) notice('Union Arena cards are still being imported on the server. Try again in a few minutes.', true);
      render();
    }
    if (m.t === 'room') { st.room = m.room; if (!m.room.started) st.view = null; render(); }
    if (m.t === 'game') { if (m.defs) st.defs = m.defs; st.view = m.view; st.picks.clear(); closeMenu(); render(); }
    if (m.t === 'err') notice(m.msg, true);
    if (m.t === 'chat') { st.chat.push(m); render(); }
    if (m.t === 'rooms') { st.openRooms = m.rooms; render(); }
  };
}
const send = (m) => { if (st.ws?.readyState === 1) st.ws.send(JSON.stringify(m)); };
const act = (a) => send({ t: 'act', a, rid: ++st.rid });
const myName = () => ($('#nameIn')?.value || ls.get(NAME) || 'Player').trim().slice(0, 24);

// ---------- lobby ----------
async function loadMyDecks() {
  try { const r = await fetch('/api/ua/my/decks'); st.myDecks = (await r.json()).decks || []; } catch { st.myDecks = []; }
}
function deckOptions(selected = '') {
  const titles = Object.entries(st.titles).sort((a, b) => a[1].localeCompare(b[1]));
  return `<option value="">Choose a deck…</option>
    ${st.myDecks.length ? `<optgroup label="My decks">${st.myDecks.map((d) => `<option value="id:${esc(d.id)}" ${selected === `id:${d.id}` ? 'selected' : ''}>${esc(d.name)} (${d.cards.reduce((n, [, q]) => n + q, 0)})</option>`).join('')}</optgroup>` : ''}
    <optgroup label="Starter decks">${titles.map(([k, v]) => `<option value="auto:${esc(k)}">${esc(v)}</option>`).join('')}</optgroup>`;
}
const deckMsg = (v) => (v.startsWith('id:') ? { id: v.slice(3) } : { auto: v.slice(5) });

function renderLobby() {
  const r = st.room;
  if (!r) {
    return `<div class="lobby">
      <div class="panel"><h2>Union Arena table</h2>
        <p class="ua-note">Play a friend or the bot. The table runs the official rules: energy, AP, Raid, battles, life triggers. Card abilities run automatically where Ink can read them; anything else you resolve by hand with table actions.</p>
        <label class="lbl" for="nameIn">Your name</label><input id="nameIn" value="${esc(ls.get(NAME) || '')}" placeholder="Player" maxlength="24">
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-gold" data-do="bot">Play the bot</button><button class="btn" data-do="room">Open a table for a friend</button></div>
        <div style="display:flex;gap:8px"><input id="codeIn" placeholder="Table code" maxlength="5" style="text-transform:uppercase;width:140px"><button class="btn btn-quiet" data-do="join">Join</button><button class="btn btn-quiet" data-do="rooms">Open tables</button></div>
        ${st.openRooms ? `<div>${st.openRooms.length ? st.openRooms.map((x) => `<button class="btn btn-quiet btn-sm" data-join="${esc(x.code)}">${esc(x.host)} · ${esc(x.code)}</button>`).join(' ') : '<span class="ua-note">No open tables right now.</span>'}</div>` : ''}
      </div></div>`;
  }
  const host = !!r.host;
  const seatHtml = (s, i) => {
    if (!s) return `<div class="seat"><b>Open seat</b><span class="ua-note">Send your friend this link:</span><input readonly value="${esc(`${location.origin}/ua/play?room=${r.code}`)}" onclick="this.select()"></div>`;
    const mine = isMine(i);
    return `<div class="seat"><b>${esc(s.name)}${s.bot ? ' 🤖' : ''}${mine ? ' (you)' : ''}</b>
      ${s.deck ? `<span>${esc(s.deck.name)} · ${s.deck.size} cards ${s.deck.legal ? '✓' : '✗'}</span>${!s.deck.legal ? `<span class="ua-note">${esc(s.deck.problems.join(' '))}</span>` : ''}` : '<span class="ua-note">No deck yet</span>'}
      ${mine ? `<select data-deck>${deckOptions()}</select><button class="btn ${s.ready ? 'btn-quiet' : 'btn-gold'} btn-sm" data-do="ready">${s.ready ? 'Not ready' : 'Ready'}</button>` : ''}
      ${s.bot && host ? `<select data-botdeck><option value="">Bot deck: random title</option>${Object.entries(st.titles).sort((a, b) => a[1].localeCompare(b[1])).map(([k, v]) => `<option value="auto:${esc(k)}">${esc(v)}</option>`).join('')}</select>` : ''}
      ${!s.bot ? `<span class="ua-note">${s.ready ? 'Ready' : 'Not ready'}${s.online ? '' : ' · offline'}</span>` : ''}</div>`;
  };
  return `<div class="lobby"><div class="panel"><h2>Table ${esc(r.code)}${r.vsBot ? ' · vs the bot' : ''}</h2>
    <div class="seats">${r.seats.map(seatHtml).join('')}</div>
    <div style="display:flex;gap:8px">${host ? '<button class="btn btn-gold" data-do="start">Start game</button>' : '<span class="ua-note">The host starts the game.</span>'}<button class="btn btn-quiet" data-do="leave">Leave</button>
    <a class="btn btn-quiet" href="/ua">Build a deck</a></div></div>
    ${chatHtml()}</div>`;
}
const isMine = (i) => st.room?.you === i;

// ---------- board ----------
const D = (no) => st.defs[no] || {};
function cardEl(c, { cls = '', back = false } = {}) {
  if (back) return '<div class="fc back"></div>';
  const d = D(c.no);
  const base = d.bp;
  const bpCls = c.bp != null && base != null ? (c.bp > base ? 'up' : c.bp < base ? 'down' : '') : '';
  const kws = c.kw ? Object.entries(c.kw).filter(([, v]) => v).map(([k, v]) => ({ step: 'Step', snipe: 'Snipe', doubleAttack: '2×Atk', doubleBlock: '2×Blk', impact: 'Impact', nullifyImpact: 'Null', damage: v > 1 ? `Dmg ${v}` : '' })[k]).filter(Boolean) : [];
  return `<div class="fc ${c.rest ? 'rest' : ''} ${cls}" data-iid="${esc(c.iid)}" data-no="${esc(c.no)}" style="background-image:url('${esc(d.img || '')}')" title="${esc(d.name || '')}">
    ${c.bp != null ? `<span class="bp ${bpCls}">${c.bp}</span>` : ''}
    ${c.under?.length ? `<span class="stack">+${c.under.length}</span>` : ''}
    ${kws.length ? `<span class="kws">${kws.map((k) => `<span>${k}</span>`).join('')}</span>` : ''}</div>`;
}
function classFor(c) {
  const v = st.view;
  const out = [];
  if (st.picks.has(c.iid)) out.push('sel');
  if (v?.pending?.options?.includes(c.iid) && v.pending.seat === v.you) out.push('can');
  if (v?.battle && (v.battle.att === c.iid || v.battle.blocker === c.iid || v.battle.target === c.iid)) out.push('att');
  if (v?.legal?.some((a) => a.iid === c.iid && ['play', 'move', 'attack', 'activate'].includes(a.type))) out.push('can');
  return out.join(' ');
}
function lane(cards, tag) {
  return `<div class="lane"><span class="tag">${tag}</span>${cards.map((c) => cardEl(c, { cls: classFor(c) })).join('')}</div>`;
}
function mat(p, mine) {
  const gen = Object.entries(p.energyGen || {}).filter(([k, n]) => k !== 'any' && n).map(([k, n]) => `<span class="dot ${k}"></span>${n}`).join(' ');
  const meta = `<div class="meta"><b>${esc(p.name)}</b>
    <span class="pill life">♥ ${p.life}</span><span class="pill">Deck ${p.deck}</span><span class="pill">Hand ${Array.isArray(p.hand) ? p.hand.length : p.hand}</span>
    <div class="ap">${p.ap.map((a) => `<i class="${a ? '' : 'rest'}" title="AP ${a ? 'active' : 'resting'}"></i>`).join('')}</div>
    <span class="ua-note">${gen || 'no energy'}</span></div>`;
  const piles = `<div class="piles"><button data-pile="side" data-seat="${mine ? 'me' : 'opp'}">Sideline ${p.side.length}</button><button data-pile="removal" data-seat="${mine ? 'me' : 'opp'}">Removal ${p.removal.length}</button>${p.check.length ? `<span>Checking: ${p.check.map((c) => esc(D(c.no).name)).join(', ')}</span>` : ''}</div>`;
  const lines = mine ? lane(p.front, 'Front') + lane(p.energy, 'Energy') : lane(p.energy, 'Energy') + lane(p.front, 'Front');
  return `<div class="ua-mat ${mine ? 'me' : 'opp'}">${meta}<div class="lines">${lines}</div>${piles}</div>`;
}

const PHASE_NEXT = { start: 'Go to movement', move: 'Go to main phase', main: 'Go to attack', attack: 'End turn' };
function promptHtml() {
  const v = st.view;
  const p = v.pending;
  if (v.winner != null) {
    return `<div class="prompt"><div class="winner">${v.winner === v.you ? 'You win!' : `${esc(v.players[v.winner].name)} wins`}</div>
      <div class="acts"><button class="btn btn-gold" data-do="rematch">Back to the table</button><a class="btn btn-quiet" href="/ua">Decks</a></div></div>`;
  }
  if (!p) return '<div class="prompt"><div class="msg">…</div></div>';
  if (p.seat !== v.you) return `<div class="prompt"><div class="msg">Waiting for ${esc(v.players[p.seat].name)}…</div><div class="ua-note">${esc(p.prompt || '')}</div></div>`;
  const legal = v.legal || [];
  let body = '';
  switch (p.type) {
    case 'mulligan': body = '<button class="btn btn-gold" data-a=\'{"type":"mulligan","redraw":false}\'>Keep</button><button class="btn" data-a=\'{"type":"mulligan","redraw":true}\'>Mulligan</button>'; break;
    case 'phase': {
      const extra = legal.find((a) => a.type === 'extraDraw');
      body = `${extra ? '<button class="btn" data-a=\'{"type":"extraDraw"}\'>Extra draw (1 AP)</button>' : ''}<button class="btn btn-gold" data-a='{"type":"next"}'>${PHASE_NEXT[p.phase]}</button>`;
      const hint = { start: '', move: 'Click a character on your energy line to move it up (Step characters can move back).', main: 'Click a card in your hand to play it, or a card on your field to use its ability.', attack: 'Click an active front line character to attack.' }[p.phase];
      return `<div class="prompt"><div class="msg">${esc(p.prompt)}</div>${hint ? `<div class="ua-note">${hint}</div>` : ''}<div class="acts">${body}</div><div class="acts"><button class="btn btn-danger btn-sm" data-do="concede">Concede</button></div></div>`;
    }
    case 'block': body = `${p.must ? '' : '<button class="btn" data-a=\'{"type":"block","iid":null}\'>Don’t block</button>'}<span class="ua-note">Or click a highlighted character to block.</span>`; break;
    case 'yesno': body = '<button class="btn btn-gold" data-a=\'{"type":"yesno","yes":true}\'>Yes</button><button class="btn" data-a=\'{"type":"yesno","yes":false}\'>No</button>'; break;
    case 'trigger': {
      const raids = legal.filter((a) => a.raidOnto);
      body = `<button class="btn btn-gold" data-a='{"type":"trigger","use":true}'>${p.trigger.type === 'raid' ? 'Add to hand' : 'Use trigger'}</button>
        ${raids.map((a) => `<button class="btn" data-a='${esc(JSON.stringify(a))}'>Raid onto ${esc(D(cardNo(a.raidOnto)).name)}</button>`).join('')}
        <button class="btn btn-quiet" data-a='{"type":"trigger","use":false}'>Don’t use</button>`;
      break;
    }
    case 'choose': {
      const n = st.picks.size;
      const okCount = n >= p.min && n <= p.max;
      if (p.labels) {
        body = `<div class="opts">${p.options.map((o, i) => `<button class="lbl-opt ${st.picks.has(o) ? 'sel' : ''}" data-pick="${esc(o)}">${esc(p.labels[i])}</button>`).join('')}</div>`;
      } else {
        const offBoard = p.options.filter((o) => !onBoard(o));
        body = offBoard.length ? `<div class="opts">${offBoard.map((o) => cardEl({ iid: o, no: p.optCards?.[o] }, { cls: st.picks.has(o) ? 'sel' : '' })).join('')}</div>` : '<span class="ua-note">Click the highlighted cards.</span>';
      }
      body += `<div class="acts"><button class="btn btn-gold" data-do="confirm" ${okCount ? '' : 'disabled'}>Confirm${p.max > 1 ? ` (${n})` : ''}</button>${p.min === 0 ? '<button class="btn btn-quiet" data-do="none">Choose none</button>' : ''}</div>`;
      break;
    }
    case 'manual':
      body = `<div class="ua-note">Ink can’t run this ability yet. Resolve it by hand: click cards for table actions, then press Done.</div>
        <div class="acts"><button class="btn btn-sm" data-a='{"type":"manual","op":"draw","n":1}'>Draw 1</button><button class="btn btn-sm" data-a='{"type":"manual","op":"ap","active":true}'>AP → active</button><button class="btn btn-sm" data-a='{"type":"manual","op":"ap","active":false}'>AP → resting</button><button class="btn btn-sm" data-a='{"type":"manual","op":"shuffle"}'>Shuffle deck</button></div>
        <button class="btn btn-gold" data-a='{"type":"manualDone"}'>Done</button>`;
      return `<div class="prompt"><div class="msg">${esc(D(cardNo(p.card)).name || 'Ability')}</div><div>${fmt(p.manualText || p.text || '')}</div>${body}</div>`;
    default: body = '';
  }
  return `<div class="prompt"><div class="msg">${esc(p.prompt || '')}</div><div class="acts">${body}</div></div>`;
}
const fmt = (t) => esc(t).replace(/\[([^\]]+)\]/g, '<b>[$1]</b>');
function cardNo(iid) {
  const v = st.view;
  for (const p of v.players) for (const z of ['front', 'energy', 'side', 'removal', 'check', 'hand']) if (Array.isArray(p[z])) { const c = p[z].find((x) => x.iid === iid); if (c) return c.no; }
  return v.pending?.optCards?.[iid];
}
function onBoard(iid) {
  const v = st.view;
  return v.players.some((p) => ['front', 'energy'].some((z) => p[z].some((c) => c.iid === iid)));
}
function chatHtml() {
  return `<div class="panel" style="gap:6px"><div class="log" style="max-height:140px">${st.chat.slice(-30).map((m) => `<div><b>${esc(m.from)}</b>: ${esc(m.text)}</div>`).join('') || '<span class="ua-note">Chat</span>'}</div><input id="chatIn" placeholder="Say something…" maxlength="300"></div>`;
}
function renderBoard() {
  const v = st.view;
  const me = v.players[v.you], opp = v.players[1 - v.you];
  st.mySeat = v.you;
  const handCards = Array.isArray(me.hand) ? me.hand : [];
  return `<div class="ua-play">
    <div class="ua-board">
      ${mat(opp, false)}
      <div class="ua-note" style="text-align:center">${v.active === v.you ? 'Your' : `${esc(opp.name)}’s`} turn · ${esc(v.phase)}${v.spectator ? ' · spectating' : ''}</div>
      ${mat(me, true)}
      <div class="hand">${handCards.map((c) => cardEl(c, { cls: classFor(c) })).join('') || '<span class="ua-note">No cards in hand</span>'}</div>
    </div>
    <div class="side-panel">
      ${promptHtml()}
      <div class="log" id="log">${v.log.map((l) => `<div class="${/^—/.test(l.text) ? 'turn' : ''}">${esc(l.text)}</div>`).join('')}</div>
      <input id="chatIn" placeholder="Chat…" maxlength="300" style="background:var(--ink-panel);color:var(--fg);border:1px solid var(--line-cool);border-radius:10px;padding:8px 10px">
    </div></div>`;
}

function render() {
  const app = $('#app');
  const focusChat = document.activeElement?.id === 'chatIn';
  app.innerHTML = st.view && st.room?.started ? renderBoard() : renderLobby();
  const log = $('#log'); if (log) log.scrollTop = log.scrollHeight;
  if (focusChat) $('#chatIn')?.focus();
  if (st.room && !st.room.started) {
    const sel = $('[data-deck]');
    sel?.addEventListener('change', () => { if (sel.value) send({ t: 'setDeck', deck: deckMsg(sel.value) }); });
    const bsel = $('[data-botdeck]');
    bsel?.addEventListener('change', () => { if (bsel.value) send({ t: 'botDeck', deck: deckMsg(bsel.value) }); });
  }
}

// ---------- clicks ----------
function closeMenu() { st.menu?.remove(); st.menu = null; }
function menu(x, y, items, hint = '') {
  closeMenu();
  if (!items.length && !hint) return;
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = (hint ? `<div class="hint">${hint}</div>` : '') + items.map((it, i) => `<button data-i="${i}">${esc(it.label)}</button>`).join('');
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  m.onclick = (e) => { const b = e.target.closest('[data-i]'); if (!b) return; const it = items[Number(b.dataset.i)]; closeMenu(); it.run(); };
  st.menu = m;
}

function clickCard(el, ev) {
  const v = st.view;
  if (!v || v.spectator) return;
  const iid = el.dataset.iid, no = el.dataset.no;
  const p = v.pending;
  const legal = v.legal || [];
  const d = D(no);
  // replacing a card on a full line
  if (st.pendingReplace) {
    const a = { ...st.pendingReplace, remove: iid };
    st.pendingReplace = null;
    act(a);
    return;
  }
  if (p?.seat === v.you && p.type === 'choose' && p.options?.includes(iid)) {
    if (st.picks.has(iid)) st.picks.delete(iid); else { if (p.max === 1) st.picks.clear(); st.picks.add(iid); }
    render();
    return;
  }
  if (p?.seat === v.you && p.type === 'block' && p.options.includes(iid)) { act({ type: 'block', iid }); return; }
  if (p?.seat === v.you && p.type === 'manual') {
    const mine = true;
    menu(ev.clientX, ev.clientY, [
      { label: 'Switch to resting', run: () => act({ type: 'manual', op: 'rest', iid, rest: true }) },
      { label: 'Switch to active', run: () => act({ type: 'manual', op: 'rest', iid, rest: false }) },
      { label: '+1000 BP (this turn)', run: () => act({ type: 'manual', op: 'bp', iid, n: 1000 }) },
      { label: '−1000 BP (this turn)', run: () => act({ type: 'manual', op: 'bp', iid, n: -1000 }) },
      { label: 'Sideline', run: () => act({ type: 'manual', op: 'sideline', iid }) },
      { label: 'Return to hand', run: () => act({ type: 'manual', op: 'move', iid, to: 'hand' }) },
      { label: 'Bottom of deck', run: () => act({ type: 'manual', op: 'move', iid, to: 'deckBottom' }) },
      { label: 'Into sideline (placed)', run: () => act({ type: 'manual', op: 'move', iid, to: 'side' }) },
      { label: 'Removal area', run: () => act({ type: 'manual', op: 'move', iid, to: 'removal' }) },
      { label: 'Play to front line', run: () => act({ type: 'manual', op: 'move', iid, to: 'front' }) },
      { label: 'Play to energy line', run: () => act({ type: 'manual', op: 'move', iid, to: 'energy' }) },
    ].filter(() => mine), d.name);
    return;
  }
  const mineActs = legal.filter((a) => a.iid === iid);
  const items = [];
  const nm = (i) => D(cardNo(i)).name;
  for (const a of mineActs) {
    if (a.type === 'play') {
      if (a.raid) items.push({ label: `Raid onto ${nm(a.onto)}`, run: () => act(a) });
      else if (a.line) items.push({ label: `Play to ${a.line === 'front' ? 'front line' : 'energy line'}`, run: () => act(a) });
      else items.push({ label: `Use ${d.name}`, run: () => act(a) });
    }
    if (a.type === 'move') items.push({ label: el.closest('.lane')?.textContent.startsWith('Front') ? 'Move to energy line (Step)' : 'Move to front line', run: () => act(a) });
    if (a.type === 'attack') items.push({ label: a.target ? `Snipe ${nm(a.target)}` : 'Attack', run: () => act(a) });
    if (a.type === 'activate') {
      items.push({ label: `Activate: ${String(a.label || '').replace(/\[[^\]]+\]\s*/g, '').slice(0, 70)}…`, run: () => {
        if (a.needDiscard) {
          const hand = v.players[v.you].hand;
          const pick = hand.slice(0, a.needDiscard).map((c) => c.iid);
          if (!confirm(`This costs ${a.needDiscard} card(s) from your hand. Discard ${hand.slice(0, a.needDiscard).map((c) => D(c.no).name).join(', ')}?`)) return;
          act({ ...a, discard: pick });
        } else act(a);
      } });
    }
  }
  // a full line: offer to play there anyway by replacing a card
  const inHand = Array.isArray(v.players[v.you].hand) && v.players[v.you].hand.some((c) => c.iid === iid);
  if (inHand && p?.type === 'phase' && p.phase === 'main' && p.seat === v.you && (d.type === 'character' || d.type === 'site')) {
    for (const line of d.type === 'site' ? ['energy'] : ['front', 'energy']) {
      if (v.players[v.you][line].length >= 4 && !mineActs.some((a) => a.line === line)) {
        items.push({ label: `Play to ${line === 'front' ? 'front line' : 'energy line'}, replacing a card…`, run: () => { st.pendingReplace = { type: 'play', iid, line }; notice(`Click the card on your ${line === 'front' ? 'front line' : 'energy line'} to put into your removal area.`); } });
      }
    }
  }
  if (inHand && p?.type === 'phase' && p.phase === 'move' && p.seat === v.you) { /* nothing from hand in movement */ }
  // a full front line in movement: replace
  if (p?.type === 'phase' && p.phase === 'move' && p.seat === v.you && v.players[v.you].energy.some((c) => c.iid === iid) && v.players[v.you].front.length >= 4 && d.type === 'character') {
    items.push({ label: 'Move to front line, replacing a card…', run: () => { st.pendingReplace = { type: 'move', iid }; notice('Click the front line card to put into your removal area.'); } });
  }
  menu(ev.clientX, ev.clientY, items, items.length ? '' : esc(d.name || ''));
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.menu')) return;
  const x = e.target.closest('[data-close]'); if (x) { x.closest('dialog')?.close(); return; }
  const card = e.target.closest('.fc[data-iid]');
  if (card && !card.closest('dialog')) { clickCard(card, e); return; }
  closeMenu();
  const pick = e.target.closest('[data-pick]');
  if (pick) { const p = st.view.pending; const o = pick.dataset.pick; if (st.picks.has(o)) st.picks.delete(o); else { if (p.max === 1) st.picks.clear(); st.picks.add(o); } render(); return; }
  const a = e.target.closest('[data-a]');
  if (a) { act(JSON.parse(a.dataset.a)); return; }
  const pile = e.target.closest('[data-pile]');
  if (pile) { showPile(pile.dataset.seat, pile.dataset.pile); return; }
  const join = e.target.closest('[data-join]');
  if (join) { ls.set(NAME, myName()); send({ t: 'join', code: join.dataset.join, name: myName() }); st.mySeat = 1; return; }
  const d = e.target.closest('[data-do]');
  if (!d) return;
  const w = d.dataset.do;
  if (w === 'bot' || w === 'room') { ls.set(NAME, myName()); st.myName = myName(); st.mySeat = 0; send({ t: 'create', name: myName(), vsBot: w === 'bot' }); loadMyDecks().then(render); }
  if (w === 'join') { ls.set(NAME, myName()); st.mySeat = 1; send({ t: 'join', code: $('#codeIn').value.trim().toUpperCase(), name: myName() }); loadMyDecks().then(render); }
  if (w === 'rooms') send({ t: 'rooms' });
  if (w === 'leave') { send({ t: 'leave' }); st.room = null; st.view = null; history.replaceState(null, '', '/ua/play'); render(); }
  if (w === 'ready') { const s = st.room.seats[st.room.you]; send({ t: 'ready', ready: !s?.ready }); }
  if (w === 'start') send({ t: 'start' });
  if (w === 'rematch') send({ t: 'rematch' });
  if (w === 'concede' && confirm('Concede this game?')) act({ type: 'concede' });
  if (w === 'confirm') act({ type: 'choose', picks: [...st.picks] });
  if (w === 'none') act({ type: 'choose', picks: [] });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeMenu(); st.pendingReplace = null; }
  if (e.key === 'Enter' && e.target.id === 'chatIn' && e.target.value.trim()) { send({ t: 'chat', text: e.target.value }); e.target.value = ''; }
});
// big card on hover
document.addEventListener('mouseover', (e) => {
  const c = e.target.closest('.fc[data-no]');
  const peek = $('#peek');
  if (!c || matchMedia('(hover: none)').matches) { peek.style.display = 'none'; return; }
  const d = D(c.dataset.no);
  if (!d.img) return;
  peek.src = d.img;
  const r = c.getBoundingClientRect();
  peek.style.display = 'block';
  peek.style.left = `${r.right + 270 > innerWidth ? r.left - 270 : r.right + 10}px`;
  peek.style.top = `${Math.max(8, Math.min(innerHeight - 370, r.top - 60))}px`;
});
function showPile(who, zone) {
  const v = st.view; if (!v) return;
  const p = v.players[who === 'me' ? v.you : 1 - v.you];
  $('#pileTitle').textContent = `${p.name} · ${zone === 'side' ? 'Sideline' : 'Removal area'}`;
  $('#pileBody').innerHTML = p[zone].map((c) => `<div class="ua-card"><img src="${esc(D(c.no).img)}" alt="${esc(D(c.no).name)}"></div>`).join('') || '<p class="ua-note">Empty.</p>';
  $('#pileModal').showModal();
}

// start from a deck link (/ua/play?deck=<id>): open a bot table with it
(async function init() {
  await loadMyDecks();
  connect();
  const q = new URLSearchParams(location.search);
  const want = q.get('deck');
  if (want && !q.get('room')) {
    const wait = setInterval(() => {
      if (st.ws?.readyState !== 1 || !st.token) return;
      clearInterval(wait);
      if (!st.room) { st.mySeat = 0; send({ t: 'create', name: myName(), vsBot: true }); setTimeout(() => send({ t: 'setDeck', deck: { id: want } }), 300); }
    }, 200);
  }
  render();
})();
