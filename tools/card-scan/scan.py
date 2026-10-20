# /// script
# requires-python = ">=3.10"
# dependencies = ["opencv-python-headless>=4.9", "numpy>=1.26"]
# ///
"""
Scan Lorcana card images and read their rules text (+ stat icons) straight off the card.

Pipeline per card (all deterministic, no AI):
  1. pick one standard printing per card (skip enchanted / iconic / promo full-art)
  2. download the image once into cache/card-img/
  3. locations are printed sideways → rotate them upright
  4. find the parchment rules box, cut it at the flavour-text divider
  5. find the dark ability-name banners → OCR them on their own, then blank them
  6. template-match the stat icons ({S} {W} {L} {I} {E}) → record them, then blank them
  7. OCR what's left (tesseract), slot the icons back in by position
  8. diff against the cards.db text; when the DB is missing an icon the card has, patch it in

Usage:
  uv run tools/card-scan/scan.py                 # whole pool → cache/scan/results.jsonl + summary.json
  uv run tools/card-scan/scan.py --name Webby    # just matching cards, print results
  uv run tools/card-scan/scan.py --name Webby --debug   # also writes annotated crops to cache/scan/debug/
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sqlite3
import subprocess
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "cache" / "cards.db"
IMG_DIR = ROOT / "cache" / "card-img"
OUT_DIR = ROOT / "cache" / "scan"
TPL_DIR = Path(__file__).resolve().parent / "templates"
CDN = "https://cdn.dreamborn.ink/images/en/cards/"

ICONS = ["strength", "willpower", "lore", "ink", "exert"]
FULL_ART = {"enchanted", "iconic", "promo", "epic"}
ICON_TOKEN = {k: "{" + k + "}" for k in ICONS}
# dreamborn writes the same icon several ways
DB_ICON_ALIASES = {
    "{S}": "{strength}", "{W}": "{willpower}", "{L}": "{lore}", "{I}": "{ink}", "{E}": "{exert}",
    "{toughness}": "{willpower}", "{inkk}": "{ink}",
}

# ---------------------------------------------------------------- card selection


def load_cards(name_filter: str | None):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "select id, name, title, type, rarity, abilities, keywords from cards where language='en' or language is null"
    ).fetchall()
    groups: dict[str, list] = {}
    for r in rows:
        abil = json.loads(r["abilities"] or "[]")
        if not abil:
            continue
        full = f"{r['name']} - {r['title']}" if r["title"] else r["name"]
        if name_filter and name_filter.lower() not in full.lower():
            continue
        groups.setdefault(full, []).append((r, abil))
    cards = []
    for full, printings in groups.items():
        # prefer a normal-frame printing; full-art layouts put the text somewhere else
        printings.sort(key=lambda p: (p[0]["rarity"] in FULL_ART, p[0]["id"]))
        r, abil = printings[0]
        cards.append({"id": r["id"], "full": full, "type": r["type"], "rarity": r["rarity"], "abilities": abil,
                      "keywords": json.loads(r["keywords"] or "{}"),
                      "alts": [p[0]["id"] for p in printings[1:] if p[0]["rarity"] not in FULL_ART],
                      "fullArtOnly": r["rarity"] in FULL_ART})
    return cards


def fetch_image(card_id: str) -> np.ndarray | None:
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    path = IMG_DIR / (card_id.replace("/", "_") + ".webp")
    if not path.exists():
        try:
            req = urllib.request.Request(CDN + card_id, headers={"User-Agent": "Mozilla/5.0 ink-card-scan"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                path.write_bytes(resp.read())
        except Exception:
            return None
    return cv2.imread(str(path))


# ---------------------------------------------------------------- layout


def parchment_mask(img: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    return ((h >= 10) & (h <= 32) & (s >= 20) & (s <= 120) & (v >= 175)).astype(np.uint8)


def longest_run(flags: np.ndarray, min_gap_fill: int = 6):
    """Longest run of True, bridging short False gaps (text lines / banners dip the ratio)."""
    best, start, gap = (0, 0), None, 0
    for i, f in enumerate(list(flags) + [False] * (min_gap_fill + 1)):
        if f:
            if start is None:
                start = i
            gap = 0
        elif start is not None:
            gap += 1
            if gap > min_gap_fill:
                end = i - gap + 1
                if end - start > best[1] - best[0]:
                    best = (start, end)
                start, gap = None, 0
    return best


# Standard frame (734x1024). Every printing we scan uses it; legendary frames put a translucent
# gradient behind the text, so we don't rely on colour detection for portrait cards.
PORTRAIT_BOX = (30, 684, 704, 953)
LOCATION_BOX = (28, 502, 991, 662)   # after rotating upright (1024x734)


def layout_box(img: np.ndarray, card_type: str):
    H, W = img.shape[:2]
    base = LOCATION_BOX if card_type == "location" else PORTRAIT_BOX
    refW, refH = (1024, 734) if card_type == "location" else (734, 1024)
    sx, sy = W / refW, H / refH
    return int(base[0] * sx), int(base[1] * sy), int(base[2] * sx), int(base[3] * sy)


def find_rules_box(img: np.ndarray):
    H, W = img.shape[:2]
    m = parchment_mask(img)
    row = m[:, int(W * 0.1):int(W * 0.9)].mean(axis=1)
    lower = H // 2
    y0, y1 = longest_run(row[lower:] > 0.3, min_gap_fill=12)
    if y1 - y0 < 40:
        return None
    y0, y1 = y0 + lower, y1 + lower
    col = m[y0:y1].mean(axis=0)
    x0, x1 = longest_run(col > 0.3, min_gap_fill=40)
    return x0, y0, x1, y1


def find_flavour_cut(gray: np.ndarray) -> int:
    """Row of the flavour divider (a thin line across most of the box), or box height if none."""
    h, w = gray.shape
    bg = np.median(gray)
    dark = (gray < bg - 25).astype(np.uint8)
    # bridge 1-2px antialias breaks, then look for one unbroken run across most of the box
    dark = cv2.dilate(dark, np.ones((1, 5), np.uint8))
    runs = np.zeros(h, dtype=int)
    for y in range(h):
        row = np.concatenate(([0], dark[y], [0]))
        d = np.diff(row)
        starts, ends = np.where(d == 1)[0], np.where(d == -1)[0]
        runs[y] = (ends - starts).max() if len(starts) else 0
    long = runs > w * 0.7
    i = 15
    while i < h:
        if long[i]:
            j = i
            while j < h and long[j]:
                j += 1
            if j - i <= 8:          # thin = divider (banners are ~30px tall and shorter)
                return max(0, i - 12)   # the divider ornament sits a little above the line
            i = j
        i += 1
    return h


def pip_column(gray: np.ndarray) -> int:
    """x where the lore-pip column starts (big diamond blobs hugging the right edge)."""
    h, w = gray.shape
    bg = np.median(gray)
    m = (gray < bg - 60).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, _, st, _ = cv2.connectedComponentsWithStats(m)
    xs = [st[i][0] for i in range(1, n)
          if 30 <= st[i][2] <= 75 and 30 <= st[i][3] <= 75 and st[i][0] + st[i][2] / 2 > w * 0.88]
    return max(1, min(xs) - 3) if xs else w


def find_banners(gray: np.ndarray):
    """Dark filled rectangles that hold ability names."""
    # banner = dark fill + bright lettering; parchment sits in between
    m = ((gray < 120) | (gray > 236)).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))   # drops thin body-text strokes
    n, _, st, _ = cv2.connectedComponentsWithStats(m)
    out = []
    for i in range(1, n):
        x, y, w, h, area = st[i]
        if w >= 50 and 18 <= h <= 50 and area / (w * h) > 0.75:
            out.append((x, y, w, h))
    return sorted(out, key=lambda b: (b[1], b[0]))


_TEMPLATES = {k: cv2.imread(str(TPL_DIR / f"{k}.png"), cv2.IMREAD_GRAYSCALE) for k in ICONS}


def templates():
    return _TEMPLATES


def find_icons(gray: np.ndarray, thresh: float = 0.8):
    hits = []
    for kind, tpl in templates().items():
        for scale in np.arange(0.7, 1.21, 0.05):
            t = cv2.resize(tpl, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            if t.shape[0] >= gray.shape[0] or t.shape[1] >= gray.shape[1]:
                continue
            res = cv2.matchTemplate(gray, t, cv2.TM_CCOEFF_NORMED)
            ys, xs = np.where(res >= thresh)
            for y, x in zip(ys, xs):
                hits.append((float(res[y, x]), kind, int(x), int(y), t.shape[1], t.shape[0]))
    # non-max suppression across kinds and scales
    hits.sort(reverse=True)
    keep = []
    for h in hits:
        s, k, x, y, w, hh = h
        if all(abs((x + w / 2) - (kx + kw / 2)) > min(w, kw) * 0.6 or abs((y + hh / 2) - (ky + kh / 2)) > min(hh, kh) * 0.6
               for _, _, kx, ky, kw, kh in keep):
            keep.append(h)
    return [{"kind": k, "score": round(s, 3), "x": x, "y": y, "w": w, "h": hh} for s, k, x, y, w, hh in keep]


# ---------------------------------------------------------------- OCR


def tesseract_tsv(gray: np.ndarray, psm: int):
    ok, buf = cv2.imencode(".png", gray)
    p = subprocess.run(["tesseract", "stdin", "stdout", "--psm", str(psm), "tsv"],
                       input=buf.tobytes(), capture_output=True, check=False)
    words = []
    for line in p.stdout.decode("utf-8", "replace").splitlines()[1:]:
        f = line.split("\t")
        if len(f) < 12 or not f[11].strip():
            continue
        words.append({"block": int(f[2]), "par": int(f[3]), "line": int(f[4]),
                      "x": int(f[6]), "y": int(f[7]), "w": int(f[8]), "h": int(f[9]),
                      "conf": float(f[10]), "text": f[11]})
    return words


def ocr_banner(gray: np.ndarray) -> str:
    inv = 255 - gray
    up = cv2.resize(inv, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    words = tesseract_tsv(up, 7)
    name = " ".join(w["text"] for w in words).strip()
    return re.sub(r"[\s|©®@*_~]+$", "", name)


def build_lines(words, icons, scale):
    """Group OCR words into visual lines, slot icons in by x position."""
    items = [{"x": w["x"] / scale, "y": w["y"] / scale, "h": w["h"] / scale, "text": w["text"],
              "key": (w["block"], w["par"], w["line"])} for w in words]
    lines: dict[tuple, list] = {}
    for it in items:
        lines.setdefault(it["key"], []).append(it)
    ordered = []
    for ws in lines.values():
        top = min(w["y"] for w in ws)
        bot = max(w["y"] + w["h"] for w in ws)
        ordered.append({"top": top, "bot": bot, "words": ws})
    for ic in icons:
        cy = ic["y"] + ic["h"] / 2
        tgt = min(ordered, key=lambda l: 0 if l["top"] - 4 <= cy <= l["bot"] + 4 else min(abs(cy - l["top"]), abs(cy - l["bot"])),
                  default=None)
        token = {"x": ic["x"], "y": ic["y"], "h": ic["h"], "text": ICON_TOKEN[ic["kind"]]}
        if tgt is None or not (tgt["top"] - 12 <= cy <= tgt["bot"] + 12):
            ordered.append({"top": ic["y"], "bot": ic["y"] + ic["h"], "words": [token]})
        else:
            tgt["words"].append(token)
    ordered.sort(key=lambda l: l["top"])
    for l in ordered:
        l["words"].sort(key=lambda w: w["x"])
        l["text"] = " ".join(w["text"] for w in l["words"])
        l["left"] = l["words"][0]["x"]
    return ordered


def assemble(lines, banners):
    """Lines + banner names → [{name?, text}] paragraphs."""
    if not lines and not banners:
        return []
    heights = sorted(l["bot"] - l["top"] for l in lines) or [30]
    lh = heights[len(heights) // 2]
    starts = [{"y": b["y"], "name": b["name"]} for b in banners]
    paras, cur, prev_bot = [], None, None
    for l in lines:
        bstart = next((b for b in starts if abs(b["y"] - l["top"]) < lh * 0.8), None)
        gap = (l["top"] - prev_bot) if prev_bot is not None else 0
        if cur is None or bstart or gap > lh * 0.6:
            cur = {"name": bstart["name"] if bstart else None, "lines": []}
            paras.append(cur)
            if bstart:
                starts.remove(bstart)
        cur["lines"].append(l["text"])
        prev_bot = l["bot"]
    for b in starts:  # banner with no text beside it (shouldn't happen, keep anyway)
        paras.append({"name": b["name"], "lines": []})
    out = []
    for p in paras:
        text = " ".join(p["lines"])
        text = re.sub(r"(?<=\s)_+(?=\s|$)", "", text)          # blanked-icon artefacts
        text = re.sub(r"([+\-])[\]|lI](?![a-z])", r"\g<1>1", text)  # +] / +l → +1
        text = re.sub(r"(\w)- (\w)", r"\1\2", text)   # re-join hyphenated line breaks
        out.append({"name": p["name"], "text": text.strip()})
    return out


# ---------------------------------------------------------------- compare with DB

TOKEN_RE = re.compile(r"\{[a-z]+\}|[a-z]+|[0-9]+|[+\-—–]", re.I)
ICON_SET = set(ICON_TOKEN.values())


def norm_db(text: str) -> str:
    """dreamborn markup → plain text with canonical {icon} tokens. Keeps the ability-name prefix out."""
    t = text
    for a, b in DB_ICON_ALIASES.items():
        t = t.replace(a, b)
    t = re.sub(r"<([^>]+)>", r"\1", t)          # <Challenger> keyword markup
    t = re.sub(r"\{([A-Z][a-z]+)\}", r"\1", t)  # {Reckless} → Reckless
    t = re.sub(r"\\[^\\]+\\", " ", t)            # \Ability Name\ (names are compared separately)
    return t


ALL_KEYWORDS = ["shift", "universal shift", "evasive", "bodyguard", "support", "ward", "rush", "singer", "resist",
                "challenger", "boost", "sing together", "reckless", "alert", "vanish"]


def keyword_patterns(card_kws: dict):
    pats = [re.compile(r"\b\w*\s?shift(?![a-z])(\s*\d+)?(\s*\{ink\})?", re.I)]   # Shift, Puppy Shift, Universal Shift…
    for k in set(card_kws or {}) | set(ALL_KEYWORDS):
        words = r"\s+".join(map(re.escape, re.sub(r"([a-z])([A-Z])", r"\1 \2", k).split()))
        pats.append(re.compile(r"\b" + words + r"(?![a-z])(\s*\+?\s*\d+)?(\s*\{(?:ink|strength)\})?", re.I))
    return pats


def content_tokens(text: str, kw_pats):
    """Tokens that carry rules meaning, with their (start, end) in `text`.
    Reminder text "( … )" and the card's own keyword phrases are masked out (same length,
    so positions stay valid) — the DB and the printed card disagree on those a lot."""
    masked = re.sub(r"\([^)]*\)?", lambda m: " " * len(m.group(0)), text)
    for p in kw_pats:
        masked = p.sub(lambda m: " " * len(m.group(0)), masked)
    out = []
    for m in TOKEN_RE.finditer(masked):
        t = m.group(0).lower()
        if t in "—–":
            t = "-"
        out.append((t, m.start(), m.end()))
    return out


def compare(db_abilities, scanned, card_kws):
    kw = keyword_patterns(card_kws)
    a = [t for ab in db_abilities for t, _, _ in content_tokens(norm_db(ab.get("description", "")), kw)]
    b = [t for p in scanned for t, _, _ in content_tokens(p["text"].replace("’", "'"), kw)]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    fixes, problems = [], []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            continue
        ins, dels = b[j1:j2], a[i1:i2]
        icons = [x for x in ins if x in ICON_SET]
        plain = lambda xs: "".join(x for x in xs if x not in "+-" and x not in ICON_SET)
        if plain(dels) == plain(ins):
            # same words (maybe glued / stray dash) — anything left over is icons the DB is missing
            if icons and not any(x in ICON_SET for x in dels):
                at = i2 if op == "replace" else i1
                fixes.append({"after": " ".join(a[max(0, at - 4):at]), "icons": icons, "at": at})
            continue
        if op == "insert" and all(len(x) <= 2 and x.isalpha() for x in ins) and len(ins) <= 3:
            continue                                    # OCR crumbs off the art edge; DB words are authoritative
        else:
            problems.append({"op": op, "db": " ".join(a[i1:i2]), "scan": " ".join(ins)})
    return {"ratio": round(sm.ratio(), 4), "fixes": fixes, "problems": problems,
            "dbIcons": sum(x in ICON_SET for x in a), "scanIcons": sum(x in ICON_SET for x in b)}


def patch_db_text(db_abilities, fixes, card_kws):
    """Insert missing icons into the DB text. DB spelling stays the source of truth for words;
    the scan only contributes the icons the DB dropped."""
    kw = keyword_patterns(card_kws)
    pending = sorted(fixes, key=lambda f: f["at"])
    gi, out = 0, []
    for ab in db_abilities:
        raw = ab.get("description", "")
        name_m = re.match(r"\s*\\([^\\]+)\\\s*", raw)
        text = norm_db(raw)
        toks = content_tokens(text, kw)
        inserts = []                                    # (char position, icons)
        while pending and pending[0]["at"] <= gi + len(toks):
            f = pending.pop(0)
            k = f["at"] - gi
            pos = toks[k - 1][2] if k > 0 else 0        # right after the token the icon follows
            inserts.append((pos, f["icons"]))
        for pos, icons in sorted(inserts, reverse=True):
            text = text[:pos] + " " + " ".join(icons) + text[pos:]
        gi += len(toks)
        out.append({"name": ab.get("name") or (name_m.group(1) if name_m else None),
                    "description": re.sub(r"\s+", " ", text).strip()})
    return out


# ---------------------------------------------------------------- main per-card


def scan_card(card, debug=False):
    res = {"id": card["id"], "full": card["full"], "type": card["type"], "rarity": card["rarity"]}
    img = fetch_image(card["id"])
    for alt in card.get("alts", []):
        if img is not None:
            break
        img = fetch_image(alt)
        res["id"] = alt
    if img is None:
        return {**res, "status": "no-image"}
    if card["type"] == "location":
        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    box = layout_box(img, card["type"])
    x0, y0, x1, y1 = box
    gray = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    if card["type"] in ("character", "location"):
        gray = gray[:, : pip_column(gray)]   # lore pips live in the right-hand column
    gray = gray.copy()
    bg = int(np.median(gray))

    banners = []
    for (bx, by, bw, bh) in find_banners(gray):
        banners.append({"x": bx, "y": by, "w": bw, "h": bh, "name": ocr_banner(gray[by:by + bh, bx:bx + bw])})
    for b in banners:
        gray[max(0, b["y"] - 2):b["y"] + b["h"] + 2, max(0, b["x"] - 2):b["x"] + b["w"] + 4] = bg
    cut = find_flavour_cut(gray)
    gray = gray[:cut]
    banners = [b for b in banners if b["y"] < cut]

    icons = find_icons(gray)
    for ic in icons:
        gray[ic["y"]:ic["y"] + ic["h"], ic["x"]:ic["x"] + ic["w"]] = bg

    scale = 2.0
    up = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    up = cv2.adaptiveThreshold(up, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 51, 25)
    words = [w for w in tesseract_tsv(up, 6) if w["conf"] > 10 or re.search(r"[A-Za-z0-9]", w["text"])]
    lines = build_lines(words, icons, scale)
    scanned = assemble(lines, banners)
    cmp = compare(card["abilities"], scanned, card.get("keywords"))

    if not cmp["problems"] and not cmp["fixes"]:
        status = "match"
    elif cmp["fixes"] and len(cmp["problems"]) <= 2 and cmp["dbIcons"] + sum(len(f["icons"]) for f in cmp["fixes"]) == cmp["scanIcons"]:
        status = "icon-fix"
    elif cmp["ratio"] >= 0.9:
        status = "close"
    else:
        status = "mismatch"
    out = {**res, "status": status, "ratio": cmp["ratio"], "box": box, "icons": icons,
           "banners": [b["name"] for b in banners], "scanned": scanned,
           "fixes": cmp["fixes"], "problems": cmp["problems"][:12]}
    if status == "icon-fix":
        out["patched"] = patch_db_text(card["abilities"], cmp["fixes"], card.get("keywords"))
    if debug:
        dbg = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        for ic in icons:
            cv2.rectangle(dbg, (ic["x"], ic["y"]), (ic["x"] + ic["w"], ic["y"] + ic["h"]), (0, 0, 255), 2)
            cv2.putText(dbg, ic["kind"][:2], (ic["x"], ic["y"] - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
        for b in banners:
            cv2.rectangle(dbg, (b["x"], b["y"]), (b["x"] + b["w"], b["y"] + b["h"]), (255, 0, 0), 2)
        (OUT_DIR / "debug").mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(OUT_DIR / "debug" / (card["id"].replace("/", "_") + ".png")), dbg)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", help="only cards whose 'Name - Title' contains this")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=8)
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    cards = load_cards(args.name)
    if args.limit:
        cards = cards[: args.limit]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    with ThreadPoolExecutor(args.jobs) as pool:
        for i, r in enumerate(pool.map(lambda c: scan_card(c, args.debug), cards), 1):
            results.append(r)
            if not args.name and i % 100 == 0:
                print(f"  {i}/{len(cards)}", file=sys.stderr)

    if args.name:
        for r in results:
            print(json.dumps(r, indent=2, ensure_ascii=False))
        return

    with open(OUT_DIR / "results.jsonl", "w") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    counts: dict[str, int] = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    fixes = {r["id"]: r["patched"] for r in results if r.get("patched")}
    (OUT_DIR / "icon-fixes.json").write_text(json.dumps(fixes, indent=2, ensure_ascii=False))
    summary = {"cards": len(results), "status": counts, "iconFixes": len(fixes)}
    (OUT_DIR / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
