# Worksheet Builder

Turns a Cambridge textbook chapter PDF into an editable, print-ready student
workbook: upload a chapter, get an AI-proposed first-pass crop of every
question with an estimated working-space blank under each one, fix anything
wrong through natural-language edit commands, export a print-ready PDF.

Shares its PDF-cropping primitives (render pages, read text-block
coordinates, crop a region + pull its embedded text) with the sibling
[Textbook Q&A tutoring platform](https://github.com/elliotttheeducator/maths-textbook-question-hub),
but is otherwise a separate product with its own backend, data model, and
workflow - that project is a backend-less static site for classroom tutoring;
this one needs real project storage and an editable/export pipeline, which
the tutoring app deliberately has neither of.

## Status

First build of the core pipeline: upload → AI-assisted detection → structured
edits → print-ready PDF export. See `backend/README.md` for how to run it and
what's implemented so far.

## What's next

- Word (.docx) export
- NL command loop on top of the edit engine (the engine already accepts
  structured patches - `POST /projects/{id}/edit` - the AI-facing chat layer
  that turns "make this bigger" into one of those patches isn't built yet)
- Direct-manipulation editor UI (resize handles, drag-to-reorder) as a faster
  input path once real usage shows which edits are most common
