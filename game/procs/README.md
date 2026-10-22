# Procs: card text → runnable JSON

Every ability on every card is compiled **once, at build time**, into a small JSON program (a *proc*).
The engine runs the proc whenever the ability fires. Nothing is interpreted mid-game and no AI is involved.
The same text always compiles to the same proc.

```
tools/card-scan  →  cache/scan/results.jsonl  scan verdict per card (DB + card image + lorcanajson + corrections)
build-rulings    →  cache/rulings.db         cards · printings · rulings (one row per ability: db_text, scan_text, text, proc_id)
compile-procs    →  cache/proc.db            procs (proc_id = hash of the proc JSON, kind, exec, why, fns, json); fills rulings.proc_id
game/cards.js    →  def.procs                linked to every printing at load (falls back to compiling DB text)
procs/runtime.js →  engine                  fire(event) → queue → pump → s.pending prompts
/procs                                      look up any card and see its proc
```

```sh
pnpm build:rulings               # cards.db + scan results → rulings.db
pnpm build:procs                 # rulings.db → proc.db + coverage (add --misses for what to build next)
pnpm test:procs                  # compiler + runtime scenarios
pnpm test:chaos                  # 200 bot games with random decks of every runnable card
open http://localhost:3000/procs # lookup UI   (API: /api/procs/search?q=  /api/procs/card?full=  /api/procs/stats)
```

## Layers (`compile.js`)

| layer | what | where |
|---|---|---|
| L0 normalize | one spelling: `{ink}` `{strength}` `{exert}` `{lore}` `{willpower}`, `—` cost dash, straight quotes, `•` bullets, split ability names merged | `normalize.js` |
| L1 split | keyword lines vs named abilities; trigger / cost / condition / body | `compileAbility` |
| L2 phrases | **filter** ("damaged Villain character of yours with cost 3 or less"), **selector** (self · chosen · up to N · each · it/them), **amount** (N · their {strength} · for each X), **condition** | `filter` `selector` `condition` |
| L3 compose | sentences → ordered steps, with `may` / `linked` (then) / `ifDid` (if you do) / `otherwise` / `cond` gates | `clause` `effects` |

**All or nothing.** If any clause in an ability doesn't match, the whole ability becomes `{kind:'unparsed', why, at}`.
It stays manual: the text is logged for both players, like a real table. The same happens when the compiler
understands the text but the runtime doesn't support a building block yet. That case sets `exec:false` with
`why: "engine can't run: …"`, and `support.js` is the contract between the two.

## Proc shapes

```jsonc
{ "kind": "keyword",   "kws": [{ "kw": "resist", "n": 1 }] }
{ "kind": "triggered", "on": [{ "ev": "quest" }], "once": true, "during": "yours", "cond": {…}, "do": [steps] }
{ "kind": "activated", "cost": { "exert": true, "ink": 2 }, "do": [steps] }
{ "kind": "static",    "cond": { "have": {…}, "n": 1 }, "effect": { "fn": "mod", "sel": { "self": true }, "mods": [{ "stat": "str", "n": 2 }] } }
{ "kind": "action",    "playCost": { "n": 2, "cond": {…} }, "do": [steps] }
{ "kind": "unparsed",  "why": "effect: \"name a card\"", "at": "…" }
```

A step is `{ fn, …args }` and is executed by `FN[fn]` in `runtime.js`:

`draw gainLore loseLore damage heal moveDamage banish toHand toDeckBottom shuffleIn toInkwell inkTop mill exert ready mod discard oppChoose fromDiscard look payInk chooseOne playFree costMod shuffle`.
Statics also use `selfCost` and `enters`.

Example: Hades - Lord of the Underworld. *"When you play this character, return a character card from your discard to your hand."*

```json
{ "kind": "triggered", "on": [{ "ev": "play" }],
  "do": [{ "fn": "fromDiscard", "filter": { "types": ["character"], "zone": "discard", "owner": "you" }, "n": 1 }] }
```

## Runtime (`runtime.js`)

- **Triggers:** the engine calls `R.fire(s, ev, info)` on play, quest, challenge, banish (with in-challenge and banished-by info), turn start and end, sing, ink, and move. Each matching triggered proc on the relevant cards is queued in `s.fx`.
- **Pump:** `R.pump` runs queued steps in order.
  - A step that needs a choice sets `s.pending` and returns `null`.
  - `H.choose` → `R.answer` records the choice, and the same step re-enters.
  - Because every engine action is atomic (snapshot/rollback), a bad answer can't half-apply.
- **Prompts** (`s.pending`):
  - `valid` (+ `cards` for off-board picks) means pick a card.
  - `confirm` means yes/no.
  - `choices` means choose-one.
  - Only the choosing seat sees `valid`/`cards`.
- **Challenges:** "whenever this character challenges / is challenged" resolves **before** challenge damage (CR 4.6.5–4.6.6). Damage is a queued `_challengeDamage` step.
- **End of turn:** "at the end of your turn" resolves before the turn passes (a queued `_endTurn` step).
- **Statics:** re-applied in every game-state check (`R.statics`) as `until:'static'` mods, so conditions turn on and off live. Restrictions (`cantQuest`, `cantChallenge`, `cantReady`, `cantBeChallenged`, `cantSing`, `challengeReady`) are keyword-style mods checked in `public/js/play/rules.js`.
- **Costs:** `R.costDelta` combines a card's own "you pay N less", board statics, and one-shot "next card costs less" effects.

## Adding a building block

1. Run `pnpm build:procs --misses` and pick the biggest bucket.
2. Teach the compiler the phrase (L2/L3) so it emits a step. Coverage stays the same, but the reason changes to `engine can't run: fn X`.
3. Implement `FN.X` in `runtime.js` and add `'X'` to `support.js`. The runtime throws at startup if support lists a fn it doesn't have.
4. Add a scenario in `scripts/test-procs.mjs`, then run `pnpm test`.
