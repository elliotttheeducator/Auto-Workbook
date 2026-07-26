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

proposals.json shape: a list of {"blocks": [...]} entries, each one a
workbook page (a printed sheet) - NOT tied to source PDF page numbers.
Pack whatever content should share one physical sheet into one entry;
a source page with little content (e.g. a short Key Ideas box) should
usually share a workbook page with the next bit of content rather than
sitting alone with the rest of the sheet blank. Each block dict:
    {"type": "heading", "id": "h1", "text": "Exercise 1"}
    {"type": "heading", "id": "h2", "text": "7A Angles and triangles", "style": "title"}
    {"type": "heading", "id": "h3", "text": "Fluency", "style": "tier", "tier": "fluency"}
    {"type": "image", "id": "diagram1", "page": 2, "rect": [x0, y0, x1, y1]}
    {"type": "question", "id": "ex1a", "page": 2, "rect": [x0, y0, x1, y1],
     "contextImageId": "diagram1",
     "workingSpaceStyle": "grid", "workingSpaceHeightMm": 40,
     "workingSpaceColumns": 2}
"page" (question/image blocks only) is the 0-indexed source PDF page to
crop "rect" out of - each block picks its own source page, so a single
workbook page can freely combine crops pulled from several different
source pages. rect is in PDF points with a top-left origin (fitz's
native convention).
workingSpaceStyle is "grid" (default), "lines" (ruled, for written/proof
answers), or "none". workingSpaceHeightMm defaults to 40 (medium) if
omitted; for "lines" it's snapped to the nearest 10mm (one ruled line).
workingSpaceColumns (lines style only) is 1 (default) or 2, splitting the
ruled area into two side-by-side columns - good for a multi-part question
where each part only needs a short answer, not a full-width line.
Heading "style" is "title" (large, for the exercise/section title),
"tier" (a coloured bar - pass "tier" as one of fluency/problemsolving/
reasoning/enrichment for its colour), or omitted for a plain sub-heading.

A page entry can also have "combinedGroups": [...] for multi-part
questions (ids like "ex2a", "ex2b", ...) - each entry crops the WHOLE
question (all parts together, exactly as printed) as a second, separate
crop, shown when that group's layout is toggled to "combined" in the
editor instead of the individual per-part crops:
    {"groupId": "ex2", "page": 7, "rect": [x0, y0, x1, y1],
     "workingSpaceStyle": "grid", "workingSpaceHeightMm": 60}
groupId must equal the shared prefix of its members' ids (ex2a/ex2b's
group id is "ex2"). Give the split parts ("ex2a" etc, as normal question
blocks) a small workingSpaceHeightMm and the combinedGroups entry a
large one - split is meant to default small (one box per part), combined
large (one shared box for the whole question).
"""
from __future__ import annotations

import argparse
import json
import os
import uuid

import fitz  # PyMuPDF

CROP_ZOOM = 3  # ~216 DPI, matches print quality
GRID_MM = 5
RULE_MM = 10
SIZE_MEDIUM_MM = 40


def snap_down(value_mm: float, spacing_mm: float) -> float:
    steps = max(1, int(value_mm // spacing_mm))
    return steps * spacing_mm


def working_space_for(proposal: dict) -> dict:
    style = proposal.get("workingSpaceStyle", "grid")
    height_mm = proposal.get("workingSpaceHeightMm", SIZE_MEDIUM_MM)
    spacing = RULE_MM if style == "lines" else GRID_MM
    ws = {"style": style, "heightMm": snap_down(height_mm, spacing)}
    if style == "lines" and proposal.get("workingSpaceColumns") == 2:
        ws["columns"] = 2
    return ws


def build_project(pdf_path: str, title: str, pages_proposals: list[dict], project_dir: str, project_id: str) -> dict:
    crops_dir = os.path.join(project_dir, "crops")
    os.makedirs(crops_dir, exist_ok=True)

    pages = []
    combined_blocks = {}
    with fitz.open(pdf_path) as doc:
        for i, entry in enumerate(pages_proposals):
            blocks = []
            for p in entry["blocks"]:
                if p["type"] == "heading":
                    heading = {"type": "heading", "id": p["id"], "text": p.get("text", "")}
                    if p.get("style"):
                        heading["style"] = p["style"]
                    if p.get("tier"):
                        heading["tier"] = p["tier"]
                    blocks.append(heading)
                    continue

                src_page = doc[p["page"]]
                pix = src_page.get_pixmap(matrix=fitz.Matrix(CROP_ZOOM, CROP_ZOOM), clip=fitz.Rect(*p["rect"]))
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
            pages.append({"id": f"page{i}", "blocks": blocks})

            for cg in entry.get("combinedGroups", []):
                src_page = doc[cg["page"]]
                pix = src_page.get_pixmap(matrix=fitz.Matrix(CROP_ZOOM, CROP_ZOOM), clip=fitz.Rect(*cg["rect"]))
                pix.save(os.path.join(crops_dir, f"{cg['groupId']}.png"))
                combined_blocks[cg["groupId"]] = {"workingSpace": working_space_for(cg)}

    # A combinedGroups entry only exists because it's meant to be shown -
    # default those groups to "combined" rather than making every new
    # chapter start with the small split view for questions that were
    # deliberately given a nice whole-question crop.
    workbook = {
        "id": project_id,
        "title": title,
        "sourcePdfName": pdf_path.split("/")[-1],
        "pages": pages,
        "groupLayout": {gid: "combined" for gid in combined_blocks},
        "combinedBlocks": combined_blocks,
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
