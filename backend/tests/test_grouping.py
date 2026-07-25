from app.grouping import group_id_for, question_groups
from app.models import HeadingBlock, Page, QuestionBlock, WorkingSpace


def _q(id_: str) -> QuestionBlock:
    return QuestionBlock(
        id=id_, crop=f"{id_}.png", working_space=WorkingSpace(height_pt=50, estimated_by="heuristic")
    )


def test_group_id_for_strips_trailing_letter_only_when_preceded_by_digit():
    assert group_id_for("ex1a") == "ex1"
    assert group_id_for("bu1j") == "bu1"
    assert group_id_for("ex8") == "ex8"
    assert group_id_for("ex10c") == "ex10"


def test_question_groups_chunks_contiguous_same_group_blocks():
    page = Page(
        id="p1",
        blocks=[
            HeadingBlock(id="h1", text="Exercise 1"),
            _q("ex1a"),
            _q("ex1b"),
            _q("ex1c"),
            _q("ex2"),
            _q("ex3a"),
            _q("ex3b"),
        ],
    )
    groups = question_groups(page)
    assert [[b.id for b in g] for g in groups] == [
        ["ex1a", "ex1b", "ex1c"],
        ["ex2"],
        ["ex3a", "ex3b"],
    ]


def test_question_groups_does_not_merge_across_non_question_blocks():
    page = Page(
        id="p1",
        blocks=[_q("ex1a"), HeadingBlock(id="h1", text="Break"), _q("ex1b")],
    )
    groups = question_groups(page)
    assert [[b.id for b in g] for g in groups] == [["ex1a"], ["ex1b"]]
