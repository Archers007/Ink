// AI client. Prefers the server proxy (uses env keys). Falls back to BYO key in localStorage.

import * as Deck from './deck.js';
import { DB } from './db.js';

const LS_KEY = 'ink.byok';

export function loadByok() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch { return {}; }
}
export function saveByok(v) { localStorage.setItem(LS_KEY, JSON.stringify(v)); }

export async function serverConfig() {
  try {
    const r = await fetch('/api/ai/config');
    return await r.json();
  } catch { return { provider: null }; }
}

export function buildSystemPrompt(extra = {}) {
  const card_count = DB.allCards?.length ?? 0;
  return [
    "You are 'Inkwell', a Disney Lorcana deck-building assistant.",
    `You have access to ${card_count} cards via the user's deck builder.`,
    "Lorcana rules of thumb:",
    " - Decks are exactly 60 cards, at most 2 ink colors, max 4 copies per unique card.",
    " - Inks: Amber, Amethyst, Emerald, Ruby, Sapphire, Steel. Decks usually have ≥30 inkable cards.",
    " - Quest for lore (race to 20). Common archetypes: aggro, midrange, control, song-spam.",
    "Style: be concise, use bullet lists, and ALWAYS write card names exactly as `Name - Title` when proposing changes.",
    "When suggesting a deck, output a fenced ```decklist code block with one line per card formatted `4 Name - Title`.",
    extra.context ? `\nCURRENT DECK CONTEXT:\n${extra.context}` : '',
  ].join('\n');
}

export function deckContext() {
  const ents = Deck.entries();
  if (ents.length === 0) return 'Deck is empty.';
  const lines = [`Deck "${Deck.Deck.name}":`];
  for (const { card, qty } of ents) {
    lines.push(`- ${qty}x ${card.name}${card.title ? ' - ' + card.title : ''} (cost ${card.cost}, ${card.inks.join('/')}, ${card.type})`);
  }
  const s = Deck.summary();
  lines.push(`Totals: ${s.total} cards, ${s.inkable} inkable, avg cost ${s.avgCost.toFixed(2)}, inks ${s.inks.join('+') || 'none'}.`);
  return lines.join('\n');
}

export async function chat(messages, { onStream } = {}) {
  const system = buildSystemPrompt({ context: deckContext() });

  const cfg = await serverConfig();
  if (cfg.provider) {
    const r = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system, messages }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'ai error');
    return j.text;
  }

  // BYO key
  const byok = loadByok();
  if (!byok.key) throw new Error('No AI configured. Set OPENAI_API_KEY on server, or paste a key in A.I. Settings.');
  if (byok.provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': byok.key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: byok.model || 'claude-3-5-sonnet-latest',
        max_tokens: 1200,
        system,
        messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || 'anthropic error');
    return (j.content || []).map((b) => b.text || '').join('');
  }
  // default openai
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'authorization': 'Bearer ' + byok.key, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: byok.model || 'gpt-4o-mini',
      messages: [{ role: 'system', content: system }, ...messages],
      temperature: 0.7,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || 'openai error');
  return j.choices?.[0]?.message?.content ?? '';
}

// Parse `decklist` code block in AI output and return [{name, title, qty}, ...]
export function extractDecklist(text) {
  const m = text.match(/```(?:decklist)?\n([\s\S]*?)```/);
  if (!m) return null;
  const out = [];
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.trim().match(/^(\d+)\s*[xX]?\s+(.+?)$/);
    if (mm) out.push({ qty: Number(mm[1]), rest: mm[2].trim() });
  }
  return out;
}
