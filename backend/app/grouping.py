"""Derives a question's sub-part group from its id, e.g. "ex1a"/"ex1b" both
belong to group "ex1"; "ex8" (no trailing letter) is its own singleton group.
Matches the naming convention already used by the sibling tutoring project's
manifests (`<parentid><letter>`).

Grouping is inferred, never stored - a question's group follows purely from
its id, so renaming is out of scope (ids are stable once detected).
"""
from __future__ import annotations

import re

from .models import Block, Page, QuestionBlock

_GROUP_RE = re.compile(r"^(.*\d)([a-z])$")


def group_id_for(question_id: str) -> str:
    match = _GROUP_RE.match(question_id)
    return match.group(1) if match else question_id


def question_groups(page: Page) -> list[list[QuestionBlock]]:
    """Consecutive QuestionBlocks on a page, chunked by shared group id.
    Order-preserving; a group's members must be contiguous in the page's
    block list (true for anything produced by detection or import, since
    sub-parts are always added in sequence)."""
    return [blocks for kind, blocks in iter_render_units(page) if kind == "group"]


def iter_render_units(page: Page) -> list[tuple[str, list[Block]]]:
    """Walks a page's blocks in order, yielding ("single", [block]) for
    headings/images and ("group", [question_blocks...]) for a run of
    QuestionBlocks sharing a group id - so a renderer can lay out headings
    and grouped questions in their original order without losing either."""
    units: list[tuple[str, list[Block]]] = []
    current_group_id: str | None = None
    for block in page.blocks:
        if not isinstance(block, QuestionBlock):
            units.append(("single", [block]))
            current_group_id = None
            continue
        gid = group_id_for(block.id)
        if gid == current_group_id and units and units[-1][0] == "group":
            units[-1][1].append(block)
        else:
            units.append(("group", [block]))
            current_group_id = gid
    return units
