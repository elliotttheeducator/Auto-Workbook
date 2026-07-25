"""Interactive editor page: per-question-group Split/Combined toggle and
per-question Small/Medium/Large working-space buttons, each wired to the
existing /edit endpoint via a plain fetch call. Renders crops directly, the
same way the preview does - no PDF exists until the Export button is
clicked, which just links to the already-built /export.pdf endpoint.
"""
from __future__ import annotations

import html

from .grouping import group_id_for, iter_render_units
from .models import HeadingBlock, ImageBlock, QuestionBlock, Workbook
from .styles import A4_WIDTH_PT, PAGE_MARGIN_PT, RULE_SPACING_PT, WORKING_SPACE_CSS, working_space_html
from .working_space import SIZE_PRESETS_PT, nearest_size_preset

EDITOR_CSS = (
    """
body { font-family: -apple-system, Helvetica, Arial, sans-serif; margin: 0; background: #e5e5e5; }
.topbar {
  position: sticky; top: 0; z-index: 10;
  background: #222; color: white; padding: 10pt 16pt;
  display: flex; align-items: center; justify-content: space-between;
}
.topbar h1 { font-size: 14pt; margin: 0; font-weight: 600; }
.topbar a.export {
  background: #2a7; color: white; text-decoration: none;
  padding: 6pt 14pt; border-radius: 4pt; font-weight: 600;
}
.spread {
  display: flex; gap: 10pt; justify-content: center;
  margin: 16pt auto; width: max-content; max-width: 100%;
}
"""
    + f"""
.page {{
  background: white; width: {A4_WIDTH_PT}pt; min-height: 200pt;
  flex: 0 0 auto; box-shadow: 0 1pt 4pt rgba(0,0,0,0.3);
  padding: {PAGE_MARGIN_PT}pt; box-sizing: border-box;
}}
"""
    + """
.heading { font-size: 16pt; font-weight: 600; margin: 12pt 0 6pt; }
.block { margin-bottom: 10pt; }
.block img, .block-crop img { max-width: 100%; display: block; }
.group { margin-bottom: 16pt; border: 1px solid #ddd; border-radius: 6pt; padding: 8pt; }
.group .block-crop { margin-bottom: 6pt; }
.group-controls {
  display: flex; align-items: center; gap: 10pt; margin-bottom: 6pt;
  font-size: 10pt; color: #555;
}
"""
    + WORKING_SPACE_CSS
    + """
.size-picker, .style-picker, .lines-picker { display: flex; align-items: center; gap: 4pt; margin-top: 4pt; }
.size-picker button, .style-picker button, .lines-picker button {
  border: 1px solid #999; background: white; border-radius: 3pt;
  padding: 2pt 8pt; font-size: 9pt; cursor: pointer;
}
.size-picker button.active, .style-picker button.active { background: #2a7; color: white; border-color: #2a7; }
.lines-picker span { font-size: 9pt; color: #555; min-width: 46pt; text-align: center; }
"""
)

EDITOR_JS = """
const PROJECT_ID = window.location.pathname.split('/')[2];
const SIZE_PT = {small: %(small)s, medium: %(medium)s, large: %(large)s};
const RULE_SPACING_PT = %(rule_spacing)s;

async function callEdit(patch) {
  const res = await fetch(`/projects/${PROJECT_ID}/edit`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    alert('Edit failed: ' + await res.text());
    return;
  }
  location.reload();
}

function setLayout(groupId, mode) {
  callEdit({op: 'set_group_layout', group_id: groupId, mode: mode});
}

function setSize(questionId, size) {
  callEdit({op: 'resize_working_space', question_id: questionId, height_pt: SIZE_PT[size]});
}

function setStyle(questionId, style) {
  callEdit({op: 'set_working_space_style', question_id: questionId, style: style});
}

function setLines(questionId, lines) {
  callEdit({op: 'resize_working_space', question_id: questionId, height_pt: lines * RULE_SPACING_PT});
}

async function setGroupLines(idsCsv, lines) {
  const ids = idsCsv.split(',');
  for (const id of ids) {
    await fetch(`/projects/${PROJECT_ID}/edit`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({op: 'resize_working_space', question_id: id, height_pt: lines * RULE_SPACING_PT}),
    });
  }
  location.reload();
}

async function setGroupSize(idsCsv, size) {
  const ids = idsCsv.split(',');
  for (const id of ids) {
    await fetch(`/projects/${PROJECT_ID}/edit`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({op: 'resize_working_space', question_id: id, height_pt: SIZE_PT[size]}),
    });
  }
  location.reload();
}

async function setGroupStyle(idsCsv, style) {
  const ids = idsCsv.split(',');
  for (const id of ids) {
    await fetch(`/projects/${PROJECT_ID}/edit`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({op: 'set_working_space_style', question_id: id, style: style}),
    });
  }
  location.reload();
}
""" % {**SIZE_PRESETS_PT, "rule_spacing": RULE_SPACING_PT}


def _image_src(image_base_url: str, crop_filename: str) -> str:
    return f"{image_base_url.rstrip('/')}/{crop_filename}"


def _crop_html(image_base_url: str, block: QuestionBlock) -> str:
    src = _image_src(image_base_url, block.crop)
    context_html = ""
    if block.context_image:
        ctx_src = _image_src(image_base_url, f"{block.context_image}.png")
        context_html = f'<img src="{html.escape(ctx_src)}">'
    return f'<div class="block-crop">{context_html}<img src="{html.escape(src)}"></div>'


