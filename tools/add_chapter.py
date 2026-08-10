"""Adds a chapter to the Worksheet Builder site's data/ folder, from one
or two source PDFs (a chapter PDF and, optionally, an answers PDF) and a
list of per-page block proposals (the same "which regions are which
question" reasoning a live detection API call would produce, done by
hand instead).

Writes data/<id>/workbook.json and data/<id>/crops/<blockId>.png, and
appends the new project to data/index.json - real files, committed and
pushed straight into the repo, so the static site just reads them. No
upload step: the site never has to receive data at runtime.

Usage:
    python add_chapter.py --pdf chapter.pdf --answers-pdf answers.pdf \
        --proposals proposals.json \
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
native convention). "source" (optional, default "chapter") picks which
PDF "page" refers to - "chapter" (--pdf) or "answers" (--answers-pdf) -
so answer pages can be interleaved into the same workbook alongside the
chapter content they answer.
workingSpaceStyle is "grid" (default), "lines" (ruled), or "none". Default
to grid even for reasoning-tier questions - it's fine for short verbal
answers too, not just numbers. Only reach for "lines" when the question
explicitly asks the student to write out a full explanation, proof, or
multi-step justification from scratch ("explain why...", "prove that...",
"complete a proof"): a "find x" (numeric), a naming/labelling question, a
"measure and compare" question, or a "give a reason (SSS/SAS/AAA/RHS)"
one-word-plus-a-number question all belong on grid, even when they sit
right next to a lines-worthy proof in the same exercise.
workingSpaceHeightMm defaults to 40 (medium) if omitted; for "lines" it's
snapped to the nearest 10mm (one ruled line).
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

Which layout a group actually *starts* on is computed automatically
(plan_group_defaults), not something to set by hand: past the last
warmup section (Building Understanding, worked examples, "Now you try"
- i.e. once a "tier" heading has appeared), a group with more than 3
parts defaults to split (splitting is what actually helps once there
are that many; 2-3 parts read fine as one combined crop). A split
part's own starting diagram scale is never baked in here either - it
comes from the workbook-wide "default split scale" control in the
editor itself (tunable live, not fixed the moment a chapter's built).

A page entry can also be marked `"cover": true` - its (single) image
block is rendered edge-to-edge with no page margin or heading, for a
workbook cover/title page:
    {"cover": true, "blocks": [{"type": "image", "id": "cover", "page": 0,
     "rect": [0, 0, 595, 842]}]}

Every crop (except a cover) gets its blank margin auto-trimmed off after
cropping - a "rect" only has to roughly bound its content, not hug it
exactly. Don't hand-tune rects tighter to compensate; let the trim
handle it. Two files get written per crop id: "<id>.png", trimmed tight
(CROP_TIGHT_PAD_PX) - what every question shows by default - and
"<id>__full.png", trimmed generously (CROP_SOURCE_PAD_PX) - the source
image the in-app manual crop tool loads, so a too-tight default crop can
always be dragged back out to reveal real margin, never just re-cropped
from nothing. workbook.json also gets a "defaultCropRect" per block
(percentages of the full image) so the crop tool's selection box starts
exactly where the default crop already is.

A "Key Ideas" summary image and a worked example's own diagram are both
just "image" blocks - nothing structural distinguishes them from any
other image - but two optional fields matter for them specifically:
  - section: true - marks it as informational content (a Key Ideas box,
    a worked example) rather than an actual question, so it starts at
    the workbook-wide "default section scale" instead of "default
    combined scale" (see resolvedDefaultScales in model.js) - both
    adjustable live from the editor, but kept as separate controls since
    a Key Ideas page and an actual question crop usually want different
    starting densities. Set this on every Key Ideas and example image;
    don't also hand-set imageScale unless this specific one genuinely
    needs to differ from its siblings.
  - glueForward: true on a worked example's own diagram - without it,
    nothing stops the example's diagram landing on one sheet and the
    "Now you try" that explains it landing on the next. Same idea as a
    heading always gluing to what it introduces, just spelled out
    explicitly here since there's no id convention (the way a group's
    "{groupId}_stem" naming is) tying an example to its own "now you
    try".

An answer-key page image (any "source": "answers" image block) is set
to "answers": true automatically - its own default-scale bucket too, so
a chapter's answer pages can be shrunk to actually fit fewer sheets
instead of being pinned to a fixed real-world mm width matching the
source PDF (the old behavior, which meant they could never be adjusted
at all).
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import uuid

import fitz  # PyMuPDF
from PIL import Image

CROP_ZOOM = 3  # ~216 DPI, matches print quality
GRID_MM = 5
RULE_MM = 10
SIZE_MEDIUM_MM = 40
# A pixel darker than this (out of 255) counts as real content, not
# background - used to trim blank margin off a hand-picked crop rect (see
# _ink_bbox). Threshold, not exact-white difference: a scanned or
# rendered page is rarely pure #fff right at an edge.
CROP_TRIM_THRESHOLD = 245
# The margin the DEFAULT shipped crop (what every question shows before
# anyone touches the manual crop tool) keeps around its own real ink.
# Deliberately tight - most crops need no manual adjustment at all, and
# every point of unwanted blank margin here is a point someone has to
# manually trim back out later. Getting most crops right and a few too
# tight (fixable by dragging back out - see CROP_SOURCE_PAD_PX below)
# beats getting most too loose and every one needing a trim.
CROP_TIGHT_PAD_PX = 15
# The margin the SOURCE image (what the manual crop tool loads to select
# from - see crop.js/app.js's handleOpenCrop) keeps around that same ink.
# Generous, unlike CROP_TIGHT_PAD_PX above: crop.js can only ever select
# a sub-region of the pixels it's handed, with no way to reveal content
# past the image's own edge, so this is the only headroom a "make it
# bigger" edit ever has to work with. Only spends margin the proposal's
# own rect already captured (never reaches past the pixmap it was
# given), so it's free - no new risk of bleeding into neighbouring
# content that wasn't already avoided when the rect was chosen.
CROP_SOURCE_PAD_PX = 60


def _ink_bbox(img: Image.Image, pad_px: int) -> tuple[int, int, int, int] | None:
    """Bounding box of every pixel darker than CROP_TRIM_THRESHOLD, padded
    by pad_px and clamped to the image - None if the image is blank.
    """
    mask = img.convert("L").point(lambda p: 255 if p < CROP_TRIM_THRESHOLD else 0)
    bbox = mask.getbbox()
    if bbox is None:
        return None
    left, top, right, bottom = bbox
    left = max(0, left - pad_px)
    top = max(0, top - pad_px)
    right = min(img.width, right + pad_px)
    bottom = min(img.height, bottom + pad_px)
    return left, top, right, bottom


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


def group_id_for(block_id: str) -> str | None:
    m = re.match(r"^(.+?)(\d+)([a-zA-Z])$", block_id)
    return m.group(1) + m.group(2) if m else None


def plan_group_defaults(pages_proposals: list[dict]) -> dict[str, str]:
    """Works out, before any cropping starts, which groups should default
    to "split" - needs the *whole* document's structure (every part of a
    group, and which heading section it falls under), not just whatever's
    on the one page a block happens to sit on.

    A group defaults to split only once it's past the last "warmup"
    section (Building Understanding, worked examples, "Now you try") -
    a "tier" heading (Fluency/Problem-solving/Reasoning/Enrichment)
    marks that a chapter has moved into its real exercise - and only
    once it has more than 3 parts: 2-3 parts read fine as one combined
    crop, but splitting is what actually helps once there's 4+.

    A combinedGroups entry can also set "forceSplit": true to always
    default to split regardless of the above - for Building
    Understanding groups specifically, which should stay compact (small,
    per-part) even though they sit before any tier heading and so would
    otherwise always default combined.
    """
    combined_gids: set[str] = set()
    force_split_gids: set[str] = set()
    for entry in pages_proposals:
        for cg in entry.get("combinedGroups", []):
            combined_gids.add(cg["groupId"])
            if cg.get("forceSplit"):
                force_split_gids.add(cg["groupId"])

    part_count: dict[str, int] = {}
    in_tier_section = False
    tier_section_gids: set[str] = set()
    for entry in pages_proposals:
        for p in entry["blocks"]:
            if p["type"] == "heading":
                if p.get("style") == "tier":
                    in_tier_section = True
                elif p.get("style") == "title":
                    in_tier_section = False
                continue
            if p["type"] != "question":
                continue
            gid = group_id_for(p["id"])
            if not gid:
                continue
            part_count[gid] = part_count.get(gid, 0) + 1
            if in_tier_section:
                tier_section_gids.add(gid)

    return {
        gid: (
            "split"
            if gid in force_split_gids or (gid in tier_section_gids and part_count.get(gid, 0) > 3)
            else "combined"
        )
        for gid in combined_gids
    }


def build_project(docs: dict, title: str, pages_proposals: list[dict], project_dir: str, project_id: str) -> dict:
    crops_dir = os.path.join(project_dir, "crops")
    os.makedirs(crops_dir, exist_ok=True)
    group_layout = plan_group_defaults(pages_proposals)

    def crop(p: dict, crop_id: str, trim: bool = True) -> dict | None:
        """Writes "<crop_id>.png" (tight default) and, when trimmed,
        "<crop_id>__full.png" (generous source for the manual crop tool)
        - see CROP_TIGHT_PAD_PX/CROP_SOURCE_PAD_PX above. Returns the
        tight crop's own rect as percentages of the full image (for
        workbook.json's "defaultCropRect"), or None for an untrimmed
        (cover) crop, which has no full/tight split at all.
        """
        src_doc = docs[p.get("source", "chapter")]
        src_page = src_doc[p["page"]]
        pix = src_page.get_pixmap(matrix=fitz.Matrix(CROP_ZOOM, CROP_ZOOM), clip=fitz.Rect(*p["rect"]))
        full_img = Image.open(io.BytesIO(pix.tobytes("png")))
        if not trim:
            full_img.save(os.path.join(crops_dir, f"{crop_id}.png"))
            return None
        full_img.save(os.path.join(crops_dir, f"{crop_id}__full.png"))
        tight_bbox = _ink_bbox(full_img, CROP_TIGHT_PAD_PX)
        if tight_bbox is None:
            tight_bbox = (0, 0, full_img.width, full_img.height)
        full_img.crop(tight_bbox).save(os.path.join(crops_dir, f"{crop_id}.png"))
        left, top, right, bottom = tight_bbox
        return {
            "x": round(left / full_img.width * 100, 2),
            "y": round(top / full_img.height * 100, 2),
            "w": round((right - left) / full_img.width * 100, 2),
            "h": round((bottom - top) / full_img.height * 100, 2),
        }

    pages = []
    combined_blocks = {}
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

            # A cover image is deliberately full-bleed (edge to edge, no
            # margin) - trimming would eat into that framing rather than
            # just removing dead space, so it's the one crop left alone.
            default_crop_rect = crop(p, p["id"], trim=not entry.get("cover"))
            if p["type"] == "image":
                image_block = {"type": "image", "id": p["id"]}
                # An answer-key page image - its own default-scale bucket
                # (see "answers" in the module docstring above), not a
                # fixed real-world mm width matching the source PDF: that
                # used to mean an answer image could never be shrunk at
                # all, however tall it turned out to be.
                if p.get("source") == "answers":
                    image_block["answers"] = True
                if p.get("imageScale"):
                    image_block["imageScale"] = p["imageScale"]
                # Author-set, not a runtime editor toggle - see
                # glueForward in render.js's per-page block loop. Use for
                # a worked example's diagram, so it can never end up
                # stranded from the "Now you try" that explains it.
                if p.get("glueForward"):
                    image_block["glueForward"] = True
                # A Key Ideas summary or worked-example diagram - see
                # "section" in the module docstring above. Puts it in its
                # own default-scale bucket (separate from an actual
                # question's combined/standalone crop) at render time.
                if p.get("section"):
                    image_block["section"] = True
                if default_crop_rect:
                    image_block["defaultCropRect"] = default_crop_rect
                blocks.append(image_block)
            else:
                question_block = {
                    "type": "question",
                    "id": p["id"],
                    "contextImage": p.get("contextImageId"),
                    "workingSpace": working_space_for(p),
                }
                # No baked-in imageScale here (unlike an image block's
                # optional per-block override above) - a split part's
                # starting scale now comes from the workbook-wide
                # "default split scale" control (see DEFAULT_SPLIT_SCALE
                # in model.js), tunable from the editor itself instead of
                # fixed the moment a chapter's built. Baking a number in
                # here would just permanently shadow that control for
                # every part in every future chapter.
                if p.get("imageScale"):
                    question_block["imageScale"] = p["imageScale"]
                if default_crop_rect:
                    question_block["defaultCropRect"] = default_crop_rect
                blocks.append(question_block)
        page = {"id": f"page{i}", "blocks": blocks}
        if entry.get("cover"):
            page["cover"] = True
        pages.append(page)

        for cg in entry.get("combinedGroups", []):
            cg_default_crop_rect = crop(cg, cg["groupId"])
            combined_blocks[cg["groupId"]] = {"workingSpace": working_space_for(cg)}
            if cg_default_crop_rect:
                combined_blocks[cg["groupId"]]["defaultCropRect"] = cg_default_crop_rect

    workbook = {
        "id": project_id,
        "title": title,
        "sourcePdfName": os.path.basename(docs["chapter"].name),
        "pages": pages,
        "groupLayout": group_layout,
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
    parser.add_argument("--answers-pdf", help="path to an answers PDF, for blocks with \"source\": \"answers\"")
    parser.add_argument("--proposals", required=True, help="path to the proposals JSON")
    parser.add_argument("--title", required=True, help="chapter title shown in the editor")
    parser.add_argument("--data-dir", default="data", help="repo-relative data/ directory to write into")
    args = parser.parse_args()

    with open(args.proposals) as f:
        pages_proposals = json.load(f)

    os.makedirs(args.data_dir, exist_ok=True)
    project_id = uuid.uuid4().hex[:12]
    project_dir = os.path.join(args.data_dir, project_id)

    with fitz.open(args.pdf) as chapter_doc:
        docs = {"chapter": chapter_doc}
        if args.answers_pdf:
            with fitz.open(args.answers_pdf) as answers_doc:
                docs["answers"] = answers_doc
                workbook = build_project(docs, args.title, pages_proposals, project_dir, project_id)
        else:
            workbook = build_project(docs, args.title, pages_proposals, project_dir, project_id)
    update_index(args.data_dir, workbook["id"], args.title)

    num_crops = len([f for f in os.listdir(os.path.join(project_dir, "crops"))])
    print(f"wrote {project_dir}: {len(workbook['pages'])} pages, {num_crops} crops, id={workbook['id']}")


if __name__ == "__main__":
    main()
