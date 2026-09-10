#!/usr/bin/env python3
"""Builds a publishable page from the shared skeleton and one content file.

The point of the split is cost. The skeleton is the engine and runs to
hundreds of lines; the content is a small JSON document. Keeping them
apart means adding a chapter never involves opening the engine - which
is what a chat would otherwise have to read, in full, every time.

    python3 tools/builder/build.py workbook
    python3 tools/builder/build.py test
    python3 tools/builder/build.py all

Writes tools/builder/dist/<name>.html, ready to hand to the Artifact
tool. See CLAUDE.md in this directory for the publish step.
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKELETON = HERE / "skeleton.html"
CONTENT = HERE / "content"
DIST = HERE / "dist"

# The tab/gallery name for each build. Kept here rather than in the
# content file so a title can never drift from the artifact it names.
TITLES = {
    "workbook": "Chalkline Workbooks",
    "test": "Chalkline Test Papers",
}


def build(name: str) -> Path:
    """Two routes in. A `<name>.paper` file is the short one: the paper
    written as text, compiled by the page itself so there is only ever
    one parser. A `<name>.json` file is the long one, for a document the
    text format cannot express."""
    paper = CONTENT / f"{name}.paper"
    if paper.exists():
        base_path = CONTENT / f"{name}.base.json"
        if not base_path.exists():
            raise SystemExit(f"{paper.name} needs {base_path.name} beside it "
                             f"(mode, crest, rubric, answer-space defaults)")
        try:
            doc = json.loads(base_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise SystemExit(f"{base_path.name} is not valid JSON: {e}")
        text = paper.read_text(encoding="utf-8")
        doc["paperText"] = text
        check_paper(text, paper.name)
        check_base(doc, base_path.name)
        src = paper
    else:
        src = CONTENT / f"{name}.json"
        if not src.exists():
            raise SystemExit(f"no {name}.paper or {name}.json in {CONTENT}")
        try:
            doc = json.loads(src.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise SystemExit(f"{src.name} is not valid JSON: {e}")
        check(doc, src.name)

    html = SKELETON.read_text(encoding="utf-8")
    for token, value in (
        # separators=... keeps the inlined document compact; the source
        # file stays indented and reviewable.
        ("__CONTENT__", json.dumps(doc, ensure_ascii=False, separators=(",", ":"))),
        ("__TITLE__", TITLES.get(name, doc.get("title", "Builder"))),
    ):
        if token not in html:
            raise SystemExit(f"skeleton.html has no {token} placeholder")
        html = html.replace(token, value)

    DIST.mkdir(exist_ok=True)
    out = DIST / f"{name}.html"
    out.write_text(html, encoding="utf-8")
    qs = (len(re.findall(r"(?m)^Q\b", doc["paperText"])) if "paperText" in doc
          else sum(len(s["questions"])
                   for t in doc["textbooks"] for c in t["chapters"] for s in c["sections"]))
    print(f"{out.relative_to(HERE.parent.parent)}  from {src.name}  "
          f"{qs} questions, {len(html) // 1024} KB")
    return out


def check_paper(text: str, where: str) -> None:
    """The paper format fails quietly when it fails: a mistyped keyword
    is simply ignored, and the line it was carrying never reaches the
    page. Better to say so here than to leave someone hunting for a
    question that silently vanished."""
    if not re.search(r"(?m)^Q\b", text):
        raise SystemExit(f"{where}: no questions - every question starts with a line beginning \"Q\"")
    known = {"title", "paper", "year", "time", "class", "footer",
             "describe", "covers", "rule", "section"}
    for i, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([a-zA-Z]{2,})\s*:\s*", line)
        if m and m.group(1).lower() not in known and not re.match(r"^(Q|fig|note)\b", line):
            raise SystemExit(f"{where} line {i}: unknown keyword {m.group(1)!r} - "
                             f"expected one of {', '.join(sorted(known))}")
    bands = set(re.findall(r"\[([A-Za-z])\]", text))
    odd = {b for b in bands if b.upper() not in set("ABCDE")}
    if odd:
        raise SystemExit(f"{where}: {sorted(odd)} is not an achievement band (A-E)")


def check_base(doc: dict, where: str) -> None:
    if doc.get("mode") not in ("workbook", "test"):
        raise SystemExit(f"{where}: mode must be \"workbook\" or \"test\"")


def check(doc: dict, where: str) -> None:
    """Catches the mistakes that would otherwise only show up as a blank
    page after publishing, when the fix costs a whole round trip."""
    if doc.get("mode") not in ("workbook", "test"):
        raise SystemExit(f"{where}: mode must be \"workbook\" or \"test\"")
    if not doc.get("textbooks"):
        raise SystemExit(f"{where}: needs at least one textbook")
    seen = set()
    for t in doc["textbooks"]:
        for c in t.get("chapters", []):
            for s in c.get("sections", []):
                for q in s.get("questions", []):
                    qid = q.get("id")
                    if not qid:
                        raise SystemExit(f"{where}: a question in {s.get('code')} has no id")
                    # Ids are how a chosen question is remembered, so a
                    # duplicate silently ties two questions together.
                    if qid in seen:
                        raise SystemExit(f"{where}: duplicate question id {qid!r}")
                    seen.add(qid)


if __name__ == "__main__":
    names = sys.argv[1:] or ["all"]
    if names == ["all"]:
        # A base file belongs to the .paper beside it, not to a build of
        # its own - globbing it produced a phantom "test.base" target.
        names = sorted({p.stem for p in CONTENT.glob("*.paper")}
                       | {p.stem for p in CONTENT.glob("*.json")
                          if not p.name.endswith(".base.json")})
    for n in names:
        build(n)
