# Ink ▸ Play (demo)

Online Disney Lorcana for two players at `/play`. Host a room, send the invite link (`/play?room=CODE`), pick decks, play. There's also a practice bot.

## Architecture

| Piece | File | Notes |
|---|---|---|
| Card index | `game/cards.js` | Reads the cached dreamborn `cards.db` with `node:sqlite`, normalises keywords/abilities, parses decklists, validates Constructed rules, generates 4 demo decks |
| Rules engine | `game/engine.js` | Pure, server-authoritative state machine. `applyAction()` is atomic (an illegal action rolls back fully). `viewFor(seat)` hides hands/decks/inkwells |
| Shared rules | `public/js/play/rules.js` | Legality helpers imported by **both** server and client, so they can't drift |
| Lobby | `game/lobby.js` | WebSocket rooms at `/ws/play`: create/join/spectate, deck select, ready/start, chat, reconnect tokens, rate limiting, idle cleanup |
| Bot | `game/bot.js` | Simple opponent: ink → play → good challenges → quest |
| 3D board | `public/js/play/board.js`, `textures.js` | three.js (served from `node_modules` at `/vendor/three`) |
| UI | `public/play.html`, `public/js/play/main.js`, `public/css/play.css` | Lobby, HUD counters, card inspector, targeting, mulligan/peek/discard modals |

## Automated vs. manual

Automated: setup + mulligan, ready/set/draw, drying, 1 ink per turn, paying costs, playing every card type, singing + Sing Together, Shift (incl. Puppy/Universal), questing, challenges (Evasive, Alert, Bodyguard, Challenger, Resist, Rush, Reckless), locations (move cost, start-of-turn lore, being challenged), Support, Boost, damage → banish, 20 lore win, deck-out, concede.

Card text is compiled into **procs** at build time (`game/procs/`, see [game/procs/README.md](../game/procs/README.md)). When **every** clause of an ability compiles, the engine runs it through an effect queue, and choices show up as prompts for the right player. If any clause isn't recognised, the whole ability stays manual, so a card never gets half-resolved. Automated abilities are marked **⚡ auto** in the card panel. Look up any card's proc at **`/procs`**.

- Triggers: "When you play this …", "Whenever this character quests …", plus actions and songs
- Effects: draw N · gain / opponents lose lore · deal N damage (Resist applies) · remove up to N damage · banish / return to hand / bottom of deck / exert / ready *chosen …* · ±N ⚔️🛡️◆ and keyword grants "this turn" or "until the start of your next turn" · discard (chosen, at random, or *each opponent chooses*) · each opponent banishes or exerts one of theirs
- Target filters: opposing / of yours / another / damaged / exerted / ready, "with N ⚔️ or less/more", "cost N or less/more". Ward is enforced
- "you may …" becomes a Yes/No or Skip prompt, and declining also skips the linked ", then …" clause

Coverage on the current card pool: about 150 of 676 play/quest triggers and 86 of 343 actions/songs. All 4 demo decks are built only from cards the engine fully automates.

Manual (like a real table): everything else. Unrecognised abilities show up in the log as `↳ reminders`. Players resolve them with the manual tools (damage, lore, exert/ready, stat/keyword mods, move cards between zones, draw, look at top N, shuffle), and every action gets logged for both players.

## Tests

```
pnpm test:effects         # scenario tests for automated abilities (Ward, Resist, durations, may/then, opponent choices)
pnpm test:engine          # 60 bot-vs-bot games + fuzzed illegal actions, invariants checked after each step
pnpm test:lobby           # needs the server running: ws://localhost:3000/ws/play
```

## Assets

- Card data + images: dreamborn.ink (`cards.db`, `cdn.dreamborn.ink/images/en/cards/<id>`, CORS-enabled). Downscaled to 512px wide in the browser.
- Card back, table felt, counters, lore dial: drawn procedurally in canvas. This is original art, not the official card back.
- Still missing: sound effects, a proper lore-tracker/ink icon set, card-back art, avatars, and an animated "challenge" effect.
