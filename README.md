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
- **Browse public decks** — 🃄 Decks button opens a deck browser that proxies
  `https://dreamborn.ink/api/v2/decks` (Popular / Trending / Video / Latest),
  with color and format filters, name/creator search, and pagination. One
  click imports any deck into the builder (decoded from dreamborn's `pbCode`).
- **Profile + themes** — 👤 Profile button opens a panel with account info,
  statistics, and a theme picker. Six themes:
  * **HTML 1996** — the default silver chrome look.
  * **Modern Dark** — slate + neon blue, soft shadows.
  * **Modern Light** — clean white cards, blue title bar.
  * **Lorcana Ink** — deep purple + gold, serif, glowing borders.
  * **Terminal** — phosphor green CRT with scanlines, monospace.
  * **Geocities '99** — rainbow chrome, Comic Sans, peak Web 1.0.

  Themes live in `public/css/themes.css` as CSS custom-property overrides
  on `[data-theme="..."]`; persisted in `localStorage` as `ink.theme`.

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
server.js              Express: auth, AI, db cache, decks proxy, static
public/index.html      Win95-style chrome shell + modals
public/css/style.css   Base layout + Win95 primitives, themed via CSS vars
public/css/themes.css  Alternate themes (modern-dark/light, lorcana, terminal, geocities)
public/js/db.js        sql.js wiring, ink bitmask decoding
public/js/auth.js      /api/login, /api/me, /api/collection
public/js/deck.js      Deck model, import/export, legality
public/js/ai.js        Server proxy or BYO key (OpenAI/Anthropic)
public/js/search.js    Scryfall-style query parser + predicate compiler
public/js/themes.js    Theme registry; applies persisted theme before render
public/js/decks.js     Deck-browser modal (proxies dreamborn.ink/decks)
public/js/app.js       Everything wired together: UI, grid, deck, AI chat
public/dreamborn-sniffer.js  Console-paste fetch/XHR/WebSocket recorder
```

## Endpoints we proxy

| Path                      | Source                                              | Notes                          |
| ------------------------- | --------------------------------------------------- | ------------------------------ |
| `/api/cards.db`           | `dreamborn.ink/cache/en/cards.db`                   | 1h cache                       |
| `/api/prices.db`          | `dreamborn.ink/cache/prices/{cur}/prices.db`        | 1h cache                       |
| `/api/login`              | Firebase Identity Toolkit → dreamborn `/api/auth/login` | issues `ink_sid` cookie    |
| `/api/me`                 | (session lookup)                                    | who am I                       |
| `/api/collection`         | `dreamborn.ink/api/users/{uid}/owned-cards`         | needs sign-in                  |
| `/api/decks`              | `dreamborn.ink/api/v2/decks`                        | page 2+ needs sign-in          |
| `/api/decks/:id`          | scrapes the Nuxt SSR payload from `/decks/{id}`     | decodes `pbCode` into cards    |
| `/api/ai/chat`            | OpenAI or Anthropic                                 | server keys optional           |

## Disclaimer

Not affiliated with Disney, Ravensburger, or Dreamborn. Card images and data
are pulled from publicly cached endpoints at `dreamborn.ink`. Use politely.
