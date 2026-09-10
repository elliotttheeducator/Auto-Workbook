# Chalkline builders — for a Claude chat

Two published tools that lay out printable maths sheets. **The tools do
the work.** Pagination, answer boxes, diagrams, the rubric's question
lists — all of that happens in the page. Your job is to write the paper,
which is plain text and short.

| Tool | URL |
| --- | --- |
| **Chalkline Workbooks** | https://claude.ai/code/artifact/4e4a2c95-7bbc-4db9-8c88-49e4da2207f4 |
| **Chalkline Test Papers** | https://claude.ai/code/artifact/f2e05b76-c747-49a8-89ec-305e9cb3ee2a |

**Do not read `skeleton.html`.** It is the engine, ~1200 lines, and
nothing in it changes to write a paper. Reading it is the expensive
mistake this whole layout exists to prevent.

## The fast path — no repo, no build, no publish

Write the paper in the format below and give it to the user. They open
the tool, drop it in the **Content console → Paper** box, press **Build**,
and print. That is the whole loop. Use it for any one-off paper.

## The paper format

```
title:  Year 7 Enrichment Mathematics
paper:  Measurement Test
year:   Year 7
time:   40 minutes
footer: Show all mathematical procedures.
describe: In-class test on measurement which will allow you to…
covers: Establish the formulas for area of rectangles and triangles.
rule:   You are allowed a calculator.
section: A — Short answer

Q This shape is drawn on a centimetre grid. Work out:
fig grid cols=7 rows=5 pts=1,1;5,1;5,3;3,3;3,4;1,4
a [C] (2) the perimeter
b [C] (2) the area

Q [B] (3) space=50 Marie's step length is 90 cm. How far in km
are 5000 steps?
```

- `Q` opens a question, a single letter opens a part.
- `[C]` is the achievement band. **Never write the rubric's question
  lists by hand** — tag questions and parts, and the "Grade / Question"
  column builds itself, so it cannot drift from the paper.
  Band the *part* when parts differ (`10a` B, `10b` A), else the question.
- `(4)` marks. A question with no marks of its own adds up its parts'.
- `space=50` answer-box height in mm · `cols=2` parts across.
- `note …` small print under the stem.
- A bare line continues the question or part above it.
- `#` starts a comment. An unknown `key:` is rejected by the build.

Header keys: `title paper year time class footer describe covers rule
section`. `covers` and `rule` repeat, one per line.

## Diagrams

Write the figure; don't ask for a picture. It draws from the dimensions
the question already states, so the diagram and the numbers cannot
disagree.

| `type` | fields |
| --- | --- |
| `rect` `square` | `w` `h` (or `side`) |
| `tri` | `b` `h`, `right=1` for a right angle at the left |
| `para` | `b` `h` |
| `circle` | `r` **or** `d` |
| `lshape` | `w` `h` `cutW` `cutH` |
| `prism` | `l` `w` `h` |
| `triprism` | `b` `h` `l` |
| `grid` | `cols` `rows` `pts=x,y;x,y;…` in grid squares |
| `sector` | `r` `angle` (degrees) |
| `houseprism` | `w` `h` `l` `rh` — prism with a triangular roof |

All take `unit=` (default cm), `side` to float it right of the text, and
`alt=` for screen readers. `fig` attaches to the part above it, or to the
question when no part is open.

A dimension may be a **letter instead of a number** — `fig triprism b=4
h=h l=6` labels the height `h` and draws it at a sensible size, which is
how you set "find the missing height".

There is no other shape type. If a question needs one, either describe
the extra detail in a `note` or say so — adding a type means editing the
engine (see below).

## Word

**Export .docx** is beside Print. Word is where these papers live, so the
export is a real .docx — cover, rubric table, questions, bordered answer
boxes and the diagrams as images — not a print-to-PDF. It is generated in
the page with no library, and handed over through the `downloads`
capability, which is the only way an artifact can give a viewer a file;
the button hides itself when that capability is not available.

If you change what the sheets contain, change `buildDocx()` to match, or
the two drift apart.

## Making it permanent

When the user wants a paper to be what the tool opens with:

1. Write it to `content/test.paper` (or `content/workbook.json`).
2. `python3 tools/builder/build.py test` — validates and writes `dist/`.
3. Republish to the **same URL**, which is what keeps their link working:
   ```
   Artifact(file_path="tools/builder/dist/test.html",
            url="https://claude.ai/code/artifact/f2e05b76-c747-49a8-89ec-305e9cb3ee2a")
   ```
   No `favicon` on a republish — the icon is how they find the tab.
4. Commit.

`content/test.base.json` holds what the paper text cannot say and rarely
changes: mode, the school crest as a data URI, the answer-space defaults,
and the A–E rubric descriptors. `workbook.json` is a full JSON document
because a workbook carries several textbooks and chapters at once; the
shape is in the file and it is small enough to read.

## Heavy lifting

Only these need `skeleton.html`, and only the named part of it:

- **a new diagram type** — `figureNode()`, add a branch
- **a new paper keyword** — `parsePaper()` and `HEAD_KEYS`
- **how sheets look** — the CSS at the top of the file
- **pagination** — `renderSheets()`

Both tools share the skeleton, so a change lands on both: rebuild and
republish each. Grep for the function name rather than reading the file.

## If the user pastes JSON or paper text back at you

The console's **Copy for Claude** hands back the paper text when there is
one, the full JSON otherwise. Write it to the matching file, build,
republish — that promotes what they did in the browser to the published
page. Until then their edits live in that one browser's `localStorage`.
