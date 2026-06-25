// =====================================================================
//  Scryfall-style query parser + evaluator for Lorcana cards.
// ---------------------------------------------------------------------
//  Examples:
//    (c:r or c:b) (t:item or t:character) o:draw o:banish o:"this item" -o:{t}
//    c:amber t:character cost>=3 cost<=5 kw:singer lore>=2 i:yes
//    n:mickey -tt:tailor o:"+1"
//    p:villain o:banish r:legendary
//    f:"toy story" t:character str>3
//
//  Field codes (all case-insensitive):
//
//    c, color, ink        amber|a, amethyst|m|purple|p,
//                         emerald|e|g|green, ruby|r|red,
//                         sapphire|s|b|blue, steel|t|gray
//                         (multi-color cards match any listed color)
//    t, type              character | action | item | location | song
//    n, name              substring of name
//    tt, title, st        substring of title
//    o, oracle, text      substring of abilities + keywords
//    kw, keyword          singer | support | ward | evasive | rush |
//                         bodyguard | challenger | reckless | resist |
//                         shift | vanish | alert | boost
//    p, prop, char        substring of characteristics
//                         (storyborn, dreamborn, hero, villain, princess,
//                          prince, ally, mentor, toy, alien, etc.)
//    f, franchise         substring of franchise
//    r, rarity            common | uncommon | rare | super rare |
//                         legendary | enchanted | epic | iconic | promo
//    set, s               001..012 (3-digit set id)
//    i, inkable, inkwell  yes|no|true|false|1|0
//    illu, illus, artist  substring of illustrator
//
//    NUMERIC ops: >, <, >=, <=, =, !=, ..  (e.g. cost>=3, lore=2, str3..5)
//      cost                ink cost
//      str, a, attack      strength
//      wp, w, def          willpower
//      lore, l             lore
//      mv, move            movement (locations)
//
//  Boolean: AND (implicit), OR, parentheses.
//  Negation: prefix with `-` (preferred) or `!`.
//    -t:song    NOT a song
//    -"some phrase"   exclude that phrase from oracle
//
//  In-text symbols (case insensitive): {exert},{ink},{lore},{strength},{willpower}
//  Shorthand inside o:: {t}→{exert}, {i}→{ink}, {l}→{lore}, {s}→{strength}, {w}→{willpower}
//
//  Bare words (no field) match the card NAME or subtitle (like a normal
//  search bar). Use o:/text: to search the rules text instead.
// =====================================================================

const COLOR_ALIASES = {
  a: 'amber', am: 'amber', amber: 'amber',
  m: 'amethyst', am2: 'amethyst', purple: 'amethyst', p: 'amethyst', amethyst: 'amethyst',
  e: 'emerald', g: 'emerald', green: 'emerald', emerald: 'emerald',
  r: 'ruby', red: 'ruby', ruby: 'ruby',
  s: 'sapphire', b: 'sapphire', blue: 'sapphire', sapphire: 'sapphire',
  t: 'steel', gray: 'steel', grey: 'steel', steel: 'steel',
};

const SYMBOL_ALIASES = {
  t: 'exert', e: 'exert', x: 'exert',
  i: 'ink', ink: 'ink',
  l: 'lore', lore: 'lore',
  s: 'strength', str: 'strength', strength: 'strength', a: 'strength', attack: 'strength',
  w: 'willpower', wp: 'willpower', def: 'willpower', willpower: 'willpower',
};

const RARITIES = new Set(['common','uncommon','rare','super rare','legendary','enchanted','epic','iconic','promo']);

// Lex: split into raw tokens, honouring "double quoted" strings and parens.
// A single token can splice quoted and unquoted runs (e.g. `o:"this item"`),
// so the inner group repeats either a quoted span or a non-whitespace/paren run.
const TOKEN_RE = /\s*(\(|\)|(?:"(?:[^"\\]|\\.)*"|[^\s()"]+)+)/y;

