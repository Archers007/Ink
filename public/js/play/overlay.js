// Ink ▸ Play — HTML cues over the 3D table: the big "Your turn" banner, the tab title on your turn, and the card
// spotlight at the right edge (what the opponent just played or used, and the card you're choosing targets for).
export function createOverlay({ $, esc, IMG, D, cardLabel, isMobile, board }) {
  const baseTitle = document.title;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- the turn banner: centred on the table's middle line, scales in and fades out ----
  let cueTimer = null;
  function turnCue(text, mine) {
    const el = $('#turnCue');
    if (!el) return;
    clearTimeout(cueTimer);
    el.textContent = text;
    el.className = mine ? 'mine' : 'theirs';
    const mid = board.toScreen({ x: 0, y: 0, z: 0 });
    el.style.top = `${Math.round(Math.max(80, Math.min(innerHeight - 80, mid.y)))}px`;
    el.style.left = `${Math.round(Math.max(160, Math.min(innerWidth - 160, mid.x)))}px`;
    el.hidden = false;
    void el.offsetWidth;                                        // restart the animation when two turns come close together
    el.classList.add('go');
    cueTimer = setTimeout(() => { el.hidden = true; el.classList.remove('go'); }, reduced() ? 1200 : 1700);
  }

  // ---- the tab title: "● Your turn" while it's your move, so a player in another tab sees it come round ----
  function title(mine) {
    const t = mine ? `● Your turn · ${baseTitle}` : baseTitle;
    if (document.title !== t) document.title = t;
  }

  // ---- the spotlight: a large card at the right edge ----
  // A transient one (the opponent's play) shows for a moment over the steady one (the card you're choosing targets
  // for), which comes back when it's gone.
  let steady = null, flash = null, flashTimer = null;
  function draw() {
    const el = $('#spot');
    if (!el) return;
    const s = flash || steady;
    if (!s || !D(s.cardId)) { el.hidden = true; el.dataset.card = ''; return; }
    const d = D(s.cardId);
    const key = `${s.cardId}|${s.caption}|${s.kind}`;
    if (el.dataset.key !== key) {
      el.innerHTML = `<span class="sp-cap">${esc(s.caption)}</span>
        <div class="sp-card ${d.type === 'location' ? 'land' : ''}" data-card="${esc(s.cardId)}" data-zoom="${esc(s.cardId)}" title="${esc(cardLabel(d))} — show it full size"><img src="${IMG(s.cardId)}" alt="${esc(cardLabel(d))}"></div>
        ${s.sub ? `<span class="sp-sub">${esc(s.sub)}</span>` : ''}`;
      el.dataset.key = key;
      el.className = s.kind;
      if (s === flash && !reduced()) { void el.offsetWidth; el.classList.add('in'); }
    }
    el.hidden = false;
  }
  function spotlight(cardId, caption, sub = '') {
    clearTimeout(flashTimer);
    flash = { cardId, caption, sub, kind: 'flash' };
    draw();
    flashTimer = setTimeout(() => { flash = null; draw(); }, 2600);
  }
  // the card whose ability or action is choosing targets (desktop: phones have the prompt bar's own picture)
  function source(cardId, caption = 'Choosing for', sub = '') {
    const next = cardId && !isMobile() ? { cardId, caption, sub, kind: 'src' } : null;
    if (JSON.stringify(next) === JSON.stringify(steady)) return;
    steady = next;
    draw();
  }
  function clear() { clearTimeout(flashTimer); flash = null; steady = null; draw(); }
  return { turnCue, title, spotlight, source, clear };
}
