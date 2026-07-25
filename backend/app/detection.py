"""Automatic first-pass detection: for each page, show Claude the rendered
page image plus the exact text-block coordinates on it, and ask it to
propose question/heading/image regions and a working-space estimate per
question - the same reasoning a human does by eye in the sibling tutoring
project, just made once per page via the API instead of interactively.

This is a proposal, not a verdict: the app always shows results in the
editor for the teacher to fix before export, so an imperfect page here is
a minor annoyance, not a broken workbook.

Requires ANTHROPIC_API_KEY in the environment.
"""
from __future__ import annotations

import base64
import json
import os

import anthropic

from . import pdf_tools
from .models import HeadingBlock, ImageBlock, Page, QuestionBlock, SourceRect, WorkingSpace, Workbook

DETECTION_MODEL = os.environ.get("WORKBOOK_DETECTION_MODEL", "claude-sonnet-5")

SYSTEM_PROMPT = """You are helping turn a textbook chapter page into a student \
workbook. Given a rendered page image and the exact text-block coordinates \
extracted from the underlying PDF (in PDF points, top-left origin), propose \
the regions that should become workbook blocks.

Rules:
- Every lettered sub-part of a question (a, b, c, ...) is its own "question" \
block with its own rect - never merge sub-parts into one image.
- When several sub-parts share a printed instruction or diagram that only \
appears once on the page, put that shared instruction in its own "image" \
block and reference its id from each sub-part's contextImageId.
- Section/exercise titles are "heading" blocks with no rect needed.
- Key ideas boxes and worked examples are "image" blocks.
- For each "question" block, estimate workingSpaceHeightPt: how much blank \
working space (in PDF points) a student would need to answer it by hand - a \
one-line numeric answer needs less than a multi-step working-out problem or \
one requiring a sketch/graph.
- Use the text block y-coordinates to find precise crop boundaries rather \
than guessing from the image alone; a rect should tightly bound its content \
with a small margin.
"""

PROPOSE_REGIONS_TOOL = {
    "name": "propose_regions",
    "description": "Propose the workbook blocks found on this page.",
    "input_schema": {
        "type": "object",
        "properties": {
            "blocks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": ["heading", "question", "image"]},
                        "id": {"type": "string", "description": "short unique id, e.g. ex1a"},
                        "text": {"type": "string", "description": "heading text (heading blocks only)"},
                        "rect": {
                            "type": "array",
                            "items": {"type": "number"},
                            "minItems": 4,
                            "maxItems": 4,
                            "description": "[x0, y0, x1, y1] in PDF points (question/image blocks only)",
                        },
                        "contextImageId": {
                            "type": "string",
                            "description": "id of a shared image block this question depends on, if any",
                        },
                        "workingSpaceHeightPt": {
                            "type": "number",
                            "description": "estimated blank working space in PDF points (question blocks only)",
                        },
                    },
                    "required": ["type", "id"],
                },
            }
        },
        "required": ["blocks"],
    },
}


def _b64_image(path: str) -> str:
    with open(path, "rb") as f:
        return base64.standard_b64encode(f.read()).decode("ascii")


def _format_blocks(blocks: list[pdf_tools.TextBlock]) -> str:
    lines = [f"y0={b.y0:.1f} y1={b.y1:.1f}  {b.text[:80]}" for b in blocks]
    return "\n".join(lines) or "(no text blocks found on this page)"


def propose_page_regions(
    client: anthropic.Anthropic,
    page_image_path: str,
    page_blocks: list[pdf_tools.TextBlock],
) -> list[dict]:
    """One Claude call for one rendered page. Returns the raw block dicts
    from the tool call, in page order."""
    message = client.messages.create(
        model=DETECTION_MODEL,
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        tools=[PROPOSE_REGIONS_TOOL],
        tool_choice={"type": "tool", "name": "propose_regions"},
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": f"Text blocks on this page (PDF points):\n{_format_blocks(page_blocks)}",
                    },
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": _b64_image(page_image_path),
                        },
                    },
                ],
            }
        ],
    )
    for block in message.content:
        if block.type == "tool_use" and block.name == "propose_regions":
            return block.input.get("blocks", [])
    raise RuntimeError("model did not return a propose_regions tool call")


def build_workbook_from_proposals(
    project_id: str,
    title: str,
    source_pdf: str,
    pages_proposals: list[list[dict]],
    crops_dir: str,
) -> Workbook:
    """Turn each page's raw proposal dicts into an actual Workbook, cropping
    every question/image region out of the source PDF as it goes."""
    pages: list[Page] = []
    for page_no, proposals in enumerate(pages_proposals):
        regions = [
            pdf_tools.Region(p["id"], page_no, tuple(p["rect"]))
            for p in proposals
            if p["type"] in ("question", "image") and p.get("rect")
        ]
        crops = {c.name: c for c in pdf_tools.slice_pdf(source_pdf, regions, crops_dir)}

        blocks = []
        for p in proposals:
            if p["type"] == "heading":
                blocks.append(HeadingBlock(id=p["id"], text=p.get("text", "")))
            elif p["type"] == "image":
                crop = crops[p["id"]]
                rect = p["rect"]
                blocks.append(
                    ImageBlock(
                        id=p["id"],
                        crop=crop.image_path,
                        source_rect=SourceRect(page=page_no, x0=rect[0], y0=rect[1], x1=rect[2], y1=rect[3]),
                    )
                )
            elif p["type"] == "question":
                crop = crops[p["id"]]
                rect = p["rect"]
                blocks.append(
                    QuestionBlock(
                        id=p["id"],
                        crop=crop.image_path,
                        source_rect=SourceRect(page=page_no, x0=rect[0], y0=rect[1], x1=rect[2], y1=rect[3]),
                        context_image=p.get("contextImageId"),
                        working_space=WorkingSpace(
                            height_pt=p.get("workingSpaceHeightPt", 80.0),
                            estimated_by="ai",
                        ),
                    )
                )
        pages.append(Page(id=f"page{page_no}", blocks=blocks))

    return Workbook(id=project_id, title=title, source_pdf=source_pdf, pages=pages)


def detect_workbook(project_id: str, title: str, source_pdf: str, render_dir: str, crops_dir: str) -> Workbook:
    """Full first-pass detection for a freshly uploaded PDF: render every
    page, ask Claude to propose blocks for it, and assemble the resulting
    Workbook (with real crops already made)."""
    client = anthropic.Anthropic()
    page_images = pdf_tools.render_pages(source_pdf, render_dir, zoom=2)
    all_blocks = pdf_tools.dump_text_blocks(source_pdf)

    pages_proposals = []
    for page_no, image_path in enumerate(page_images):
        page_blocks = [b for b in all_blocks if b.page == page_no]
        pages_proposals.append(propose_page_regions(client, image_path, page_blocks))

    return build_workbook_from_proposals(project_id, title, source_pdf, pages_proposals, crops_dir)
