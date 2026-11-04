// Worker for the Deck Lab (lib/lab.js). Two kinds, picked by workerData.mode:
//
//   'game'  plays one game at a time, like game/analysis/simworker.js
//           in:  { id, game: { deck, oppDeck, me, seed, pilot, budgetMs, preview, paceMs } }
//           out: { id, frame } while a streamed game runs · { id, rec } when it ends · { id, error }
//
//   'brain' runs the deck-building brain (game/lab/brain.js) off the main thread, on its own copy of the card index
//           in:  { id, fn, args, mtime }   (mtime changes when the server rebuilt its index: reload ours)
//           out: { id, result } · { id, error }
import { parentPort, workerData } from 'node:worker_threads';

const mode = workerData?.mode || 'game';

if (mode === 'game') {
  const { playGame } = await import('../analysis/playgame.js');
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
} else {
  const { loadCardIndex, resolveDeck } = await import('../cards.js');
  const { buildReport } = await import('../analysis/report.js');
  let brain = null, index = null, indexMtime = null, loading = null;

  async function ready(mtime) {
    brain ||= await import(workerData.brainUrl || new URL('./brain.js', import.meta.url).href);
    if (index && (mtime == null || mtime === indexMtime)) return;
    loading ||= loadCardIndex(workerData.dbFile).then((idx) => { index = idx; indexMtime = mtime; }).finally(() => { loading = null; });
    await loading;
  }

  const defsOf = (cards) => resolveDeck(index, { cards }).defs;
  const FNS = {
    readSeed: (a) => brain.readSeed(index, a),
    findSynergies: (a) => brain.findSynergies(index, a.core, a.opts || {}),
    assemble: (a) => brain.assemble(index, a),
    cardImpact: (a) => brain.cardImpact(a.records, defsOf(a.cards)),
    proposeSwaps: (a) => {
      const report = buildReport({ records: a.records, defs: defsOf(a.cards), opponents: a.opponents, settings: {} });
      return brain.proposeSwaps(index, a.cards, { impact: a.impact, report, synergies: a.synergies, inks: a.inks, locks: a.locks, tried: a.tried, max: a.max, format: a.format });
    },
  };

  parentPort.on('message', async ({ id, fn, args, mtime }) => {
    try {
      await ready(mtime);
      if (!FNS[fn]) throw new Error(`unknown brain call: ${fn}`);
      const result = await FNS[fn](args || {});
      parentPort.postMessage({ id, result });
    } catch (e) {
      parentPort.postMessage({ id, error: e?.message || String(e) });
    }
  });
}
