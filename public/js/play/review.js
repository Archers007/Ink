// Game review on a replay, chess.com style (game/analysis/review.js on the server). It starts by itself: every
// finished game with a person in it is queued for the engine as it's saved, and opening a replay that isn't done yet
// moves it to the front. Then it shows:
//   both players' accuracy, and how many of their moves were great / best / good / inaccuracies / mistakes / blunders
//   the evaluation graph over the whole game (from the watched seat's side) with the big moments marked; click, drag
//     or arrow-key along it to move through the game
//   the move made from the position on screen, rated, with the engine's best move when it wasn't that
//   previous / next key moment, and an eval bar beside the table
//
//   const review = createReview({ replay: () => S.replay, showFrame, stopReplay, isMobile, esc, moveName, toast, onChange })
//   review.open(R) when a replay loads · review.render() after every frame · review.toggle() · review.state(R)

export const CLS = {
  great: { name: 'Great', glyph: '!', css: 'great' },
  best: { name: 'Best', glyph: '★', css: 'best' },
  good: { name: 'Good', glyph: '✓', css: 'good' },
  inaccuracy: { name: 'Inaccuracy', glyph: '?!', css: 'inac' },
  mistake: { name: 'Mistake', glyph: '?', css: 'mist' },
  blunder: { name: 'Blunder', glyph: '??', css: 'blun' },
  forced: { name: 'Only move', glyph: '□', css: 'forced' },
};
const ORDER = ['great', 'best', 'good', 'inaccuracy', 'mistake', 'blunder'];
const KEY = new Set(['great', 'inaccuracy', 'mistake', 'blunder']);   // the moments worth jumping to
const SCALE = 5;                                                       // a 5-lore lead fills ~76% of the graph's half
const squash = (e) => Math.tanh(e / SCALE);                            // ±150 ("wins") pins to the edge
const fmt = (x) => (x >= 150 ? 'wins' : x <= -150 ? 'loses' : `${x > 0 ? '+' : ''}${(Math.round(x * 10) / 10).toFixed(1)}`);

