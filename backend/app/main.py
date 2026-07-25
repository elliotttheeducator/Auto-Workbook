from __future__ import annotations

import os
import re

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import ValidationError

from . import detection, export, storage
from .edits import EditError, PatchEnvelope, apply_patch
from .models import Workbook

app = FastAPI(title="Worksheet Builder")

_SAFE_CROP_FILENAME = re.compile(r"^[A-Za-z0-9_-]+\.png$")
_PROJECT_ID_PATTERN = re.compile(r"^[a-f0-9]{12}$")  # matches storage.create_project's uuid4().hex[:12]


def _require_project(project_id: str) -> None:
    # project_id feeds directly into filesystem paths (storage.py) - reject
    # anything that isn't the exact shape create_project generates before
    # it ever reaches a path join, rather than trying to blacklist "..".
    if not _PROJECT_ID_PATTERN.match(project_id) or not storage.project_exists(project_id):
        raise HTTPException(status_code=404, detail=f"no project {project_id!r}")


def _require_workbook(project_id: str) -> Workbook:
    _require_project(project_id)
    if not os.path.exists(storage.workbook_path(project_id)):
        raise HTTPException(status_code=409, detail="project has not been detected yet")
    return storage.load_workbook(project_id)


@app.get("/", response_class=HTMLResponse)
def home():
    from .home import render_home_html

    projects = []
    for project_id in storage.list_projects():
        title = None
        if os.path.exists(storage.workbook_path(project_id)):
            title = storage.load_workbook(project_id).title
        projects.append((project_id, title))
    return HTMLResponse(content=render_home_html(projects))


@app.post("/projects")
async def create_project(file: UploadFile):
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="expected a PDF upload")
    pdf_bytes = await file.read()
    project_id = storage.create_project(pdf_bytes)
    return {"project_id": project_id}


@app.post("/projects/{project_id}/detect")
def detect_project(project_id: str, title: str = "Untitled chapter"):
    _require_project(project_id)
    workbook = detection.detect_workbook(
        project_id=project_id,
        title=title,
        source_pdf=storage.source_pdf_path(project_id),
        render_dir=storage.crops_dir(project_id),
        crops_dir=storage.crops_dir(project_id),
    )
    storage.save_workbook(project_id, workbook)
    return workbook.model_dump(by_alias=True)


@app.post("/projects/{project_id}/detect-proposals")
def detect_project_from_proposals(project_id: str, body: dict):
    """Same result as /detect, but skips the live Claude API call - accepts
    already-produced per-page block proposals (the same shape the model's
    propose_regions tool would have returned) and crops/assembles the
    workbook from them directly. Lets detection be done by hand (e.g. by
    Claude reading the PDF in a chat session) against a deployed instance
    that has no ANTHROPIC_API_KEY configured."""
    _require_project(project_id)
    title = body.get("title", "Untitled chapter")
    pages_proposals = body["pagesProposals"]
    workbook = detection.build_workbook_from_proposals(
        project_id=project_id,
        title=title,
        source_pdf=storage.source_pdf_path(project_id),
        pages_proposals=pages_proposals,
        crops_dir=storage.crops_dir(project_id),
    )
    storage.save_workbook(project_id, workbook)
    return workbook.model_dump(by_alias=True)


@app.get("/projects/{project_id}")
def get_project(project_id: str):
    workbook = _require_workbook(project_id)
    return workbook.model_dump(by_alias=True)


@app.post("/projects/{project_id}/edit")
def edit_project(project_id: str, patch: dict):
    workbook = _require_workbook(project_id)
    try:
        parsed_patch = PatchEnvelope.model_validate(patch).root
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=str(e))

    try:
        workbook = apply_patch(
            workbook,
            parsed_patch,
            pdf_path=storage.source_pdf_path(project_id),
            crops_dir=storage.crops_dir(project_id),
        )
    except EditError as e:
        raise HTTPException(status_code=422, detail=str(e))

    storage.save_workbook(project_id, workbook)
    return workbook.model_dump(by_alias=True)


@app.get("/projects/{project_id}/crops/{filename}")
def get_crop(project_id: str, filename: str):
    _require_project(project_id)
    if not _SAFE_CROP_FILENAME.match(filename):
        raise HTTPException(status_code=404, detail="no such crop")
    path = os.path.join(storage.crops_dir(project_id), filename)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="no such crop")
    return FileResponse(path)


@app.get("/projects/{project_id}/preview", response_class=HTMLResponse)
def preview_project(project_id: str):
    workbook = _require_workbook(project_id)
    from .render import render_workbook_html

    html_content = render_workbook_html(workbook, image_base_url=f"/projects/{project_id}/crops")
    return HTMLResponse(content=html_content)


@app.get("/projects/{project_id}/editor", response_class=HTMLResponse)
def editor_project(project_id: str):
    workbook = _require_workbook(project_id)
    from .editor import render_editor_html

    html_content = render_editor_html(workbook, image_base_url=f"/projects/{project_id}/crops")
    return HTMLResponse(content=html_content)


@app.get("/projects/{project_id}/export.pdf")
def export_project(project_id: str):
    _require_workbook(project_id)
    pdf_path = export.export_workbook_pdf(project_id)
    return FileResponse(pdf_path, media_type="application/pdf", filename="workbook.pdf")
