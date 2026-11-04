// Silent front-end updates. Every page loads this (pwa.js pulls it in; pages without pwa.js have their own <script>).
// It knows the build its files came with (/js/build.js, written by the server and cached by the service worker with
// the rest of the shell) and asks the server for the current one (GET /api/version) every minute, when the tab comes
// back into view and when the network returns. When they differ — a deploy changed the front end — it deletes the
// service worker's shell cache (ink-shell-*; card images and fonts stay), asks the worker to update and reloads the
// page, as soon as the page says that's safe:
//   window.inkReloadSafe = () => false    // a game in progress, a form with unsaved input…; else it waits for the next check
// It never touches localStorage, cookies or IndexedDB, so sign-ins, decks and settings survive the reload. A per-tab
// note in sessionStorage stops reload loops: if the reloaded page still has the old files (a CDN or HTTP cache serving
// stale copies) the next try waits 2, 4, 8 … up to 60 minutes. A server that's down mid-deploy just means "ask again
// later". One tab that sees a new build tells the others (BroadcastChannel), so they don't each wait a minute.

const POLL_MS = 60_000;
const NOTE_KEY = 'ink.update.reload';                     // sessionStorage, this tab only: { to, n, at }
const BACKOFF_MAX_MIN = 60;

if (!window.__inkUpdater) {
  window.__inkUpdater = true;
  start();
}

function start() {
  let build = null;                                       // the build this page's files came with
  let pending = null;                                     // a newer build the server reported
  let busy = false, lastCheck = 0, reloading = false;

  const readNote = () => { try { return JSON.parse(sessionStorage.getItem(NOTE_KEY) || 'null'); } catch { return null; } };
  const writeNote = (n) => { try { sessionStorage.setItem(NOTE_KEY, JSON.stringify(n)); } catch {} };
  const dropNote = () => { try { sessionStorage.removeItem(NOTE_KEY); } catch {} };
  // a page that throws while answering is treated as busy: better a stale page than a lost game
  const safe = () => { try { return window.inkReloadSafe?.() !== false; } catch { return false; } };

  async function serverBuild() {
    try {
      const r = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!r.ok) return null;
      const j = await r.json();
      return typeof j?.version === 'string' && j.version ? j.version : null;
    } catch { return null; }                              // offline, or the server is restarting for a deploy
  }

  const channel = (() => { try { return new BroadcastChannel('ink-update'); } catch { return null; } })();
  // another tab saw a new build: ask the server now rather than at this tab's next poll (and don't take its word for it)
  if (channel) channel.onmessage = (e) => { const v = e.data?.build; if (build && typeof v === 'string' && v !== build) check(true); };

  async function check(force = false) {
    if (busy || reloading || (!force && Date.now() - lastCheck < 10_000)) return;   // focus + visibility fire together
    busy = true; lastCheck = Date.now();
    try {
      const v = await serverBuild();
      if (!v) return;
      if (!build) build = v;                              // no build stamp (build.js missing): the first answer is ours
      if (v === build) { pending = null; return; }
      if (pending !== v) channel?.postMessage({ build: v });
      pending = v;
      await tryReload(v);
    } finally { busy = false; }
  }

  async function tryReload(v) {
    if (reloading || !safe()) return;                     // not now: the next check tries again
    const note = readNote(), now = Date.now();
    let n = 1;
    if (note?.to === v) {                                 // already reloaded for this build and still on the old files
      const waitMin = Math.min(BACKOFF_MAX_MIN, 2 ** Math.max(1, note.n || 1));
      if (now - (note.at || 0) < waitMin * 60_000) return;
      n = (note.n || 1) + 1;
    }
    reloading = true;
    writeNote({ to: v, n, at: now });
    console.info(`[update] front end ${build} → ${v}, reloading`);
    try {
      if ('caches' in window) for (const k of await caches.keys()) if (k.startsWith('ink-shell-')) await caches.delete(k);
    } catch {}
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await Promise.race([reg.update(), new Promise((r) => setTimeout(r, 3000))]);
    } catch {}                                            // sw.js unreachable: the reload still fetches fresh files
    if (!safe()) { reloading = false; return; }           // something started meanwhile
    location.reload();
  }

  (async () => {
    try { build = (await import('./build.js')).BUILD || null; } catch { build = null; }
    const note = readNote();
    if (note && note.to === build) dropNote();            // the reload worked
    check(true);
    setInterval(() => check(true), POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    window.addEventListener('focus', () => check());
    window.addEventListener('online', () => check(true));
  })();
}
