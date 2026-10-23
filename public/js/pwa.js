// PWA glue: register the service worker, catch the browser's install prompt and hand it to the page.
//   import { installable, install } from '/js/pwa.js';
//   window.addEventListener('ink:installable', () => showInstallButton());
// Nothing here is needed for the game to work; it only makes "Add to home screen" and offline shell loads possible.

let deferred = null;

export const standalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
export const installable = () => !!deferred;
export async function install() {
  if (!deferred) return false;
  const p = deferred; deferred = null;
  p.prompt();
  const { outcome } = await p.userChoice;
  window.dispatchEvent(new CustomEvent('ink:installable'));
  return outcome === 'accepted';
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();                                   // we show our own button
  deferred = e;
  window.dispatchEvent(new CustomEvent('ink:installable'));
});
window.addEventListener('appinstalled', () => { deferred = null; window.dispatchEvent(new CustomEvent('ink:installable')); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // a new build waiting → let it take over on the next navigation; the game state lives on the server anyway
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => { if (sw.state === 'installed' && navigator.serviceWorker.controller) window.dispatchEvent(new CustomEvent('ink:update')); });
      });
    }).catch((e) => console.warn('[pwa] service worker failed:', e.message));
  });
}
