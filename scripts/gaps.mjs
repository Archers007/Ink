#!/usr/bin/env node
// Coverage gaps: every not-built / partly-built card, its misses bucketed into gap families, ranked by how
// many cards each family would finish (cards whose only misses are in that family).
//
//   node scripts/gaps.mjs              ranked families + examples
//   node scripts/gaps.mjs <family>     every card + miss in one family
//   node scripts/gaps.mjs --other      the misses no family claims (to grow the list below)
//   (every form runs scripts/build-cards.mjs first — imports sanitized.db, compiles procs; --no-build reuses
//    cache/sanitized.db + proc.db)

import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

if (!process.argv.includes('--no-build')) {
  console.error('gaps: building cards (import → procs)…');
  const r = spawnSync('node', ['scripts/build-cards.mjs'], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) { console.error('gaps: scripts/build-cards.mjs failed — fix it or pass --no-build'); process.exit(1); }
}

// card → { procs: [{ kind, exec, why, text }] } from cache/sanitized.db + cache/proc.db
const db = new DatabaseSync(new URL('../cache/sanitized.db', import.meta.url).pathname, { readOnly: true });
db.exec(`ATTACH DATABASE '${new URL('../cache/proc.db', import.meta.url).pathname}' AS p`);
const P = {};
for (const r of db.prepare('SELECT r.card_key, r.text, p.kind, p.exec, p.why FROM rulings r JOIN p.procs p USING (proc_id) ORDER BY r.card_key, r.idx').all()) {
  (P[r.card_key] ||= { procs: [] }).procs.push({ kind: r.kind, exec: !!r.exec, why: r.why, text: r.text });
}
db.close();

