#!/usr/bin/env python3
"""Draft corrections.json for the cards the scanner couldn't settle (status close / mismatch / db-suspect).

Third source as the tie-breaker: lorcanajson's allCards.json (https://lorcanajson.org, community-transcribed
from the printed cards, with official errata applied). Per flagged card:
  DB text == lorcanajson   → "ocr"     the DB was right, the scan misread it (reviewed stamp)
  DB text != lorcanajson   → "db-fix"  use lorcanajson's text
  listed in ERRATA below   → "errata"  official text change from a set's release notes (docs/rules/)
Existing hand-written entries in corrections.json are kept as-is. Re-run after a scan:

    curl -sLo /tmp/allCards.json https://lorcanajson.org/files/current/en/allCards.json
    python3 tools/card-scan/make_corrections.py /tmp/allCards.json
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RESULTS = ROOT / "cache" / "scan" / "results.jsonl"
OUT = HERE / "corrections.json"
SYM = {"⬡": "{ink}", "¤": "{strength}", "◊": "{lore}", "⟳": "{exert}", "⛉": "{willpower}", "◉": "{inkable}"}
ERRATA = {  # card → where the official change is published
    "Jukebox": "Hyperia set notes (docs/rules/Hyperia-set-notes_EN.txt): 'a card in your discard' → 'another card in your discard'",
}


def sym(t: str) -> str:
    for k, v in SYM.items():
        t = t.replace(k, v)
    return re.sub(r"\s+", " ", t).strip()


def lj_abilities(c) -> list:
    if c.get("type") == "Action":                 # songs/actions: one ability, like the DB stores them
        return [{"name": None, "description": sym(c["fullText"])}] if c.get("fullText") else []
    out = []
    for a in c.get("abilities") or []:
        if a.get("type") == "keyword":
            out.append({"name": None, "description": sym(a["fullText"])})
        else:
            desc = a.get("effect", "")
            if a.get("costsText"):
                desc = f"{a['costsText']} — {desc}"
            out.append({"name": a.get("name"), "description": sym(desc)})
    return out


def norm(abilities) -> list:
    """Per ability, so a DB row that split one ability in two (Yao's "OOH," / "I'M SCARED") counts as wrong."""
    out = []
    for a in abilities:
        t = f"{a.get('name') or ''} | {a.get('description') or ''}"
        t = t.replace("{I}", "{ink}").replace("{S}", "{strength}").replace("{E}", "{exert}").replace("{L}", "{lore}")
        t = re.sub(r"[<>]", "", t).replace("’", "'").replace("—", "-").lower()
        out.append(re.sub(r"[^a-z0-9{}|+-]+", " ", t).split())
    return out


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    lj = json.loads(Path(sys.argv[1]).read_text())
    by = {}
    for c in lj["cards"] if isinstance(lj, dict) else lj:
        by.setdefault(c.get("fullName") or c["name"], c)
    corr = json.loads(OUT.read_text()) if OUT.exists() else {}
    corr.setdefault("_doc", "card full name → {why: errata|db-fix|ocr, abilities|replace, note, ocrNoise}. "
                    "Drafted by make_corrections.py, hand edits win.")
    added = {"errata": 0, "db-fix": 0, "ocr": 0, "no-lj": []}
    for line in RESULTS.read_text().splitlines():
        r = json.loads(line)
        full = r["full"]
        if r["status"] in ("match", "icon-fix") and full not in ERRATA:
            continue
        if full in corr:
            continue
        c = by.get(full)
        if not c:
            added["no-lj"].append(full)
            continue
        lja = lj_abilities(c)
        if full in ERRATA:
            corr[full] = {"why": "errata", "abilities": lja, "note": ERRATA[full]}
        elif norm(lja) == norm(r["db"]):
            corr[full] = {"why": "ocr", "note": "DB agrees with lorcanajson; scan misread"}
        else:
            corr[full] = {"why": "db-fix", "abilities": lja, "note": "DB disagrees with lorcanajson + the print"}
        added[corr[full]["why"]] += 1
    OUT.write_text(json.dumps(corr, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps(added, indent=1))


if __name__ == "__main__":
    main()
