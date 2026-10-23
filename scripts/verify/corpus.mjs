// Every card ability in cache/sanitized.db, compiled in-process — what the verify checks run over.
//   corpus() → [{ key: 'card_key#idx', card, name, type, text, p }]
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileAbility } from '../../game/procs/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let memo = null;
export function corpus() {
  if (memo) return memo;
  const db = new DatabaseSync(path.join(ROOT, 'cache/sanitized.db'), { readOnly: true });
  const rows = db.prepare("SELECT r.card_key, r.idx, r.name, r.text, c.type, c.name || ' - ' || coalesce(c.title, '') AS full FROM rulings r JOIN rules c USING (card_key) ORDER BY r.card_key, r.idx").all();
  db.close();
  memo = rows.map((r) => ({ key: `${r.card_key}#${r.idx}`, card: r.card_key, full: r.full.replace(/ - $/, ''), name: r.name || '', type: r.type, text: r.text, p: compileAbility({ name: r.name || '', text: r.text }, r.type) }));
  return memo;
}
export const runnable = () => corpus().filter((x) => x.p.exec);