function tokenize(input) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(input))) {
    const raw = m[1];
    if (raw === '(' || raw === ')') tokens.push({ t: raw, v: raw });
    else if (/^(or|OR|\|\|)$/.test(raw)) tokens.push({ t: 'or' });
    else if (/^(and|AND|&&)$/.test(raw)) tokens.push({ t: 'and' });
    else if (raw === '-' || raw === '!') tokens.push({ t: 'not' });
    else tokens.push({ t: 'term', v: raw });
  }
  return tokens;
}

// Strip surrounding quotes if the whole string is a single quoted span.
function unquote(s) {
  if (typeof s !== 'string') return s;
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
  return s;
}

// Parse: recursive descent. Grammar:
//   expr  := or
//   or    := and ('or' and)*
//   and   := unary (and? unary)*       (whitespace = implicit AND)
//   unary := '-' unary | atom
//   atom  := '(' expr ')' | term
function parse(input) {
  const toks = tokenize(input);
  let i = 0;
  const peek = () => toks[i];
  const eat = (t) => { if (peek() && peek().t === t) { i++; return true; } return false; };

  function parseExpr() { return parseOr(); }
  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().t === 'or') { i++; const right = parseAnd(); left = { op: 'or', a: left, b: right }; }
    return left;
  }
  function parseAnd() {
    let left = parseUnary();
    while (true) {
      const p = peek();
      if (!p) break;
      if (p.t === ')' || p.t === 'or') break;
      if (p.t === 'and') i++;
      const right = parseUnary();
      if (!right) break;
      left = { op: 'and', a: left, b: right };
    }
    return left;
  }
  function parseUnary() {
    if (peek() && peek().t === 'not') {
      // support `-foo` (the `-` was tokenized as 'not' only when standalone;
      // a `-key:val` term keeps the dash inside `v`). Both paths handled below.
      i++;
      const inner = parseUnary();
      return inner && { op: 'not', a: inner };
    }
    return parseAtom();
  }
  function parseAtom() {
    const p = peek(); if (!p) return null;
    if (p.t === '(') {
      i++;
      const e = parseExpr();
      eat(')');
      return e;
    }
    if (p.t === 'term') {
      i++;
      // A term may be `-key:val`, `key!val` (negated), `key:val`, `key>3`, etc.
      let v = p.v;
      let negate = false;
      if (v.startsWith('-') && v.length > 1) { negate = true; v = v.slice(1); }
      const f = compileFilter(v);
      const node = { op: 'pred', fn: f.fn, src: f.src, error: f.error };
      return negate ? { op: 'not', a: node } : node;
    }
    // unexpected
    i++;
    return null;
  }
  const tree = parseExpr();
  if (i < toks.length) {
    // trailing junk we couldn't parse — ignore but report
    return { tree, leftover: toks.slice(i) };
  }
  return { tree, leftover: [] };
}

// ---------- filter compilation ----------
function abilityText(card) {
  let s = '';
  if (Array.isArray(card.abilities)) {
    for (const a of card.abilities) s += ' ' + ((a.name ? a.name + ': ' : '') + (a.description || ''));
  } else if (typeof card.abilities === 'string') {
    try { const j = JSON.parse(card.abilities);
      if (Array.isArray(j)) for (const a of j) s += ' ' + ((a.name ? a.name + ': ' : '') + (a.description || ''));
      else s += ' ' + card.abilities;
    } catch { s += ' ' + card.abilities; }
  }
  let kw = '';
  if (typeof card.keywords === 'string' && card.keywords) {
    try {
      const k = JSON.parse(card.keywords);
      kw = Object.keys(k).join(' ');
    } catch { kw = card.keywords; }
  } else if (card.keywords && typeof card.keywords === 'object') {
    kw = Object.keys(card.keywords).join(' ');
  }
  // Collapse the newlines/extra spaces that separate a card's abilities so a
  // quoted phrase matches as one continuous string regardless of wrapping.
  // (Symbol normalisation from #2 is applied first by expandSymbols.)
  return collapseWhitespace(expandSymbols((s + ' ' + kw).toLowerCase()));
}

