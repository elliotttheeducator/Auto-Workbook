"""The constrained set of edit operations the AI (and, later, any direct-
manipulation UI) is allowed to perform on a workbook. Deliberately not a
general "rewrite the JSON" tool - a bad AI turn can only do one of these
five well-defined things, never corrupt the rest of the project.
"""
from __future__ import annotations

from typing import Literal, Union

from pydantic import BaseModel, Field, RootModel

from . import pdf_tools
from .grouping import group_id_for
from .models import QuestionBlock, Workbook

# ids here become filenames on disk (via pdf_tools.slice_pdf) - constrain at
# the API boundary too, not just in pdf_tools.Region, for a clean 422 instead
# of a ValueError surfacing from deep inside the patch application.
_SAFE_ID = r"^[A-Za-z0-9_-]+$"


class ResizeWorkingSpace(BaseModel):
    op: Literal["resize_working_space"] = "resize_working_space"
    question_id: str
    height_pt: float


class ReorderPages(BaseModel):
    op: Literal["reorder_pages"] = "reorder_pages"
    page_order: list[str]


class MoveBlock(BaseModel):
    op: Literal["move_block"] = "move_block"
    block_id: str
    target_page_id: str
    index: int


class SplitQuestion(BaseModel):
    op: Literal["split_question"] = "split_question"
    question_id: str
    first_id: str = Field(pattern=_SAFE_ID)
    second_id: str = Field(pattern=_SAFE_ID)
    split_fraction: float = 0.5


class MergeQuestions(BaseModel):
    op: Literal["merge_questions"] = "merge_questions"
    question_ids: list[str]
    new_id: str = Field(pattern=_SAFE_ID)


class SetGroupLayout(BaseModel):
    """Toggle a question group's rendering between one-working-space-per-part
    and one-shared-working-space-for-the-group. Pure rendering metadata - no
    block or crop is touched, so it's freely reversible either direction."""

    op: Literal["set_group_layout"] = "set_group_layout"
    group_id: str
    mode: Literal["split", "combined"]


Patch = Union[
    ResizeWorkingSpace, ReorderPages, MoveBlock, SplitQuestion, MergeQuestions, SetGroupLayout
]


class PatchEnvelope(RootModel[Patch]):
    """Parses a raw dict/JSON patch into the right Patch subtype."""


class EditError(ValueError):
    pass


def apply_patch(workbook: Workbook, patch: Patch, pdf_path: str, crops_dir: str) -> Workbook:
    if isinstance(patch, ResizeWorkingSpace):
        return _resize_working_space(workbook, patch)
    if isinstance(patch, ReorderPages):
        return _reorder_pages(workbook, patch)
    if isinstance(patch, MoveBlock):
        return _move_block(workbook, patch)
    if isinstance(patch, SplitQuestion):
        return _split_question(workbook, patch, pdf_path, crops_dir)
    if isinstance(patch, MergeQuestions):
        return _merge_questions(workbook, patch, pdf_path, crops_dir)
    if isinstance(patch, SetGroupLayout):
        return _set_group_layout(workbook, patch)
    raise EditError(f"unknown patch op: {patch}")


def _resize_working_space(workbook: Workbook, patch: ResizeWorkingSpace) -> Workbook:
    found = workbook.find_block(patch.question_id)
    if found is None:
        raise EditError(f"no question with id {patch.question_id!r}")
    pi, bi, block = found
    if not isinstance(block, QuestionBlock):
        raise EditError(f"block {patch.question_id!r} is not a question")
    if patch.height_pt <= 0:
        raise EditError("height_pt must be positive")
    block.working_space.height_pt = patch.height_pt
    block.working_space.estimated_by = "manual"
    return workbook


def _reorder_pages(workbook: Workbook, patch: ReorderPages) -> Workbook:
    by_id = {p.id: p for p in workbook.pages}
    if set(patch.page_order) != set(by_id):
        raise EditError("page_order must be a permutation of every existing page id")
    workbook.pages = [by_id[pid] for pid in patch.page_order]
    return workbook


def _set_group_layout(workbook: Workbook, patch: SetGroupLayout) -> Workbook:
    known_group_ids = {group_id_for(qid) for qid in workbook.all_question_ids()}
    if patch.group_id not in known_group_ids:
        raise EditError(f"no question group {patch.group_id!r}")
    workbook.group_layout[patch.group_id] = patch.mode
    return workbook