export function createReview({ replay, showFrame, stopReplay, isMobile, esc, moveName, toast, onChange = () => {} }) {
  const box = document.getElementById('reviewBox');
  const bar = document.createElement('div');
  bar.id = 'evalBar'; bar.hidden = true; bar.setAttribute('aria-hidden', 'true');
  bar.innerHTML = '<div class="eb-fill"></div><span class="eb-num"></span>';
  document.getElementById('hud').append(bar);

  // ---------- fetching ----------
  async function open(R) {
    const url = `/api/replays/${encodeURIComponent(R.id)}/review`;
    R.showReview ??= true;
    let g = await fetch(url).then((x) => x.json()).catch(() => null);
    if (replay() !== R) return;
    if (g?.state === 'done') { R.review = g.review; onChange(); return; }
    if (!g || g.state === 'none' || g.state === 'failed') {
      const r = await fetch(url, { method: 'POST' });
      g = await r.json().catch(() => ({}));
      if (replay() !== R) return;
      if (!r.ok) { R.reviewing = null; R.reviewError = g.error || 'The engine is busy.'; onChange(); return; }
    }
    R.reviewing = { progress: g.progress || [0, 0], ahead: g.ahead };
    onChange();
    const poll = async () => {
      if (replay() !== R) return;
      const p = await fetch(url).then((x) => x.json()).catch(() => null);
      if (replay() !== R) return;
      if (p?.state === 'done') { R.review = p.review; R.reviewing = null; onChange(); return; }
      if (p?.state === 'failed' || p?.state === 'none') { R.reviewing = null; R.reviewError = p?.error || 'The review stopped.'; toast(`Review failed: ${R.reviewError}`, 'err'); onChange(); return; }
      R.reviewing = { progress: p?.progress || [0, 0], ahead: p?.ahead };
      render();
      setTimeout(poll, 1200);
    };
    setTimeout(poll, 1000);
  }
  function toggle() {
    const R = replay();
    if (!R) return;
    R.showReview = R.showReview === false;
    if (R.showReview && !R.review && !R.reviewing) { R.reviewError = null; open(R); }
    onChange();
  }
  const state = (R) => (R?.review ? 'done' : R?.reviewing ? 'running' : R?.reviewError ? 'failed' : 'none');

  // ---------- the numbers behind the graph ----------
  function model(R) {
    const rv = R.review, fr = R.data.frames, seat = R.data.seat;
    if (R._model?.rv === rv && R._model.fr === fr && R._model.seat === seat) return R._model;
    const frameOf = (k) => { const i = fr.findIndex((f) => f.k === k - 1); return i < 0 ? null : i; };
    const pts = [];
    for (const m of rv.moves) {
      const x = frameOf(m.k);
      if (x == null || !Number.isFinite(m.eval)) continue;           // no eval for that position: the line holds
      pts.push({ x, e: m.who === seat ? m.eval : -m.eval, m });
    }
    // the last point is the result: whoever won is off the chart
    const last = fr.length - 1;
    if (rv.winner != null && R.data.complete !== false) pts.push({ x: last, e: rv.winner === seat ? 150 : -150, end: true });
    else if (pts.length) pts.push({ x: last, e: pts[pts.length - 1].e, end: true });
    const turns = [];
    fr.forEach((f, i) => { if (i && f.view.turn !== fr[i - 1].view.turn) turns.push(i); });
    const keys = pts.filter((q) => q.m && KEY.has(q.m.cls)).map((q) => q.x);
    return (R._model = { rv, fr, seat, pts, turns, keys, last: Math.max(1, last), names: R.data.seats.map((s) => s.name) });
  }
  // the evaluation for the position on screen: the latest one at or before it
  function evalAt(md, i) {
    let e = 0;
    for (const p of md.pts) { if (p.x > i) break; e = p.e; }
    return e;
  }

  // ---------- drawing ----------
  function graphSvg(md) {
    const W = 1000, H = 100, X = (x) => (x / md.last) * W, Y = (e) => H / 2 - squash(e) * (H / 2 - 3);
    if (!md.pts.length) return '';
    // a step line: the evaluation holds until the next decision
    let line = `M0 ${Y(0)}`, y = Y(0);
    for (const p of md.pts) { line += ` L${X(p.x)} ${y} L${X(p.x)} ${Y(p.e)}`; y = Y(p.e); }
    line += ` L${W} ${y}`;
    const grid = md.turns.map((x) => `<line x1="${X(x)}" x2="${X(x)}" y1="0" y2="${H}" class="rg-turn"/>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="rg-svg" aria-hidden="true">
      <rect x="0" y="0" width="${W}" height="${H}" class="rg-bg"/>${grid}
      <path d="${line} L${W} ${H} L0 ${H} Z" class="rg-area"/><line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="rg-mid"/>
      <path d="${line}" class="rg-line" vector-effect="non-scaling-stroke"/></svg>`;
  }
  // the marks sit in HTML over the stretched SVG, so they stay round
  function marksHtml(md) {
    return md.pts.filter((p) => p.m && KEY.has(p.m.cls)).map((p) => {
      const c = CLS[p.m.cls];
      return `<button class="rg-mark ${c.css} ${p.m.who === md.seat ? '' : 'opp'}" style="left:${(p.x / md.last) * 100}%;top:${50 - squash(p.e) * 47}%" data-jump="${p.x}"
        title="Turn ${p.m.turn} · ${esc(md.names[p.m.who])}: ${esc(moveName(p.m.played))} · ${c.name}${p.m.loss ? ` (−${p.m.loss})` : ''}" aria-label="Turn ${p.m.turn}, ${esc(md.names[p.m.who])}: ${c.name}"></button>`;
    }).join('');
  }

  function render() {
    const R = replay();
    renderBar(R);
    if (!R || R.showReview === false || (!R.review && !R.reviewing && !R.reviewError)) { box.hidden = true; box.dataset.key = ''; return; }
    // desktop: top of the right column, over the log, covering none of the table; phones: floating under the replay bar
    const home = isMobile() ? document.getElementById('hud') : document.getElementById('side');
    if (box.parentElement !== home) { home.prepend(box); box.dataset.key = ''; }
    box.hidden = false;
    const rb = document.getElementById('replayBar');
    box.style.top = isMobile() && !rb.hidden ? `${Math.round(rb.getBoundingClientRect().bottom + 6)}px` : '';
    if (!R.review) { box.dataset.key = ''; progress(R); return; }
    const md = model(R);
    // the graph, accuracy and table are drawn once; stepping through the game (or dragging along the graph, which
    // needs its element to stay put) only moves the cursor and rewrites the move below it
    const key = `${R.id}:${R.data.seat}:${md.pts.length}`;
    if (box.dataset.key !== key || !box.querySelector('#rvGraph')) { shell(R, md); box.dataset.key = key; }
    follow(R, md);
  }
  const closeBtn = '<button class="sm ghost" id="rvX" aria-label="Hide the review" title="Hide the review">✕</button>';
  function progress(R) {
    const [d, t] = R.reviewing?.progress || [0, 0];
    const pct = t ? Math.round((100 * d) / t) : 0;
    box.innerHTML = `<div class="rv-head"><span class="lbl">Game review</span>${closeBtn}</div>
      ${R.reviewError ? `<p class="muted small">${esc(R.reviewError)} <button class="sm" id="rvRetry">Try again</button></p>`
        : `<p class="muted small">${R.reviewing?.ahead > 1 ? `Waiting for the engine (${R.reviewing.ahead - 1} game${R.reviewing.ahead > 2 ? 's' : ''} ahead)…` : t ? `The engine is going through the game: ${d} of ${t} decisions` : 'Starting the engine…'}</p>
        <div class="rv-prog" role="progressbar" aria-label="Review progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>`}`;
    box.querySelector('#rvX').onclick = toggle;
    box.querySelector('#rvRetry')?.addEventListener('click', () => { R.reviewError = null; open(R); });
  }
  function shell(R, md) {
    const rv = R.review, seat = R.data.seat, other = 1 - seat;
    const p = (s) => rv.players[s] || { accuracy: null, counts: {} };
    const acc = (s) => `<div class="rv-pl ${s === seat ? 'me' : ''}"><span class="rv-nm">${esc(md.names[s])}</span><b class="rv-acc">${p(s).accuracy ?? '—'}</b><small>accuracy</small></div>`;
    box.innerHTML = `<div class="rv-head"><span class="lbl">Game review</span>${closeBtn}</div>
      <div class="rv-acc2">${acc(seat)}<span class="rv-vs">vs</span>${acc(other)}</div>
      <div class="rv-graph" id="rvGraph" role="slider" tabindex="0" aria-label="Evaluation over the game: click, drag or use the arrow keys to move through it" aria-valuemin="0" aria-valuemax="${md.last}">
        ${graphSvg(md)}<i class="rg-cursor"></i>${marksHtml(md)}<span class="rg-tip" hidden></span></div>
      <div class="rv-axis"><span>${esc(md.names[seat])} ahead ↑</span><span id="rvPos"></span></div>
      <div id="rvNow"></div>
      <div class="rv-nav"><button class="sm" id="rvPrev" title="The previous great move, inaccuracy, mistake or blunder">◀ Key moment</button><button class="sm" id="rvNext" title="The next great move, inaccuracy, mistake or blunder">Key moment ▶</button></div>
      <table class="rv-tab"><thead><tr><th></th><th>${esc(md.names[seat])}</th><th>${esc(md.names[other])}</th></tr></thead><tbody>
        ${ORDER.map((c) => `<tr><td><span class="rv-c ${CLS[c].css}"><i>${CLS[c].glyph}</i>${CLS[c].name}</span></td><td>${p(seat).counts?.[c] ?? 0}</td><td>${p(other).counts?.[c] ?? 0}</td></tr>`).join('')}
      </tbody></table>`;
    box.querySelector('#rvX').onclick = toggle;
    bindGraph(box.querySelector('#rvGraph'), md);
    box.querySelector('#rvPrev').onclick = () => { const i = replay().i; const x = [...md.keys].reverse().find((k) => k < i); if (x != null) jump(x); };
    box.querySelector('#rvNext').onclick = () => { const i = replay().i; const x = md.keys.find((k) => k > i); if (x != null) jump(x); };
  }
  function follow(R, md) {
    const rv = R.review, fr = R.data.frames;
    const next = rv.moves.find((m) => m.k === fr[R.i].k + 1);       // the move made from the position on screen
    box.querySelector('.rg-cursor').style.left = `${(R.i / md.last) * 100}%`;
    box.querySelector('#rvGraph').setAttribute('aria-valuenow', String(R.i));
    box.querySelector('#rvGraph').setAttribute('aria-valuetext', `Turn ${fr[R.i].view.turn}, ${fmt(evalAt(md, R.i))}`);
    box.querySelector('#rvPos').textContent = `turn ${fr[R.i].view.turn} · ${fmt(evalAt(md, R.i))}`;
    box.querySelector('#rvNow').innerHTML = next ? nowHtml(next, md) : `<div class="rv-now muted small">${R.i >= md.last ? endText(rv, md) : 'Step forward to a decision to see how it rates.'}</div>`;
    box.querySelector('#rvPrev').disabled = !md.keys.some((k) => k < R.i);
    box.querySelector('#rvNext').disabled = !md.keys.some((k) => k > R.i);
  }
  function nowHtml(m, md) {
    const c = CLS[m.cls];
    const better = !['best', 'great', 'forced'].includes(m.cls) && m.best;
    const why = m.cls === 'great' ? 'every other move gave up 2+ lore' : m.cls === 'best' ? 'the engine agrees' : m.cls === 'forced' ? 'nothing else to do' : m.loss ? `gave up ${m.loss} lore` : '';
    return `<div class="rv-now"><span class="rv-badge ${c.css}" aria-hidden="true">${c.glyph}</span><div><b>${esc(md.names[m.who])}</b>: ${esc(moveName(m.played))}
      <div class="rv-why"><span class="rv-c ${c.css}">${c.name}</span>${why ? ` <span class="muted">${why}</span>` : ''}</div>
      ${better ? `<div class="rv-best"><span class="muted">Best was</span> ${esc(moveName(m.best))} <span class="muted">(${fmt(m.bestScore)})</span></div>` : ''}</div></div>`;
  }
  const endText = (rv, md) => (rv.winner == null ? 'The game stopped here.' : `${esc(md.names[rv.winner])} won on turn ${rv.finalTurn ?? '?'}.`);
  function jump(x) { stopReplay(); showFrame(Math.max(0, x)); }

  function bindGraph(g, md) {
    const tip = g.querySelector('.rg-tip');
    const xAt = (ev) => { const r = g.getBoundingClientRect(); return Math.round(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * md.last); };
    const near = (x) => md.pts.reduce((b, q) => (q.m && Math.abs(q.x - x) < Math.abs((b?.x ?? 1e9) - x) ? q : b), null);
    let dragging = false;
    g.onpointerdown = (ev) => { if (ev.target.closest('.rg-mark')) return; dragging = true; g.setPointerCapture(ev.pointerId); jump(xAt(ev)); };
    g.onpointermove = (ev) => {
      const x = xAt(ev);
      if (dragging) { if (x !== replay()?.i) jump(x); return; }
      const q = near(x);
      if (!q) { tip.hidden = true; return; }
      tip.hidden = false;
      tip.textContent = `Turn ${q.m.turn} · ${md.names[q.m.who]}: ${moveName(q.m.played)} · ${CLS[q.m.cls].name} · ${fmt(q.e)}`;
      tip.style.left = `${Math.min(55, Math.max(0, (q.x / md.last) * 100 - 20))}%`;
    };
    g.onpointerup = g.onpointercancel = () => { dragging = false; };
    g.onpointerleave = () => { tip.hidden = true; };
    g.onkeydown = (ev) => {
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') { ev.preventDefault(); jump(replay().i + (ev.key === 'ArrowRight' ? 1 : -1)); }
      if (ev.key === 'Home' || ev.key === 'End') { ev.preventDefault(); jump(ev.key === 'Home' ? 0 : md.last); }
    };
    g.querySelectorAll('[data-jump]').forEach((b) => { b.onclick = () => jump(+b.dataset.jump); });
  }

  // the bar beside the table: how the position on screen stands, from the watched seat's side
  function renderBar(R) {
    if (!R?.review || R.showReview === false || isMobile()) { bar.hidden = true; return; }
    const md = model(R);
    const e = evalAt(md, R.i);
    bar.hidden = false;
    bar.querySelector('.eb-fill').style.height = `${50 + squash(e) * 50}%`;
    bar.querySelector('.eb-num').textContent = fmt(e);
    bar.classList.toggle('down', e < 0);
    bar.title = `Engine: ${fmt(e)} lore for ${md.names[R.data.seat]} by their next turn`;
  }

  return { open, toggle, render, state };
}