// Collapse runs of whitespace (spaces, tabs, and the newlines between a card's
// abilities) into a single space. Applied to both the oracle haystack and the
// search needle so an exact "quoted phrase" lines up regardless of how the
// source text happens to wrap. (See #3.)
function collapseWhitespace(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}
function characteristicsText(card) {
  if (typeof card.characteristics === 'string') {
    try { return JSON.parse(card.characteristics).join(' ').toLowerCase(); }
    catch { return card.characteristics.toLowerCase(); }
  }
  if (Array.isArray(card.characteristics)) return card.characteristics.join(' ').toLowerCase();
  return '';
}
function keywordsObj(card) {
  if (!card.keywords) return {};
  if (typeof card.keywords === 'string') {
    try { return JSON.parse(card.keywords); } catch { return {}; }
  }
  return card.keywords;
}

// Symbol expansion in oracle text searches
function expandSymbols(s) {
  return s.replace(/\{([a-z]+)\}/gi, (_, k) => {
    const norm = SYMBOL_ALIASES[k.toLowerCase()];
    return '{' + (norm || k.toLowerCase()) + '}';
  });
}

// Compare numeric value w/ an operator + rhs (string).
function cmp(val, op, rhs) {
  if (val == null) return false;
  if (op === '..') {
    const [lo, hi] = rhs;
    return Number(val) >= lo && Number(val) <= hi;
  }
  const n = Number(rhs);
  if (Number.isNaN(n)) return false;
  const v = Number(val);
  switch (op) {
    case '>':  return v >  n;
    case '<':  return v <  n;
    case '>=': return v >= n;
    case '<=': return v <= n;
    case '=':  case ':': return v === n;
    case '!=': return v !== n;
  }
  return false;
}

