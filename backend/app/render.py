"""Renders a workbook.json to a single HTML page-flow document.

This is the one rendering path shared by both the on-screen editor preview
and the print export - `export.py` prints this same HTML headlessly rather
than maintaining a second, separate PDF layout engine.
"""
from __future__ import annotations

import html

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
.block img { max-width: 100%; display: block; }
.question { margin-bottom: 14pt; }
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


def render_workbook_html(workbook: Workbook, image_base_url: str) -> str:
    pages_html = []
    for page in workbook.pages:
        blocks_html = []
        for block in page.blocks:
            if isinstance(block, HeadingBlock):
                blocks_html.append(f'<div class="heading">{html.escape(block.text)}</div>')
            elif isinstance(block, ImageBlock):
                src = _image_src(image_base_url, block.crop)
                blocks_html.append(f'<div class="block"><img src="{html.escape(src)}"></div>')
            elif isinstance(block, QuestionBlock):
                src = _image_src(image_base_url, block.crop)
                context_html = ""
                if block.context_image:
                    ctx_src = _image_src(image_base_url, f"{block.context_image}.png")
                    context_html = f'<img src="{html.escape(ctx_src)}">'
                blocks_html.append(
                    f'<div class="block question" id="{html.escape(block.id)}">'
                    f"{context_html}"
                    f'<img src="{html.escape(src)}">'
                    f'<div class="working-space" style="height: {block.working_space.height_pt}pt;"></div>'
                    f"</div>"
                )
        pages_html.append(f'<div class="page" id="{html.escape(page.id)}">{"".join(blocks_html)}</div>')

    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>{html.escape(workbook.title)}</title>"
        f"<style>{PAGE_CSS}</style>"
        "</head><body>"
        f"{''.join(pages_html)}"
        "</body></html>"
    )
