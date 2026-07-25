"""Adds a chapter to the Worksheet Builder site's data/ folder, from a
chapter PDF and a list of per-page block proposals (the same "which
regions are which question" reasoning a live detection API call would
produce, done by hand instead).

Writes data/<id>/workbook.json and data/<id>/crops/<blockId>.png, and
appends the new project to data/index.json - real files, committed and
pushed straight into the repo, so the static site just reads them. No
upload step: the site never has to receive data at runtime.

Usage:
    python add_chapter.py --pdf chapter.pdf --proposals proposals.json \
        --title "Y9 Chapter 7 - Angles and triangles" --data-dir ../data

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
import json
import os
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


def build_project(pdf_path: str, title: str, pages_proposals: list[list[dict]], project_dir: str, project_id: str) -> dict:
    crops_dir = os.path.join(project_dir, "crops")
    os.makedirs(crops_dir, exist_ok=True)

    pages = []
    with fitz.open(pdf_path) as doc:
        for page_no, proposals in enumerate(pages_proposals):
            page = doc[page_no]
            blocks = []
            for p in proposals:
                if p["type"] == "heading":
                    blocks.append({"type": "heading", "id": p["id"], "text": p.get("text", "")})
                    continue

                pix = page.get_pixmap(matrix=fitz.Matrix(CROP_ZOOM, CROP_ZOOM), clip=fitz.Rect(*p["rect"]))
                pix.save(os.path.join(crops_dir, f"{p['id']}.png"))

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

    workbook = {
        "id": project_id,
        "title": title,
        "sourcePdfName": pdf_path.split("/")[-1],
        "pages": pages,
        "groupLayout": {},
    }
    with open(os.path.join(project_dir, "workbook.json"), "w") as f:
        json.dump(workbook, f, indent=2)

    return workbook


def update_index(data_dir: str, project_id: str, title: str) -> None:
    index_path = os.path.join(data_dir, "index.json")
    entries = []
    if os.path.exists(index_path):
        with open(index_path) as f:
            entries = json.load(f)
    entries.append({"id": project_id, "title": title})
    with open(index_path, "w") as f:
        json.dump(entries, f, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pdf", required=True, help="path to the chapter PDF")
    parser.add_argument("--proposals", required=True, help="path to the proposals JSON")
    parser.add_argument("--title", required=True, help="chapter title shown in the editor")
    parser.add_argument("--data-dir", default="data", help="repo-relative data/ directory to write into")
    args = parser.parse_args()

    with open(args.proposals) as f:
        pages_proposals = json.load(f)

    os.makedirs(args.data_dir, exist_ok=True)
    project_id = uuid.uuid4().hex[:12]
    project_dir = os.path.join(args.data_dir, project_id)

    workbook = build_project(args.pdf, args.title, pages_proposals, project_dir, project_id)
    update_index(args.data_dir, workbook["id"], args.title)

    num_crops = len([f for f in os.listdir(os.path.join(project_dir, "crops"))])
    print(f"wrote {project_dir}: {len(workbook['pages'])} pages, {num_crops} crops, id={workbook['id']}")


if __name__ == "__main__":
    main()
