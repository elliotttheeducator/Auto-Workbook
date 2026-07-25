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


def _multi_part_workbook(synthetic_pdf, crops_dir):
    proposals = [
        [
            {"type": "question", "id": "ex1a", "rect": [30, 80, 300, 150], "workingSpaceHeightPt": 50},
            {"type": "question", "id": "ex1b", "rect": [30, 160, 300, 220], "workingSpaceHeightPt": 90},
        ]
    ]
    return build_workbook_from_proposals("proj1", "T", synthetic_pdf, proposals, str(crops_dir))


def test_split_layout_renders_one_working_space_per_part(synthetic_pdf, tmp_path):
    crops_dir = tmp_path / "crops"
    crops_dir.mkdir()
    workbook = _multi_part_workbook(synthetic_pdf, crops_dir)

    out = render_workbook_html(workbook, image_base_url="/x")

    assert out.count('class="working-space"') == 2
    assert "height: 50.0pt" in out
    assert "height: 90.0pt" in out
    assert 'class="block question-group"' not in out


def test_combined_layout_renders_one_shared_working_space(synthetic_pdf, tmp_path):
    crops_dir = tmp_path / "crops"
    crops_dir.mkdir()
    workbook = _multi_part_workbook(synthetic_pdf, crops_dir)
    workbook.group_layout["ex1"] = "combined"

    out = render_workbook_html(workbook, image_base_url="/x")

    assert out.count('class="working-space"') == 1
    assert "height: 90.0pt" in out  # max of the two members
    assert 'id="ex1a"' in out and 'id="ex1b"' in out  # both crops still present
    assert 'class="block question-group"' in out
