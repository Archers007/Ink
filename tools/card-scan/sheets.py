# /// script
# requires-python = ">=3.10"
# dependencies = ["opencv-python-headless>=4.9", "numpy>=1.26", "pillow>=10"]
# ///
"""
Review sheets for the cards the scanner couldn't verify on its own.

Each row: the card's real rules box | DB text | scanned text | the diff.
  uv run tools/card-scan/sheets.py                      # close + mismatch + db-suspect → cache/scan/review/
  uv run tools/card-scan/sheets.py --status close --per 5
"""
from __future__ import annotations

import argparse
import json
import textwrap
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "cache" / "scan" / "review"
IMG_DIR = ROOT / "cache" / "card-img"
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"

CROP_W, TEXT_W, PAD = 700, 820, 12


def font(size, bold=False):
    try:
        return ImageFont.truetype(BOLD if bold else FONT, size)
    except OSError:
        return ImageFont.load_default()


def card_crop(r):
    img = cv2.imread(str(IMG_DIR / (r["id"].replace("/", "_") + ".webp")))
    if img is None:
        return Image.new("RGB", (CROP_W, 200), (40, 40, 40))
    if r["type"] == "location":
        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    H, W = img.shape[:2]
    # a bit above the rules box so the name / type bar is visible too
    y0 = max(0, int(H * (0.60 if r["type"] != "location" else 0.62)))
    crop = img[y0:int(H * 0.94), :]
    crop = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
    scale = CROP_W / crop.shape[1]
    crop = cv2.resize(crop, (CROP_W, int(crop.shape[0] * scale)), interpolation=cv2.INTER_AREA)
    return Image.fromarray(crop)


def abil_text(abil):
    return "\n".join((f"[{a['name']}] " if a.get("name") else "") + (a.get("description") or a.get("text") or "")
                     for a in abil or [])


def text_block(draw, x, y, label, body, colour, width_chars=92, size=17):
    f, fb = font(size), font(size, True)
    draw.text((x, y), label, fill=colour, font=fb)
    y += size + 4
    for para in (body or "∅ (empty)").split("\n"):
        for line in textwrap.wrap(para, width_chars) or [""]:
            draw.text((x, y), line, fill=(20, 20, 20), font=f)
            y += size + 3
    return y + 6


def row(r, idx):
    crop = card_crop(r)
    panel_h = 0
    # measure by drawing on a tall scratch canvas, then crop to fit
    scratch = Image.new("RGB", (TEXT_W, 1400), (250, 248, 240))
    d = ImageDraw.Draw(scratch)
    y = PAD
    head = f"#{idx}  {r['full']}   ·  {r['status']}{' / ' + r['dbIssue'] if r.get('dbIssue') else ''}   ·  {r['id']}"
    d.text((PAD, y), head, fill=(120, 20, 20), font=font(19, True))
    y += 30
    y = text_block(d, PAD, y, "DB", abil_text(r.get("db")), (30, 60, 160))
    y = text_block(d, PAD, y, "SCAN", abil_text(r.get("scanned")), (20, 120, 40))
    diff = "; ".join(f"{p['op']}: db[{p['db']}] scan[{p['scan']}]" for p in r.get("problems", [])[:6])
    if r.get("fixes"):
        diff += ("; " if diff else "") + "icons: " + ", ".join(f"…{f['after']} +{''.join(f['icons'])}" for f in r["fixes"])
    if r.get("digitConflict"):
        diff += ("; " if diff else "") + f"DIGITS {r['digitConflict']}"
    y = text_block(d, PAD, y, "DIFF", diff or "—", (160, 90, 0), width_chars=100, size=15)
    panel_h = max(y + PAD, crop.height)
    out = Image.new("RGB", (CROP_W + TEXT_W, panel_h), (250, 248, 240))
    out.paste(crop, (0, 0))
    out.paste(scratch.crop((0, 0, TEXT_W, panel_h)), (CROP_W, 0))
    ImageDraw.Draw(out).line([(0, panel_h - 1), (CROP_W + TEXT_W, panel_h - 1)], fill=(160, 160, 160), width=2)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", nargs="*", default=["db-suspect", "mismatch", "close"])
    ap.add_argument("--per", type=int, default=4)
    args = ap.parse_args()
    results = [json.loads(l) for l in open(ROOT / "cache" / "scan" / "results.jsonl")]
    todo = [r for r in results if r["status"] in args.status]
    todo.sort(key=lambda r: (args.status.index(r["status"]), r["full"]))
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("sheet-*.png"):
        old.unlink()
    index = []
    for s in range(0, len(todo), args.per):
        rows = [row(r, s + i) for i, r in enumerate(todo[s:s + args.per])]
        sheet = Image.new("RGB", (CROP_W + TEXT_W, sum(x.height for x in rows)), (255, 255, 255))
        y = 0
        for x in rows:
            sheet.paste(x, (0, y))
            y += x.height
        path = OUT / f"sheet-{s // args.per:02d}.png"
        sheet.save(path)
        index += [{"n": s + i, "sheet": path.name, "full": r["full"], "id": r["id"], "status": r["status"]}
                  for i, r in enumerate(todo[s:s + args.per])]
    (OUT / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False))
    print(f"{len(todo)} cards → {len(range(0, len(todo), args.per))} sheets in {OUT}")


if __name__ == "__main__":
    main()
