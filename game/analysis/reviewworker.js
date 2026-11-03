// Game reviews off the main thread (lib/replays.js). Loads the card index once.
// in: { id, rec, budgetMs } → out: { id, progress: [done, total] } … { id, review } (or { id, error }). Both players.
import { parentPort, workerData } from 'node:worker_threads';
import { loadCardIndex } from '../cards.js';
import { reviewGame } from './review.js';

const index = await loadCardIndex(workerData.cardsDb);
parentPort.on('message', ({ id, rec, budgetMs }) => {
  try {
    let last = 0;
    const review = reviewGame(index, rec, [0, 1], { budgetMs, onProgress: (d, t) => { const now = Date.now(); if (now - last > 500 || d === t) { last = now; parentPort.postMessage({ id, progress: [d, t] }); } } });
    parentPort.postMessage({ id, review });
  } catch (e) { parentPort.postMessage({ id, error: e.message }); }
});
parentPort.postMessage({ ready: true });