// root-cause family → test on the missing fragment (quoted part of "why"), then on why+text. First match wins.
const FAMILIES = [
  ['ocr-junk', /^(?:'|card|hOLD\.?|of Cheese-a|gain 1lore|you may|you pay 1 \{ink\})$|characteris|\{exert\}\?|\{exert\} \{ink\}, 1|\{exert\} \{exert\}|^\{ink\} |temporary Red Panda|"[A-Z ]{4,} When|^\s*,|has nothing to refer to/],
  ['deckbuilding-rule', /in your deck|copies of|regardless of ink type/i],
  ['class-name-unknown', /^(?:villain|hunny|robot|inventor|king and queen) characters$|^named Alien card$/i],
  ['no-card-type', /^no card type$/],
  ['shift-variants', /(?:duo|combo|potato) shift|shift any character|counts as being named .* for shift|as if this character had any name/i],
  ['name-a-card', /^name a card$/i],
  ['pay-to (cost inside an effect)', /^(?:to |pay \d+ \{ink\} (?:and|to)|put .* (?:discard|deck) .* to |reveal a song card in your hand to|discard your hand to|shuffle this card into your deck to|\{exert\} (?:one|chosen) .* to )/i],
  ['tail fragment (pronoun/and-split)', /^(?:he|she|they|it) (?:gets?|gains?|may)|^(?:this character )?(?:gains? .+ and|can't)$|^(?:and|or) |^(?:his|her|their) |^that (?:card|was)|^it on |^one (?:into|on)|^at that location$|^and\/or|enters play exerted and$|\band$/i],
  ['challenge context', /challenging (?:player|character)|being challenged|who was challenged|after the challenge|during that challenge|challenging a /i],
  ['turn-history condition', /this turn|this way|ink drop to play|second (?:card|challenge)|for the first time/i],
  ['board-state condition', /^(?:an? |another |there|one of your|you have|an opponent|one or more|this character (?:is|has)|he's|they're|he had|that character had|it (?:has|is)|the (?:item|banished))/i],
  ['play-from-zone / free play', /\bplay\b.*(?:for free|from (?:your|their|under)|discard|as if)|for free\b.*\bplay|play (?:it|him|that character|this card)$|shift a character from/i],
  ['location movement', /\bmove\b|\bhere\b|at a location|to a location/i],
  ['reveal/look variants', /reveal|look at|top or the bottom|top of your deck|put one into your hand|put (?:revealed|that card|it)/i],
  ['comparison filter', /same (?:name|cost)|than (?:each|that|you)|equal to or less|highest|with total|different name/i],
  ['player choice (other player acts)', /chooses?|chosen player|each player|its player|their player|that player|players? with the most/i],
  ['damage group ops', /damage (?:counters|each|total)|move .*damage|same amount of damage|remove up to/i],
  ['zone group moves', /^(?:put|return|draw|discard) (?:all|each|up to|any number|\d|a card from the bottom)/i],
  ['global rule change', /can't|count(?:s)? as having|need \d+ lore|enter(?:s)? play|can ink|lose (?:rush|evasive|the)|classification|can't be reduced|skip your|instead of their|only one character|play with the top/i],
];
const triggerish = (p) => /^trigger:/.test(p.why) || /^"?(?:whenever|when|at the end)/i.test((p.why.match(/"([^"]*)"/) || [, ''])[1]);
const CAT = (why) => (/^engine can't run/.test(why) ? 'engine' : why.split(/[:\s]/)[0]);   // effect / filter / condition / trigger / …
const familyOf = (p) => {
  const hay = `${p.why} ${p.text}`;
  const quoted = (p.why.match(/"([^"]*)"/) || [, ''])[1];
  if (/^engine can't run: keyword/.test(p.why)) return 'shift-variants';
  if (/^(?:needs a duration|static with a duration)/.test(p.why)) return 'duration on statics';
  if (triggerish(p)) return 'trigger long tail';
  if (/^instead|^otherwise/.test(p.why)) return 'replacement / otherwise';
  for (const [f, rx] of FAMILIES) if (rx.test(quoted || p.why.replace(/^\w+: /, ""))) return f;
  return 'other';
};

const fam = {};                    // family → { misses, cards:Set, finishes:Set, cats:{}, ex:[] }
const cards = { manual: 0, partial: 0 };
for (const [full, c] of Object.entries(P)) {
  const miss = c.procs.filter((p) => !p.exec);
  if (!miss.length) continue;
  const status = c.procs.some((p) => p.exec && p.kind !== 'keyword' && p.kind !== 'reminder') ? 'partial' : 'manual';
  cards[status]++;
  const fs = new Set();
  for (const p of miss) {
    const f = familyOf(p);
    fs.add(f);
    const F = (fam[f] ||= { misses: 0, cards: new Set(), finishes: new Set(), cats: {}, ex: [] });
    F.misses++; F.cards.add(full); F.cats[CAT(p.why)] = (F.cats[CAT(p.why)] || 0) + 1;
    F.ex.push({ full, status, why: p.why, text: p.text });
  }
  if (fs.size === 1) fam[[...fs][0]].finishes.add(full);
}

const arg = process.argv.slice(2).find((a) => a === '--other' || !a.startsWith('--'));
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
if (arg && arg !== '--other' ? fam[arg] : arg === '--other') {
  const F = fam[arg === '--other' ? 'other' : arg];
  for (const e of F.ex) console.log(`${e.status === 'partial' ? '◐' : '○'} ${e.full}\n    why:  ${short(e.why, 140)}\n    text: ${short(e.text, 220)}`);
  process.exit(0);
}
const total = Object.values(fam).reduce((a, F) => a + F.misses, 0);
console.log(`${cards.manual + cards.partial} cards not fully built (${cards.manual} manual ○ · ${cards.partial} partial ◐) · ${total} missing abilities\n`);
console.log('family                    misses  cards  finishes  where it breaks');
const rows = Object.entries(fam).sort((a, b) => b[1].finishes.size - a[1].finishes.size || b[1].misses - a[1].misses);
for (const [f, F] of rows) {
  const cats = Object.entries(F.cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`${f.padEnd(25)} ${String(F.misses).padStart(6)} ${String(F.cards.size).padStart(6)} ${String(F.finishes.size).padStart(9)}  ${cats}`);
}
console.log('\n(finishes = cards that become fully automatic if that family alone is built)\n');
for (const [f, F] of rows.slice(0, 8)) {
  console.log(`▸ ${f}`);
  for (const e of F.ex.slice(0, 3)) console.log(`    ${short(e.full, 38).padEnd(38)} ${short(e.why, 100)}`);
}
