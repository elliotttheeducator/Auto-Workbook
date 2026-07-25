# Worksheet Builder backend

FastAPI service implementing the upload → detect → edit → export pipeline.

## Setup

```
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
export ANTHROPIC_API_KEY=...   # required for /detect (not needed to run tests)
.venv/bin/uvicorn app.main:app --reload
```

## Layout

- `app/pdf_tools.py` - low-level PDF primitives (render pages, read text-block
  coordinates, crop a region + extract its embedded text). Ported from the
  sibling tutoring project's `tools/slice_chapter.py`, generalized.
- `app/models.py` - the `workbook.json` data model (the single source of
  truth for a project - preview, export, and edits all read/write this one
  structure).
- `app/storage.py` - filesystem-backed project storage
  (`storage/projects/<id>/{source.pdf,crops/,workbook.json}`). Swappable for
  an object store later; nothing else depends on the filesystem layout.
- `app/detection.py` - the first-pass AI detector: one Claude call per
  rendered page (page image + exact text-block coordinates in), a structured
  `propose_regions` tool call out. A proposal, not a verdict - the editor is
  where a teacher fixes whatever it gets wrong.
- `app/edits.py` - the constrained set of edit operations
  (`resize_working_space`, `reorder_pages`, `move_block`, `split_question`,
  `merge_questions`). Deliberately not a general "rewrite the JSON" tool, so
  a bad edit can only do one well-defined thing.
- `app/render.py` - renders `workbook.json` to one HTML page-flow document,
  used for both the on-screen preview and the PDF export.
- `app/export.py` - prints that same HTML headlessly via Playwright to a
  print-ready PDF.
- `app/main.py` - wires it all into HTTP endpoints.

## API

| Route | Method | Purpose |
|---|---|---|
| `/projects` | POST | Upload a chapter PDF (multipart `file`), returns `project_id` |
| `/projects/{id}/detect` | POST | Run first-pass AI detection, saves `workbook.json` |
| `/projects/{id}` | GET | Fetch the current `workbook.json` |
| `/projects/{id}/edit` | POST | Apply one structured edit patch |
| `/projects/{id}/crops/{filename}` | GET | Serve a cropped question/image PNG |
| `/projects/{id}/preview` | GET | HTML page-flow preview |
| `/projects/{id}/export.pdf` | GET | Print-ready PDF export |

## Tests

```
.venv/bin/pytest tests/ -v
```

All 26 tests run without an API key - detection's Claude call is mocked in
`test_api.py`; everything else (crop primitives, the edit engine including
real split/merge re-cropping, HTML rendering, PDF export) is tested against a
synthetic single-page PDF generated in `conftest.py`, so no real (copyrighted)
textbook content is needed to develop against this backend.

## Not built yet

- Auth (this is meant to be single-user/within-school, not public multi-tenant)
- Word export
- The natural-language chat layer that turns a teacher's typed instruction
  into one of `edits.py`'s patches - the patch API it would call already
  exists and is tested
- Cloud object storage (currently local filesystem under `storage/`)
