"""Heuristic working-space estimate, used wherever a richer signal (the AI
detector's own per-question estimate, or a teacher's manual resize) isn't
available - e.g. importing questions that only carry a difficulty tier, not
a full worked assessment of what the question needs.

Deliberately coarse: this is a fallback default, not a replacement for the
AI detector's per-question estimate in detection.py.
"""
from __future__ import annotations

TIER_HEIGHT_PT = {
    "warmup": 50.0,
    "fluency": 70.0,
    "problem-solving": 110.0,
    "reasoning": 140.0,
    "enrichment": 140.0,
}
DEFAULT_HEIGHT_PT = 80.0

# The editor's Small/Medium/Large picker - a coarser, teacher-facing version
# of the same idea as TIER_HEIGHT_PT above.
SIZE_PRESETS_PT = {
    "small": 50.0,
    "medium": 90.0,
    "large": 150.0,
}


def estimate_by_tier(tier: str) -> float:
    return TIER_HEIGHT_PT.get(tier, DEFAULT_HEIGHT_PT)


def nearest_size_preset(height_pt: float) -> str:
    """Which S/M/L bucket a height is closest to - used to give the picker
    a sensible default selection for AI-estimated heights that don't
    exactly match a preset."""
    return min(SIZE_PRESETS_PT, key=lambda size: abs(SIZE_PRESETS_PT[size] - height_pt))
