// Theme registry + apply/persist. Read by app.js on boot, before the catalog
// renders, so the user never sees the wrong colors flash.

export const THEMES = [
  {
    id: '1996',
    name: 'HTML 1996',
    blurb: 'Silver chrome, Win95 bevels, Times New Roman.',
    swatch: { surface: '#c0c0c0', primary: '#000080', accent: '#ff0000', titlebar: 'linear-gradient(90deg,#000080,#1084d0)' },
  },
  {
    id: 'modern-dark',
    name: 'Modern Dark',
    blurb: 'Slate + neon blue. Soft shadows, no bevels.',
    swatch: { surface: '#1e293b', primary: '#60a5fa', accent: '#f87171', titlebar: 'linear-gradient(135deg,#1e293b,#334155)' },
  },
  {
    id: 'modern-light',
    name: 'Modern Light',
    blurb: 'Clean light cards with a blue title bar.',
    swatch: { surface: '#ffffff', primary: '#2563eb', accent: '#dc2626', titlebar: 'linear-gradient(135deg,#2563eb,#1d4ed8)' },
  },
  {
    id: 'lorcana',
    name: 'Lorcana Ink',
    blurb: 'Deep magical purple, gold accents, serif.',
    swatch: { surface: '#241338', primary: '#d4af37', accent: '#f0abfc', titlebar: 'linear-gradient(90deg,#2e1065,#6d28d9,#2e1065)' },
  },
  {
    id: 'terminal',
    name: 'Terminal',
    blurb: 'Phosphor green CRT with scanlines.',
    swatch: { surface: '#001a00', primary: '#00ff88', accent: '#ff5555', titlebar: '#003300' },
  },
  {
    id: 'geocities',
    name: 'Geocities \'99',
    blurb: 'Rainbow chrome, Comic Sans, peak Web 1.0.',
    swatch: { surface: '#ffe4ff', primary: '#0000ff', accent: '#ff0000', titlebar: 'linear-gradient(90deg,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff)' },
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
