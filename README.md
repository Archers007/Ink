# Ink — Lorcana Deck Builder (1996 edition)

A Disney Lorcana deck builder, styled like the web in **1996** (and a few wilder
themes). Best viewed in Netscape Navigator 3.0+ (or, fine, anything modern).

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
cp .env.example .env   # optional: set PORT / Cloudflare tunnel token
pnpm start          # http://localhost:3000
```

Environment (all optional):

| Var                 | Effect                                          |
| ------------------- | ----------------------------------------------- |
| `PORT`              | Defaults to 3000.                                |
| `CLOUDFLARED_TOKEN` | Token for the optional `cloudflared` tunnel service. |

## Run it with Docker

```bash
# Build + run with compose (recommended)
docker compose up --build           # http://localhost:5060

# …or plain Docker
docker build -t ink .
docker run -p 5060:5060 -v ink-cache:/app/cache -v ink-data:/app/data ink
```

Notes:

- The image is a small `node:24-alpine` build, runs as the non-root `node`
  user, and ships a `HEALTHCHECK`.
- `cards.db` / `prices.db` are **not** baked in — the server downloads them
  from dreamborn.ink into `/app/cache` on first boot, so the container needs
  outbound internet. The `ink-cache` volume persists them across restarts.
- The persistent visit-stats DB lives in `/app/data/ink.db`; the `ink-data`
  volume keeps it (and the running hit count) across restarts.
- Set the published host port with `INK_PORT` (the app always listens on
  `5060` inside the container), e.g. `INK_PORT=8080 docker compose up`.

### Public access via Cloudflare Tunnel

The compose stack includes a `cloudflared` service that exposes the app
publicly with no inbound ports opened:

```bash
# put your tunnel token in .env (NEVER commit it):
#   CLOUDFLARED_TOKEN=eyJ...
docker compose up --build          # starts ink + cloudflared
```

- In the Cloudflare **Zero Trust → Networks → Tunnels** dashboard, point the
  tunnel's public hostname at the origin service **`http://ink:5060`**
  (cloudflared reaches the app by its compose service name over the shared
  network).
- The token is read from `CLOUDFLARED_TOKEN` in your local, git-ignored `.env`.
- To run Ink **without** the tunnel: `docker compose up ink`.

## Architecture

```
┌────────────────────────────┐        ┌──────────────────────────────┐
│  Browser                   │        │  Node / Express              │
│ ────────────────────────── │ /api/* │ ──────────────────────────── │
│  index.html · style.css    │ ─────▶ │  /api/login    ─▶ Firebase   │
│  app.js · deck.js          │        │  /api/login    ─▶ dreamborn  │
│  db.js  (sql.js + WASM) ◀──┼─.db────│  /api/cards.db (cached)      │
│                            │        │  /api/prices.db (cached)     │
│  cards.db queried in-mem   │        │  /api/collection ─▶ dreamborn│
│                            │        │  /api/decks     ─▶ dreamborn │
│                            │        │  /api/decks/:id ─▶ dreamborn │
│  hit counter           ◀───┼─stats──│  /api/stats     ─▶ data/ink.db│
└────────────────────────────┘        └──────────────────────────────┘
```

`cards.db` and `prices.db` are SQLite files cached on disk for 1 hour. The
browser loads them via `sql.js` and runs queries client-side — no per-card
network calls.

Site visits are recorded server-side into a small persistent SQLite DB
(`data/ink.db`, via Node's built-in `node:sqlite`). It survives restarts and
feeds the “Hits since 1996” counter in the header. To report bugs or request
features, use the **🐛 Issues** link in the header (or the footer).

## File map

```
server.js              Express: auth, db cache, decks proxy, visit stats, static
data/ink.db            Persistent SQLite visit log (created at runtime, git-ignored)
public/index.html      Win95-style chrome shell + modals
public/css/style.css   Base layout + Win95 primitives, themed via CSS vars
public/css/themes.css  Alternate themes (deep-sea-lab, vaporwave, brutalist-concrete, liquid-glass)
public/js/db.js        sql.js wiring, ink bitmask decoding
public/js/auth.js      /api/login, /api/me, /api/collection
public/js/deck.js      Deck model, import/export, legality
public/js/search.js    Scryfall-style query parser + predicate compiler
public/js/themes.js    Theme registry; applies persisted theme before render
public/js/decks.js     Deck-browser modal (proxies dreamborn.ink/decks)
public/js/app.js       Everything wired together: UI, grid, deck
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
| `/api/stats`              | local `data/ink.db` (SQLite)                        | persistent site-visit counts   |

## Disclaimer

Not affiliated with Disney, Ravensburger, or Dreamborn. Card images and data
are pulled from publicly cached endpoints at `dreamborn.ink`. Use politely.
