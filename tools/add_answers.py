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

Answers are placed immediately after the section they belong to, not
collected at the back. A student checking their work on 3F should not
have to find where 3F's answers begin among five sections' worth of
dense two-column reference text.

Usage:
  python3 tools/add_answers.py --pdf ANSWERS.pdf --project-id ID \\
      --section 3E=17:L:588-706,17:R:46-706,18:L:46-448 \\
      --section 3F=18:L:448-706,18:R:46-322

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
    # Stops short of the black "Answers" tab printed down the outside
    # edge, which otherwise appears as a dark sliver beside the text.
    "R": (272.0, 492.0),
    "W": (48.0, 492.0),
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
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--section", action="append", required=True,
                    help="CODE=PAGE:COL:Y0-Y1,... - repeat per section")
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

    added = 0
    for entry in args.section:
        if "=" not in entry:
            raise SystemExit(f"bad --section {entry!r}, want CODE=CROP,CROP")
        code, specs = entry.split("=", 1)
        code = code.strip()
        blocks = build_section(doc, code, specs.split(","), crops_dir)
        added += len(blocks) - 1
        insert_after_section(wb, code, blocks)

    wb["buildVersion"] = uuid.uuid4().hex[:8]
    with open(wb_path, "w", encoding="utf-8") as f:
        json.dump(wb, f, ensure_ascii=False, indent=1)
    print(f"placed {added} answer crops into {out_dir}, one block after each section")


def build_section(doc, code, specs, crops_dir):
    blocks = [{
        "type": "heading",
        "id": f"ans_{code.lower()}_title",
        "text": f"Answers: {code}",
        "style": "title",
    }]
    for n, spec in enumerate(specs):
        pno, col, y0, y1 = parse_crop(spec.strip())
        x0, x1 = COLUMNS[col]
        rect = fitz.Rect(x0, y0, x1, y1)
        cid = f"ans_{code.lower()}_{n:02d}"
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
        # Left-aligned, not centred. An answers column is a column of
        # TEXT, and centring a 78mm column on a 170mm page leaves an
        # indent down the left that reads as a mistake.
        blocks.append({
            "type": "image",
            "id": cid,
            "widthMm": round(mm(rect.width), 1),
        })

    return blocks


def insert_after_section(wb, code, blocks):
    """Puts a section's answers on their own page, right after it.

    The section is located by the id prefix its own blocks carry, so
    this needs no agreement with the extractor beyond the naming it
    already uses - and a section that is not in the booklet at all
    (filtered out, or not built yet) falls back to the end rather than
    landing somewhere arbitrary."""
    tag = f"_{code.lower()}_"
    last = -1
    for i, page in enumerate(wb["pages"]):
        if any(tag in b.get("id", "") and not b.get("id", "").startswith("ans_")
               for b in page["blocks"]):
            last = i
    at = last + 1 if last >= 0 else len(wb["pages"])
    wb["pages"].insert(at, {"blocks": blocks})


if __name__ == "__main__":
    main()
