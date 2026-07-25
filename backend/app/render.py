"""Renders a workbook.json to a single HTML page-flow document.

This is the one rendering path shared by both the on-screen editor preview
and the print export - `export.py` prints this same HTML headlessly rather
than maintaining a second, separate PDF layout engine.
"""
from __future__ import annotations

import html

from .grouping import group_id_for, iter_render_units
from .models import HeadingBlock, ImageBlock, QuestionBlock, Workbook

PAGE_CSS = """
@page { size: A4; margin: 36pt; }
body { font-family: -apple-system, Helvetica, Arial, sans-serif; margin: 0; }
.page {
  page-break-after: always;
  padding: 8pt 0;
}
.page:last-child { page-break-after: auto; }
.heading { font-size: 16pt; font-weight: 600; margin: 12pt 0 6pt; }
.block { margin-bottom: 10pt; }
.block img, .block-crop img { max-width: 100%; display: block; }
.question { margin-bottom: 14pt; }
.question-group { margin-bottom: 14pt; }
.question-group .block-crop { margin-bottom: 6pt; }
.working-space {
  border: 1px dashed #bbb;
  border-radius: 4pt;
  margin-top: 4pt;
}
@media screen {
  body { background: #e5e5e5; }
  .page {
    background: white;
    width: 595pt;
    min-height: 841pt;
    margin: 16pt auto;
    box-shadow: 0 1pt 4pt rgba(0,0,0,0.3);
    padding: 36pt;
    box-sizing: border-box;
  }
}
"""


def _image_src(image_base_url: str, crop_filename: str) -> str:
    return f"{image_base_url.rstrip('/')}/{crop_filename}"


def _question_crop_html(image_base_url: str, block: QuestionBlock) -> str:
    src = _image_src(image_base_url, block.crop)
    context_html = ""
    if block.context_image:
        ctx_src = _image_src(image_base_url, f"{block.context_image}.png")
        context_html = f'<img src="{html.escape(ctx_src)}">'
    return f'<div class="block-crop" id="{html.escape(block.id)}">{context_html}<img src="{html.escape(src)}"></div>'


def _working_space_html(height_pt: float) -> str:
    return f'<div class="working-space" style="height: {height_pt}pt;"></div>'


def _render_question_group(
    image_base_url: str, blocks: list[QuestionBlock], layout: str
) -> str:
    crops_html = "".join(_question_crop_html(image_base_url, b) for b in blocks)
    if layout == "combined" and len(blocks) > 1:
        shared_height = max(b.working_space.height_pt for b in blocks)
        return f'<div class="block question-group">{crops_html}{_working_space_html(shared_height)}</div>'
    # split (default): each sub-part keeps its own working space
    parts = [
        f'<div class="block question">{_question_crop_html(image_base_url, b)}{_working_space_html(b.working_space.height_pt)}</div>'
        for b in blocks
    ]
    return "".join(parts)


def render_workbook_html(workbook: Workbook, image_base_url: str) -> str:
    pages_html = []
    for page in workbook.pages:
        blocks_html = []
        for kind, unit_blocks in iter_render_units(page):
            if kind == "single":
                block = unit_blocks[0]
                if isinstance(block, HeadingBlock):
                    blocks_html.append(f'<div class="heading">{html.escape(block.text)}</div>')
                elif isinstance(block, ImageBlock):
                    src = _image_src(image_base_url, block.crop)
                    blocks_html.append(f'<div class="block"><img src="{html.escape(src)}"></div>')
            else:  # "group"
                gid = group_id_for(unit_blocks[0].id)
                layout = workbook.group_layout.get(gid, "split")
                blocks_html.append(_render_question_group(image_base_url, unit_blocks, layout))
        pages_html.append(f'<div class="page" id="{html.escape(page.id)}">{"".join(blocks_html)}</div>')

    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>{html.escape(workbook.title)}</title>"
        f"<style>{PAGE_CSS}</style>"
        "</head><body>"
        f"{''.join(pages_html)}"
        "</body></html>"
    )
