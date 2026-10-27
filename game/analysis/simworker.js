// Worker for deck simulations (lib/sim.js hands out one game at a time).
// in:  { id, game: { deck, oppDeck, me, seed, pilot, budgetMs, preview, paceMs } }
// out: { id, frame } while a previewed game runs · { id, rec } when it ends · { id, error }
import { parentPort } from 'node:worker_threads';
import { playGame } from './playgame.js';

parentPort.on('message', async ({ id, game }) => {
  try {
    let last = 0;
    const onFrame = game.preview ? (f) => { const now = Date.now(); if (now - last > 120) { last = now; parentPort.postMessage({ id, frame: f }); } } : null;
    const rec = await playGame({ ...game, onFrame, paceMs: game.preview ? game.paceMs || 0 : 0 });
    parentPort.postMessage({ id, rec });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
