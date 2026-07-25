from app.working_space import estimate_by_tier


def test_known_tiers_increase_with_difficulty():
    order = ["warmup", "fluency", "problem-solving", "reasoning", "enrichment"]
    heights = [estimate_by_tier(t) for t in order]
    assert heights == sorted(heights)


def test_unknown_tier_falls_back_to_default():
    from app.working_space import DEFAULT_HEIGHT_PT

    assert estimate_by_tier("mystery-tier") == DEFAULT_HEIGHT_PT
