# Ink — Lorcana deck builder and online table

Build Disney Lorcana decks, then play them in the browser against a friend or the bot; the rules engine
runs every card. One theme, "Inkwell & Gold": deep ink blues, gilt for what you can act on, Marcellus
for names and Figtree for everything else (`public/css/ink.css`).

## What it does

- **Card pool** — 2,680 Lorcana cards (3,450+ printings) across all sets: Ravensburger's official card data
  (cards.disneylorcana.com) merged onto `dreamborn.ink`'s public `sanitized.db`, queried locally via `sql.js`.
- **Deck builder** — click to add, right-click (or long-press) to remove, hover for the full card.
  Live legality (60 cards, ≤ 2 inks, ≤ 4 copies, and cards that change those rules), ink curve.
- **Accounts and decks** — every deck is stored in Ink's own database (`data/ink.db`), not on dreamborn.ink.
  A guest's first save creates a guest account for that browser; creating an account with an email and password
  keeps it (decks and all), and signing in from a browser that had guest decks moves them into the account.
- **Shared decks** — tick “Share with other players” and the deck shows under Browse decks → *Ink players*
  (`/api/community/decks`); `/api/community/stats` counts players, guests, decks and shared decks.
- **Test deck** — in the builder: the engine plays the deck against starter, your own or shared decks on the
  server (worker threads, `lib/sim.js`), optionally showing one game live, and reports matchups, the game plan,
  weaknesses (inkability, card draw, curve, removal, dead cards), strengths, combos, mulligan and per-card numbers
  (`game/analysis/`). Card and combo claims need ~99% confidence; everything carries its sample size.
- **Play** — `/play`: pick a deck tile and hit *Play … vs bot*, or create a room and send the invite link.
- **Dreamborn collection (optional)** — link a dreamborn.ink account to filter the pool to cards you own.
- **Import / export** — paste a decklist like `4 Mickey Mouse - Brave Little Tailor`, or copy yours back out.
- **Browse public decks** — proxies `https://dreamborn.ink/api/v2/decks`; one click imports a deck.

## Sign-in

Email + password: `lib/accounts.js` keeps users, password hashes (scrypt, per-user salt), sessions (only a SHA-256
of the cookie token) and decks in `data/ink.db`. Ten failed sign-ins from one IP or for one email in 15 minutes
pause sign-in for that IP/email. There's no password reset yet (it needs an email sender).

### Discord / Google (off for now)

The OAuth 2.0 flow is built but switched off. To turn it on, set `INK_OAUTH=1` plus either provider's credentials;
one that isn't configured stays hidden.

1. **Discord**: discord.com/developers/applications → New Application → OAuth2. Add the redirect
   `<PUBLIC_URL>/auth/discord/callback`, copy the Client ID and Secret into `DISCORD_CLIENT_ID` /
   `DISCORD_CLIENT_SECRET`. Scope used: `identify`.
2. **Google**: console.cloud.google.com → APIs & Services → Credentials → Create OAuth client ID (Web).
   Authorized redirect URI `<PUBLIC_URL>/auth/google/callback`; set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
   Scopes used: `openid profile`.
3. Set `PUBLIC_URL` to the address people open (e.g. your Cloudflare tunnel hostname), so the redirect URI
   matches exactly.

For local testing without a provider, `INK_DEV_LOGIN=1` (never in production) adds `/auth/dev?name=…`.

## How the Dreamborn collection link works

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
| `INK_OAUTH`         | `1` turns Discord / Google sign-in on (off by default). |
| `PUBLIC_URL`        | Public origin for OAuth redirects, e.g. `https://ink.example.com`. |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord sign-in. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`   | Google sign-in. |
| `CLOUDFLARED_TOKEN` | Token for the optional `cloudflared` tunnel service. |

## Run it with Docker

```bash
# Build + run with compose (recommended)
docker compose up --build           # http://localhost:8080

