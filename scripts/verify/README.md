# Verifying the cards

"Runnable" only means the compiler produced a proc the engine supports. A card is **verified** when it clears every
check below. `pnpm verify` runs the static ones; `pnpm test` runs all of them.

| check | what it proves | file |
|---|---|---|
| schema | every proc is well-formed: known building blocks, only fields their class reads, and every back-reference (`ifDid`, `linked`, `otherwise`, "that card", "that many") has something before it to refer to | `schema.mjs` |
| gates | which steps of an ability happen ("you may", "If you do,", "then", "If …,", "Otherwise,") is written down as a spec (`GATES`); every step-list shape in the corpus, under every combination of outcomes, runs exactly the spec's steps through the real `Runtime.pump` | `gates.mjs` |
| probe | every word of the card text is read: deleting any part or content word changes the proc (redundant templating words are listed, with reasons, in `probe-allow.json`) | `probe.mjs` |
| readback | the plain-English read-back (`game/procs/explain.js`) shows every field, so a reviewer can see a misread; no junk read-backs (fields allowed to stay unsaid are in `readback-allow.json`, with reasons) | `readback.mjs` |
| explore | for every card with a runnable ability: on a small fixed board, play it / quest / use each ability / pass the turn / challenge, then take **every** answer to every prompt that follows. Every reachable state passes `checkInvariants`, no stuck bag, no unanswerable prompt, no crash, a bad answer leaves the state untouched, the same action replays the same | `explore.mjs` |
| scenarios | the card does what its **printed text** says: for each ability whose sentences the independent phrase table reads, fire it on a small board and diff against the same run with the ability removed; declining a "may" changes nothing. `--mutate` breaks each ability (numbers +1, opposing→yours) to prove the check notices; `--gaps` lists what it can't read yet | `scenarios.mjs` |
| properties | after every step of every simulated game: prompts are answerable, the bag drains, the game state check ran, cards out of play carry nothing, lore only drops through "lose lore" — on top of `engine.checkInvariants` | `props.mjs` (run by `scripts/sim-games.mjs`) |

An allow-list entry is a reviewed decision, not a way to make a check pass: add one only with the reason it's fine.
