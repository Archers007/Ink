// The coach — admins only. With it on, the server runs the hard bot's analysis (game/searchbot.js, the same search the
// "Ink Bot" plays with) for your seat every time it's your turn or your choice, and this shows the result: the top
// moves with their scores, and a gold marker on the cards the best one uses. It only suggests — nothing is played for
// you; hover another move to see its cards marked instead. On the opening hand it advises what to put on the bottom
// (game/analysis/mulligan.js); the mulligan dialog in main.js shows that through coach.mulligan().
//
//   const coach = createCoach({ net, board, view: () => S.view, you, esc, isAdmin: () => account.user()?.role === 'admin' });
//   coach.onMessage(m) for 'coach' / 'coachState' · coach.onGame() after each game update · coach.button(el)
//   coach.mulligan() → null (not an admin) or { on, advice } · coach.toggle(on?) · onMull() is called when that changes

const MAX_MOVES = 4;

export function createCoach({ net, board, view, you, esc, isAdmin, onMull = () => {} }) {
  const S = { on: false, data: null, error: null, hover: 0, raf: 0, mull: null };
  const box = document.createElement('div');
  box.id = 'coachBox'; box.hidden = true; box.setAttribute('aria-live', 'polite');
  const marks = document.createElement('div');
  marks.id = 'coachMarks';
  document.body.append(box, marks);
  let btn = null;

  const mine = () => {
    const v = view();
    return !!v && v.status === 'playing' && you() >= 0 && (v.pending ? v.pending.seat === you() : v.active === you());
  };
  // the cards a move involves, in the order they matter (the card played / attacker first)
  const cardsOf = (a) => [a?.iid, a?.attacker, a?.target, ...(a?.singers || []), ...(a?.targets || []), a?.location].filter((x) => x != null);
  const fmt = (x) => (x >= 150 ? 'wins' : x <= -150 ? 'loses' : `${x > 0 ? '+' : ''}${x.toFixed(1)}`);

  function render() {
    if (btn) {
      btn.hidden = !isAdmin() || !view() || view().status !== 'playing' || you() < 0;
      btn.classList.toggle('on', S.on);
      btn.setAttribute('aria-pressed', String(S.on));
      btn.textContent = S.on ? '🧭 Coach on' : '🧭 Coach';
    }
    if (!S.on || !isAdmin() || !view() || view().status !== 'playing') { box.hidden = true; document.body.classList.remove('coaching'); clearMarks(); return; }
    const d = S.data;
    let body;
    if (!mine()) body = '<p class="cb-note">Suggestions appear on your turn and when you have a choice to make.</p>';
    else if (S.error) body = `<p class="cb-note">The engine couldn't analyze this: ${esc(S.error)}</p>`;
    else if (!d) body = '<p class="cb-note cb-think">Thinking…</p>';
    else body = `<ol>${d.moves.slice(0, MAX_MOVES).map((mv, i) => `<li data-i="${i}" class="${i === S.hover ? 'on' : ''}"><span class="cb-rank">${i + 1}</span><span class="cb-label">${esc(mv.label)}</span><b class="cb-score ${mv.score >= 0 ? 'up' : 'down'}" title="Lore ahead by your next turn${mv.pm ? `, ±${mv.pm}` : ''}">${fmt(mv.score)}</b></li>`).join('')}</ol>`;
    box.innerHTML = `<div class="cb-head"><span class="cb-title">Coach</span>${d && mine() ? `<b class="cb-eval ${d.eval >= 0 ? 'up' : 'down'}" title="Expected lore lead by your next turn">${fmt(d.eval)}</b>` : ''}<span class="cb-sub">suggestions only</span><button class="cb-x" aria-label="Turn the coach off" title="Turn the coach off">✕</button></div>${body}`;
    box.hidden = false;
    box.classList.toggle('idle', !mine() || !d);              // phones hide it until there's a suggestion to show
    document.body.classList.toggle('coaching', !box.hidden && mine() && !!d);
    box.querySelector('.cb-x').onclick = () => toggle(false);
    // phones show one line (the best move); tapping it opens the full list over the table, tapping again folds it
    box.querySelector('ol')?.addEventListener('click', () => box.classList.toggle('open'));
    box.querySelectorAll('li[data-i]').forEach((li) => {
      li.onmouseenter = li.onfocus = () => { S.hover = Number(li.dataset.i); paintRows(); };
      li.onmouseleave = () => { S.hover = 0; paintRows(); };
      li.tabIndex = 0;
    });
    startMarks();
  }
  function paintRows() { box.querySelectorAll('li[data-i]').forEach((li) => li.classList.toggle('on', Number(li.dataset.i) === S.hover)); }

  // gold rings on the cards the highlighted move uses; they follow the cards while they move
  function clearMarks() { cancelAnimationFrame(S.raf); S.raf = 0; marks.innerHTML = ''; marks.dataset.key = ''; }
  function startMarks() {
    if (S.raf) return;
    const tick = () => {
      S.raf = 0;
      const mv = S.on && mine() && S.data?.moves?.[S.hover];
      const ids = mv ? cardsOf(mv.action) : [];
      const rects = ids.map((iid) => board.cardRect?.(iid)).filter(Boolean);
      const key = `${S.hover}:${rects.length}`;
      if (marks.dataset.key !== key) { marks.dataset.key = key; marks.innerHTML = rects.map((_, i) => `<i class="cm ${i === 0 ? 'main' : ''}" ${i === 0 ? `data-n="${S.hover + 1}"` : ''}></i>`).join(''); }
      rects.forEach((r, i) => {
        const m = marks.children[i];
        m.style.cssText = `left:${r.left - 4}px;top:${r.top - 4}px;width:${r.right - r.left + 8}px;height:${r.bottom - r.top + 8}px`;
      });
      if (rects.length || (S.on && mine())) S.raf = requestAnimationFrame(tick);
    };
    S.raf = requestAnimationFrame(tick);
  }

  function toggle(on = !S.on) {
    S.on = on; S.data = null; S.error = null; S.hover = 0; S.mull = null;
    net.send({ t: 'coach', on });
    render();
    onMull();
  }

  return {
    button(el) { btn = el; el.onclick = () => toggle(); render(); },
    onMessage(m) {
      if (m.t === 'coachState') { S.on = !!m.on; if (!S.on) { S.data = null; S.error = null; S.mull = null; } render(); onMull(); return true; }
      if (m.t === 'coach' && m.mulligan) { S.mull = m.mulligan; onMull(); return true; }
      if (m.t === 'coach') { S.error = m.error || null; S.data = m.error ? null : m; S.hover = 0; render(); if (m.error) onMull(); return true; }
      return false;
    },
    // a new position: the old suggestions no longer apply; the server sends fresh ones
    onGame() { if (S.on) { S.data = null; S.error = null; S.hover = 0; } if (view()?.status !== 'mulligan') S.mull = null; render(); },
    // the opening-hand advice for the mulligan dialog; advice is null while the engine thinks
    mulligan() { return isAdmin() ? { on: S.on, advice: S.mull, error: S.mull ? null : S.error } : null; },
    toggle,
    // after a reconnect the server has forgotten; ask again
    resume() { if (S.on) net.send({ t: 'coach', on: true }); },
    render,
  };
}
