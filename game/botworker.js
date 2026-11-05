// Runs the search bot (searchbot.js) off the main thread so a bot's thinking never stalls other rooms.
// Message in: { id, state, seat, seen: [iid…], budgetMs, analyze? } → out: { id, action, seen, info }, or with
// analyze: { id, analysis: { eval, moves: [{label, score, pm, action}] } } (or { id, error }); with mulligan: { id, mulligan }
// (the coach's opening-hand advice, analysis/mulligan.js).
import { parentPort } from 'node:worker_threads';
import { createSearchBot, analyze } from './searchbot.js';
import { adviseMulligan } from './analysis/mulligan.js';

const bots = new Map();
parentPort.on('message', ({ id, state, seat, seen, budgetMs, analyze: wantAnalysis, mulligan }) => {
  try {
    if (mulligan) { parentPort.postMessage({ id, mulligan: adviseMulligan(state, seat) }); return; }
    if (wantAnalysis) {
      const r = analyze(state, seat, { seen: new Set(seen || []) }, { budgetMs });
      parentPort.postMessage({ id, analysis: { eval: r.eval, samples: r.samples, moves: r.moves.slice(0, 5).map(({ label, score, pm, action }) => ({ label, score, pm, action })) } });
      return;
    }
    let bot = bots.get(budgetMs);
    if (!bot) { bot = createSearchBot({ budgetMs }); bots.set(budgetMs, bot); }
    const memory = { seen: new Set(seen || []) };
    const action = bot.decide(state, seat, memory);
    parentPort.postMessage({ id, action, seen: [...memory.seen], info: bot.decide.last || null });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
