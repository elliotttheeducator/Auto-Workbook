"""Low-level PDF primitives: render pages to PNG, read text-block coordinates,
and crop named rectangular regions to PNG + extract the embedded text under
each one. No OCR - these are digitally typeset PDFs, so text extraction is
exact.

Adapted from the Textbook Q&A tutoring platform's tools/slice_chapter.py,
generalized for reuse outside that project.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import fitz  # PyMuPDF

RENDER_ZOOM = 3  # ~216 DPI, used for final crop output

_SAFE_NAME = re.compile(r"^[A-Za-z0-9_-]+$")


@dataclass
class TextBlock:
    page: int
    x0: float
    y0: float
    x1: float
    y1: float
    text: str


@dataclass
class Region:
    name: str
    page: int
    rect: tuple[float, float, float, float]  # x0, y0, x1, y1 in PDF points

    def __post_init__(self) -> None:
        # `name` becomes a filename on disk (see slice_pdf) and is set from
        # user- or model-supplied ids (edit patches, detection proposals) -
        # reject anything but a safe bare filename to block path traversal.
        if not _SAFE_NAME.match(self.name):
            raise ValueError(f"invalid region name {self.name!r}: must match {_SAFE_NAME.pattern}")


@dataclass
class CropResult:
    name: str
    image_path: str
    text: str
    width: int
    height: int


def page_count(pdf_path: str) -> int:
    with fitz.open(pdf_path) as doc:
        return doc.page_count


def render_pages(pdf_path: str, out_dir: str, zoom: float = 2) -> list[str]:
    """Render every page to PNG at the given zoom, for visual inspection
    and for feeding to the detector."""
    paths = []
    with fitz.open(pdf_path) as doc:
        for i, page in enumerate(doc):
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            path = f"{out_dir}/page{i}.png"
            pix.save(path)
            paths.append(path)
    return paths


def dump_text_blocks(pdf_path: str) -> list[TextBlock]:
    """All text blocks on every page, with their PDF-point coordinates -
    the raw material a detector (human or model) reads to find crop
    anchors."""
    blocks: list[TextBlock] = []
    with fitz.open(pdf_path) as doc:
        for i, page in enumerate(doc):
            for b in page.get_text("blocks"):
                x0, y0, x1, y1, text = b[0], b[1], b[2], b[3], b[4]
                if text.strip():
                    blocks.append(TextBlock(i, x0, y0, x1, y1, text.strip()))
    return blocks


def slice_pdf(pdf_path: str, regions: list[Region], out_dir: str) -> list[CropResult]:
    """Crop each region out of the source PDF into out_dir/<name>.png and
    pull the embedded text under it."""
    results = []
    with fitz.open(pdf_path) as doc:
        for r in regions:
            page = doc[r.page]
            rect = fitz.Rect(*r.rect)
            pix = page.get_pixmap(matrix=fitz.Matrix(RENDER_ZOOM, RENDER_ZOOM), clip=rect)
            img_path = f"{out_dir}/{r.name}.png"
            pix.save(img_path)
            text = page.get_text("text", clip=rect).strip()
            results.append(CropResult(r.name, f"{r.name}.png", text, pix.width, pix.height))
    return results
