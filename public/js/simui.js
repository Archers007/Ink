// "Test deck": the engine plays the deck in the builder against other decks on the server (lib/sim.js) and the
// report comes back here — matchups, game plan, weaknesses, strengths, combos, mulligan and per-card numbers.
// Optional live preview: one of the games is played at a watchable pace and shown as it goes.
import * as account from './account.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IMG = (id) => `https://cdn.dreamborn.ink/images/en/cards/${id}`;
const pctS = (p) => `${Math.round(p * 100)}%`;
const POLL_MS = 800;

let ctx = null;          // { getDeck: () => {name, cards}, onRole(role), applyCards(cards) }
let fix = null;          // auto-fix: { job, state, locks:Set, data }
let run = null;          // { id, timer }
let last = null;         // last poll payload
let demo = null;

export function init(options) { ctx = options; }

export async function open() {
  const deck = ctx.getDeck();
  $('#simDeckName').textContent = deck.name || 'this deck';
  $('#simModal').classList.add('show');
  if (run && !last?.done) return;                        // a test is running: keep showing it
  await renderSetup(deck);
}

function api(path, opts = {}) {
  return fetch(path, { ...opts, headers: { 'content-type': 'application/json' } }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
    return j;
  });
}

// ---------- setup ----------
async function renderSetup(deck) {
  const body = $('#simBody');
  const total = deck.cards.reduce((n, [, q]) => n + q, 0);
  body.innerHTML = '<div class="note">Loading opponents…</div>';
  demo ||= await api('/api/play/demo-decks').catch(() => []);
  const mine = (await account.listDecks().catch(() => [])).filter((d) => d.cards.reduce((n, [, q]) => n + q, 0) >= 40 && d.name !== deck.name);
  const shared = (await account.communityDecks().catch(() => ({ decks: [] }))).decks.filter((d) => (d.size || 0) >= 40).slice(0, 8);
  const past = account.signedIn() ? (await api('/api/sim').catch(() => ({ runs: [] }))).runs.filter((r) => r.deck === deck.name) : [];
  const opt = (kind, id, label, checked, sub = '') => `<label class="opp"><input type="checkbox" data-kind="${kind}" data-id="${esc(id)}" ${checked ? 'checked' : ''}> <span>${esc(label)}${sub ? ` <small>${esc(sub)}</small>` : ''}</span></label>`;
  body.innerHTML = `
    ${total < 40 ? `<div class="strip bad"><span class="txt">The deck has ${total} cards. Add at least 40 (60 to be legal) to test it.</span></div>` : ''}
    <p class="note">The engine plays your deck against the decks you pick, on the server. Both sides are played by a bot that only knows what a player at the table would: its own hand, the board, both decklists and what's been revealed.</p>
    <div class="sim-grid">
      <fieldset class="sim-box"><legend class="lbl">Opponents</legend>
        <div class="opps">${demo.map((d) => opt('demo', d.id, d.name.replace(/^Demo:\s*/, ''), true, 'starter')).join('')}
          ${mine.map((d) => opt('mine', d.id, d.name, false, 'mine')).join('')}
          ${shared.map((d) => opt('shared', d.id, d.name, false, `by ${d.author}`)).join('')}</div>
      </fieldset>
      <fieldset class="sim-box"><legend class="lbl">How</legend>
        <label class="field">Bot
          <select id="simPilot" class="field-in"><option value="quick">Quick: fast, many games (good for numbers)</option><option value="smart">Smart: the Hard bot, plans ahead (slower, up to 30 games a matchup)</option></select></label>
        <label class="field">Games per opponent <select id="simGames" class="field-in"><option>20</option><option selected>50</option><option>100</option><option>200</option><option>300</option></select></label>
        <label class="check"><input type="checkbox" id="simPreview"> Watch one game as it's played</label>
        <p class="note" id="simEstimate"></p>
      </fieldset>
    </div>
    ${past.length ? `<p class="note">Earlier tests of this deck: ${past.slice(0, 5).map((r) => `<button class="linkish" data-past="${esc(r.id)}">${new Date(r.created).toLocaleString()}</button>`).join(' · ')}</p>` : ''}
    <div class="sim-actions"><span id="simErr" class="warn small"></span><button class="btn btn-gold" id="simRun" ${total < 40 ? 'disabled' : ''}>Run test</button></div>`;
  const estimate = () => {
    const n = body.querySelectorAll('.opps input:checked').length;
    const smart = $('#simPilot').value === 'smart';
    const per = smart ? Math.min(30, +$('#simGames').value) : +$('#simGames').value;
    const games = n * per;
    const secs = smart ? games * 2 : games * 0.07;
    $('#simEstimate').textContent = n ? `${games} games · about ${secs < 90 ? `${Math.max(5, Math.round(secs))} seconds` : `${Math.round(secs / 60)} minutes`}${$('#simPreview').checked ? ' (the watched game plays slowly)' : ''}.` : 'Pick at least one opponent.';
  };
  body.querySelectorAll('input, select').forEach((x) => x.addEventListener('change', estimate));
  estimate();
  body.querySelectorAll('[data-past]').forEach((b) => b.onclick = async () => { try { const j = await api(`/api/sim/${b.dataset.past}`); last = j; renderRun(j); } catch (e) { $('#simErr').textContent = e.message; } });
  $('#simRun').onclick = async () => {
    const opponents = [...body.querySelectorAll('.opps input:checked')].map((x) => ({ kind: x.dataset.kind, id: x.dataset.id }));
    try {
      const j = await api('/api/sim', { method: 'POST', body: JSON.stringify({ deck, opponents, games: +$('#simGames').value, pilot: $('#simPilot').value, preview: $('#simPreview').checked }) });
      start(j.id);
    } catch (e) { $('#simErr').textContent = e.message; }
  };
}

