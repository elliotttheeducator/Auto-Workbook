"""Builds a Worksheet Builder project bundle from a chapter PDF and a list
of per-page block proposals (the same "which regions are which question"
reasoning a live detection API call would produce, done by hand instead).

The bundle is the one file the static site needs to go straight to the
editor: it embeds every cropped question/image region as a base64 PNG
alongside the workbook structure, so the browser only has to decode and
store it - no PDF parsing happens client-side.

Usage:
    python build_bundle.py --pdf chapter.pdf --proposals proposals.json \
        --title "Y9 Chapter 7 - Angles and triangles" --out bundle.json

proposals.json shape: a list with one entry per PDF page, each entry a
list of block dicts:
    {"type": "heading", "id": "h1", "text": "Exercise 1"}
    {"type": "image", "id": "diagram1", "rect": [x0, y0, x1, y1]}
    {"type": "question", "id": "ex1a", "rect": [x0, y0, x1, y1],
     "contextImageId": "diagram1", "workingSpaceHeightPt": 60}
rect is in PDF points with a top-left origin (fitz's native convention).
"""
from __future__ import annotations

import argparse
import base64
import json
import uuid

import fitz  # PyMuPDF

CROP_ZOOM = 3  # ~216 DPI, matches print quality
GRID_MM = 5
SIZE_MEDIUM_MM = 40
PT_TO_MM = 25.4 / 72


def snap_down(value_mm: float, spacing_mm: float) -> float:
    steps = max(1, int(value_mm // spacing_mm))
    return steps * spacing_mm


def working_space_for(proposal: dict) -> dict:
    height_pt = proposal.get("workingSpaceHeightPt")
    if height_pt is not None:
        return {"style": "grid", "heightMm": snap_down(height_pt * PT_TO_MM, GRID_MM)}
    return {"style": "grid", "heightMm": SIZE_MEDIUM_MM}


def crop_to_data_uri(page: fitz.Page, rect: list[float]) -> str:
    pix = page.get_pixmap(matrix=fitz.Matrix(CROP_ZOOM, CROP_ZOOM), clip=fitz.Rect(*rect))
    png_bytes = pix.tobytes("png")
    return "data:image/png;base64," + base64.standard_b64encode(png_bytes).decode("ascii")


def build_bundle(pdf_path: str, title: str, pages_proposals: list[list[dict]]) -> dict:
    project_id = uuid.uuid4().hex[:12]
    pages = []
    crops = {}

    with fitz.open(pdf_path) as doc:
        for page_no, proposals in enumerate(pages_proposals):
            page = doc[page_no]
            blocks = []
            for p in proposals:
                if p["type"] == "heading":
                    blocks.append({"type": "heading", "id": p["id"], "text": p.get("text", "")})
                    continue

                crops[p["id"]] = crop_to_data_uri(page, p["rect"])
                if p["type"] == "image":
                    blocks.append({"type": "image", "id": p["id"]})
                else:
                    blocks.append({
                        "type": "question",
                        "id": p["id"],
                        "contextImage": p.get("contextImageId"),
                        "workingSpace": working_space_for(p),
                    })
            pages.append({"id": f"page{page_no}", "blocks": blocks})

    return {
        "id": project_id,
        "title": title,
        "sourcePdfName": pdf_path.split("/")[-1],
        "pages": pages,
        "groupLayout": {},
        "crops": crops,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pdf", required=True, help="path to the chapter PDF")
    parser.add_argument("--proposals", required=True, help="path to the proposals JSON")
    parser.add_argument("--title", required=True, help="chapter title shown in the editor")
    parser.add_argument("--out", required=True, help="path to write the bundle JSON to")
    args = parser.parse_args()

    with open(args.proposals) as f:
        pages_proposals = json.load(f)

    bundle = build_bundle(args.pdf, args.title, pages_proposals)

    with open(args.out, "w") as f:
        json.dump(bundle, f)

    print(f"wrote {args.out}: {len(bundle['pages'])} pages, {len(bundle['crops'])} crops")


if __name__ == "__main__":
    main()
