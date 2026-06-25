// Theme registry + apply/persist. Read by app.js on boot, before the catalog
// renders, so the user never sees the wrong colors flash.
//
// Each theme is more than a recolor — see public/css/themes.css, where every
// entry restyles the layout & chrome (panels, cards, buttons, background,
// animation) so switching themes genuinely changes the feel of the app.

export const THEMES = [
  {
    id: '1996',
    name: 'HTML 1996',
    blurb: 'Silver chrome, Win95 bevels, Times New Roman, a marquee.',
    swatch: { surface: '#c0c0c0', primary: '#000080', accent: '#ff0000', titlebar: 'linear-gradient(90deg,#000080,#1084d0)' },
  },
  {
    id: 'deep-sea-lab',
    name: 'Deep Sea Lab',
    blurb: 'Abyssal navy, neon-teal glow, rounded glass panels, Space Grotesk.',
    swatch: { surface: '#0a2540', primary: '#00f5d4', accent: '#9b5de5', titlebar: 'linear-gradient(90deg,#06223f,#0a2540)' },
  },
  {
    id: 'vaporwave',
    name: 'Vaporwave',
    blurb: 'Retro grid horizon, neon pink/cyan, mono caps, scrolling sun.',
    swatch: { surface: '#2a0a44', primary: '#ff71ce', accent: '#05ffa1', titlebar: 'linear-gradient(90deg,#ff71ce,#01cdfe)' },
  },
  {
    id: 'brutalist-concrete',
    name: 'Brutalist Concrete',
    blurb: 'Raw grey slab, hard black drop-shadows, heavy mono, zero gloss.',
    swatch: { surface: '#bababa', primary: '#1a1a1a', accent: '#f5b400', titlebar: '#000000' },
  },
  {
    id: 'liquid-glass',
    name: 'Liquid Glass',
    blurb: 'Frosted glass panels, drifting color blobs, pill buttons, Inter.',
    swatch: { surface: '#16203f', primary: '#7afcff', accent: '#ffe66d', titlebar: 'linear-gradient(135deg,#7afcff,#ff7af3)' },
  },
];

const KEY = 'ink.theme';

export function currentTheme() {
  const stored = localStorage.getItem(KEY);
  if (stored && THEMES.some((t) => t.id === stored)) return stored;
  return '1996';
}

export function applyTheme(id) {
  if (!THEMES.some((t) => t.id === id)) id = '1996';
  document.documentElement.dataset.theme = id;
  localStorage.setItem(KEY, id);
  return id;
}

// Call this synchronously at script load, *before* DOMContentLoaded paints,
// so we don't flash the default theme for users on a different one.
export function bootTheme() {
  applyTheme(currentTheme());
}

bootTheme();