// ---------- running ----------
function start(id) {
  stop();
  run = { id };
  last = null;
  $('#simBody').innerHTML = '<div class="note">Starting…</div>';
  poll();
}
function stop() { if (run?.timer) clearTimeout(run.timer); }
async function poll() {
  if (!run) return;
  try {
    const j = await api(`/api/sim/${run.id}`);
    last = j;
    if ($('#simModal').classList.contains('show')) renderRun(j);
    if (!j.done) run.timer = setTimeout(poll, POLL_MS);
  } catch (e) {
    $('#simBody').innerHTML = `<div class="strip bad"><span class="txt">${esc(e.message)}</span></div>`;
  }
}

const clock = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function renderRun(j) {
  const body = $('#simBody');
  const keepOpen = new Set([...body.querySelectorAll('details[open]')].map((d) => d.dataset.k));
  const prog = j.total ? j.finished / j.total : 0;
  body.innerHTML = `
    <div class="sim-progress">
      <div class="bar"><i style="width:${Math.round(prog * 100)}%"></i></div>
      <span>${j.done ? (j.cancelled ? 'Stopped' : 'Done') : j.queued ? `Waiting for the simulator (${j.queued} ahead)` : 'Playing'} · ${j.finished} of ${j.total} games · ${clock(j.elapsedMs || 0)}${j.failed ? ` · ${j.failed} failed` : ''}</span>
      ${j.done ? `${!j.cancelled && j.report ? '<button class="btn btn-gold btn-sm" id="simFix" title="Try swaps for the weaknesses and keep the ones that win more">Auto-fix</button>' : ''}<button class="btn btn-sm" id="simAgain">New test</button>` : '<button class="btn btn-quiet btn-sm" id="simCancel">Stop</button>'}
    </div>
    ${fix && fix.run === j.id ? fixHtml(j.report) : ''}
    ${j.preview ? previewHtml(j.preview) : ''}
    ${j.report ? reportHtml(j.report, j.done) : '<p class="note">The first results show up after a few games.</p>'}`;
  body.querySelectorAll('details[data-k]').forEach((d) => { if (keepOpen.has(d.dataset.k)) d.open = true; });
  $('#simCancel')?.addEventListener('click', () => api(`/api/sim/${run.id}/cancel`, { method: 'POST' }).catch(() => {}));
  $('#simAgain')?.addEventListener('click', () => { run = null; last = null; fix = null; renderSetup(ctx.getDeck()); });
  $('#simFix')?.addEventListener('click', () => { if (!fix || fix.run !== j.id) fix = { run: j.id, state: 'setup', locks: new Set() }; renderRun(j); $('#simBody').scrollTop = 0; });
  bindFix(j);
  body.querySelectorAll('[data-role]').forEach((b) => b.onclick = () => { $('#simModal').classList.remove('show'); ctx.onRole(b.dataset.role); });
}

