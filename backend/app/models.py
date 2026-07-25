"""The workbook.json data model - the single source of truth for a project.

The preview renderer, the export step, and the AI edit loop all read and
write this same structure; there is no separate editor-only state.
"""
from __future__ import annotations

from typing import Literal, Union

from pydantic import BaseModel, Field


class SourceRect(BaseModel):
    """Where a crop came from in the original PDF, in PDF points. Kept
    around after cropping so a region can be re-cropped (tighter, looser,
    at a different DPI) without re-uploading the source PDF."""

    page: int
    x0: float
    y0: float
    x1: float
    y1: float


class WorkingSpace(BaseModel):
    height_pt: float = Field(alias="heightPt")
    estimated_by: Literal["heuristic", "ai", "manual"] = Field(alias="estimatedBy")

    model_config = {"populate_by_name": True}


class HeadingBlock(BaseModel):
    type: Literal["heading"] = "heading"
    id: str
    text: str


class ImageBlock(BaseModel):
    """A standalone image with no working space - key ideas, worked
    examples, shared context diagrams."""

    type: Literal["image"] = "image"
    id: str
    crop: str
    source_rect: SourceRect | None = Field(default=None, alias="sourceRect")

    model_config = {"populate_by_name": True}


class QuestionBlock(BaseModel):
    type: Literal["question"] = "question"
    id: str
    crop: str
    source_rect: SourceRect | None = Field(default=None, alias="sourceRect")
    context_image: str | None = Field(default=None, alias="contextImage")
    working_space: WorkingSpace = Field(alias="workingSpace")

    model_config = {"populate_by_name": True}


Block = Union[HeadingBlock, ImageBlock, QuestionBlock]


class Page(BaseModel):
    id: str
    blocks: list[Block]


class Workbook(BaseModel):
    id: str
    title: str
    source_pdf: str = Field(alias="sourcePdf")
    pages: list[Page]

    model_config = {"populate_by_name": True}

    def all_question_ids(self) -> list[str]:
        return [
            b.id
            for page in self.pages
            for b in page.blocks
            if isinstance(b, QuestionBlock)
        ]

    def find_block(self, block_id: str) -> tuple[int, int, Block] | None:
        """Returns (page_index, block_index, block) for the first block
        with this id, or None."""
        for pi, page in enumerate(self.pages):
            for bi, block in enumerate(page.blocks):
                if block.id == block_id:
                    return pi, bi, block
        return None