// Parse a "filter atom" — the raw token text after any leading '-'.
//   key:val, key=val, key>=val, key<n, key..n, etc.
//   bare term -> { fn: oracle-substring, src: '"text"' }
function compileFilter(raw) {
  // negation via `!` (e.g. `o!draw`) :
  //   detect operator: : , = , != , >= , <= , > , < , !  in that order
  let m;
  if ((m = raw.match(/^([a-z]+)(:|=|!=|!|>=|<=|>|<)(.+)$/i))) {
    const key = m[1].toLowerCase();
    let op = m[2];
    let val = m[3];
    // a..b range
    let range;
    if ((range = val.match(/^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/))) {
      op = '..';
      val = [Number(range[1]), Number(range[2])];
    }
    // val may have inline quoted spans (e.g. f:"toy story"); strip outer quotes
    // and any embedded quotes used purely for whitespace grouping.
    if (typeof val === 'string') val = unquote(val).replace(/"/g, '');
    const negated = op === '!';
    if (negated) op = ':';
    const pred = buildFieldPred(key, op, val);
    if (!pred) return { fn: () => false, src: raw, error: 'unknown field "' + key + '"' };
    if (negated) return { fn: (c) => !pred(c), src: raw };
    return { fn: pred, src: raw };
  }
  // bare term: default to a card NAME / subtitle search. Most search bars work
  // this way, so plain text should behave the same here; use o:/text: to search
  // the rules text instead. (See #4.)
  const needle = unquote(raw).toLowerCase();
  return {
    fn: (c) => String(c.name || '').toLowerCase().includes(needle)
            || String(c.title || '').toLowerCase().includes(needle),
    src: raw,
  };
}

// Split a value on commas (or slashes / plus signs) for ANY-match. Treats
// the whole string as one term if there are no separators.
function splitMulti(v) {
  return String(v).split(/[,/+]/).map((s) => s.trim()).filter(Boolean);
}

function buildFieldPred(key, op, val) {
  const sval = (typeof val === 'string') ? val.toLowerCase() : val;
  switch (key) {
    case 'c': case 'color': case 'ink': {
      // val may be "amber" or comma list "amber,ruby" → match ANY
      // Special: "multi" or "2" → 2+ inks; "mono" or "1" → exactly 1 ink
      if (typeof sval === 'string') {
        if (sval === 'multi' || sval === 'm' || sval === '2+') return (c) => (c.inks?.length || 0) >= 2;
        if (sval === 'mono' || sval === 'single' || sval === '1') return (c) => (c.inks?.length || 0) === 1;
      }
      const list = splitMulti(sval).map((s) => COLOR_ALIASES[s] || s);
      if (!list.length) return null;
      return (c) => list.some((ink) => c.inks?.includes(ink));
    }
    case 't': case 'type': {
      const list = splitMulti(sval);
      return (c) => list.includes(String(c.type || '').toLowerCase());
    }
    case 'n': case 'name': {
      const list = splitMulti(sval);
      return (c) => list.some((n) => String(c.name || '').toLowerCase().includes(n));
    }
    case 'tt': case 'title': case 'st': case 'subtitle': {
      const list = splitMulti(sval);
      return (c) => list.some((n) => String(c.title || '').toLowerCase().includes(n));
    }
    case 'o': case 'oracle': case 'text': {
      // Single phrase only (commas can legitimately appear in oracle text).
      // Whitespace is collapsed on both sides so the quoted text is matched as
      // one continuous string even when it spans the card's line breaks.
      const needle = collapseWhitespace(expandSymbols(String(sval)));
      return (c) => abilityText(c).includes(needle);
    }
    case 'kw': case 'keyword': {
      const list = splitMulti(sval);
      return (c) => {
        const k = keywordsObj(c);
        const kk = Object.keys(k).map((x) => x.toLowerCase());
        return list.some((n) => kk.some((x) => x.includes(n)));
      };
    }
    case 'p': case 'prop': case 'char': case 'characteristic': case 'characteristics': {
      const list = splitMulti(sval);
      return (c) => { const t = characteristicsText(c); return list.some((n) => t.includes(n)); };
    }
    case 'f': case 'franchise': {
      const list = splitMulti(sval);
      return (c) => { const f = String(c.franchise || '').toLowerCase(); return list.some((n) => f.includes(n)); };
    }
    case 'r': case 'rarity': {
      const list = splitMulti(sval);
      return (c) => list.includes(String(c.rarity || '').toLowerCase());
    }
    case 'set': case 's': {
      const list = splitMulti(sval).map((x) => x.padStart(3, '0'));
      return (c) => list.includes(String(c.setId || ''));
    }
    case 'i': case 'inkable': case 'inkwell': {
      const truthy = /^(yes|y|true|t|1)$/i.test(String(sval));
      const falsy  = /^(no|n|false|f|0)$/i.test(String(sval));
      if (truthy) return (c) => Number(c.ink) === 1;
      if (falsy)  return (c) => Number(c.ink) !== 1;
      return null;
    }
    case 'illu': case 'illus': case 'illustrator': case 'artist': {
      const n = String(sval);
      return (c) => String(c.illustrator || '').toLowerCase().includes(n);
    }
    // numeric
    case 'cost':                              return (c) => cmp(c.cost,      op, val);
    case 'str': case 'a': case 'attack': case 'strength': return (c) => cmp(c.strength, op, val);
    case 'wp': case 'w': case 'def': case 'defense': case 'willpower': return (c) => cmp(c.willpower, op, val);
    case 'lore': case 'l':                    return (c) => cmp(c.lore,      op, val);
    case 'mv': case 'move': case 'movement':  return (c) => cmp(c.movement,  op, val);
  }
  return null;
}

// ---------- public API ----------

/**
 * Compile a search string into a `(card) => boolean` predicate.
 * Returns `{ predicate, errors, tokens }`. If `input` is empty/whitespace,
 * predicate matches everything.
 */
export function compileQuery(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return { predicate: () => true, errors: [], leftover: [] };
  const parsed = parse(trimmed);
  const errors = [];
  function evalNode(node, card) {
    if (!node) return true;
    switch (node.op) {
      case 'and': return evalNode(node.a, card) && evalNode(node.b, card);
      case 'or':  return evalNode(node.a, card) || evalNode(node.b, card);
      case 'not': return !evalNode(node.a, card);
      case 'pred': return node.fn(card);
    }
    return true;
  }
  // pre-collect any "unknown field" errors
  (function walk(n) {
    if (!n) return;
    if (n.error) errors.push(n.error);
    walk(n.a); walk(n.b);
  })(parsed.tree);
  if (parsed.leftover.length) errors.push('unparsed: ' + parsed.leftover.map((t) => t.v ?? t.t).join(' '));
  return { predicate: (card) => evalNode(parsed.tree, card), errors, leftover: parsed.leftover };
}

// Convenient one-shot.
export function searchCards(cards, query) {
  const { predicate, errors } = compileQuery(query);
  return { results: cards.filter(predicate), errors };
}

// Cheat-sheet HTML for the help popover.
export const HELP_HTML = `
<div style="font-family:Tahoma,sans-serif; font-size:12px; line-height:1.45;">
<p>Combine filters separated by spaces. Use <b>OR</b> and parentheses for choice.
Prefix with <code>-</code> to negate. Use <code>"quoted phrases"</code> for multi-word values.</p>

<table style="border-collapse:collapse;">
  <tr><td><code>c:</code> <code>color:</code> <code>ink:</code></td><td>amber·amethyst·emerald·ruby·sapphire·steel (or 1-letter a/m/e/r/s/t). Multi-color: <code>c:multi</code></td></tr>
  <tr><td><code>t:</code> <code>type:</code></td><td>character · action · item · location · song</td></tr>
  <tr><td><i>(no prefix)</i></td><td><b>card name or subtitle</b> — plain text searches names by default; use <code>o:</code> for rules text</td></tr>
  <tr><td><code>n:</code> <code>name:</code></td><td>substring of card name</td></tr>
  <tr><td><code>tt:</code> <code>title:</code></td><td>substring of subtitle (e.g. "Brave Little Tailor")</td></tr>
  <tr><td><code>o:</code> <code>text:</code></td><td>oracle text + keywords substring</td></tr>
  <tr><td><code>kw:</code></td><td>singer, support, ward, evasive, rush, bodyguard, challenger, resist, shift, vanish, alert, boost, reckless</td></tr>
  <tr><td><code>p:</code> <code>prop:</code></td><td>storyborn · dreamborn · hero · villain · princess · prince · ally · mentor · toy · alien · …</td></tr>
  <tr><td><code>f:</code> <code>franchise:</code></td><td>e.g. <code>f:"toy story"</code>, <code>f:encanto</code></td></tr>
  <tr><td><code>r:</code> <code>rarity:</code></td><td>common · uncommon · rare · "super rare" · legendary · enchanted · epic · iconic · promo</td></tr>
  <tr><td><code>set:</code></td><td>3-digit set id, e.g. <code>set:008</code></td></tr>
  <tr><td><code>i:</code> <code>inkable:</code></td><td>yes / no</td></tr>
  <tr><td><code>illu:</code> <code>artist:</code></td><td>illustrator name</td></tr>
  <tr><td colspan=2><b>Numeric</b> (use <code>&gt;</code> <code>&lt;</code> <code>&gt;=</code> <code>&lt;=</code> <code>=</code> <code>!=</code> or <code>3..5</code>):</td></tr>
  <tr><td><code>cost</code> · <code>str</code>/<code>a</code> · <code>wp</code>/<code>w</code> · <code>lore</code>/<code>l</code> · <code>mv</code></td><td>ink cost · strength · willpower · lore · movement</td></tr>
  <tr><td colspan=2><b>Symbols in oracle:</b> <code>{exert}</code> <code>{ink}</code> <code>{lore}</code> <code>{strength}</code> <code>{willpower}</code>. Shorthand: <code>o:{t}</code>=exert, <code>{i}</code>=ink, <code>{l}</code>=lore, <code>{s}</code>=strength, <code>{w}</code>=willpower.</td></tr>
</table>

<p style="margin-top:8px;"><b>Examples</b></p>
<ul style="margin:4px 0 0 18px;">
  <li><code>(c:r or c:b) (t:item or t:character) o:draw o:banish o:"this item" -o:{t}</code></li>
  <li><code>c:amber t:character cost&gt;=3 cost&lt;=5 kw:singer</code></li>
  <li><code>p:villain o:banish r:legendary -t:song</code></li>
  <li><code>f:"toy story" lore&gt;=2 i:yes</code></li>
</ul>
</div>`;
