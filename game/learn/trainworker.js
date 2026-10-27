// Trains the bot off the main thread: reads saved games from data/ink.db, replays them, fits the model, writes
// data/bot-model.json. workerData: { dbFile, cardsDb, limit } → posts { ok, summary } or { ok: false, error }.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { loadCardIndex } from '../cards.js';
import { train, saveModel } from './train.js';

try {
  const db = new DatabaseSync(workerData.dbFile, { readOnly: true });
  const rows = db.prepare('SELECT seed, seats, actions, winner FROM games WHERE winner IS NOT NULL ORDER BY finished DESC LIMIT ?').all(workerData.limit || 5000);
  db.close();
  const games = rows.map((r) => ({ seed: r.seed, seats: JSON.parse(r.seats), actions: JSON.parse(r.actions), winner: r.winner }));
  const index = await loadCardIndex(workerData.cardsDb);
  const lines = [];
  const model = train(index, games, { log: (l) => lines.push(l) });
  saveModel(model);
  parentPort.postMessage({ ok: true, summary: { games: model.games, humanGames: model.humanGames, positions: model.positions, holdout: model.value?.holdout || null, gate: model.value?.gate || null, using: !!model.value?.use, log: lines } });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message });
}
