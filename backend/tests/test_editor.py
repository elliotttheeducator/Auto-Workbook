from app.editor import render_editor_html
from app.models import HeadingBlock, Page, Workbook


def _page(id_: str) -> Page:
    return Page(id=id_, blocks=[HeadingBlock(id=f"{id_}-h", text=id_)])


def _workbook(num_pages: int) -> Workbook:
    return Workbook(
        id="wb1",
        title="T",
        source_pdf="x.pdf",
        pages=[_page(f"page{i}") for i in range(num_pages)],
    )


def test_even_pages_pair_into_full_spreads():
    out = render_editor_html(_workbook(4), image_base_url="/x")
    assert out.count('class="spread"') == 2
    assert out.count('class="page"') == 4


def test_odd_pages_leave_a_trailing_single_page_spread():
    out = render_editor_html(_workbook(3), image_base_url="/x")
    assert out.count('class="spread"') == 2
    assert out.count('class="page"') == 3


def test_grid_lines_rendered_for_a_grid_working_space():
    from app.models import QuestionBlock, WorkingSpace

    wb = Workbook(
        id="wb1",
        title="T",
        source_pdf="x.pdf",
        pages=[
            Page(
                id="p1",
                blocks=[
                    QuestionBlock(
                        id="ex1a",
                        crop="ex1a.png",
                        working_space=WorkingSpace(height_pt=60, estimated_by="heuristic", style="grid"),
                    )
                ],
            )
        ],
    )
    out = render_editor_html(wb, image_base_url="/x")
    assert "grid-line-v" in out
    assert "grid-line-h" in out


def _workbook_with_question(height_pt: float = 50.0) -> Workbook:
    from app.models import QuestionBlock, WorkingSpace

    return Workbook(
        id="wb1",
        title="T",
        source_pdf="x.pdf",
        pages=[
            Page(
                id="p1",
                blocks=[
                    QuestionBlock(
                        id="ex1a",
                        crop="ex1a.png",
                        working_space=WorkingSpace(height_pt=height_pt, estimated_by="heuristic"),
                    )
                ],
            )
        ],
    )


def test_editor_actually_renders_a_working_space_box():
    # Regression: the grid CSS rule existing is not enough - an element
    # with class="working-space" must actually be in the markup, or the
    # rule never applies to anything.
    from app.styles import GRID_SPACING_PT, snap_down

    out = render_editor_html(_workbook_with_question(height_pt=73.0), image_base_url="/x")
    assert 'class="working-space"' in out
    assert f"height: {snap_down(73.0, GRID_SPACING_PT):.3f}pt" in out