function previewHtml(f) {
  const row = (cards) => cards.map((c) => `<img src="${IMG(c.cardId)}" alt="" class="${c.exerted ? 'ex' : ''}" loading="lazy">${c.damage ? `<b class="dmg">${c.damage}</b>` : ''}`).join('');
  return `<div class="sim-preview">
    <div class="pv-head"><span class="lbl">Watching game ${f.game} · vs ${esc(f.oppName)}</span><span>Turn ${f.turn} · ${f.active === 'you' ? 'your deck' : 'opponent'} to play</span></div>
    <div class="pv-side"><span class="pv-who">Opponent <b>${f.opp.lore}</b> lore · ${f.opp.hand} in hand · ${f.opp.ink} ink</span><div class="pv-row">${row(f.opp.play)}</div></div>
    <div class="pv-mid"></div>
    <div class="pv-side"><div class="pv-row">${row(f.me.play)}</div><span class="pv-who">Your deck <b>${f.me.lore}</b> lore · ${f.me.ink} ink</span><div class="pv-row hand">${f.me.hand.map((id) => `<img src="${IMG(id)}" alt="" loading="lazy">`).join('')}</div></div>
    <ol class="pv-log">${f.log.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>
  </div>`;
}

// ---------- auto-fix ----------
const winTxt = (w) => `${Math.round(w.p * 100)}%`;
function fixHtml(report) {
  if (fix.state === 'setup') {
    const names = (report.cards || []).map((c) => c.name);
    return `<div class="fix-panel"><h3 class="display">Auto-fix</h3>
      <p class="note">Tap the cards auto-fix must keep (your combo pieces). It proposes swaps for the weaknesses above, plays each one on the same ${'games'} as your list, and keeps a swap only if it wins clearly more. It uses the Quick bot, so lock cards the bot doesn't play well.</p>
      <div class="fix-locks">${names.map((n) => `<button class="lock ${fix.locks.has(n) ? 'on' : ''}" data-lock="${esc(n)}">${fix.locks.has(n) ? '🔒 ' : ''}${esc(n)}</button>`).join('')}</div>
      <div class="sim-actions"><span class="note">About 1–3 minutes.</span><button class="btn btn-gold" id="fixGo">Find improvements</button></div></div>`;
  }
  const d = fix.data;
  if (!d) return '<div class="fix-panel"><p class="note">Starting auto-fix…</p></div>';
  const prog = d.total ? Math.round((d.done / d.total) * 100) : 0;
  const tried = d.rounds.flatMap((r, i) => r.tried.map((t) => ({ ...t, round: i + 1 })));
  return `<div class="fix-panel"><h3 class="display">Auto-fix</h3>
    ${d.state === 'running' ? `<div class="sim-progress"><div class="bar"><i style="width:${prog}%"></i></div><span>Testing swaps · ${d.done} of up to ${d.total} lists</span><button class="btn btn-quiet btn-sm" id="fixStop">Stop</button></div>` : ''}
    ${d.before ? `<p>Your list: <b>${winTxt(d.before.win)}</b> wins over ${d.before.games} games${d.after && d.state !== 'running' ? ` → with the changes: <b>${winTxt(d.after.win)}</b> (same games)` : ''}.</p>` : ''}
    ${d.changes.length ? `<div class="finding good"><b>Kept</b>${d.changes.map((c) => `<p>−${c.n} ${esc(c.cut)} · +${c.n} ${esc(c.put)} <span class="muted">(${esc(c.why)}, +${c.gain} points)</span></p>`).join('')}</div>` : d.state !== 'running' ? '<div class="finding info"><b>No swap won clearly more.</b><p>Your list stays as it is. Try locking fewer cards, or test against different decks.</p></div>' : ''}
    ${tried.length ? `<details data-k="fixtried"><summary>Every swap it tried (${tried.length})</summary><table class="sim-table"><thead><tr><th>Round</th><th>Out</th><th>In</th><th>For</th><th>Wins</th><th>Change</th></tr></thead><tbody>
      ${tried.map((t) => `<tr><td>${t.round}</td><td>−${t.n} ${esc(t.cut)}</td><td>+${t.n} ${esc(t.put)}</td><td>${esc(t.why)}</td><td>${winTxt(t.win)}</td><td class="${t.gain > 0 ? 'ok' : t.gain < 0 ? 'warn' : ''}">${t.gain > 0 ? '+' : ''}${t.gain}${t.kept ? ' ✓' : ''}</td></tr>`).join('')}</tbody></table></details>` : ''}
    ${d.rounds.at(-1)?.note && d.state !== 'running' ? `<p class="note">${esc(d.rounds.at(-1).note)}</p>` : ''}
    ${d.state === 'failed' ? `<div class="strip bad"><span class="txt">${esc(d.error || 'Auto-fix failed.')}</span></div>` : ''}
    ${d.state !== 'running' && d.changes.length ? '<div class="sim-actions"><span class="note">Results come from bot games; check the swaps make sense for how you play.</span><button class="btn btn-gold" id="fixApply">Apply to my deck</button></div>' : ''}
  </div>`;
}
function bindFix(j) {
  if (!fix || fix.run !== j.id) return;
  const body = $('#simBody');
  body.querySelectorAll('[data-lock]').forEach((b) => b.onclick = () => { const n = b.dataset.lock; fix.locks.has(n) ? fix.locks.delete(n) : fix.locks.add(n); renderRun(j); });
  $('#fixGo')?.addEventListener('click', async () => {
    try {
      const r = await api(`/api/sim/${j.id}/autofix`, { method: 'POST', body: JSON.stringify({ locks: [...fix.locks] }) });
      fix.state = 'running'; fix.job = r.job; fix.data = null;
      renderRun(j);
      pollFix(j);
    } catch (e) { alert(e.message); }
  });
  $('#fixStop')?.addEventListener('click', () => api(`/api/sim/autofix/${fix.job}/cancel`, { method: 'POST' }).catch(() => {}));
  $('#fixApply')?.addEventListener('click', () => { ctx.applyCards(fix.data.cards); $('#simModal').classList.remove('show'); });
}
async function pollFix(j) {
  if (!fix?.job) return;
  try {
    fix.data = await api(`/api/sim/autofix/${fix.job}`);
    fix.state = fix.data.state === 'running' ? 'running' : 'done';
    if ($('#simModal').classList.contains('show') && last?.id === j.id) renderRun(last);
    if (fix.data.state === 'running') setTimeout(() => pollFix(j), 1500);
  } catch (e) { fix.state = 'done'; fix.data = { ...(fix.data || {}), state: 'failed', error: e.message, rounds: [], changes: [] }; renderRun(last); }
}

