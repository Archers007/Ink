// Train the bot from saved games (data/ink.db → data/bot-model.json). With --selfplay N it first plays N quick-bot
// games between the starter decks and saves them too, so there's data before people have played.
//
//   node scripts/train-bot.mjs [--selfplay 500]
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadCardIndex, resolveDeck } from '../game/cards.js';
import { newGame, applyAction } from '../game/engine.js';
import { botDecide } from '../game/bot.js';
import { train, saveModel } from '../game/learn/train.js';
import { MODEL_FILE } from '../game/learn/model.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--selfplay');
const SELF = i > 0 ? Number(process.argv[i + 1] || 300) : 0;
const index = await loadCardIndex(path.join(root, 'cache', 'sanitized.db'));
const db = new DatabaseSync(path.join(root, 'data', 'ink.db'));
db.exec(`CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, source TEXT NOT NULL, created INTEGER NOT NULL, finished INTEGER NOT NULL, seed INTEGER NOT NULL,
  seats TEXT NOT NULL, actions TEXT NOT NULL, winner INTEGER, turns INTEGER, reason TEXT, human INTEGER NOT NULL DEFAULT 0)`);
const add = db.prepare('INSERT INTO games (id, source, created, finished, seed, seats, actions, winner, turns, reason, human) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)');

if (SELF) {
  const decks = index.demoDecks.map((d) => ({ name: d.name, r: resolveDeck(index, d) }));
  let saved = 0;
  for (let g = 0; g < SELF; g++) {
    const a = decks[g % decks.length], b = decks[(g + 1 + Math.floor(g / decks.length)) % decks.length];
    const seed = crypto.randomInt(2 ** 31);
    const s = newGame({ seed, players: [{ name: 'Bot A', deck: a.r.defs }, { name: 'Bot B', deck: b.r.defs }] });
    const actions = [];
    for (let step = 0; step < 4000 && s.status !== 'over'; step++) {
      let done = false;
      for (const seat of [0, 1]) {
        const x = botDecide(s, seat);
        if (!x) continue;
        let act = x, r = applyAction(s, seat, act);
        if (!r.ok) { act = s.pending?.seat === seat ? (s.pending.type === 'support' ? { type: 'support' } : { type: 'choose', skip: true }) : { type: 'endTurn', force: true }; r = applyAction(s, seat, act); }
        if (r.ok) actions.push([seat, act]);
        done = r.ok;
        break;
      }
      if (!done) break;
    }
    if (s.status !== 'over') continue;
    const seats = [a, b].map((d, k) => ({ name: `Bot ${'AB'[k]}`, userId: null, bot: true, level: 'easy', deckName: d.name, cards: d.r.counts }));
    add.run(crypto.randomBytes(8).toString('base64url'), 'selfplay', Date.now(), Date.now(), seed, JSON.stringify(seats), JSON.stringify(actions), s.winner, s.turn, s.endReason || '');
    saved++;
  }
  console.log(`self-play: saved ${saved} games`);
}

const rows = db.prepare('SELECT seed, seats, actions, winner FROM games WHERE winner IS NOT NULL ORDER BY finished DESC LIMIT 5000').all();
const games = rows.map((r) => ({ seed: r.seed, seats: JSON.parse(r.seats), actions: JSON.parse(r.actions), winner: r.winner }));
const model = train(index, games, { log: (l) => console.log(l) });
saveModel(model);
console.log(`model → ${MODEL_FILE} (${model.games} games, ${model.humanGames} with people, ${model.positions} positions)`);
