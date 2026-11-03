// /report — anyone, signed in or not, sends a bug report or a feature request, with as many images as they like.
// Each image uploads on its own as soon as it's added (POST /api/feedback/images, shrunk first if it's huge), so the
// report itself is small; it lands on the /admin issue board and the issue worker files it on GitHub. Nothing here
// starts Claude (lib/reports.js).
//
//   /report?kind=feature  opens on "Feature request"

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const OK_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_SIDE = 2560;                      // bigger photos are scaled down before upload; screenshots rarely are
const SHRINK_OVER = 3 * 1024 * 1024;
const PARALLEL = 3;

const KIND = {
  bug: { ico: '🐞', name: 'Bug report', d: 'Something broke or did the wrong thing.', title: 'Hard bot skips its turn after Shift', body: 'What you did, what you expected, and what happened instead. Card names, the deck, and whether it happens every time all help.', need: 'Describe what happened.' },
  feature: { ico: '✨', name: 'Feature request', d: 'An idea that would make Ink better.', title: 'Filter the card pool by keyword', body: "What you'd like and why it would help. If you've seen it done well somewhere, say where.", need: 'Describe the idea.' },
};

const params = new URL(location.href).searchParams;
const S = {
  kind: params.get('kind') === 'feature' ? 'feature' : 'bug',
  images: [],                               // { id, file, url (object URL), state: 'wait'|'up'|'ok'|'err', key?, error? }
  user: null, maxMb: 6, sending: false, nextId: 1,
  from: params.get('from') || (document.referrer && new URL(document.referrer).origin === location.origin ? document.referrer : ''),
};
const box = () => $('#app .box');

async function boot() {
  let cfg;
  try { cfg = await (await fetch('/api/feedback', { cache: 'no-store' })).json(); } catch { cfg = { open: false, error: true } }
  if (!cfg.open) {
    box().innerHTML = `<h1>Reports are closed</h1><p class="lede">${cfg.error ? "Couldn't reach Ink just now. Try again in a minute." : "We're not taking reports through this page right now."} You can still open an issue on <a href="https://github.com/Archers007/Ink/issues" target="_blank" rel="noopener">GitHub</a>.</p>`;
    return;
  }
  S.user = cfg.user; S.maxMb = cfg.maxImageMb || 6;
  build();
}

function build() {
  box().innerHTML = `
    <h1>Help make Ink better</h1>
    <p class="lede">Found a bug or have an idea? Tell us here. Everything sent goes on the Ink issue board and becomes a public GitHub issue, so leave out passwords, emails and anything private.</p>
    <div class="kinds" role="radiogroup" aria-label="What are you sending?">
      ${Object.entries(KIND).map(([k, v]) => `<button type="button" class="kind" role="radio" data-kind="${k}" aria-checked="${S.kind === k}"><span class="ico" aria-hidden="true">${v.ico}</span><span><b>${v.name}</b><span class="d">${v.d}</span></span></button>`).join('')}
    </div>
    <label for="fTitle">Title</label>
    <input id="fTitle" type="text" maxlength="140" autocomplete="off">
    <label for="fBody" id="fBodyLbl"></label>
    <textarea id="fBody" maxlength="20000"></textarea>
    <label>Images <span class="note">(optional · as many as you like · PNG, JPEG, GIF or WebP · pasting works)</span></label>
    <div class="drop" id="drop" tabindex="0" role="button" aria-label="Add images">Drop images here, <b>choose files</b>, or paste a screenshot</div>
    <input type="file" id="fFile" accept="image/*" multiple hidden>
    <div class="thumbs" id="thumbs"></div>
    ${S.user ? `<p class="warnline">Sending as <b>${esc(S.user.name)}</b>.</p>` : `<label for="fName">Your name <span class="note">(optional · shown on the issue)</span></label><input id="fName" type="text" maxlength="40" autocomplete="nickname" placeholder="Leave blank to stay anonymous">`}
    <div class="hp" aria-hidden="true"><label for="fSite">Website</label><input id="fSite" type="text" tabindex="-1" autocomplete="off"></div>
    <div class="row"><button class="btn btn-gold btn-lg" id="fSend">Send</button><span class="msg" id="fMsg" role="status"></span></div>`;
  box().querySelectorAll('[data-kind]').forEach((b) => { b.onclick = () => setKind(b.dataset.kind); });
  // arrow keys move between the two choices, as a radio group should
  box().querySelector('.kinds').onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); setKind(S.kind === 'bug' ? 'feature' : 'bug'); box().querySelector(`[data-kind="${S.kind}"]`).focus();
  };
  const drop = $('#drop'), file = $('#fFile');
  drop.onclick = () => file.click();
  drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } };
  file.onchange = () => { addFiles([...file.files]); file.value = ''; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...(e.dataTransfer?.files || [])]); };
  document.onpaste = (e) => {
    const files = [...(e.clipboardData?.items || [])].filter((it) => it.kind === 'file' && it.type.startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  };
  $('#fSend').onclick = send;
  $('#fTitle').oninput = $('#fBody').oninput = () => msg('');
  setKind(S.kind);
  paintThumbs();
}

