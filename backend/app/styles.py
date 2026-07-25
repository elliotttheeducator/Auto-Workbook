"""Shared CSS fragments used by both the static print renderer (render.py,
which export.py prints headlessly) and the interactive editor (editor.py) -
kept in one place so the working-space grid never drifts out of sync
between what you edit and what actually prints.
"""
from __future__ import annotations

A4_WIDTH_PT = 595.28
A4_HEIGHT_PT = 841.89

MM_TO_PT = 72 / 25.4
GRID_SPACING_PT = round(5 * MM_TO_PT, 3)  # 5mm, exact at print time

WORKING_SPACE_CSS = f"""
.working-space {{
  border: 1px solid #bbb;
  border-radius: 4pt;
  margin-top: 4pt;
  background-image:
    repeating-linear-gradient(to right, #ccc 0, #ccc 0.5pt, transparent 0.5pt, transparent {GRID_SPACING_PT}pt),
    repeating-linear-gradient(to bottom, #ccc 0, #ccc 0.5pt, transparent 0.5pt, transparent {GRID_SPACING_PT}pt);
  background-size: {GRID_SPACING_PT}pt {GRID_SPACING_PT}pt;
}}
"""