def _size_button_active(height_pt: float, size: str) -> str:
    return "active" if nearest_size_preset(height_pt) == size else ""


def _size_picker_html(active_height_pt: float, onclick_template: str) -> str:
    buttons = []
    for size, label in (("small", "S"), ("medium", "M"), ("large", "L")):
        active = _size_button_active(active_height_pt, size)
        onclick = html.escape(onclick_template.format(size=size), quote=True)
        buttons.append(f'<button class="{active}" onclick="{onclick}">{label}</button>')
    return f'<div class="size-picker">{"".join(buttons)}</div>'


def _style_picker_html(active_style: str, onclick_template: str) -> str:
    buttons = []
    for style, label in (("grid", "Grid"), ("lines", "Written response")):
        active = "active" if active_style == style else ""
        onclick = html.escape(onclick_template.format(style=style), quote=True)
        buttons.append(f'<button class="{active}" onclick="{onclick}">{label}</button>')
    return f'<div class="style-picker">{"".join(buttons)}</div>'


def _lines_picker_html(active_height_pt: float, onclick_template: str) -> str:
    current_lines = max(1, round(active_height_pt / RULE_SPACING_PT))
    dec_onclick = html.escape(onclick_template.format(lines=max(1, current_lines - 1)), quote=True)
    inc_onclick = html.escape(onclick_template.format(lines=current_lines + 1), quote=True)
    label = f"{current_lines} line" + ("s" if current_lines != 1 else "")
    return (
        '<div class="lines-picker">'
        f'<button onclick="{dec_onclick}">−</button>'
        f"<span>{label}</span>"
        f'<button onclick="{inc_onclick}">+</button>'
        "</div>"
    )


def _size_control_html(height_pt: float, style: str, size_target: str, lines_target: str) -> str:
    if style == "lines":
        return _lines_picker_html(height_pt, lines_target)
    return _size_picker_html(height_pt, size_target)


def _render_group(gid: str, blocks: list[QuestionBlock], layout: str, image_base_url: str) -> str:
    crops_html = "".join(_crop_html(image_base_url, b) for b in blocks)
    controls = ""
    if len(blocks) > 1:
        split_checked = "checked" if layout != "combined" else ""
        combined_checked = "checked" if layout == "combined" else ""
        controls = (
            '<div class="group-controls">'
            f"<strong>{html.escape(gid)}</strong> layout:"
            f'<label><input type="radio" name="layout-{html.escape(gid)}" {split_checked} '
            f"onchange=\"setLayout('{gid}','split')\"> Split</label>"
            f'<label><input type="radio" name="layout-{html.escape(gid)}" {combined_checked} '
            f"onchange=\"setLayout('{gid}','combined')\"> Combined</label>"
            "</div>"
        )

    if layout == "combined" and len(blocks) > 1:
        shared_height = max(b.working_space.height_pt for b in blocks)
        shared_style = blocks[0].working_space.style
        ids_csv = ",".join(b.id for b in blocks)
        working_space, _ = working_space_html(shared_height, shared_style)
        size_control = _size_control_html(
            shared_height,
            shared_style,
            "setGroupSize('" + ids_csv + "','{size}')",
            "setGroupLines('" + ids_csv + "',{lines})",
        )
        style_control = _style_picker_html(shared_style, "setGroupStyle('" + ids_csv + "','{style}')")
        return f'<div class="group">{controls}{crops_html}{working_space}{size_control}{style_control}</div>'

    parts = []
    for b in blocks:
        working_space, _ = working_space_html(b.working_space.height_pt, b.working_space.style)
        size_control = _size_control_html(
            b.working_space.height_pt, b.working_space.style, f"setSize('{b.id}','{{size}}')", f"setLines('{b.id}',{{lines}})"
        )
        style_control = _style_picker_html(b.working_space.style, f"setStyle('{b.id}','{{style}}')")
        parts.append(
            f'<div class="block question">{_crop_html(image_base_url, b)}{working_space}{size_control}{style_control}</div>'
        )
    return f'<div class="group">{controls}{"".join(parts)}</div>'


def render_editor_html(workbook: Workbook, image_base_url: str) -> str:
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
                blocks_html.append(_render_group(gid, unit_blocks, layout, image_base_url))
        pages_html.append(f'<div class="page">{"".join(blocks_html)}</div>')

    # Booklet-style browsing: pairs of pages side by side, like an open
    # book. Purely a display convenience - page order stays sequential and
    # export.py's print output is untouched (one A4 sheet per page, in
    # order), so this has no effect on the actual exported PDF's layout.
    spreads_html = []
    for i in range(0, len(pages_html), 2):
        spreads_html.append(f'<div class="spread">{"".join(pages_html[i : i + 2])}</div>')

    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>Editing: {html.escape(workbook.title)}</title>"
        f"<style>{EDITOR_CSS}</style>"
        "</head><body>"
        '<div class="topbar">'
        f"<h1>{html.escape(workbook.title)}</h1>"
        '<a class="export" href="export.pdf">Export PDF</a>'
        "</div>"
        f"{''.join(spreads_html)}"
        f"<script>{EDITOR_JS}</script>"
        "</body></html>"
    )