function setKind(k) {
  S.kind = k;
  box().querySelectorAll('[data-kind]').forEach((b) => { const on = b.dataset.kind === k; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
  $('#fTitle').placeholder = KIND[k].title;
  $('#fBody').placeholder = KIND[k].body;
  $('#fBodyLbl').textContent = k === 'bug' ? 'What happened' : 'Your idea';
  $('#fSend').textContent = k === 'bug' ? 'Send bug report' : 'Send feature request';
  const u = new URL(location.href); u.searchParams.set('kind', k); history.replaceState(null, '', u);
}

// ---------- images ----------
function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    S.images.push({ id: S.nextId++, file: f, url: URL.createObjectURL(f), state: 'wait' });
  }
  paintThumbs();
  pump();
}

function paintThumbs() {
  const label = { wait: 'Waiting…', up: 'Uploading…', ok: '', err: '' };
  $('#thumbs').innerHTML = S.images.map((im) => `<div class="th ${im.state}" data-id="${im.id}"><img src="${im.url}" alt="">
    <button class="x" data-rm="${im.id}" aria-label="Remove this image" title="Remove">✕</button>
    ${im.state !== 'ok' ? `<span class="state">${im.state === 'err' ? esc(im.error) : label[im.state]}</span>` : ''}</div>`).join('');
  $('#thumbs').querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => removeImage(Number(b.dataset.rm)); });
  sendState();
}
function removeImage(id) {
  const im = S.images.find((x) => x.id === id);
  if (im) URL.revokeObjectURL(im.url);
  S.images = S.images.filter((x) => x.id !== id);
  paintThumbs();
}

// a few uploads at a time, in the order they were added
function pump() {
  const busy = S.images.filter((x) => x.state === 'up').length;
  S.images.filter((x) => x.state === 'wait').slice(0, Math.max(0, PARALLEL - busy)).forEach(upload);
}
async function upload(im) {
  im.state = 'up'; paintThumbs();
  try {
    const blob = await prepare(im.file);
    if (blob.size > S.maxMb * 1048576) throw new Error(`Over ${S.maxMb} MB`);
    const r = await fetch('/api/feedback/images', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`);
    im.key = j.key; im.state = 'ok';
  } catch (e) { im.state = 'err'; im.error = e.message.length > 60 ? 'Upload failed' : e.message; if (e.message.length > 60) msg(e.message, true); }
  if (S.images.includes(im)) paintThumbs();
  pump();
}
// big photos are scaled down; formats the server doesn't take (HEIC, BMP…) are redrawn as JPEG. GIFs go as they are,
// so an animated one stays animated.
async function prepare(f) {
  if (f.type === 'image/gif') return f;
  const okType = OK_TYPES.includes(f.type);
  if (okType && f.size <= SHRINK_OVER) return f;
  let bmp;
  try { bmp = await createImageBitmap(f); } catch { if (okType) return f; throw new Error("Can't read this image"); }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (okType && scale === 1 && f.size <= S.maxMb * 1048576) { bmp.close?.(); return f; }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const type = f.type === 'image/png' ? 'image/webp' : 'image/jpeg';    // screenshots keep their sharp text as WebP
  return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Can't shrink this image"))), type, 0.88));
}

// ---------- sending ----------
const msg = (text, err = false) => { const m = $('#fMsg'); if (!m) return; m.textContent = text; m.classList.toggle('err', err); };
function sendState() {
  const b = $('#fSend'); if (!b) return;
  const uploading = S.images.some((x) => x.state === 'wait' || x.state === 'up');
  b.disabled = S.sending || uploading;
  if (uploading) msg(`Uploading ${S.images.filter((x) => x.state === 'wait' || x.state === 'up').length} image(s)…`);
  else if ($('#fMsg').textContent.startsWith('Uploading')) msg('');
}

async function send() {
  const title = $('#fTitle').value.trim(), body = $('#fBody').value.trim();
  if (title.length < 4) { msg('Give it a short title.', true); $('#fTitle').focus(); return; }
  if (body.length < 10) { msg(KIND[S.kind].need, true); $('#fBody').focus(); return; }
  const failed = S.images.filter((x) => x.state === 'err').length;
  if (failed && !confirm(`${failed} image${failed > 1 ? "s didn't" : " didn't"} upload. Send without ${failed > 1 ? 'them' : 'it'}?`)) return;
  S.sending = true; sendState(); msg('Sending…');
  try {
    const r = await fetch('/api/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: S.kind, title, body, name: $('#fName')?.value || '', website: $('#fSite').value,
        images: S.images.filter((x) => x.state === 'ok').map((x) => x.key),
        context: { page: S.from, browser: navigator.userAgent, screen: `${screen.width}×${screen.height}` },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Couldn't send it (${r.status})`);
    done(j);
  } catch (e) { S.sending = false; sendState(); msg(e.message, true); }
}

function done(j) {
  S.images.forEach((x) => URL.revokeObjectURL(x.url));
  const kind = S.kind;
  S.images = []; S.sending = false;
  box().innerHTML = `<div class="done"><div class="big" aria-hidden="true">${KIND[kind].ico}</div>
    <h2>Thanks, that's on the board</h2>
    <p>Your ${kind === 'bug' ? 'bug report' : 'feature request'}${j.images ? ` and ${j.images} image${j.images > 1 ? 's' : ''}` : ''} went through. It'll show up as an issue on <a href="https://github.com/Archers007/Ink/issues" target="_blank" rel="noopener">GitHub</a> shortly, where you can follow it.</p>
    <div class="row"><button class="btn btn-gold" id="again">Send another</button><a class="btn btn-quiet" href="${S.from && new URL(S.from).origin === location.origin ? esc(S.from) : '/'}">Back to Ink</a></div></div>`;
  $('#again').onclick = build;
}

boot();
