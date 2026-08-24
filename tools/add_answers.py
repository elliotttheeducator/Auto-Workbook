"""Appends an answers section to an existing project.

The answers volume is a separate book with a completely different
layout - two narrow columns of dense reference text, no question
structure to parse - so it is not worth flowing. It is cropped, which
is exactly what the bitmap pipeline is good at.

What this tool adds is that the crops are specified as COLUMNS rather
than as free rectangles. An answers page runs down its left column and
then down its right, so a section's answers routinely start halfway
down one column and finish partway down another; a whole-page crop
cannot express that without dragging in the neighbouring sections.
Naming a column and a y-range can, and it keeps every crop the same
width - which is what stops a run of answer pages looking ragged.

Usage:
  python3 tools/add_answers.py --pdf ANSWERS.pdf --project-id ID \\
      --title "Answers" --crops 17:R:46-706 18:L:46-706 ...

Each crop is PAGE:COLUMN:Y0-Y1 with 0-based page, column L, R or W
(the full width of both).
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import uuid

import fitz
from PIL import Image

# Answers are reference text, read rather than written on, and they are
# set smaller than the questions - so they are rendered at a higher
# zoom than the question crops to stay comfortably legible in print.
ANSWER_ZOOM = 4

# The answers volume's type area, measured from the pages themselves.
COLUMNS = {
    "L": (48.0, 270.0),
    "R": (272.0, 500.0),
    "W": (48.0, 500.0),
}


def mm(pt: float) -> float:
    return pt * 25.4 / 72.0


def parse_crop(spec: str):
    m = re.fullmatch(r"(\d+):([LRW]):(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)", spec)
    if not m:
        raise SystemExit(f"bad --crops entry {spec!r}, want PAGE:COLUMN:Y0-Y1")
    page, col, y0, y1 = m.group(1), m.group(2), float(m.group(3)), float(m.group(4))
    return int(page), col, y0, y1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--project-id", required=True)
    ap.add_argument("--title", default="Answers")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--crops", nargs="+", required=True, help="PAGE:COLUMN:Y0-Y1 ...")
    args = ap.parse_args()

    out_dir = os.path.join(args.data_dir, args.project_id)
    wb_path = os.path.join(out_dir, "workbook.json")
    if not os.path.exists(wb_path):
        raise SystemExit(f"no workbook at {wb_path} - build the chapter first")
    crops_dir = os.path.join(out_dir, "crops")
    os.makedirs(crops_dir, exist_ok=True)

    doc = fitz.open(args.pdf)
    wb = json.load(open(wb_path, encoding="utf-8"))
    # Re-running is normal (the chapter gets rebuilt), so any answers
    # section from a previous run is replaced rather than stacked up.
    wb["pages"] = [p for p in wb["pages"]
                   if not any(b.get("id", "").startswith("ans_") for b in p["blocks"])]

    blocks = [{
        "type": "heading",
        "id": "ans_title",
        "text": args.title,
        "style": "title",
    }]
    for n, spec in enumerate(args.crops):
        pno, col, y0, y1 = parse_crop(spec)
        x0, x1 = COLUMNS[col]
        rect = fitz.Rect(x0, y0, x1, y1)
        cid = f"ans_{n:02d}"
        pix = doc[pno].get_pixmap(matrix=fitz.Matrix(ANSWER_ZOOM, ANSWER_ZOOM), clip=rect)
        img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
        # A column rarely fills its page, and the blank tail is real
        # paper once printed - a section that ends a third of the way
        # down still claimed a full page. Trimming to the ink keeps the
        # crop's WIDTH untouched, so every answer column stays the same
        # width and the run of them still reads as one set.
        ink = Image.eval(img.convert("L"), lambda v: 255 - v).getbbox()
        if ink:
            img = img.crop((0, max(ink[1] - 8, 0), img.width, min(ink[3] + 8, img.height)))
        img.save(os.path.join(crops_dir, cid + ".png"))
        blocks.append({
            "type": "image",
            "id": cid,
            "contentKind": "diagram",
            "widthMm": round(mm(rect.width), 1),
        })

    wb["pages"].append({"blocks": blocks})
    wb["buildVersion"] = uuid.uuid4().hex[:8]
    with open(wb_path, "w", encoding="utf-8") as f:
        json.dump(wb, f, ensure_ascii=False, indent=1)
    print(f"appended {len(args.crops)} answer crops to {out_dir}")


if __name__ == "__main__":
    main()
