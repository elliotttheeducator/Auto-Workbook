from app import pdf_tools


def test_page_count(synthetic_pdf):
    assert pdf_tools.page_count(synthetic_pdf) == 1


def test_render_pages(synthetic_pdf, tmp_path):
    out_dir = tmp_path / "renders"
    out_dir.mkdir()
    paths = pdf_tools.render_pages(synthetic_pdf, str(out_dir))
    assert len(paths) == 1
    assert (out_dir / "page0.png").exists()


def test_dump_text_blocks_finds_both_questions(synthetic_pdf):
    blocks = pdf_tools.dump_text_blocks(synthetic_pdf)
    texts = [b.text for b in blocks]
    assert any("2+2" in t for t in texts)
    assert any("3+3" in t for t in texts)
    assert all(b.page == 0 for b in blocks)


def test_slice_pdf_crops_and_extracts_text(synthetic_pdf, tmp_path):
    out_dir = tmp_path / "crops"
    out_dir.mkdir()
    regions = [pdf_tools.Region("q1a", 0, (30, 80, 300, 150))]
    results = pdf_tools.slice_pdf(synthetic_pdf, regions, str(out_dir))
    assert len(results) == 1
    result = results[0]
    assert result.name == "q1a"
    assert (out_dir / "q1a.png").exists()
    assert "2+2" in result.text
    assert result.width > 0 and result.height > 0
