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
  uv run tools/card-scan/scan.py                 # whole pool → cache/scan/results.jsonl + summary.json (→ build-rulings)
  uv run tools/card-scan/scan.py --name Webby    # just matching cards, print results
  uv run tools/card-scan/scan.py --name Webby --debug   # also writes annotated crops to cache/scan/debug/
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
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

ICONS = ["strength", "willpower", "lore", "ink", "exert", "inkable"]
FULL_ART = {"enchanted", "iconic", "promo", "epic"}
ICON_TOKEN = {k: "{" + k + "}" for k in ICONS}
# dreamborn writes the same icon several ways
DB_ICON_ALIASES = {
    "{S}": "{strength}", "{W}": "{willpower}", "{L}": "{lore}", "{I}": "{ink}", "{E}": "{exert}",
    "{toughness}": "{willpower}", "{inkk}": "{ink}", "{C}": "{inkable}", "{inkwell}": "{inkable}",
}

# ---------------------------------------------------------------- corrections

CORRECTIONS = Path(__file__).resolve().parent / "corrections.json"
# why "errata"  official text change 	text "abilities" replaces the print; scan may match either
#     "db-fix"  the DB text is wrong   	"abilities" or "replace" pairs; the scan has to agree
#     "ocr"     DB is right, OCR isn't 	no text, just a reviewed stamp
CORRECTION_KINDS = {"errata", "db-fix", "ocr"}


def load_corrections() -> dict:
    if not CORRECTIONS.exists():
        return {}
    data = {k: v for k, v in json.loads(CORRECTIONS.read_text()).items() if not k.startswith("_")}
    for full, c in data.items():
        if c.get("why") not in CORRECTION_KINDS:
            raise SystemExit(f"corrections.json: {full!r} has why={c.get('why')!r}, expected one of {sorted(CORRECTION_KINDS)}")
    return data


def apply_correction(versions, corr):
    """→ (versions to compare the scan against, the text the compiler should use or None, unused replace pairs)."""
    if "abilities" in corr:
        fixed = [corr["abilities"]]
        unused = []
    elif corr.get("replace"):
        fixed, hit = [], set()
        for v in versions:
            nv = []
            for ab in v:
                ab = dict(ab)
                for i, (old, new) in enumerate(corr["replace"]):
                    for f in ("name", "description"):
                        if ab.get(f) and old in ab[f]:
                            ab[f] = ab[f].replace(old, new)
                            hit.add(i)
                nv.append(ab)
            if nv not in fixed:
                fixed.append(nv)
        unused = [p for i, p in enumerate(corr["replace"]) if i not in hit]
    else:
        return versions, None, []
    if corr["why"] == "errata":                  # the card in hand still prints the old text
        return fixed + [v for v in versions if v not in fixed], fixed[0], unused
    return fixed, fixed[0], unused


# ---------------------------------------------------------------- card selection


