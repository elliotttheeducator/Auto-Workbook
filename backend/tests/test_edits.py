import pytest

from app.edits import (
    EditError,
    MergeQuestions,
    MoveBlock,
    PatchEnvelope,
    ReorderPages,
    ResizeWorkingSpace,
    SetGroupLayout,
    SetWorkingSpaceStyle,
    SplitQuestion,
    apply_patch,
)
from app.models import Workbook


@pytest.fixture
def workbook():
    return Workbook.model_validate(
        {
            "id": "wb1",
            "title": "Test",
            "sourcePdf": "x.pdf",
            "pages": [
                {
                    "id": "p1",
                    "blocks": [
                        {"type": "heading", "id": "h1", "text": "Exercise 1"},
                        {
                            "type": "question",
                            "id": "ex1a",
                            "crop": "c.png",
                            "workingSpace": {"heightPt": 100, "estimatedBy": "heuristic"},
                        },
                    ],
                },
                {
                    "id": "p2",
                    "blocks": [
                        {
                            "type": "question",
                            "id": "ex2a",
                            "crop": "c2.png",
                            "workingSpace": {"heightPt": 50, "estimatedBy": "heuristic"},
                        }
                    ],
                },
            ],
        }
    )


def test_resize_working_space(workbook):
    workbook = apply_patch(workbook, ResizeWorkingSpace(question_id="ex1a", height_pt=200), "", "")
    block = workbook.find_block("ex1a")[2]
    assert block.working_space.height_pt == 200
    assert block.working_space.estimated_by == "manual"


def test_resize_rejects_non_positive_height(workbook):
    with pytest.raises(EditError):
        apply_patch(workbook, ResizeWorkingSpace(question_id="ex1a", height_pt=0), "", "")


def test_resize_rejects_unknown_question(workbook):
    with pytest.raises(EditError):
        apply_patch(workbook, ResizeWorkingSpace(question_id="nope", height_pt=10), "", "")


def test_reorder_pages(workbook):
    workbook = apply_patch(workbook, ReorderPages(page_order=["p2", "p1"]), "", "")
    assert [p.id for p in workbook.pages] == ["p2", "p1"]


def test_reorder_rejects_non_permutation(workbook):
    with pytest.raises(EditError):
        apply_patch(workbook, ReorderPages(page_order=["p1"]), "", "")


def test_move_block(workbook):
    workbook = apply_patch(
        workbook, MoveBlock(block_id="ex2a", target_page_id="p1", index=0), "", ""
    )
    assert workbook.pages[0].blocks[0].id == "ex2a"
    assert len(workbook.pages[1].blocks) == 0


def test_split_and_merge_question(synthetic_pdf, tmp_path):
    crops_dir = tmp_path / "crops"
    crops_dir.mkdir()
    workbook = Workbook.model_validate(
        {
            "id": "wb1",
            "title": "Test",
            "sourcePdf": synthetic_pdf,
            "pages": [
                {
                    "id": "p1",
                    "blocks": [
                        {
                            "type": "question",
                            "id": "combined",
                            "crop": "c.png",
                            "sourceRect": {"page": 0, "x0": 30, "y0": 80, "x1": 300, "y1": 220},
                            "workingSpace": {"heightPt": 100, "estimatedBy": "heuristic"},
                        }
                    ],
                }
            ],
        }
    )

    workbook = apply_patch(
        workbook,
        SplitQuestion(question_id="combined", first_id="q1a", second_id="q1b", split_fraction=0.5),
        synthetic_pdf,
        str(crops_dir),
    )
    ids = [b.id for b in workbook.pages[0].blocks]
    assert ids == ["q1a", "q1b"]
    assert (crops_dir / "q1a.png").exists()
    assert (crops_dir / "q1b.png").exists()

    workbook = apply_patch(
        workbook,
        MergeQuestions(question_ids=["q1a", "q1b"], new_id="merged"),
        synthetic_pdf,
        str(crops_dir),
    )
    ids = [b.id for b in workbook.pages[0].blocks]
    assert ids == ["merged"]
    assert (crops_dir / "merged.png").exists()


def test_set_group_layout_toggles_and_is_reversible(workbook):
    workbook = apply_patch(workbook, SetGroupLayout(group_id="ex1", mode="combined"), "", "")
    assert workbook.group_layout["ex1"] == "combined"

    workbook = apply_patch(workbook, SetGroupLayout(group_id="ex1", mode="split"), "", "")
    assert workbook.group_layout["ex1"] == "split"


def test_set_group_layout_rejects_unknown_group(workbook):
    with pytest.raises(EditError):
        apply_patch(workbook, SetGroupLayout(group_id="nope", mode="combined"), "", "")


def test_set_working_space_style_toggles(workbook):
    workbook = apply_patch(workbook, SetWorkingSpaceStyle(question_id="ex1a", style="lines"), "", "")
    assert workbook.find_block("ex1a")[2].working_space.style == "lines"

    workbook = apply_patch(workbook, SetWorkingSpaceStyle(question_id="ex1a", style="grid"), "", "")
    assert workbook.find_block("ex1a")[2].working_space.style == "grid"


def test_set_working_space_style_rejects_unknown_question(workbook):
    with pytest.raises(EditError):
        apply_patch(workbook, SetWorkingSpaceStyle(question_id="nope", style="lines"), "", "")


def test_patch_envelope_dispatches_by_op():
    patch = PatchEnvelope.model_validate({"op": "resize_working_space", "question_id": "x", "height_pt": 10}).root
    assert isinstance(patch, ResizeWorkingSpace)
