# Chalkline builders — how to edit them

Two published tools that build printable maths sheets. They share one
engine and differ only in their content file.

| Tool | Artifact URL |
| --- | --- |
| **Chalkline Workbooks** | https://claude.ai/code/artifact/4e4a2c95-7bbc-4db9-8c88-49e4da2207f4 |
| **Chalkline Test Papers** | https://claude.ai/code/artifact/f2e05b76-c747-49a8-89ec-305e9cb3ee2a |

## Read this before opening anything else

**Do not read `skeleton.html`.** It is the engine — hundreds of lines,
and nothing in it needs to change to add a textbook, a chapter or a
question. Reading it is the single most expensive mistake available
here, and it buys nothing.

Everything editable lives in two small JSON files:

```
tools/builder/content/workbook.json    ← Chalkline Workbooks
tools/builder/content/test.json        ← Chalkline Test Papers
```

## To change what a tool contains

1. Edit the relevant `content/*.json`. Use `Edit` with a unique anchor
   (a question `id`, a section `code`) rather than reading the whole
   file — the files are small, but a targeted edit is smaller still.
2. Build: `python3 tools/builder/build.py workbook` (or `test`, or `all`).
   It validates the JSON, refuses duplicate question ids, and writes
   `dist/<name>.html`.
3. Republish to the **same URL** — this is the step that keeps the link
   the user already has:

   ```
   Artifact(file_path="tools/builder/dist/workbook.html",
            url="https://claude.ai/code/artifact/4e4a2c95-7bbc-4db9-8c88-49e4da2207f4")
   ```

   Read the artifact first (`action: "read"` with that `url`) only if a
   publish is refused because this conversation has not read it; the
   refusal hands you the live version. Do not pass `favicon` on a
   republish — the icon is how the user finds the tab.

4. Commit the JSON change. `dist/` is committed too, so the published
   page is always reproducible from the repo.

## Content shape

```jsonc
{
  "id": "workbook",              // storage key; do not change once published
  "mode": "workbook" | "test",   // test mode adds marks, a total and a name bar
  "title": "Chalkline Workbooks",
  "heading": "Measurement — Circles and area",   // prints at the top of sheet 1
  "meta1": "7B",                 // workbook: class. test: time allowed
  "meta2": "Year 7",
  "footer": "…",                 // foot of every sheet
  "space": { "style": "grid|rule|plain|none", "mm": 30,
             "perPart": true, "byMarks": false },
  "current": { "textbook": "y7-essential", "chapter": "ch10" },
  "textbooks": [{
    "id": "y7-essential", "title": "Essential Mathematics Year 7",
    "chapters": [{
      "id": "ch10", "title": "Chapter 10 — Measurement",
      "sections": [{
        "id": "s10c", "code": "10C", "title": "Circles, π and circumference",
        "questions": [{
          "id": "s10c-q3",        // must be unique across the whole file
          "n": 3,                  // the number that prints
          "tier": "fluency|problem|reasoning|enrichment",
          "marks": 4,              // test mode only
          "stem": "Calculate the circumference of these circles…",
          "note": "optional small print under the stem",
          "columns": 2,            // optional; otherwise chosen from part length
          "spaceMm": 35,           // optional; overrides the global height
          "parts": [{ "letter": "a", "text": "d = 5 cm", "marks": 1 }]
        }]
      }]
    }]
  }]
}
```

A question with no `parts` always gets its own answer box. With parts,
`space.perPart` decides whether each part gets one or they share a box
underneath.

## Adding a whole chapter

Append a chapter object to the right textbook's `chapters` array. Give
every question an id that starts with the section id (`s10c-q3`) so ids
stay unique without having to check the rest of the file.

## If the user hands you JSON from the page

The tool's **Content console** has a *Copy for Claude* button. That text
is the whole content document, including anything they changed in the
browser. Write it straight to the matching `content/*.json`, build, and
republish — that promotes their local edits to the published page for
everyone.

Their in-page edits live in `localStorage` only. Until you publish them,
they exist on that one browser.

## Changing how the sheets look

Only then does `skeleton.html` come into it — CSS at the top, engine
below, one `__CONTENT__` placeholder that `build.py` fills. Both tools
share it, so a change lands on both; rebuild and republish each.
