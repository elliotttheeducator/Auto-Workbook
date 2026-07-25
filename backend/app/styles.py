"""Shared CSS/markup fragments used by both the static print renderer
(render.py, which export.py prints headlessly) and the interactive editor
(editor.py) - kept in one place so the working-space grid never drifts out
of sync between what you edit and what actually prints.

Grid/rule lines are real DOM elements (solid-fill divs), not a CSS gradient
background - a gradient gets rasterized by Chromium's print pipeline and
softens at high zoom/print DPI; solid rectangles print as sharp vector
fills at any resolution. Box dimensions are always snapped to a whole
number of lines (see `snap_down`) so a box never ends on a partial cell.
"""
from __future__ import annotations

import html

A4_WIDTH_PT = 595.28
A4_HEIGHT_PT = 841.89
PAGE_MARGIN_PT = 36.0
CONTENT_WIDTH_PT = A4_WIDTH_PT - 2 * PAGE_MARGIN_PT

MM_TO_PT = 72 / 25.4
GRID_SPACING_PT = 5 * MM_TO_PT  # 5mm - the math/diagram grid
RULE_SPACING_PT = 2 * GRID_SPACING_PT  # 10mm - ruled lines for written answers

# Widest a working-space box can be while landing exactly on a grid line at
# its right edge - applied to every box regardless of style, so grid and
# ruled boxes line up with each other visually.
WORKING_SPACE_WIDTH_PT = (int(CONTENT_WIDTH_PT // GRID_SPACING_PT)) * GRID_SPACING_PT

LINE_THICKNESS_PT = 0.5
GRID_LINE_COLOR = "#ccc"
RULE_LINE_COLOR = "#bbb"

WORKING_SPACE_CSS = f"""
.working-space {{
  position: relative;
  overflow: hidden;
  border: 1pt solid #999;
  margin-top: 4pt;
  box-sizing: border-box;
}}
.grid-line-v {{
  position: absolute; top: 0; bottom: 0; width: {LINE_THICKNESS_PT}pt;
  background: {GRID_LINE_COLOR}; margin-left: -{LINE_THICKNESS_PT / 2}pt;
}}
.grid-line-h {{
  position: absolute; left: 0; right: 0; height: {LINE_THICKNESS_PT}pt;
  background: {GRID_LINE_COLOR}; margin-top: -{LINE_THICKNESS_PT / 2}pt;
}}
.rule-line {{
  position: absolute; left: 0; right: 0; height: {LINE_THICKNESS_PT}pt;
  background: {RULE_LINE_COLOR}; margin-top: -{LINE_THICKNESS_PT / 2}pt;
}}
"""


def snap_down(length_pt: float, spacing_pt: float) -> float:
    """The largest multiple of spacing_pt that fits within length_pt - so a
    box sized to the result always ends exactly on a line, never mid-cell."""
    if length_pt <= 0:
        return 0.0
    steps = int(length_pt // spacing_pt)
    return steps * spacing_pt


def working_space_html(height_pt: float, style: str) -> tuple[str, float]:
    """Renders a working-space box's inner markup for the given nominal
    height and style ("grid" or "lines"). Both the box height and width are
    snapped to a whole number of lines first. Returns (html, actual_height_pt)
    since the snapped height can differ slightly from the requested one."""
    width_pt = WORKING_SPACE_WIDTH_PT
    spacing_pt = GRID_SPACING_PT if style == "grid" else RULE_SPACING_PT
    snapped_height = max(spacing_pt, snap_down(height_pt, spacing_pt))

    lines = []
    if style == "grid":
        x = 0.0
        while x <= width_pt + 0.01:
            lines.append(f'<div class="grid-line-v" style="left: {x:.3f}pt;"></div>')
            x += spacing_pt
        y = 0.0
        while y <= snapped_height + 0.01:
            lines.append(f'<div class="grid-line-h" style="top: {y:.3f}pt;"></div>')
            y += spacing_pt
    else:  # "lines" - ruled paper for written responses, horizontal only
        y = spacing_pt
        while y <= snapped_height + 0.01:
            lines.append(f'<div class="rule-line" style="top: {y:.3f}pt;"></div>')
            y += spacing_pt

    inner = "".join(lines)
    box_html = (
        f'<div class="working-space" '
        f'style="width: {width_pt:.3f}pt; height: {snapped_height:.3f}pt;">'
        f"{inner}</div>"
    )
    return box_html, snapped_height


def escape(text: str) -> str:
    return html.escape(text)