def load_cards(name_filter: str | None):
    """One entry per unique Name - Title.

    Alt-art printings (enchanted / epic / iconic / promo) are never scanned — same card, different frame.
    Foil isn't a separate printing at all (it's a flag on the same row). Among the standard printings we
    scan the newest (current wording), and keep every distinct DB text in the group as evidence: reprints
    in the DB often lost icons the older row still has, and vice versa."""
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "select id, name, title, type, rarity, setId, abilities, keywords from cards where language='en' or language is null"
    ).fetchall()
    groups: dict[str, list] = {}
    corrections = load_corrections()
    for r in rows:
        abil = json.loads(r["abilities"] or "[]")
        if not abil:
            continue
        for ab in abil:
            RULES_VOCAB.update(t.lower() for t in re.findall(r"[A-Za-z]{3,}", ab.get("description") or ""))
        full = f"{r['name']} - {r['title']}" if r["title"] else r["name"]
        if name_filter and name_filter.lower() not in full.lower():
            continue
        groups.setdefault(full, []).append((r, abil))
    cards = []
    for full, printings in groups.items():
        std = [p for p in printings if p[0]["rarity"] not in FULL_ART] or printings
        std.sort(key=lambda p: (str(p[0]["setId"]), p[0]["id"]), reverse=True)   # newest first
        r, abil = std[0]
        versions = []
        for _, ab in std + [p for p in printings if p not in std]:
            if ab not in versions:
                versions.append(ab)
        kws: dict = {}
        for p in printings:
            kws.update(json.loads(p[0]["keywords"] or "{}"))
        corr = None
        if full in corrections:
            c = corrections[full]
            versions, official, unused = apply_correction(versions, c)
            corr = {"why": c["why"], "official": official, "ocrNoise": bool(c.get("ocrNoise")), "unused": unused}
        cards.append({"id": r["id"], "full": full, "type": r["type"], "rarity": r["rarity"], "abilities": abil,
                      "versions": versions, "keywords": kws, "correction": corr,
                      "ids": [p[0]["id"] for p in printings],
                      "alts": [p[0]["id"] for p in std[1:]],
                      "skippedAltArt": sum(p[0]["rarity"] in FULL_ART for p in printings) if std is not printings else 0,
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


def clear_frame_edges(gray: np.ndarray, bg: int) -> None:
    """Paint the card frame that pokes into the bottom of the box (the torn parchment edge) with the
    parchment colour. Only *solid* dark regions touching the box edge: an opening
    wipes out glyph strokes first, so text sitting on the torn edge or touching dark art survives."""
    h, w = gray.shape
    dark = (gray < bg - 70).astype(np.uint8)
    solid = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(solid)
    frame = np.zeros_like(dark)
    for i in range(1, n):
        x, y, cw, ch, area = st[i]
        if y + ch >= h and area > 300:            # bottom edge only: the sides hug the text too closely
            frame[lab == i] = 1
    frame = cv2.dilate(frame, np.ones((5, 5), np.uint8)) & dark   # + the anti-aliased rim
    frame[: max(0, h - 30)] = 0                  # the torn edge only reaches ~25px up; the side borders go higher
    gray[frame > 0] = bg


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


OCR_PASSES = [("adaptive", 2.0), ("gray", 2.0), ("otsu", 3.0)]


def preprocess(gray: np.ndarray, variant: str, scale: float) -> np.ndarray:
    up = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    if variant == "adaptive":
        return cv2.adaptiveThreshold(up, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 51, 25)
    if variant == "otsu":
        return cv2.threshold(up, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    return up


# One thread per tesseract: --jobs already runs them in parallel; OpenMP threads on top thrash the CPU (minutes per card).
TESS_ENV = {**os.environ, "OMP_THREAD_LIMIT": "1"}


def tesseract_tsv(gray: np.ndarray, psm: int):
    ok, buf = cv2.imencode(".png", gray)
    p = subprocess.run(["tesseract", "stdin", "stdout", "--psm", str(psm), "tsv"],
                       input=buf.tobytes(), capture_output=True, check=False, env=TESS_ENV)
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
    name = re.sub(r"(?<= )\|(?= )", "I", name)          # "JUST HOW | LIKE IT"
    return re.sub(r"[\s|©®@*_~\-—–]+$", "", name)


def build_lines(words, icons, scale):
    """Group OCR words into visual lines, slot icons in by x position."""
    items = [{"x": w["x"] / scale, "y": w["y"] / scale, "w": w["w"] / scale, "h": w["h"] / scale, "text": w["text"],
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
            tgt["words"] = split_around_icon(tgt["words"], ic) + [token]
    ordered.sort(key=lambda l: l["top"])
    for l in ordered:
        l["words"].sort(key=lambda w: w["x"])
        l["text"] = " ".join(w["text"] for w in l["words"])
        l["left"] = l["words"][0]["x"]
    return ordered


def split_around_icon(words, ic):
    """Tesseract sometimes reads straight across a blanked icon as one word ("pay1__less", "pay?)")
    and the icon would then sort after the whole word. Split such a word where the icon sits."""
    out = []
    ix0, ix1 = ic["x"], ic["x"] + ic["w"]
    for w in words:
        x0, x1 = w["x"], w["x"] + w.get("w", 0)
        if not (x0 < (ix0 + ix1) / 2 < x1) or w["text"].startswith("{"):
            out.append(w)
            continue
        t = w["text"]
        left, right = max(0.0, ix0 - x0), max(0.0, x1 - ix1)
        k = round(len(t) * left / (left + right)) if left + right else len(t)
        gaps = [m for m in re.finditer(r"_+", t)]
        if gaps:                                   # the blank OCRs as "__" — cut there
            g = min(gaps, key=lambda m: abs(m.start() - k))
            a, b = t[:g.start()], t[g.end():]
        else:
            a, b = t[:k], t[k:]
        if a:
            out.append({**w, "text": a, "w": left})
        if b:
            out.append({**w, "text": b, "x": ix1, "w": right})
    return out


RULES_VOCAB: set[str] = set()      # every word used in any card's DB rules text (filled by load_cards)
_STRAY_TAIL = re.compile(r"(?:\s+[^\w\s.!?)”\"{}]{1,3}|\s+\}|(?<=[.!?)”])\s+\w)+\s*$")


def _ends_sentence(text: str) -> bool:
    t = _STRAY_TAIL.sub("", text.strip())
    return bool(t) and t[-1] in ".!?)”\"…"


def _looks_like_rules(text: str, lenient: bool) -> bool:
    """Real words or icons, not the OCR'd divider ornament ("ee", "SOS OC |", "—e—E—").
    lenient: the line above is mid-sentence, so glued OCR ("acard.", "hegets+4") counts too."""
    toks = [t for t, _, _ in raw_tokens(text)]
    icons = sum(t in ICON_SET for t in toks)
    words = [t for t in toks if t.isalpha() and len(t) >= 3 and re.search(r"[aeiouy]", t)]
    if lenient:
        return bool(icons or words)
    return icons + sum(t in RULES_VOCAB for t in words) >= 2


def _continues(kept, nxt, lh) -> bool:
    """Does line `nxt` still belong to the rules text that ends with kept[-1]?
    Flavour always sits a full paragraph gap below the rules (the divider lives in that gap), and a
    rules sentence never breaks into flavour mid-paragraph — so a line in the same paragraph as an
    unfinished sentence is rules text even when OCR mangled it past DB alignment ("+2 ⚙." → "42, {strength}")."""
    text = nxt["text"]
    if not raw_tokens(text):
        return True                     # icon / punctuation crumbs
    if _KW_LINE.match(text):
        return True                     # "Bodyguard (This character…" — keyword + reminder, never flavour
    prev = kept[-1]
    if nxt["top"] - prev["bot"] > lh * 0.35:
        return False                    # paragraph break
    open_paren = sum(l["text"].count("(") - l["text"].count(")") for l in kept) > 0
    return _looks_like_rules(text, lenient=open_paren or not _ends_sentence(prev["text"]))


def cut_flavour_by_db(lines, db_abilities, card_kws, banners=(), divider=False):
    """Drop trailing lines that the DB rules text doesn't account for (flavour the divider check missed).
    Align scan tokens to DB tokens; everything after the last line that holds a solid DB match goes,
    unless it continues the same paragraph (see _continues).
    divider=True: the printed flavour divider was found and already cut — nothing above it is flavour,
    so only the missing-ability check runs. Returns (lines, cut) — cut is None when a banner sits below
    the rules end (the DB is missing an ability)."""
    db = [t for ab in db_abilities for t, _, _ in raw_tokens(norm_db(ab.get("description", "")))]
    if len(db) < 3 or not lines:
        return lines, []                           # DB empty / tiny → nothing to align against, keep all
    flat, owner = [], []
    for li, l in enumerate(lines):
        for t, _, _ in raw_tokens(l["text"].replace("’", "'")):
            flat.append(t)
            owner.append(li)
    sm = difflib.SequenceMatcher(a=db, b=flat, autojunk=False)
    last = -1
    for blk in sm.get_matching_blocks():
        if blk.size >= 2:                          # 1-token matches ("a", "the") are luck, not alignment
            last = max(last, owner[blk.b + blk.size - 1])
    if last < 0:
        return lines, []
    heights = sorted(l["bot"] - l["top"] for l in lines)
    lh = heights[len(heights) // 2]
    while last + 1 < len(lines) and _continues(lines[: last + 1], lines[last + 1], lh):
        last += 1
    # flavour never sits under an ability banner — if one starts below the cut, the DB is missing an ability
    if last + 1 < len(lines) and any(b["y"] + b["h"] > lines[last + 1]["top"] for b in banners):
        return lines, None
    if divider:
        return lines, []
    return lines[: last + 1], [l["text"] for l in lines[last + 1:]]


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
        kw_start = cur is not None and _KW_LINE.match(l["text"]) and _ends_sentence(cur["lines"][-1])
        if cur is None or bstart or gap > lh * 0.6 or kw_start:
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
        # "+2 ⚙" OCRs as "42, {strength}" — no stat modifier is ever 40-something
        text = re.sub(r"(?<![\w+\-])4(\d)[,.;:]?\s+(?=\{(?:strength|willpower|lore)\})", r"+\1 ", text)
        text = re.sub(r"(\w)- (\w)", r"\1\2", text)   # re-join hyphenated line breaks
        text = re.sub(r"(?<=[.!?)”])\s+[0-9|]{1,2}$", "", text)   # art speck after the last sentence ("free. 7")
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
    t = re.sub(r"^\s*[A-Z][A-Z0-9'’ ,!?.&-]{3,}?(?= [A-Z][a-z])", "", t)   # bare "HIDE AND SEEK While…"
    return t


ALL_KEYWORDS = ["shift", "universal shift", "evasive", "bodyguard", "support", "ward", "rush", "singer", "resist",
                "challenger", "boost", "sing together", "reckless", "alert", "vanish", "adventurous", "underdog"]
_KW_LINE = re.compile(r"^\W*(?:" + "|".join(sorted(ALL_KEYWORDS, key=len, reverse=True)) + r")\b[\s+\d]*\(", re.I)


def _name_regex(name: str):
    letters = re.sub(r"[^a-z0-9]", "", name.lower())
    if len(letters) < 4:
        return None
    return re.compile(r"[\W_]*".join(map(re.escape, letters)) + r"[!?.]*", re.I)


def split_inline_names(abilities, names):
    """dreamborn sometimes bakes ability names into the description ("DEPUTIZE Your other…",
    "\\Just How I Like It\\ All cards…", "SNAP! {E} — …") or merges two abilities into one entry.
    Split at any known name (scanned banners + every printing's `name` fields) that sits at an
    ability boundary: start of text or right after . ! ? ) or a newline."""
    pats = [(n, rx) for n in dict.fromkeys(n for n in names if n) if (rx := _name_regex(n))]
    out = []
    for ab in abilities:
        desc = ab.get("description", "") or ""
        cuts = []                                       # (start, end, name text)
        for m in re.finditer(r"\\([^\\]+)\\", desc):
            cuts.append((m.start(), m.end(), m.group(1)))
        for _, rx in pats:
            for m in rx.finditer(desc):
                before = desc[:m.start()].rstrip()
                at_boundary = not before or before[-1] in ".!?)\n"
                after = desc[m.end():m.end() + 2]
                if at_boundary and (not after or after[0] in " ,{\n—-–"):
                    if not any(c[0] <= m.start() < c[1] for c in cuts):
                        cuts.append((m.start(), m.end(), desc[m.start():m.end()].strip()))
        if not cuts:
            out.append(ab)
            continue
        cuts.sort()
        head = desc[:cuts[0][0]].strip()
        if head:
            out.append({**ab, "description": head})
        own = ab.get("name")
        for i, (s0, e0, nm) in enumerate(cuts):
            body = desc[e0: cuts[i + 1][0] if i + 1 < len(cuts) else len(desc)].strip(" \n")
            name = own if (i == 0 and not head and own) else nm
            out.append({"name": name, "description": body})
    return out


def keyword_patterns(card_kws: dict):
    pats = [
        # "Shift: Discard an action card" / "Shift Remove 2 ink drops" — alternate shift costs. Runs on text
        # whose reminder "( … )" is already blanked, so stop at a 2+ space gap as well as at "(" / "."
        re.compile(r"\b(?:[a-z]+\s)?shift\s*:?\s*(?=(?:discard|remove|banish|exert|put|return)\b)"
                   r"[^(.]*?(?=\s{2,}|\(|\.|$)", re.I),
        re.compile(r"\b(?:[a-z]+\s)?shift\s*:\s*[^(.]*?(?=\s{2,}|\(|\.|$)", re.I),
        # Shift 5 {ink}, Puppy Shift 3, Universal Shift 4 — and OCR's "Shifts" for "Shift 5"
        re.compile(r"\b(?:[a-z]+\s)?shift(?:s(?![a-z])|\s*\d+)?(?:\s*\{ink\})?(?![a-z])", re.I),
    ]
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


def raw_tokens(text: str):
    return [(m.group(0).lower(), m.start(), m.end()) for m in TOKEN_RE.finditer(text) if m.group(0) not in "+-—–"]


def db_suspect(db_abilities, cmp):
    """The scan looks fine and the DB looks broken: empty text, or a stray digit where the card has an icon."""
    db_all = " ".join(a.get("description", "") for a in db_abilities).strip()
    if not db_all and cmp["scanTokens"] >= 5:
        return "db-empty"
    for p in cmp["problems"]:
        if p["op"] == "replace" and re.match(r"^\d\b", p["db"]) and p["scan"].startswith("{"):
            return "db-icon-became-digit"
    return None


def place_icons(dels, ins, i1, j1, b_first):
    """Where do the icons in a same-letters span go in the DB tokens? Count letters up to each icon in
    the scan ("characterhas5 {S} ormore") and find the DB token boundary with that many letters before
    it ("character has 5 | or more"). → [(DB index, [icons], opens ability)] or None."""
    bounds, cum = {0: i1}, 0
    for k, t in enumerate(dels):
        if t not in "+-":
            cum += len(t)
            bounds[cum] = i1 + k + 1
    out, cum = [], 0
    for j, x in enumerate(ins):
        if x in ICON_SET:
            if cum not in bounds:
                return None
            at = bounds[cum]
            if out and out[-1][0] == at:
                out[-1][1].append(x)
            else:
                out.append((at, [x], b_first[j1 + j] if j1 + j < len(b_first) else False))
        elif x not in "+-":
            cum += len(x)
    return out


def compare(db_abilities, scanned, card_kws):
    kw = keyword_patterns(card_kws)
    a = [t for ab in db_abilities for t, _, _ in content_tokens(norm_db(ab.get("description", "")), kw)]
    b, b_first = [], []
    for p in scanned:
        toks = [t for t, _, _ in content_tokens(p["text"].replace("’", "'"), kw)]
        b += toks
        b_first += [i == 0 for i in range(len(toks))]
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
            db_icons = [x for x in dels if x in ICON_SET]
            if db_icons:
                if icons and sorted(icons) != sorted(db_icons):
                    problems.append({"op": "icon-kind", "db": " ".join(dels), "scan": " ".join(ins)})
                continue
            if icons:
                placed = place_icons(dels, ins, i1, j1, b_first)
                if placed is None:              # icon lands inside a glued word — can't tell where it goes
                    problems.append({"op": "icon-unplaced", "db": " ".join(dels), "scan": " ".join(ins)})
                for at, grp, opens in placed or []:
                    fixes.append({"after": " ".join(a[max(0, at - 4):at]), "icons": grp, "at": at, "opensAbility": opens})
            continue
        if op == "insert" and all(len(x) <= 2 and x.isalpha() for x in ins) and len(ins) <= 3:
            continue                                    # OCR crumbs off the art edge; DB words are authoritative
        else:
            problems.append({"op": op, "db": " ".join(a[i1:i2]), "scan": " ".join(ins)})
    return {"ratio": round(sm.ratio(), 4), "fixes": fixes, "problems": problems,
            "dbIcons": sum(x in ICON_SET for x in a), "scanIcons": sum(x in ICON_SET for x in b), "scanTokens": len(b)}


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
        while pending and (pending[0]["at"] < gi + len(toks)
                           or (pending[0]["at"] == gi + len(toks) and not pending[0].get("opensAbility"))):
            f = pending.pop(0)
            k = f["at"] - gi
            pos = toks[k - 1][2] if k > 0 else 0        # right after the token the icon follows
            inserts.append((pos, f["icons"]))
        for pos, icons in sorted(inserts, reverse=True):
            text = text[:pos] + " " + " ".join(icons) + " " + text[pos:]
        gi += len(toks)
        text = re.sub(r"\s+", " ", text).strip()
        text = re.sub(r" ([.,:;)])", r"\1", text)
        out.append({"name": ab.get("name") or (name_m.group(1) if name_m else None), "description": text})
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
    divider = cut < gray.shape[0]
    gray = gray[:cut]
    clear_frame_edges(gray, bg)          # after banners + divider: both are big dark shapes too
    banners = [b for b in banners if b["y"] < cut]

    icons = find_icons(gray)
    for ic in icons:
        gray[ic["y"]:ic["y"] + ic["h"], ic["x"]:ic["x"] + ic["w"]] = bg

    kws = card.get("keywords")
    names = [b["name"] for b in banners] + [a.get("name") for v in card["versions"] for a in v]
    versions = [split_inline_names(v, names) for v in card["versions"]]
    best, digit_reads = None, {}
    for variant, scale in OCR_PASSES:
        words = [w for w in tesseract_tsv(preprocess(gray, variant, scale), 6)
                 if w["conf"] > 10 or re.search(r"[A-Za-z0-9]", w["text"])]
        lines = build_lines(words, icons, scale)
        for vi, version in enumerate(versions):
            ls, flavour = cut_flavour_by_db(lines, version, kws, banners, divider)
            scanned = assemble(ls, banners)
            c = compare(version, scanned, kws)
            for pr in c["problems"]:                  # remember every digit each pass read where the DB has one
                if pr["op"] == "replace" and re.fullmatch(r"\d+", pr["db"]) and re.fullmatch(r"\d+", pr["scan"]):
                    digit_reads.setdefault(pr["db"], set()).add(pr["scan"])
            key = (len(c["problems"]), len(c["fixes"]), -c["ratio"])
            if best is None or key < best["key"]:
                best = {"key": key, "cmp": c, "version": vi, "scanned": scanned, "flavour": flavour, "ocr": variant}
        if not best["cmp"]["problems"] and not best["cmp"]["fixes"]:
            break                                     # perfect agreement, no need for more passes
    cmp, scanned, flavour = best["cmp"], best["scanned"], best["flavour"]
    db_ab = versions[best["version"]]
    missing_ability = flavour is None
    # a pass that read a *different* digit than the DB is never outvoted by a pass that happened to agree
    digit_conflict = sorted(f"{k}→{'/'.join(sorted(v))}" for k, v in digit_reads.items())

    if not cmp["problems"] and not cmp["fixes"] and not digit_conflict:
        status = "match"
    elif cmp["fixes"] and len(cmp["problems"]) <= 2 and not digit_conflict \
            and cmp["dbIcons"] + sum(len(f["icons"]) for f in cmp["fixes"]) == cmp["scanIcons"]:
        status = "icon-fix"
    elif missing_ability or db_suspect(db_ab, cmp):
        status = "db-suspect"
    elif cmp["ratio"] >= 0.9:
        status = "close"
    else:
        status = "mismatch"
    out = {**res, "status": status,
           "dbIssue": ("db-missing-ability" if missing_ability else db_suspect(db_ab, cmp)) if status == "db-suspect" else None,
           "digitConflict": digit_conflict, "ocr": best["ocr"], "dbVersion": best["version"], "dbVersions": len(card["versions"]),
           "ids": card["ids"], "ratio": cmp["ratio"], "box": box, "divider": divider, "icons": icons,
           "banners": [b["name"] for b in banners], "scanned": scanned, "db": db_ab,
           "fixes": cmp["fixes"], "problems": cmp["problems"][:12], "flavourCut": flavour or []}
    if status == "icon-fix":
        out["patched"] = patch_db_text(db_ab, cmp["fixes"], kws)
    out["rules"] = rules_text(out, card.get("correction"), best["version"] == 0)
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


def rules_text(r, corr, best_is_official):
    """What the ability compiler gets for this card: {source, abilities, verified} or None (needs a human).
      match → DB text · icon-fix → DB text + scanned icons · db-suspect → scanned text (needs a ✅)
      corrections.json wins: errata → official text · db-fix → fixed text · ocr → DB text, reviewed.
    verified = the card image agrees (for errata: with the printed text, or the official one on a reprint)."""
    ok = r["status"] in ("match", "icon-fix")
    scanned_abil = r.get("patched") if r["status"] == "icon-fix" else r["db"]
    if corr:
        if corr["why"] == "ocr":
            return {"source": "reviewed", "abilities": scanned_abil if ok else r["db"], "verified": ok}
        abil = scanned_abil if ok and best_is_official else corr["official"]
        return {"source": "errata" if corr["why"] == "errata" else "corrected", "abilities": abil, "verified": ok}
    if ok:
        return {"source": "db" if r["status"] == "match" else "db+icons", "abilities": scanned_abil, "verified": True}
    if r["status"] == "db-suspect":
        return {"source": "scan", "abilities": [{"name": p["name"], "description": p["text"]} for p in r["scanned"]],
                "verified": False, "review": r["dbIssue"]}
    return None


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
    # each row's "rules" = clean text for the ability compiler (flavour already cut, see rules_text());
    # tools/build-rulings.mjs combines it with cards.db into cache/rulings.db
    rules = {r["full"]: r["rules"] for r in results if r.get("rules")}
    by_card = {c["full"]: c for c in cards}
    corr_cards = [c for c in cards if c.get("correction")]
    # a db-fix the card image doesn't back up is a typo in corrections.json until proven otherwise
    unverified = sorted(r["full"] for r in results if r.get("rules") and r["rules"]["source"] == "corrected"
                        and not r["rules"]["verified"] and not by_card[r["full"]]["correction"]["ocrNoise"])
    summary = {"cards": len(results), "printingsCovered": sum(len(r.get("ids", [])) for r in results),
               "altArtSkipped": sum(c.get("skippedAltArt", 0) for c in cards),
               "status": counts, "iconFixes": len(fixes), "rulesReady": len(rules),
               "rulesSources": {s: sum(v["source"] == s for v in rules.values())
                                for s in ("db", "db+icons", "errata", "corrected", "reviewed", "scan")},
               "digitConflicts": sum(bool(r.get("digitConflict")) for r in results),
               "corrections": {"applied": len(corr_cards),
                               "unknownCards": sorted(set(load_corrections()) - set(by_card)),
                               "unusedReplace": {c["full"]: c["correction"]["unused"]
                                                 for c in corr_cards if c["correction"]["unused"]},
                               "dbFixNotVerifiedByScan": unverified}}
    (OUT_DIR / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
