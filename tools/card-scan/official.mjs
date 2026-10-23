#!/usr/bin/env node
// Ravensburger's public card gallery (cards.disneylorcana.com) server-renders its whole catalog into the page as a
// seroval stream ($R[n]=… JS literals). This reads that literal — no eval — and writes cache/official.json:
// one entry per printing with rules_text, flavor_text, ink_cost, ink_convertible, strength, willpower, quest_value,
// move_cost, subtypes, keyword abilities, FAQ (additional_info) and image urls.
//
//   node tools/card-scan/official.mjs            download (if missing) + parse
//   node tools/card-scan/official.mjs --refresh  re-download

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OFFICIAL_URL = 'https://cards.disneylorcana.com/en-US/';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = path.join(ROOT, 'cache/official.html');
const OUT = path.join(ROOT, 'cache/official.json');

// a tiny reader for the literal subset seroval emits: {k:v}, [a,b], "str", 12, -3.5, !0, !1, null, void 0,
// $R[n]=value (define) and $R[n] (reference to an earlier define)
export function parseSeroval(src, start) {
  let i = start;
  const refs = [];
  const ws = () => { while (/\s/.test(src[i])) i++; };
  const str = () => {
    const q = src[i++]; let out = '';
    for (;;) {
      const c = src[i++];
      if (c === q) return out;
      if (c !== '\\') { out += c; continue; }
      const e = src[i++];
      if (e === 'n') out += '\n'; else if (e === 'r') out += '\r'; else if (e === 't') out += '\t';
      else if (e === 'b') out += '\b'; else if (e === 'f') out += '\f'; else if (e === 'v') out += '\v'; else if (e === '0') out += '\0';
      else if (e === 'x') { out += String.fromCharCode(parseInt(src.slice(i, i + 2), 16)); i += 2; }
      else if (e === 'u') {
        if (src[i] === '{') { const j = src.indexOf('}', i); out += String.fromCodePoint(parseInt(src.slice(i + 1, j), 16)); i = j + 1; }
        else { out += String.fromCharCode(parseInt(src.slice(i, i + 4), 16)); i += 4; }
      } else out += e;
    }
  };
  const key = () => {
    ws();
    if (src[i] === '"' || src[i] === "'") return str();
    const m = /^[A-Za-z_$0-9][\w$]*/.exec(src.slice(i, i + 200));
    i += m[0].length; return m[0];
  };
  const val = () => {
    ws();
    const c = src[i];
    if (c === '$' && src.startsWith('$R[', i)) {
      const j = src.indexOf(']', i); const n = +src.slice(i + 3, j); i = j + 1;
      if (src[i] === '=') { i++; return (refs[n] = val()); }
      return refs[n];
    }
    if (c === '{') {
      i++; const o = {};
      for (ws(); src[i] !== '}'; ws()) { const k = key(); ws(); i++; /* : */ o[k] = val(); ws(); if (src[i] === ',') i++; ws(); }
      i++; return o;
    }
    if (c === '[') {
      i++; const a = [];
      for (ws(); src[i] !== ']'; ws()) { a.push(val()); ws(); if (src[i] === ',') i++; }
      i++; return a;
    }
    if (c === '"' || c === "'") return str();
    if (src.startsWith('!0', i)) { i += 2; return true; }
    if (src.startsWith('!1', i)) { i += 2; return false; }
    if (src.startsWith('null', i)) { i += 4; return null; }
    if (src.startsWith('void 0', i)) { i += 6; return undefined; }
    const m = /^-?(?:\d+\.?\d*(?:e[+-]?\d+)?|Infinity|NaN)/i.exec(src.slice(i, i + 40));
    if (!m) throw new Error(`seroval: unexpected ${JSON.stringify(src.slice(i, i + 40))} at ${i}`);
    i += m[0].length; return Number(m[0]);
  };
  return val();
}

export async function loadOfficial({ refresh = false } = {}) {
  if (refresh || !existsSync(HTML)) {
    const res = await fetch(OFFICIAL_URL, { headers: { 'user-agent': 'Mozilla/5.0 (Ink card build)' } });
    if (!res.ok) throw new Error(`official: ${OFFICIAL_URL} → ${res.status}`);
    mkdirSync(path.dirname(HTML), { recursive: true });
    writeFileSync(HTML, await res.text());
  }
  const html = readFileSync(HTML, 'utf8');
  const at = html.indexOf('cardsData:');
  if (at < 0) throw new Error('official: no cardsData in the page — the site changed');
  const data = parseSeroval(html, at + 'cardsData:'.length);
  return { cards: data.cards, sets: data.sets || data.card_sets || null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { cards } = await loadOfficial({ refresh: process.argv.includes('--refresh') });
  writeFileSync(OUT, JSON.stringify(cards));
  console.log(`official: ${cards.length} printings → ${path.relative(ROOT, OUT)}`);
}
