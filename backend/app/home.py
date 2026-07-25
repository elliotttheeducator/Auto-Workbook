"""Landing page: lists existing projects and lets you upload a new chapter
PDF. This is the one page a bare browser visit to the deployed site lands
on - everything else (editor, export) is reached by following a link from
here."""
from __future__ import annotations

import html

HOME_CSS = """
body { font-family: -apple-system, Helvetica, Arial, sans-serif; margin: 0; background: #e5e5e5; }
.topbar { background: #222; color: white; padding: 10pt 16pt; }
.topbar h1 { font-size: 14pt; margin: 0; font-weight: 600; }
main { max-width: 640px; margin: 24pt auto; padding: 0 16pt; }
.upload-box, .project-list {
  background: white; border-radius: 6pt; padding: 16pt; margin-bottom: 16pt;
  box-shadow: 0 1pt 4pt rgba(0,0,0,0.15);
}
.project-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8pt 0; border-bottom: 1px solid #eee;
}
.project-row:last-child { border-bottom: none; }
.project-row .status { color: #888; font-size: 10pt; }
a.button, button.button {
  background: #2a7; color: white; text-decoration: none; border: none;
  padding: 6pt 14pt; border-radius: 4pt; font-weight: 600; cursor: pointer; font-size: 10pt;
}
"""

HOME_JS = """
async function uploadPdf(event) {
  event.preventDefault();
  const input = document.getElementById('pdf-file');
  if (!input.files.length) return;
  const form = new FormData();
  form.append('file', input.files[0]);
  const res = await fetch('/projects', { method: 'POST', body: form });
  if (!res.ok) {
    alert('Upload failed: ' + await res.text());
    return;
  }
  location.reload();
}
"""


def _project_row_html(project_id: str, title: str | None) -> str:
    safe_id = html.escape(project_id)
    if title is not None:
        return (
            '<div class="project-row">'
            f"<div><strong>{html.escape(title)}</strong><br>"
            f'<span class="status">{safe_id}</span></div>'
            f'<div><a class="button" href="/projects/{safe_id}/editor">Open editor</a></div>'
            "</div>"
        )
    return (
        '<div class="project-row">'
        f"<div><strong>{safe_id}</strong><br>"
        '<span class="status">uploaded, not yet detected</span></div>'
        "</div>"
    )


def render_home_html(projects: list[tuple[str, str | None]]) -> str:
    if projects:
        rows = "".join(_project_row_html(pid, title) for pid, title in reversed(projects))
        list_html = f'<div class="project-list">{rows}</div>'
    else:
        list_html = '<div class="project-list">No projects yet - upload a chapter PDF to start one.</div>'

    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>Worksheet Builder</title>"
        f"<style>{HOME_CSS}</style>"
        "</head><body>"
        '<div class="topbar"><h1>Worksheet Builder</h1></div>'
        "<main>"
        '<div class="upload-box">'
        "<form onsubmit=\"uploadPdf(event)\">"
        '<input id="pdf-file" type="file" accept="application/pdf" required>'
        '<button class="button" type="submit">Upload chapter PDF</button>'
        "</form>"
        "</div>"
        f"{list_html}"
        "</main>"
        f"<script>{HOME_JS}</script>"
        "</body></html>"
    )
