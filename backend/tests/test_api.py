from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import storage
from app.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "STORAGE_ROOT", str(tmp_path / "projects"))
    return TestClient(app)


def _canned_proposals():
    return [
        [
            {"type": "heading", "id": "h1", "text": "Exercise 1"},
            {"type": "question", "id": "q1a", "rect": [30, 80, 300, 150], "workingSpaceHeightPt": 60},
            {"type": "question", "id": "q1b", "rect": [30, 180, 300, 220], "workingSpaceHeightPt": 40},
        ]
    ]


def _create_and_detect(client, synthetic_pdf):
    with open(synthetic_pdf, "rb") as f:
        r = client.post("/projects", files={"file": ("synthetic.pdf", f, "application/pdf")})
    assert r.status_code == 200
    project_id = r.json()["project_id"]

    with patch("app.detection.propose_page_regions", return_value=_canned_proposals()[0]):
        r = client.post(f"/projects/{project_id}/detect", params={"title": "Test Chapter"})
    assert r.status_code == 200
    return project_id, r.json()


def test_upload_rejects_non_pdf(client):
    r = client.post("/projects", files={"file": ("x.txt", b"hello", "text/plain")})
    assert r.status_code == 400


def test_get_before_detect_is_409(client, synthetic_pdf):
    with open(synthetic_pdf, "rb") as f:
        r = client.post("/projects", files={"file": ("synthetic.pdf", f, "application/pdf")})
    project_id = r.json()["project_id"]
    assert client.get(f"/projects/{project_id}").status_code == 409


def test_unknown_project_is_404(client):
    assert client.get("/projects/000000000000").status_code == 404


def test_project_id_path_traversal_is_rejected(client):
    r = client.get("/projects/..%2f..%2f..%2fetc/crops/passwd.png")
    assert r.status_code == 404


def test_detect_then_get_roundtrip(client, synthetic_pdf):
    project_id, body = _create_and_detect(client, synthetic_pdf)
    assert body["title"] == "Test Chapter"
    assert [b["id"] for b in body["pages"][0]["blocks"] if b["type"] == "question"] == ["q1a", "q1b"]

    r = client.get(f"/projects/{project_id}")
    assert r.status_code == 200
    assert r.json() == body


def test_crop_image_is_servable(client, synthetic_pdf):
    project_id, body = _create_and_detect(client, synthetic_pdf)
    r = client.get(f"/projects/{project_id}/crops/q1a.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"


def test_crop_filename_traversal_is_rejected(client, synthetic_pdf):
    project_id, _ = _create_and_detect(client, synthetic_pdf)
    r = client.get(f"/projects/{project_id}/crops/..%2f..%2fsource.pdf")
    assert r.status_code == 404


def test_edit_resize_working_space(client, synthetic_pdf):
    project_id, _ = _create_and_detect(client, synthetic_pdf)
    r = client.post(
        f"/projects/{project_id}/edit",
        json={"op": "resize_working_space", "question_id": "q1a", "height_pt": 250},
    )
    assert r.status_code == 200
    block = next(b for b in r.json()["pages"][0]["blocks"] if b["id"] == "q1a")
    assert block["workingSpace"]["heightPt"] == 250
    assert block["workingSpace"]["estimatedBy"] == "manual"


def test_edit_unknown_op_is_422(client, synthetic_pdf):
    project_id, _ = _create_and_detect(client, synthetic_pdf)
    r = client.post(f"/projects/{project_id}/edit", json={"op": "not_a_real_op"})
    assert r.status_code == 422


def test_edit_bad_target_is_422(client, synthetic_pdf):
    project_id, _ = _create_and_detect(client, synthetic_pdf)
    r = client.post(
        f"/projects/{project_id}/edit",
        json={"op": "resize_working_space", "question_id": "no-such-question", "height_pt": 10},
    )
    assert r.status_code == 422


def test_preview_renders_html(client, synthetic_pdf):
    project_id, _ = _create_and_detect(client, synthetic_pdf)
    r = client.get(f"/projects/{project_id}/preview")
    assert r.status_code == 200
    assert "Exercise 1" in r.text
    assert f"/projects/{project_id}/crops/q1a.png" in r.text


def test_export_pdf(client, synthetic_pdf):
    project_id, _ = _create_and_detect(client, synthetic_pdf)
    r = client.get(f"/projects/{project_id}/export.pdf")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.content[:5] == b"%PDF-"
