// The bot's learned knowledge (data/bot-model.json, written by train.js): a win-probability model over position
// features, used by the search bot's evaluate() once it beats the hand-tuned score on held-out games, and what
// people do with each card (ink it or play it, keep it or send it back), used by the quick bot.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { features } from './features.js';

export const MODEL_FILE = process.env.INK_BOT_MODEL || fileURLToPath(new URL('../../data/bot-model.json', import.meta.url));
let cache = null, checkedAt = 0, mtime = 0;

export function getModel() {
  const now = Date.now();
  if (now - checkedAt < 15000) return cache;
  checkedAt = now;
  try {
    const st = fs.statSync(MODEL_FILE);
    if (st.mtimeMs !== mtime) { mtime = st.mtimeMs; cache = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8')); }
  } catch { cache = null; mtime = 0; }
  return cache;
}

export const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
export function winProb(m, x) {
  let z = m.bias;
  for (let i = 0; i < x.length; i++) z += m.weights[i] * ((x[i] - m.mean[i]) / m.std[i]);
  return sigmoid(z);
}
// How much of the learned score the search bot adds to its hand-tuned one. A blend, not a replacement: a model
// fitted to games where everyone inks every turn can't know what skipping ink costs (it learned "a big hand
// wins"), so the hand-tuned score keeps the basics and the model adjusts around them.
export const BLEND = 0.5;
export const valueWith = (v, s, seat) => 100 * (2 * winProb(v, features(s, seat)) - 1);
// the learned part of the score, or null until a head-to-head test showed it wins more (train.js)
export function learnedValue(s, seat) {
  const m = getModel();
  if (!m?.value?.use) return null;
  return BLEND * valueWith(m.value, s, seat);
}
// people's habits with a card: { ink, play, shipped, kept } counts, or null
export function cardHabit(full) {
  return getModel()?.habits?.[full] || null;
}