# …or plain Docker
docker build -t ink .
docker run -p 8080:5060 -v ink-cache:/app/cache -v ink-data:/app/data ink
```

Notes:

- The image is a small `node:24-alpine` build, runs as the non-root `node`
  user, and ships a `HEALTHCHECK`.
- `sanitized.db` is **not** baked in — the server downloads dreamborn's
  DBs and Ravensburger's card gallery into `/app/cache` on first boot and builds
  `sanitized.db` from them, so the container needs outbound internet. The `ink-cache`
  volume persists them across restarts.
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


## Play on a phone (PWA)

`/play` is an installable web app with a landscape layout in the style of MTG Arena: player plates on the left,
End turn and the ☰ menu (log, chat, tools) on the right, your hand across the bottom. Tap a card to see what it can do,
drag it onto the table to play it (or onto your inkwell to ink it). Portrait shows a "turn your phone" screen.

- Android / Chrome: open the site, the lobby offers **📲 Install the app** (or use the browser menu → Install).
- iPhone / iPad: Share → **Add to Home Screen**.
- The service worker (`public/sw.js`) caches the shell and card images so the app opens fast; the game itself always
  needs the server (WebSocket), there is no offline play.

## Architecture

```
┌────────────────────────────┐        ┌──────────────────────────────┐
│  Browser                   │        │  Node / Express              │
│ ────────────────────────── │ /api/* │ ──────────────────────────── │
│  index.html · style.css    │ ─────▶ │  /api/login    ─▶ Firebase   │
│  app.js · deck.js          │        │  /api/login    ─▶ dreamborn  │
│  db.js  (sql.js + WASM) ◀──┼─.db────│  /api/sanitized.db (built)   │
│  sanitized.db in-mem       │        │  /api/collection ─▶ dreamborn│
│                            │        │  /api/decks     ─▶ dreamborn │
│                            │        │  /api/decks/:id ─▶ dreamborn │
│  account.js            ◀───┼─/auth──│  lib/accounts.js ─▶ data/ink.db│
└────────────────────────────┘        └──────────────────────────────┘
```

`sanitized.db` is a SQLite file cached on disk for 1 hour. The
browser loads them via `sql.js` and runs queries client-side — no per-card
network calls. `sanitized.db` is built by `tools/import-cards.mjs`: dreamborn's
printings (ids, sets, rarity — decks and collections key on them) with
every rules field (cost, inkable, stats, classifications, keywords, text,
flavour, FAQ) taken from Ravensburger's catalog, which is the source of truth.

Site visits are recorded server-side into a small persistent SQLite DB
(`data/ink.db`, via Node's built-in `node:sqlite`), next to the accounts and their decks. It survives
restarts (`/api/stats`). To report bugs or request
features, use the **🐛 Issues** link in the header (or the footer).

## File map

```
server.js              Express: db cache, decks proxy, visit stats, static, lobby
lib/accounts.js        Email + password sign-in (Discord / Google behind INK_OAUTH), sessions, /api/my/decks
data/ink.db            Persistent SQLite: visits, users, sessions, decks (created at runtime, git-ignored)
public/index.html      Deck builder
public/css/ink.css     Theme tokens + shared components (all pages)
public/css/style.css   Deck builder layout
public/js/account.js   Account + deck storage shared by the builder and /play
public/js/db.js        sql.js wiring, ink bitmask decoding
public/js/auth.js      Dreamborn collection link: /api/login, /api/me, /api/collection
public/js/deck.js      Deck model, import/export, legality
public/js/search.js    Scryfall-style query parser + predicate compiler
public/js/decks.js     Deck-browser modal (proxies dreamborn.ink/decks)
public/js/app.js       Everything wired together: UI, grid, deck
public/dreamborn-sniffer.js  Console-paste fetch/XHR/WebSocket recorder
```

## Endpoints we proxy

| Path                      | Source                                              | Notes                          |
| ------------------------- | --------------------------------------------------- | ------------------------------ |
| `/api/sanitized.db`       | `dreamborn.ink/cache/en/cards.db` + `cards.disneylorcana.com` | 1h cache, official page re-read daily |
| `/api/login`              | Firebase Identity Toolkit → dreamborn `/api/auth/login` | issues `ink_sid` cookie    |
| `/api/me`                 | (session lookup)                                    | who am I                       |
| `/api/collection`         | `dreamborn.ink/api/users/{uid}/owned-cards`         | needs sign-in                  |
| `/api/decks`              | `dreamborn.ink/api/v2/decks`                        | page 2+ needs sign-in          |
| `/api/decks/:id`          | scrapes the Nuxt SSR payload from `/decks/{id}`     | decodes `pbCode` into cards    |
| `/api/stats`              | local `data/ink.db` (SQLite)                        | persistent site-visit counts   |

## Disclaimer

Not affiliated with Disney, Ravensburger, or Dreamborn. Card images and data
are pulled from publicly cached endpoints at `dreamborn.ink`. Use politely.