// ---------- report ----------
const range = (r) => `${r.ci[0]}–${r.ci[1]}%`;
const sev = { high: 'High', medium: 'Medium', info: 'Note' };
function deltaHtml(d) {
  if (!d) return '<span class="muted">—</span>';
  return `<span class="${d.real ? (d.d > 0 ? 'ok' : 'warn') : 'muted'}" title="${d.nWith} games with, ${d.nWithout} without${d.real ? '' : ' · within noise'}">${d.d > 0 ? '+' : ''}${d.d} ±${d.pm}</span>`;
}
function curveSvg(me, opp) {
  const W = 320, H = 110, P = 18;
  const pts = (arr) => arr.map((v, i) => (v == null ? null : [P + (i * (W - 2 * P)) / 9, H - P - (v / 20) * (H - 2 * P)])).filter(Boolean);
  const line = (p, cls) => (p.length > 1 ? `<polyline class="${cls}" points="${p.map((x) => x.join(',')).join(' ')}"/>` : '');
  return `<svg viewBox="0 0 ${W} ${H}" class="curve-svg" role="img" aria-label="Average lore by turn">
    <line x1="${P}" x2="${W - P}" y1="${P}" y2="${P}" class="goal"/><text x="${W - P}" y="${P - 4}" text-anchor="end">20 lore</text>
    ${Array.from({ length: 10 }, (_, i) => `<text x="${P + (i * (W - 2 * P)) / 9}" y="${H - 3}" text-anchor="middle">${i + 1}</text>`).join('')}
    ${line(pts(opp), 'opp')}${line(pts(me), 'me')}</svg>`;
}
function reportHtml(r, done) {
  const facts = r.facts;
  const sec = (k, title, inner, open = false) => `<details data-k="${k}" ${open ? 'open' : ''}><summary>${title}</summary><div class="sec">${inner}</div></details>`;
  return `<div class="sim-report">
    <div class="sim-summary">
      <div class="big"><b>${pctS(r.overall.p)}</b><span>wins over ${r.games} games<br><small>95% range ${range(r.overall)}</small></span></div>
      <div class="facts">${facts.size} cards · ${facts.inkablePct}% inkable · average cost ${facts.avgCost} · ${r.settings.pilot === 'smart' ? 'Smart bot' : 'Quick bot'}${done ? '' : ' · <em>still running</em>'}</div>
      ${r.settings.legal ? '' : `<div class="strip"><span class="txt">Not tournament-legal: ${esc(r.settings.problems.join('; '))}</span></div>`}
    </div>
    <div class="sim-cols">
      <section><h3 class="display">Weaknesses</h3>
        ${r.weaknesses.length ? r.weaknesses.map((w) => `<div class="finding ${w.severity}"><span class="sev">${sev[w.severity]}</span><b>${esc(w.title)}</b><p>${esc(w.detail)}</p>${w.fix ? `<p class="fix">${esc(w.fix)}${w.role ? ` <button class="linkish" data-role="${w.role}">Show ${w.role === 'draw' ? 'card draw' : w.role} in the pool</button>` : ''}</p>` : ''}</div>`).join('') : '<p class="note">Nothing stood out.</p>'}
      </section>
      <section><h3 class="display">Strengths</h3>
        ${r.strengths.length ? r.strengths.map((w) => `<div class="finding good"><b>${esc(w.title)}</b><p>${esc(w.detail)}</p></div>`).join('') : '<p class="note">Nothing stood out yet.</p>'}
        <h3 class="display">Combos</h3>
        ${r.combos.filter((c) => c.delta.real).length ? r.combos.filter((c) => c.delta.real).map((c) => `<div class="finding good"><b>${esc(c.cards[0])} + ${esc(c.cards[1])}</b><p>On the board together in ${c.games} games: ${pctS(c.win.p)} wins (+${c.delta.d} ±${c.delta.pm} points against the rest).</p></div>`).join('') : `<p class="note">No pair of cards clearly wins more when they're out together${r.games < 300 ? ' yet; more games will show the stronger ones' : ''}.</p>`}
        <p class="note">Combos and key cards are patterns in these games, not proof one card causes the other's wins.</p>
      </section>
    </div>
    ${sec('match', 'Matchups', `<table class="sim-table"><thead><tr><th>Against</th><th>Games</th><th>Wins</th><th>Going first</th><th>Going second</th><th>Win on turn</th></tr></thead><tbody>
      ${r.matchups.map((m) => `<tr><td>${esc(m.name)}</td><td>${m.games}</td><td><b>${pctS(m.win.p)}</b> <small>${range(m.win)}</small></td><td>${m.onPlay.n ? pctS(m.onPlay.p) : '—'}</td><td>${m.onDraw.n ? pctS(m.onDraw.p) : '—'}</td><td>${m.winTurn || '—'}</td></tr>`).join('')}</tbody></table>`, true)}
    ${sec('plan', 'Game plan', `<div class="plan">
      <div>${curveSvg(r.plan.loreByTurn, r.plan.oppLoreByTurn)}<p class="note"><span class="key me"></span> your deck · <span class="key opp"></span> opponents · average lore at the end of each of your turns</p></div>
      <ul class="plan-facts"><li>Wins on its turn <b>${r.plan.winTurn || '—'}</b> on average</li><li><b>${r.plan.questsPerGame}</b> quests and <b>${r.plan.challengesPerGame}</b> challenges a game</li><li><b>${r.plan.playsPerTurn}</b> cards played a turn</li>
        <li>Curve: ${facts.curve.map((n, i) => `${i + 1}${i === 6 ? '+' : ''}: ${n}`).join(' · ')}</li><li>Roles: ${Object.entries(facts.roles).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'}</li></ul></div>`)}
    ${sec('mull', 'Mulligan', `
      ${r.mulligan.shipped.length ? `<p>Sent back most: ${r.mulligan.shipped.map((c) => `${esc(c.name)} (${c.perGame} a game)`).join(', ')}.</p>` : '<p class="note">The bot rarely sent cards back.</p>'}
      ${r.mulligan.keep.length ? `<p class="ok">Wins more when in the starting hand: ${r.mulligan.keep.map((c) => `${esc(c.name)} (+${c.d} ±${c.pm})`).join(', ')}.</p>` : ''}
      ${r.mulligan.avoid.length ? `<p class="warn">Wins less when in the starting hand: ${r.mulligan.avoid.map((c) => `${esc(c.name)} (${c.d} ±${c.pm})`).join(', ')}.</p>` : ''}
      <p class="note">The starting hand is the hand after the mulligan.</p>`)}
    ${sec('cards', 'Cards', `<table class="sim-table cards"><thead><tr><th>Card</th><th>Copies</th><th title="Played per game">Played</th><th title="Put into the inkwell per game">Inked</th><th title="Average turn it was played">Turn</th><th title="Still in hand when the game ended, per game">Stuck</th><th title="Win rate when played minus when not, in points">Win when played</th><th title="Win rate when in the starting hand minus when not">In starting hand</th></tr></thead><tbody>
      ${r.cards.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.copies}</td><td>${c.playedPerGame}</td><td>${c.inkedPerGame}</td><td>${c.avgTurnPlayed ?? '—'}</td><td>${c.stuckPerGame}</td><td>${deltaHtml(c.playedDelta)}</td><td>${deltaHtml(c.openingDelta)}</td></tr>`).join('')}</tbody></table>
      <p class="note">Win numbers are in points with a 95% range; grey means within noise.</p>`)}
  </div>`;
}
