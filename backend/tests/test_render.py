from app.detection import build_workbook_from_proposals
from app.render import render_workbook_html


def test_render_includes_heading_and_question_with_working_space(synthetic_pdf, tmp_path):
    crops_dir = tmp_path / "crops"
    crops_dir.mkdir()
    proposals = [
        [
            {"type": "heading", "id": "h1", "text": "Exercise 1"},
            {"type": "question", "id": "q1a", "rect": [30, 80, 300, 150], "workingSpaceHeightPt": 60},
        ]
    ]
    workbook = build_workbook_from_proposals("proj1", "Test Chapter", synthetic_pdf, proposals, str(crops_dir))

    out = render_workbook_html(workbook, image_base_url="/projects/proj1/crops")

    assert "Exercise 1" in out
    assert '/projects/proj1/crops/q1a.png' in out
    assert "height: 60.0pt" in out
    assert 'id="q1a"' in out


def test_render_escapes_heading_text(synthetic_pdf, tmp_path):
    crops_dir = tmp_path / "crops"
    crops_dir.mkdir()
    proposals = [[{"type": "heading", "id": "h1", "text": "<script>alert(1)</script>"}]]
    workbook = build_workbook_from_proposals("proj1", "T", synthetic_pdf, proposals, str(crops_dir))
    out = render_workbook_html(workbook, image_base_url="/x")
    assert "<script>alert(1)</script>" not in out
    assert "&lt;script&gt;" in out
