# Ink — Lorcana Deck Builder (1996 edition)

A Disney Lorcana deck builder with an A.I. helper, styled like the web in **1996**:
silver chrome, 3D bevels, Times New Roman, a marquee, and a blinking caret. Best
viewed in Netscape Navigator 3.0+ (or, fine, anything modern).

> Theme inspired by entry #34 ("HTML 1996") from `shopify-playground/CssSwatch`.

## What it does

- **Card catalog** — 2,900+ Lorcana cards across all sets, fetched from
  `dreamborn.ink`'s public `cards.db` and queried locally via `sql.js`.
- **Deck builder** — left-click to add, right-click to remove, hover for a preview.
  Live legality: 60 cards, ≤ 2 inks, ≥ 30 inkable, ≤ 4 copies per unique card.
- **Sign-in (optional)** — Dreamborn email/password → Firebase Identity Toolkit →
  Dreamborn session cookie. The cookie stays on the server so the browser doesn't
  fight CORS. Lets you sync your owned collection and filter the catalog by what
  you own.
- **Import / export** — paste a decklist like `4 Mickey Mouse - Brave Little Tailor`,
  or copy yours back out.
- **A.I. helper** — talk to "Inkwell", which has your current decklist as context
  and can suggest cards, build decks around a theme, critique, or recommend
  swaps from your collection. If the AI returns a fenced ` ```decklist ` block,
  you can apply it in one click.

## How auth works

Three calls, chained server-side, matching the curls in the issue:

1. `POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword`
   — Firebase password auth, returns `idToken`.
2. `POST https://dreamborn.ink/api/auth/login` with `{token: idToken}`
   — Dreamborn replies with a `__session` cookie.
3. `GET https://dreamborn.ink/api/users/{uid}/owned-cards` with that cookie
   — your collection.

The server keeps the cookie in an in-memory session keyed by an httpOnly
`ink_sid` cookie it issues to the browser. Credentials never touch our backend
disk; they go straight to Google + Dreamborn.

## Run it

```bash
pnpm install        # or npm install
cp .env.example .env   # optional: add an AI key
pnpm start          # http://localhost:3000
```

Environment (all optional):

| Var                 | Effect                                          |
| ------------------- | ----------------------------------------------- |
| `OPENAI_API_KEY`    | Server-proxied AI via OpenAI (no key in browser). |
| `OPENAI_MODEL`      | Defaults to `gpt-4o-mini`.                       |
| `ANTHROPIC_API_KEY` | Server-proxied AI via Anthropic.                 |
| `ANTHROPIC_MODEL`   | Defaults to `claude-3-5-sonnet-latest`.          |
| `PORT`              | Defaults to 3000.                                |

If no server-side key is set, click **A.I. settings** in the UI to paste a
"bring your own key" — stored in your browser's `localStorage`, never sent to
our server.

## Architecture

```
┌────────────────────────────┐        ┌──────────────────────────────┐
│  Browser                   │        │  Node / Express              │
│ ────────────────────────── │ /api/* │ ──────────────────────────── │
│  index.html · style.css    │ ─────▶ │  /api/login    ─▶ Firebase   │
│  app.js · deck.js · ai.js  │        │  /api/login    ─▶ dreamborn  │
│  db.js  (sql.js + WASM) ◀──┼─.db────│  /api/cards.db (cached)      │
│                            │        │  /api/prices.db (cached)     │
│  cards.db queried in-mem   │        │  /api/collection ─▶ dreamborn│
│                            │        │  /api/ai/chat   ─▶ OpenAI    │
│                            │        │                 ─▶ Anthropic │
└────────────────────────────┘        └──────────────────────────────┘
```

`cards.db` and `prices.db` are SQLite files cached on disk for 1 hour. The
browser loads them via `sql.js` and runs queries client-side — no per-card
network calls.

## File map

```
server.js              Express: auth proxy, AI proxy, db cache, static
public/index.html      Win95-style chrome shell
public/css/style.css   The 1996 theme (silver/navy/Times) + Win95 primitives
public/js/db.js        sql.js wiring, ink bitmask decoding
public/js/auth.js      /api/login, /api/me, /api/collection
public/js/deck.js      Deck model, import/export, legality
public/js/ai.js        Server proxy or BYO key (OpenAI/Anthropic)
public/js/app.js       Everything wired together: UI, grid, deck, AI chat
```

## Disclaimer

Not affiliated with Disney, Ravensburger, or Dreamborn. Card images and data
are pulled from publicly cached endpoints at `dreamborn.ink`. Use politely.
