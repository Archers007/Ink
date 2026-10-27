// Runs the search bot (searchbot.js) off the main thread so a bot's thinking never stalls other rooms.
// Message in: { id, state, seat, seen: [iid…], budgetMs } → out: { id, action, seen, info } (or { id, error }).
import { parentPort } from 'node:worker_threads';
import { createSearchBot } from './searchbot.js';

const bots = new Map();
parentPort.on('message', ({ id, state, seat, seen, budgetMs }) => {
  try {
    let bot = bots.get(budgetMs);
    if (!bot) { bot = createSearchBot({ budgetMs }); bots.set(budgetMs, bot); }
    const memory = { seen: new Set(seen || []) };
    const action = bot.decide(state, seat, memory);
    parentPort.postMessage({ id, action, seen: [...memory.seen], info: bot.decide.last || null });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
