"""Filesystem-backed project storage.

Layout under STORAGE_ROOT:
  <project_id>/source.pdf
  <project_id>/crops/<name>.png
  <project_id>/workbook.json

Swappable later for an object store (e.g. R2/S3) - callers only depend on
this module's function signatures, not on the filesystem layout.
"""
from __future__ import annotations

import os
import uuid

from .models import Workbook

STORAGE_ROOT = os.environ.get(
    "WORKBOOK_STORAGE_ROOT",
    os.path.join(os.path.dirname(__file__), "..", "storage", "projects"),
)


def _project_dir(project_id: str) -> str:
    return os.path.join(STORAGE_ROOT, project_id)


def crops_dir(project_id: str) -> str:
    return os.path.join(_project_dir(project_id), "crops")


def source_pdf_path(project_id: str) -> str:
    return os.path.join(_project_dir(project_id), "source.pdf")


def workbook_path(project_id: str) -> str:
    return os.path.join(_project_dir(project_id), "workbook.json")


def create_project(pdf_bytes: bytes) -> str:
    project_id = uuid.uuid4().hex[:12]
    os.makedirs(crops_dir(project_id), exist_ok=True)
    with open(source_pdf_path(project_id), "wb") as f:
        f.write(pdf_bytes)
    return project_id


def project_exists(project_id: str) -> bool:
    return os.path.isdir(_project_dir(project_id))


def save_workbook(project_id: str, workbook: Workbook) -> None:
    with open(workbook_path(project_id), "w") as f:
        f.write(workbook.model_dump_json(by_alias=True, indent=2))


def load_workbook(project_id: str) -> Workbook:
    with open(workbook_path(project_id)) as f:
        return Workbook.model_validate_json(f.read())


def list_projects() -> list[str]:
    if not os.path.isdir(STORAGE_ROOT):
        return []
    return sorted(
        name for name in os.listdir(STORAGE_ROOT)
        if os.path.isdir(os.path.join(STORAGE_ROOT, name))
    )
