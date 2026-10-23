// The Comprehensive Rules (docs/rules/comprehensive-rules-*.txt) as an index of numbered sections, so code can cite a
// rule and tools can quote it:   section('3.2.3.1') → "The active player draws a card from their deck. If this turn is …"
//
// The text is the PDF export: page footers (disneylorcana.com / ©Disney …) are dropped and wrapped lines are joined
// back onto their section. Server-side only (reads the file).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/rules');
const FILE = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^comprehensive-rules/i.test(f)).sort().pop() : null;
export const CR_VERSION = FILE ? FILE.replace(/^comprehensive-rules-|\.txt$/gi, '') : null;

let index = null;
function load() {
  if (index) return index;
  index = new Map();
  if (!FILE) return index;
  const lines = readFileSync(path.join(DIR, FILE), 'utf8').split('\n');
  let cur = null;
  let started = false;                                   // skip the table of contents
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*(disneylorcana\.com|©Disney)/i.test(line) || !line.trim()) continue;
    const m = line.match(/^\s*(\d+(?:\.\d+)+)\.?\s+(.*)$/);
    if (m && (started || m[1] === '1.1.1')) {
      started = true;
      cur = m[1];
      index.set(cur, m[2].trim());
      continue;
    }
    if (started && cur && !/^\s*\d+\.\s+[A-Z ,]+$/.test(line)) index.set(cur, `${index.get(cur)} ${line.trim()}`.replace(/\s+/g, ' '));
  }
  return index;
}
export const section = (id) => load().get(String(id)) ?? null;
export const sections = () => [...load().keys()];
// the first sentence, for read-backs
export const quote = (id, max = 160) => { const t = section(id); return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : null; };
