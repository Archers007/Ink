# card-scan

Reads each card's rules text **off the card image** and cross-checks it against `cache/cards.db`.
Deterministic — OpenCV + tesseract, no AI. Runs at build time; nothing here runs mid-game.

Why: dreamborn's text sometimes drops stat icons (Webby – Mystery Enthusiast reads
"gets +1 this turn"; the card says `+1 {strength}`). The image is the source of truth for icons,
the DB is the source of truth for spelling.

## Run

```sh
brew install tesseract          # once
pnpm scan:cards                 # whole pool, ~2.5 min with 12 jobs
uv run tools/card-scan/scan.py --name "Webby" --debug   # one card, annotated crop in cache/scan/debug/
```

Outputs (gitignored, in `cache/scan/`):
- `results.jsonl` — one row per card: status, icons found, banners, scanned text, diff problems
- `icon-fixes.json` — card id → DB abilities with the missing icons patched in
- `summary.json` — counts per status

## Which cards need the scan?

`node tools/card-scan/needs-ocr.mjs` flags cards whose DB text lost an icon, from the text alone (`+1 this turn`,
`pay 2 to`, a cost that starts with `—`, …). Against the last full scan it catches all 164 icon-fix cards; the other
50 it flags are printings the scan didn't read. close / mismatch cards are OCR trouble, which the DB text can't
predict, so the full scan still runs.

Each pattern lives in `PATTERNS` with real card text it must flag and must pass. To add or tune one:

    pnpm needs-ocr --missed            # icon-fix cards nothing catches: DB text + where the icon went
    pnpm needs-ocr --pattern stat-mod  # what one pattern flags, matched words in [brackets], ✓ = scan agrees
    pnpm needs-ocr --check             # every pattern vs its examples (runs in pnpm test)

## Pipeline

1. one normal-frame printing per card (skips enchanted / epic / iconic / promo full-art)
2. image cached in `cache/card-img/`; locations rotated upright
3. fixed-layout rules box (standard + legendary frames share it), lore-pip column trimmed
4. ability-name banners found (dark fill + white letters), OCR'd on their own, blanked
5. flavour text cut at the divider (one unbroken line across the box), then a second cut:
   align the scan to the DB text and drop trailing lines the DB doesn't cover. Never cuts past an
   ability banner — if a banner sits below the cut, the DB is missing an ability (`db-suspect`)
6. stat icons template-matched (`templates/*.png`: strength, willpower, lore, ink, exert), blanked
7. tesseract on the rest, icons slotted back in by position
8. token diff vs DB — reminder text and keyword phrases masked on both sides

## Statuses

| status     | meaning                                                         |
|------------|-----------------------------------------------------------------|
| `match`    | card and DB agree on every rules word and icon                  |
| `icon-fix` | agree on words; DB is missing icons the card shows → patched    |
| `close`    | 1-2 small disagreements, needs a look                           |
| `db-suspect` | scan looks right, DB looks broken (empty text, icon became a digit, missing ability) |
| `mismatch` | OCR or layout trouble, or a real DB difference — manual review  |

Only `match` / `icon-fix` cards should feed the ability compiler automatically.

## Corrections

`corrections.json` settles the cards the scan can't (close / mismatch / db-suspect). Keyed by card full name:

| why | meaning | the ruling gets |
|---|---|---|
| `errata` | official text change (set release notes in `docs/rules/`) | the official `abilities` |
| `db-fix` | the DB text is wrong (typo, old wording, missing icon/ability) | the fixed `abilities` (or `replace` pairs) |
| `ocr` | the DB is right, the scan misread it | the DB text, stamped reviewed |

`ocrNoise: true` = the scan only disagrees by a misread digit/letter, checked by hand.

Draft new entries with lorcanajson as the tie-breaker (hand edits are kept):

    curl -sLo /tmp/allCards.json https://lorcanajson.org/files/current/en/allCards.json
    python3 tools/card-scan/make_corrections.py /tmp/allCards.json

`summary.json → corrections` lists unknown card names, unused `replace` pairs and db-fixes the scan doesn't back up.
Each row's `rules` (clean text for the ability compiler, flavour cut) carries `source` (db · db+icons · errata · corrected · reviewed · scan)
and `verified`. `node tools/build-rulings.mjs` combines it with `cards.db` into `cache/rulings.db`, one `rulings` row per ability.
