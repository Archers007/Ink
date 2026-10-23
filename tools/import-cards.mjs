#!/usr/bin/env node
// Build step: cache/dreamborn.db (dreamborn.ink's printings) + cards.disneylorcana.com (Ravensburger's catalog,
// tools/card-scan/official.mjs) → cache/cards.db, the imported card data everything else reads.
//
//   node tools/import-cards.mjs            import (downloads the official page once, cached in cache/official.html)
//   node tools/import-cards.mjs --refresh  re-download the official page first
//
// Ravensburger is the source of truth for every rules field: cost, inkable, inks, strength, willpower, lore,
// move cost, classifications, keywords, rules text, flavour text and FAQ. dreamborn supplies what Ravensburger
// doesn't: its printing ids (decks, collections and prices.db are keyed by them), sets, rarity, variants,
// illustrator, franchise, formats. A card Ravensburger doesn't list keeps dreamborn's values (source 'dreamborn').
//
// cards.db keeps dreamborn's `cards` / `sets` / `metadata` tables in dreamborn's shape (one row per printing),
// so the deck builder and the engine read it unchanged, plus:
//   rules     one row per unique card (Name - Title): the merged values, flavour, FAQ, which source won
//   rulings   one row per ability: the text the compiler gets; proc_id → proc.db (tools/compile-procs.mjs)
//   diffs     every field where dreamborn said something else — what the import corrected
// Deterministic: same inputs → same rows.

import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOfficial } from './card-scan/official.mjs';
import { canon, unknownIcons, mergeSplitNames, splitDbAbilities } from '../game/procs/normalize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'cache/dreamborn.db');
const OUT = path.join(ROOT, 'cache/cards.db');
if (!existsSync(SRC)) { console.error('cache/dreamborn.db missing — start the server once to download it'); process.exit(1); }

// Ravensburger down and no cached copy → every card keeps dreamborn's values (source 'dreamborn'), loudly
let official = [];
try { ({ cards: official } = await loadOfficial({ refresh: process.argv.includes('--refresh') })); } catch (e) {
  try { ({ cards: official } = await loadOfficial()); console.warn(`⚠ ${e.message} — using the cached official page`); } catch {
    console.warn(`⚠ ${e.message} — no official data, importing dreamborn's text as is`);
  }
}

// the same card under another spelling on dreamborn (lower-case "name - title")
const ALIAS = {
  'tweedledee & tweedledum - strange storytellers': 'tweedle dee & tweedle dum - strange storytellers',
  'vaiana - adventurer of land and sea': 'moana - adventurer of land and sea',
};
const keyOf = (name, title) => (title ? `${name} - ${title}` : name).toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const INK_BIT = { AMBER: 1, AMETHYST: 2, EMERALD: 4, RUBY: 8, SAPPHIRE: 16, STEEL: 32 };
const TYPE = { characters: 'character', actions: 'action', items: 'item', locations: 'location' };
const FULL_ART = new Set(['ENCHANTED', 'ICONIC', 'EPIC', 'SPECIAL']);

