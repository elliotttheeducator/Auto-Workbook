import fitz
import pytest


@pytest.fixture
def synthetic_pdf(tmp_path):
    """A minimal two-question single-page PDF, used everywhere so tests
    don't depend on any real (copyrighted) textbook content."""
    path = tmp_path / "synthetic.pdf"
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((40, 100), "Q1a. What is 2+2?")
    page.insert_text((40, 200), "Q1b. What is 3+3?")
    doc.save(str(path))
    doc.close()
    return str(path)
