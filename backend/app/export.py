"""Print-ready PDF export: prints the same HTML the editor previews,
headlessly, via Playwright/Chromium - one rendering path for both preview
and export rather than a second layout engine.
"""
from __future__ import annotations

import os

from playwright.sync_api import sync_playwright

from . import storage
from .render import render_workbook_html

CHROMIUM_EXECUTABLE = os.environ.get("PLAYWRIGHT_CHROMIUM_PATH", "/opt/pw-browsers/chromium")


def export_workbook_pdf(project_id: str) -> str:
    """Renders the project's current workbook.json to a print-ready PDF and
    returns the path it was written to."""
    workbook = storage.load_workbook(project_id)
    project_dir = os.path.dirname(storage.workbook_path(project_id))
    html_path = os.path.join(project_dir, "preview.html")
    pdf_path = os.path.join(project_dir, "export.pdf")

    html_content = render_workbook_html(workbook, image_base_url="crops")
    with open(html_path, "w") as f:
        f.write(html_content)

    launch_kwargs = {}
    if os.path.exists(CHROMIUM_EXECUTABLE):
        launch_kwargs["executable_path"] = CHROMIUM_EXECUTABLE

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_kwargs)
        page = browser.new_page()
        page.goto(f"file://{html_path}")
        page.pdf(path=pdf_path, print_background=True, prefer_css_page_size=True)
        browser.close()

    return pdf_path