// Ravensburger printings → one card each. Full-art printings drop the reminder text, so the card's text comes
// from a standard printing, newest set first (a reprint carries any errata).
const setNo = (c) => Number(String(c.card_sets?.[0]?.id || '').replace(/\D/g, '')) || 0;
const byKey = new Map();
for (const c of official) {
  if (!TYPE[c.card_type]) continue;                         // supplies (Ink Drop tokens)
  const k = keyOf(c.name, c.subtitle);
  const k2 = ALIAS[k] || k;
  (byKey.get(k2) || byKey.set(k2, []).get(k2)).push(c);
}
// Ravensburger's layout → one ability per paragraph (blank line), the way the rest of the build reads it:
//   abilities end at a newline, " %", or a run of spaces / a ")" right before the next \Name\
//   a "choose one:" list's • bullets stay with the ability above them
//   keywords listed on one line ("<Bodyguard>, <Support>") are one ability each
//   a name that lost its opening backslash ("Odd One Out\ When…") gets it back
const rulesOf = (c) => String(c.rules_text || '').replace(/\r/g, '')
  .replace(/[ \t]*%[ \t]*/g, '\n')
  .replace(/(?<=\S)[ \t]*\\(?=[^\s\\][^\\\n]{0,60}\\\s)/g, '\n\\')
  .split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => l.replace(/^(?![\\<({•])([^\\\n]{1,60})\\(?=\s)/, '\\$1\\'))
  .flatMap((l) => (/^<[^<>]+>[^<>,]*(?:,\s*<[^<>]+>[^<>,]*)+$/.test(l) ? l.split(/,\s*(?=<)/) : [l]))   // "<Bodyguard>, <Support>"
  .reduce((out, l) => (out && l.startsWith('•') ? `${out}\n${l}` : out ? `${out}\n\n${l}` : l), '');
const pick = (cs) => [...cs].sort((a, b) => FULL_ART.has(a.rarity) - FULL_ART.has(b.rarity) || setNo(b) - setNo(a)
  || rulesOf(b).length - rulesOf(a).length || String(a.card_identifier).localeCompare(String(b.card_identifier)))[0];

// the card's own keywords (Ravensburger lists them: Nick Wilde has Shift, not the Adventurous he gives away) →
// dreamborn's `keywords` shape: { shift: 3, challenger: 2, evasive: true, 'puppy shift': 3, shift: "Discard an
// action card" }. The value comes from the card's keyword line ("<Resist> +2", "<Shift> 3 {I}", "<Shift> Remove 2
// ink drops"); its key from the line too, so "<Puppy Shift> 3" stays a variant of Shift.
function keywordsOf(own, text) {
  const kw = {};
  const names = (own || []).map((n) => n.toLowerCase());
  for (const line of String(text).split(/\n/)) {
    const m = line.match(/^\s*<([^<>:]+)(?::\s*([^<>]+))?>\s*([^\n(]*)/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    if (!names.some((n) => key === n || key.endsWith(' ' + n))) continue;
    let v = true;
    const rest = m[3].replace(/\\[^\\]*\\.*$/, '').trim();            // up to a named ability on the same line
    const num = rest.match(/^\+?(\d+)\b/);
    if (m[2]) v = m[2].trim();                                          // <Shift: Discard an action card>
    else if (num) v = Number(num[1]);
    else if (/shift$/.test(key) && rest) v = rest.replace(/\s*\{I\}\s*$/, '').trim();
    kw[key] ??= v;
  }
  for (const n of names) if (!Object.keys(kw).some((k) => k === n || k.endsWith(' ' + n))) kw[n] = true;
  return kw;
}
const classesOf = (c) => {
  const sub = (c.subtypes || []).map((s) => s.toLowerCase());
  return c.card_type === 'characters' ? sub : [TYPE[c.card_type], ...sub];
};
const typeOf = (c) => (c.card_type === 'actions' && (c.subtypes || []).includes('Song') ? 'song' : TYPE[c.card_type]);
// one entry per ability, the way dreamborn stores them: { name?, description } with <Keyword> and {I} markup kept
const abilityRows = (text) => splitDbAbilities('', text)
  .map((a) => (a.name ? { name: a.name, description: a.text } : { description: a.text }));

// how dreamborn's ability text differs from Ravensburger's — null when only reminder text or markup spelling does
const KW_WORD = /^(?:shift|evasive|rush|ward|resist|bodyguard|support|challenger|singer|alert|vanish|boost|reckless|adventurous|sing|together|universal|puppy|\+?\d+|\{ink\})$/;
const tokens = (x) => (x == null ? [] : JSON.parse(x).flatMap((a) => [a.name || '', canon(a.description ?? a.text ?? '')]).join(' ')
  .replace(/\([^)]*\)/g, ' ').toLowerCase().match(/\{[a-z]+\}|[a-z0-9+]+/g) || []);
function textDiff(was, now) {
  const a = tokens(was), b = tokens(now);
  if (a.join(' ') === b.join(' ')) return null;
  if (!a.length) return 'missing';
  if (!b.length) return 'extra';
  const plain = (t) => t.filter((w) => !w.startsWith('{')).join(' ');
  if (plain(a) === plain(b)) return 'icons';
  const noKw = (t) => t.filter((w) => !KW_WORD.test(w)).join(' ');
  if (noKw(a) === noKw(b)) return 'keyword-lines';
  return 'text';
}

// ---- write cards.db ----
const TMP = OUT + '.tmp';
rmSync(TMP, { force: true });
copyFileSync(SRC, TMP);
const db = new DatabaseSync(TMP);
const cols = db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name);
for (const [c, t] of [['card_key', 'TEXT'], ['flavor', 'TEXT'], ['source', 'TEXT']]) if (!cols.includes(c)) db.exec(`ALTER TABLE cards ADD COLUMN ${c} ${t}`);
db.exec(`
  DROP TABLE IF EXISTS rules; DROP TABLE IF EXISTS rulings; DROP TABLE IF EXISTS diffs;
  CREATE TABLE rules (
    card_key TEXT PRIMARY KEY,      -- "Name - Title", as in rulings / proc lookups
    name TEXT NOT NULL, title TEXT, type TEXT NOT NULL, cost INTEGER, inkable INTEGER, inks TEXT,
    lore INTEGER, strength INTEGER, willpower INTEGER, movement INTEGER,
    classes TEXT, keywords TEXT, rules_text TEXT, flavor TEXT,
    faq TEXT,                       -- Ravensburger's FAQ for the card: [{ title, body }]
    source TEXT NOT NULL,           -- disney · dreamborn (Ravensburger doesn't list it)
    official_id TEXT,               -- Ravensburger deck_building_id (shared by reprints)
    printed TEXT                    -- the Ravensburger printing the text came from ("158/204 EN 14")
  );
  CREATE TABLE rulings (
    id INTEGER PRIMARY KEY, card_key TEXT NOT NULL REFERENCES rules, idx INTEGER NOT NULL,
    name TEXT, text TEXT NOT NULL,  -- what the compiler gets (canonical spelling)
    proc_id TEXT,                   -- → proc.db procs.proc_id; NULL until compile-procs runs
    UNIQUE (card_key, idx)
  );
  CREATE TABLE diffs (
    card_key TEXT NOT NULL, field TEXT NOT NULL,
    kind TEXT NOT NULL,             -- value · text · icons · keyword-lines (dreamborn kept them in \`keywords\` only) · missing · extra
    dreamborn TEXT, disney TEXT
  );
  CREATE INDEX IF NOT EXISTS cards_card_key ON cards(card_key);
  CREATE INDEX rulings_proc ON rulings(proc_id);
`);

const rows = db.prepare(`SELECT * FROM cards${cols.includes('language') ? " WHERE language = 'en'" : ''} ORDER BY id`).all();
const printings = new Map();
for (const r of rows) { const k = keyOf(r.name, r.title); (printings.get(k) || printings.set(k, []).get(k)).push(r); }

const upd = db.prepare(`UPDATE cards SET card_key = ?, flavor = ?, source = ?, cost = ?, ink = ?, colorMask = ?, type = ?,
  strength = ?, willpower = ?, lore = ?, movement = ?, characteristics = ?, keywords = ?, abilities = ? WHERE id = ?`);
const insRule = db.prepare('INSERT INTO rules VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insRuling = db.prepare('INSERT INTO rulings (card_key, idx, name, text) VALUES (?,?,?,?)');
const insDiff = db.prepare('INSERT INTO diffs VALUES (?,?,?,?,?)');

const json = (v) => (v == null ? null : JSON.stringify(v));
const same = (a, b) => (a ?? null) === (b ?? null);
const stats = { cards: 0, disney: 0, dreamborn: 0, rulings: 0, diffs: {} };
const errors = [];
db.exec('BEGIN');
for (const [k, prs] of [...printings].sort((a, b) => a[0].localeCompare(b[0]))) {
  const d0 = prs[0];
  const full = d0.title ? `${d0.name} - ${d0.title}` : d0.name;
  const cs = byKey.get(k);
  const o = cs && pick(cs);
  let v;
  if (o) {
    const text = rulesOf(o);
    const ab = abilityRows(text);
    v = {
      cost: o.ink_cost ?? null, ink: o.ink_convertible ? 1 : 0,
      colorMask: (o.magic_ink_colors || []).reduce((m, c) => m | (INK_BIT[c] || 0), 0), type: typeOf(o),
      strength: o.strength ?? null, willpower: o.willpower ?? null, lore: o.quest_value ?? null, movement: o.move_cost ?? null,
      characteristics: json(classesOf(o)), keywords: o.abilities?.length ? json(keywordsOf(o.abilities, text)) : null,
      abilities: ab.length ? json(ab) : null, flavor: o.flavor_text || null, source: 'disney',
    };
    // what dreamborn had (every printing, so one bad row — Mickey's flavour-as-ability promo — shows up)
    for (const f of ['cost', 'ink', 'colorMask', 'type', 'strength', 'willpower', 'lore', 'movement', 'characteristics', 'keywords', 'abilities']) {
      const was = [...new Set(prs.map((p) => p[f] ?? null))];
      const norm = (x) => (x == null ? null : f === 'characteristics' ? JSON.stringify(JSON.parse(x).sort())        // same classes, any order
        : f === 'abilities' || f === 'keywords' ? canon(x) : x);
      const bad = was.filter((x) => !same(norm(x), norm(v[f])));
      if (!bad.length) continue;
      if (f === 'keywords' && bad.every((x) => x && v.keywords && JSON.stringify(Object.keys(JSON.parse(x)).sort()) === JSON.stringify(Object.keys(JSON.parse(v.keywords)).sort())
        && Object.entries(JSON.parse(x)).every(([kk, vv]) => vv === true || JSON.parse(v.keywords)[kk] === vv))) continue;   // dreamborn left a value out
      const kinds = bad.map((x) => (f === 'abilities' ? textDiff(x, v.abilities) : 'value'));
      if (kinds.every((x) => x === null)) continue;                    // reminder text / markup spelling only
      bad.forEach((x, i) => kinds[i] && insDiff.run(full, f, kinds[i], x == null ? null : String(x), v[f] == null ? null : String(v[f])));
      for (const x of kinds) if (x) stats.diffs[`${f}:${x}`] = (stats.diffs[`${f}:${x}`] || 0) + 1;
    }
    stats.disney++;
  } else {
    // Ravensburger doesn't list it: dreamborn's values, from the printing with the most text
    const r = [...prs].sort((a, b) => String(b.abilities || '').length - String(a.abilities || '').length)[0];
    v = { ...r, flavor: null, source: 'dreamborn' };
    stats.dreamborn++;
  }
  for (const p of prs) upd.run(full, v.flavor, v.source, v.cost, v.ink, v.colorMask, v.type, v.strength, v.willpower, v.lore, v.movement,
    v.characteristics, v.keywords, v.abilities, p.id);

  insRule.run(full, d0.name, d0.title || null, v.type, v.cost, v.ink, json(Object.entries(INK_BIT).filter(([, b]) => v.colorMask & b).map(([n]) => n.toLowerCase())),
    v.lore, v.strength, v.willpower, v.movement, v.characteristics, v.keywords, o ? rulesOf(o) : null, v.flavor,
    o?.additional_info?.length ? json(o.additional_info.map((x) => ({ title: x.title, body: x.body }))) : null,
    v.source, o?.deck_building_id ?? null, o?.card_identifier ?? null);

  let abilities = mergeSplitNames((v.abilities ? JSON.parse(v.abilities) : [])
    .flatMap((a) => splitDbAbilities(a.name || '', a.description ?? a.text ?? ''))
    .map((a) => ({ name: canon(a.name || ''), text: canon(a.text) })).filter((a) => a.text));
  // an action / song is one effect even when it's printed over several paragraphs ("For each Sorcerer … you
  // pay 1 {I} less to play this action." + "Draw 2 cards."); keyword lines and reminder text stay apart
  if (v.type === 'action' || v.type === 'song') {
    const own = (a) => a.name || /^\(/.test(a.text) || /^(?:Sing Together|Singer|Shift)\b/.test(a.text);
    abilities = abilities.reduce((out, a) => {
      const prev = out[out.length - 1];
      if (prev && !own(prev) && !own(a)) prev.text = `${prev.text} ${a.text}`; else out.push({ ...a });
      return out;
    }, []);
  }
  abilities.forEach((a, i) => {
    const bad = unknownIcons(a.text);
    if (bad.length) errors.push(`${full}: unknown icon {${bad.join('}, {')}} in "${a.text}"`);
    insRuling.run(full, i, a.name || null, a.text);
  });
  stats.cards++; stats.rulings += abilities.length;
}
db.exec('COMMIT');
db.exec('ANALYZE');
db.exec('VACUUM');                                          // the browser downloads this file
db.close();
renameSync(TMP, OUT);

const notOnDreamborn = [...byKey.keys()].filter((k) => !printings.has(k));
console.log(`cards → ${path.relative(ROOT, OUT)}`);
console.log(`  cards:     ${stats.cards} unique (${rows.length} dreamborn printings) — ${stats.disney} from Ravensburger, ${stats.dreamborn} dreamborn only`);
console.log(`  rulings:   ${stats.rulings}`);
console.log(`  corrected: ${Object.entries(stats.diffs).map(([f, n]) => `${f} ${n}`).join(' · ') || 'nothing'}   (SELECT * FROM diffs)`);
if (notOnDreamborn.length) console.log(`  skipped:   ${notOnDreamborn.length} Ravensburger cards dreamborn doesn't print (Illumineer's Quest etc.)`);
if (errors.length) {
  console.log(`\n⚠ ${errors.length} text problems:`);
  for (const e of errors.slice(0, 20)) console.log('  ' + e);
  process.exitCode = 1;
}