def _move_block(workbook: Workbook, patch: MoveBlock) -> Workbook:
    found = workbook.find_block(patch.block_id)
    if found is None:
        raise EditError(f"no block with id {patch.block_id!r}")
    src_page_i, src_block_i, block = found
    target_page = next((p for p in workbook.pages if p.id == patch.target_page_id), None)
    if target_page is None:
        raise EditError(f"no page with id {patch.target_page_id!r}")

    workbook.pages[src_page_i].blocks.pop(src_block_i)
    index = max(0, min(patch.index, len(target_page.blocks)))
    target_page.blocks.insert(index, block)
    return workbook


def _split_question(
    workbook: Workbook, patch: SplitQuestion, pdf_path: str, crops_dir: str
) -> Workbook:
    found = workbook.find_block(patch.question_id)
    if found is None:
        raise EditError(f"no question with id {patch.question_id!r}")
    pi, bi, block = found
    if not isinstance(block, QuestionBlock):
        raise EditError(f"block {patch.question_id!r} is not a question")
    if block.source_rect is None:
        raise EditError(f"question {patch.question_id!r} has no source_rect to split")
    if not 0 < patch.split_fraction < 1:
        raise EditError("split_fraction must be between 0 and 1")

    rect = block.source_rect
    split_y = rect.y0 + (rect.y1 - rect.y0) * patch.split_fraction
    regions = [
        pdf_tools.Region(patch.first_id, rect.page, (rect.x0, rect.y0, rect.x1, split_y)),
        pdf_tools.Region(patch.second_id, rect.page, (rect.x0, split_y, rect.x1, rect.y1)),
    ]
    crops = pdf_tools.slice_pdf(pdf_path, regions, crops_dir)

    new_blocks = []
    for region, crop in zip(regions, crops):
        new_blocks.append(
            QuestionBlock(
                id=region.name,
                crop=crop.image_path,
                source_rect=block.source_rect.model_copy(
                    update={"y0": region.rect[1], "y1": region.rect[3]}
                ),
                working_space=block.working_space.model_copy(),
            )
        )
    workbook.pages[pi].blocks[bi : bi + 1] = new_blocks
    return workbook


def _merge_questions(
    workbook: Workbook, patch: MergeQuestions, pdf_path: str, crops_dir: str
) -> Workbook:
    if len(patch.question_ids) < 2:
        raise EditError("merge_questions needs at least two question_ids")

    blocks_found = [workbook.find_block(qid) for qid in patch.question_ids]
    if any(f is None for f in blocks_found):
        missing = [qid for qid, f in zip(patch.question_ids, blocks_found) if f is None]
        raise EditError(f"no question(s) with id(s) {missing!r}")

    pages_involved = {f[0] for f in blocks_found}
    if len(pages_involved) > 1:
        raise EditError("merge_questions only supports blocks on the same page")

    blocks = [f[2] for f in blocks_found]
    if not all(isinstance(b, QuestionBlock) for b in blocks):
        raise EditError("all merge_questions targets must be questions")
    if any(b.source_rect is None for b in blocks):
        raise EditError("all merge_questions targets must have a source_rect")

    rects = [b.source_rect for b in blocks]
    page_no = rects[0].page
    if any(r.page != page_no for r in rects):
        raise EditError("merge_questions targets must come from the same PDF page")

    merged_rect = (
        min(r.x0 for r in rects),
        min(r.y0 for r in rects),
        max(r.x1 for r in rects),
        max(r.y1 for r in rects),
    )
    region = pdf_tools.Region(patch.new_id, page_no, merged_rect)
    crop = pdf_tools.slice_pdf(pdf_path, [region], crops_dir)[0]

    pi = blocks_found[0][0]
    indices = sorted(f[1] for f in blocks_found)
    merged_working_space = max(b.working_space.height_pt for b in blocks)
    new_block = QuestionBlock(
        id=patch.new_id,
        crop=crop.image_path,
        source_rect=blocks[0].source_rect.model_copy(
            update={"x0": merged_rect[0], "y0": merged_rect[1], "x1": merged_rect[2], "y1": merged_rect[3]}
        ),
        working_space=blocks[0].working_space.model_copy(update={"height_pt": merged_working_space}),
    )

    for i in sorted(indices, reverse=True):
        workbook.pages[pi].blocks.pop(i)
    workbook.pages[pi].blocks.insert(indices[0], new_block)
    return workbook
