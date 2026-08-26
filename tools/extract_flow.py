"""Extracts a chapter as *flowing text* rather than as page-region bitmaps.

This is the second-generation pipeline, sitting alongside add_chapter.py
rather than replacing it. add_chapter.py crops every question as one
bitmap fusing its text and its diagram; that forces a single scale
factor onto both, and text and diagrams want opposite scaling laws:

  - text has an ABSOLUTE size requirement (10pt is 10pt or it can't be
    read), and can reflow to fit a narrow column;
  - a diagram has a RELATIVE one (scale to whatever space exists), and
    cannot reflow at all.

Fused into one bitmap, the text is forced to obey the diagram's law, so
narrowing a column can only shrink the text - measured at 2.2pt for a
full-width question dropped into a 2-split. The same rigidity wastes
paper: an aspect-locked bitmap can't be broken across a gap, so pages
end ~23% empty.

So this tool separates them at extraction time:

  - question boundaries come from the book's own structure, not from
    hand-tuned coordinates. This series tags every question number in a
    dedicated font (QNUM_FONT) in a fixed left gutter, so segmentation
    is exact rather than eyeballed - which is what removes both the 241
    hand-written rects a chapter like this used to need and the entire
    class of clipping/bleed/dissection bugs that came with them.
  - body prose becomes real text, rendered later at one fixed size
    everywhere, so "different sized writing" stops being possible by
    construction.
  - figures keep their exact PDF bbox (get_drawings/get_image_info
    report it precisely - no guessing) and stay bitmaps, free to scale
    independently of the text beside them.

Math is the one genuinely hard part, and it gets a graded response
rather than one blanket rule (see classify_char):

  - a symbol that is really just a character (pi, times, degree) maps to
    its Unicode equivalent and stays text;
  - italic variables stay text, marked italic;
  - only glyphs with real TWO-DIMENSIONAL layout - superscripts,
    subscripts, stacked fractions - are cropped, as small inline images
    spliced back into the text flow at the line's own height. That keeps
    perfect fidelity for the cases a text pipeline would mangle, while
    leaving everything around them reflowable.

Output is a flow document (see build_flow_document) consumed by the
"flowquestion" branch in the renderer. Anything this tool cannot parse
confidently is reported, never silently guessed - a chapter is meant to
fall back to the bitmap pipeline per question rather than ship wrong.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import uuid

import fitz  # PyMuPDF
from PIL import Image

# Rendering zoom for the small inline math / figure crops. Matches
# add_chapter.py's CROP_ZOOM so both pipelines produce comparable
# pixel density (~216 DPI) and can be mixed on one page.
CROP_ZOOM = 3

# --- structural fingerprints of this publisher's layout -------------
# Measured from the source PDFs, not assumed. A different series would
# need these re-measured; everything else in this file is generic.
# These are PREFIXES, deliberately cut to 15 characters, and they are
# compared with startswith rather than equality. Some exports subset
# their fonts and truncate the name to 16 bytes, so the same Times
# Roman arrives as "TimesLTStd-Roma" in one file and
# "TimesLTStd-Roman" in another. Fifteen characters is the longest
# prefix that survives both, and it still tells Roman from Italic.
BODY_FONT = "TimesLTStd-Roma"
ITALIC_FONT = "TimesLTStd-Ital"
BODY_SIZE = 10.0
# Question numbers ("6", "12") are set in their own rounded-bold face,
# always in the left gutter - this pair is what makes segmentation exact.
QNUM_FONT = "HelveticaRounde"
QNUM_X = (52.0, 68.0)
# The same face is reused at 6pt for margin cross-reference tags
# ("Example 5"), so a size floor is what separates a real question
# number from one of those - see is_qnum.
QNUM_MIN_SIZE = 8.0
# Part letters ("a", "b") sit just inside the question number's gutter.
PART_X = (66.0, 82.0)
# Tier bands ("FLUENCY", "PROBLEM-SOLVING") are set in condensed bold
# caps. The weight is not part of the test because truncation can take
# it off the name; tier_of only accepts a band whose TEXT is one of the
# four known tier names, which is what keeps this loose prefix safe.
TIER_FONT_PREFIX = "HelveticaLTStd"

# A char is off the line's baseline by more than this => it is a super-
# or subscript, i.e. real 2D layout that has to be cropped rather than
# flowed. Well under a full line's leading, comfortably over the
# sub-pixel jitter between glyphs that share a baseline.
BASELINE_TOL_PT = 1.6
# Same idea for point size: a superscript here measures 5.2pt against a
# 8-10pt body, so anything off by more than this is not body text.
SIZE_TOL_PT = 0.8
# Horizontal gap at which two math glyphs stop being one run. Roughly a
# space at body size - wider than the sub-point gaps inside a fraction,
# narrower than the gap back to surrounding prose.
MATH_RUN_GAP_PT = 3.0
# Smallest thing that can be a diagram, judged on its SHORT side and
# its area rather than on width and height separately. Triangles here
# come in every proportion - one is 47 x 16pt and another 14 x 40pt -
# so a floor on each axis drops whichever ones happen to be thin that
# way round, leaving the question a diagram short and its labels loose
# in the prose. The area floor is what still rejects stray marks: an
# arrowhead is 7 x 7, a tick is 3 x 1.
MIN_FIG_SIDE = 11.0
MIN_FIG_AREA = 250.0


def too_small(r):
    return min(r.width, r.height) < MIN_FIG_SIDE or r.get_area() < MIN_FIG_AREA

# Two text lines this close together are one row of the page, printed
# with a little stagger, not two separate lines.
LINE_ROW_TOL_PT = 4.0

# Symbols that are only "math" in the sense of being a character the
# body face lacks - there is no 2D layout to preserve, so they stay
# text (and stay reflowable) instead of becoming images.
SYMBOL_TEXT = {
    "p": "π",  # SymbolStd maps pi onto 'p'
    "π": "π",
    "×": "×",
    "÷": "÷",
    "°": "°",
    "≈": "≈",
    "≠": "≠",
    "≤": "≤",
    "≥": "≥",
    "√": "√",
    "−": "−",
}

# Zero-width marks the typesetter injects as math-run boundaries. They
# carry no width and no meaning once a line is reflowed, so they are
# dropped outright.
ZERO_WIDTH = "\u200b\ufeff"
# Narrow/thin spaces are the opposite case: they are REAL spaces. This
# book sets "40 cm" with a four-per-em space between value and unit, so
# discarding them (rather than normalising them to an ordinary space)
# silently welds the words into "40cm" everywhere in the chapter.
THIN_SPACE = "\u2005\u202f\u2009\u200a"


def mm(pt: float) -> float:
    return pt * 25.4 / 72.0


# Glyphs the exporter moved into the Unicode private-use area, where a
# codepoint carries no meaning of its own. What each one means depends
# on the FONT it is set in - E01F is the "fi" ligature in the body face
# and the letter theta in the math face - so the table is keyed by both.
# Identified by rendering each glyph and reading it, not by guessing:
# left unmapped they reach the page as tofu, and the chapter fills with
# "nd the ratio" and "a vertical ag pole".
PUA_GLYPHS = {
    ("TimesLTStd-Roma", 0xE01C): "fl",
    ("TimesLTStd-Roma", 0xE01F): "fi",
    ("STIXGeneral-Reg", 0xE009): "α",
    ("STIXGeneral-Reg", 0xE00A): "θ",
    ("STIXGeneral-Reg", 0xE00F): "θ",
    ("STIXGeneral-Ita", 0xE01E): "α",
    ("STIXGeneral-Ita", 0xE01F): "θ",
    ("STIXGeneral-Bol", 0xE01F): "θ",
}
# Every private-use codepoint met that the table does not cover, as
# {(font, codepoint): count}. Reported at the end of a build: an
# unmapped one is silent corruption of the prose, so it must be seen
# and added rather than shipped.
UNMAPPED_PUA = {}

# Every dimension label the prose gave up as belonging to a drawing that
# no crop turned out to contain, as "p4 q1: '4'". A lost label is a side
# length missing from a diagram a student has to answer from, and it is
# invisible in the output - the crop just looks like a triangle with one
# fewer number on it - so it is reported at the end of a build the same
# way an unmapped glyph is.
LOST_LABELS = []


def decode_pua(font, ch):
    """Maps one private-use glyph to the text it actually shows."""
    if not ("" <= ch <= ""):
        return ch
    key = (font[:15], ord(ch))
    if key in PUA_GLYPHS:
        return PUA_GLYPHS[key]
    UNMAPPED_PUA[key] = UNMAPPED_PUA.get(key, 0) + 1
    return ch


def drop_filler_spaces(chars):
    """Removes the padding spaces the typesetter puts inside ligatures.

    An "fi" ligature is set as one glyph followed by a space that
    occupies no new ground - its box sits INSIDE the ligature's own -
    which is the typesetter balancing the glyph's advance, not a word
    break. Kept, it splits the word: the chapter read "fi nd the ratio"
    and "a vertical fl ag pole".

    A real space starts where the glyph before it ends, so overlap is
    what separates the two - not the character, and not the font."""
    out = []
    for c in chars:
        if not c["c"].strip() and out:
            pb, cb = out[-1]["bbox"], c["bbox"]
            width = cb[2] - cb[0]
            overlap = min(pb[2], cb[2]) - max(pb[0], cb[0])
            if width > 0 and overlap > 0.5 * width:
                continue
        out.append(c)
    return out


def norm_font(name):
    """The font's real name, with any subset tag removed.

    A subsetted font is named "ABCDEF+Times", and some exporters mangle
    the "+" into stray bytes rather than dropping it. Either way the
    tag is per-file noise - the SAME face arrives under a different
    six-letter tag in every export - so matching on the raw name makes
    the layout fingerprints below file-specific. Stripping it here, at
    the one place spans are built, keeps every downstream test working
    on whichever export the chapter came from."""
    m = re.match(r"^[A-Z]{6}[^A-Za-z0-9]+(.+)$", name)
    return m.group(1) if m else name


class Span:
    """One run of characters sharing a font/size, with per-char boxes."""

    def __init__(self, raw):
        self.font = norm_font(raw["font"])
        self.size = raw["size"]
        self.chars = [c for c in raw["chars"] if c["c"] not in ZERO_WIDTH]
        for c in self.chars:
            c["c"] = decode_pua(self.font, c["c"])
        self.chars = drop_filler_spaces(self.chars)


def page_lines(page: fitz.Page):
    """Every text line on the page as (bbox, [Span]), reading order."""
    out = []
    for block in page.get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            spans = [Span(s) for s in line["spans"]]
            spans = [s for s in spans if s.chars]
            if spans:
                out.append((fitz.Rect(line["bbox"]), spans))
    # Reading order, which is by ROW and then left to right - not by
    # raw y. A marker and the prose it introduces are set on the same
    # line but not at identical y ("b i" at 504.7 carrying text whose
    # own box starts at 504.1), so a plain y sort puts the sentence
    # before the marker that opens it and the part is built from the
    # wrong text. Body leading here is ~14pt, so a few points of
    # stagger cannot be a genuinely different line.
    out.sort(key=lambda t: t[0].y0)
    # A row ends where the gap to the NEXT line exceeds the tolerance,
    # not where the distance from the row's first line does. Measuring
    # from the first line lets one stray spacer set the anchor and then
    # cut the row a couple of points early - which put a part's marker
    # after its own text, so the text joined the part before it. Body
    # leading here is ~14pt, so consecutive lines a few points apart
    # are always one row.
    rows, top, prev = [], None, None
    for bbox, _spans in out:
        if prev is None or bbox.y0 - prev > LINE_ROW_TOL_PT:
            top = bbox.y0
        prev = bbox.y0
        rows.append(top)
    order = sorted(range(len(out)), key=lambda i: (rows[i], out[i][0].x0))
    return [out[i] for i in order]


def baseline_of(spans) -> float:
    """The line's dominant baseline, taken from glyph ORIGINS rather than
    bounding boxes. This distinction matters more than it looks: a
    decimal point set in STIXGeneral has a bbox whose bottom sits 2.4pt
    below the baseline (the face reports a descender-inclusive box), so
    a bbox-based test reads "1.4" as having a dropped glyph and crops
    the point out into an image. Origins are the true typesetting
    baseline and are font-independent, so they separate a real subscript
    from a font's idiosyncratic metrics."""
    tally = {}
    for s in spans:
        for c in s.chars:
            key = round(c["origin"][1], 1)
            tally[key] = tally.get(key, 0) + 1
    return max(tally, key=tally.get) if tally else 0.0


def body_size_of(spans) -> float:
    """The line's dominant point size, by character count.

    Not the largest size on the line. A line often ends with a stray
    space span set a point larger than the text it follows, and taking
    the maximum let that one invisible character redefine what "body
    size" meant for the whole line - every real glyph then measured as
    the wrong size, so an ordinary "cos 75 =" was cropped into images
    word by word instead of staying editable text."""
    tally = {}
    for s in spans:
        n = sum(1 for c in s.chars if c["c"].strip())
        if n:
            tally[round(s.size, 1)] = tally.get(round(s.size, 1), 0) + n
    return max(tally, key=tally.get) if tally else BODY_SIZE


# Superscripts and subscripts that Unicode can write directly. Cropping
# these as images is technically faithful and practically worse: a 2mm
# bitmap of a "2" prints softer than the type around it, ignores the
# text-size control, and carries whatever specks sat next to it in the
# source. Only the characters that actually appear raised or lowered in
# maths of this kind are listed - anything else still becomes a crop.
SUPERSCRIPT = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "-": "⁻", "−": "⁻", "+": "⁺", "(": "⁽", ")": "⁾",
    "n": "ⁿ",
}
SUBSCRIPT = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
    "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
}


def classify_char(c, span, baseline, body_size):
    """text | italic | symbol | crop - see the module docstring for why
    only the last of these has to leave the text flow.

    Only genuine two-dimensional layout is cropped. Font alone never
    forces a crop: a symbol face is usually just supplying a character
    the body face lacks, and cropping on that basis turns ordinary
    "C = pi d" into a row of disconnected images."""
    ch = c["c"]
    # Whitespace is never 2D layout, whatever baseline it sits on. The
    # typesetter puts narrow no-break spaces *inside* math runs, so they
    # carry the math baseline and would otherwise be cropped as their
    # own images - producing a stray sliver of the fraction bar between
    # the fraction and the words after it.
    if not ch.strip():
        return "text"
    off_baseline = abs(c["origin"][1] - baseline) > BASELINE_TOL_PT
    wrong_size = abs(span.size - body_size) > SIZE_TOL_PT
    # Real 2D layout: a raised/dropped glyph, or one set noticeably
    # smaller than its line - superscripts, subscripts, and the halves
    # of a stacked fraction all land here.
    if off_baseline or wrong_size:
        # A raised or lowered character that Unicode can write is
        # written, not photographed - see SUPERSCRIPT. It has to be
        # genuinely off the line, not merely a size outlier, or an
        # ordinary digit would be turned into an exponent.
        dy = c["origin"][1] - baseline
        if dy < -BASELINE_TOL_PT and ch in SUPERSCRIPT:
            return "super"
        if dy > BASELINE_TOL_PT and ch in SUBSCRIPT:
            return "under"
        return "crop"
    if span.font.startswith("Symbol"):
        # This face remaps the Latin alphabet onto Greek, so its bytes
        # are meaningless without translation - anything not in the
        # table genuinely cannot be reproduced as text.
        return "symbol" if ch in SYMBOL_TEXT else "crop"
    if span.font.startswith(ITALIC_FONT):
        return "italic"
    return "text"


def find_fractions(lines):
    """Locates stacked fractions across a question's lines.

    These cannot be found line by line, because the typesetter does not
    keep one in a single line: the rule is an oversized '_' on a short
    line of its own, the numerator is raised into the line above, and
    the denominator is dropped into the line *below* - where ordinary
    prose then continues on the same line ("pi . Use this rearranged
    rule to calculate..."). Handled per line, the three pieces come out
    as unrelated fragments, which is precisely how naive extraction
    turns C/pi into disconnected images.

    So the bar is found first, then everything vertically stacked within
    its horizontal span is pulled into one box - the whole fraction, to
    be cropped once as a single inline image.

    A bar is recognised by what is STACKED ON IT, not by how big it is.
    Size looked like the discriminator - one book sets its rules
    oversized - but another sets them at body size, and there the test
    found no fractions at all and every one came out as three loose
    fragments. Requiring something directly above AND directly below is
    what a fraction actually is, and it still rejects the other thing
    underscores are used for here: the fill-in-the-blank rules in
    "H stands for the word ______", which have neither."""
    bars = []
    for _bbox, spans in lines:
        for s in spans:
            for c in s.chars:
                if c["c"] == "_":
                    bars.append((fitz.Rect(c["bbox"]), c["origin"][1]))

    boxes = []
    for bar, bar_origin in bars:
        box = fitz.Rect(bar)
        above = below = False
        for _bbox, spans in lines:
            for s in spans:
                for c in s.chars:
                    if not c["c"].strip():
                        continue
                    cb = fitz.Rect(c["bbox"])
                    # Membership is decided on the glyph's CENTRE against
                    # the bar's width, not on box overlap: a numerator's
                    # box overlaps the bar's vertically (they are only
                    # ~2pt apart and both ~10pt tall), while the prose
                    # that continues along the denominator's line starts
                    # just past the bar's right edge. Centre-in-span is
                    # what separates those two cases.
                    cx = 0.5 * (cb.x0 + cb.x1)
                    if not (bar.x0 <= cx <= bar.x1):
                        continue
                    # ...and within a line's reach vertically, measured
                    # origin-to-origin so a raised numerator and a
                    # dropped denominator both register.
                    if abs(c["origin"][1] - bar_origin) <= 10.0:
                        # Which side of the rule a glyph is on: its own
                        # CENTRE against the rule's BASELINE. Both
                        # halves of that matter. Comparing baselines
                        # alone fails because the numerator's origin
                        # sits under a point above the bar's; comparing
                        # the bar's box centre fails because an
                        # underscore's box is nearly a full em tall, so
                        # its centre lands above the rule it draws.
                        # Underscores are skipped - a rule is never the
                        # numerator or denominator of another rule.
                        ccy = 0.5 * (cb.y0 + cb.y1)
                        if c["c"] != "_":
                            if ccy < bar_origin - 1.0:
                                above = True
                            elif ccy > bar_origin + 1.0:
                                below = True
                        box |= cb
        if above and below:
            boxes.append(box)
    return boxes


def build_runs(spans, baseline, body_size, frac_boxes=(), emitted=None):
    """Splits one line into a stream of runs: reflowable text/italic, and
    'crop' runs (contiguous 2D-layout glyphs) that keep their bbox so the
    caller can render them as inline images.

    `frac_boxes`/`emitted` carry the cross-line fraction state from
    find_fractions: any glyph falling inside a fraction box is replaced
    by that whole fraction, emitted once at the position of its first
    glyph and suppressed everywhere after."""
    if emitted is None:
        emitted = set()
    atoms = []
    for s in spans:
        for c in s.chars:
            cb = fitz.Rect(c["bbox"])
            hit = next((i for i, fb in enumerate(frac_boxes) if fb.contains(cb) or (fb & cb).get_area() > 0.5 * cb.get_area()), None)
            if hit is not None:
                if hit in emitted:
                    continue
                emitted.add(hit)
                atoms.append({"kind": "crop", "c": "", "bbox": fitz.Rect(frac_boxes[hit])})
                continue
            kind = classify_char(c, s, baseline, body_size)
            ch = c["c"]
            if kind == "symbol":
                ch = SYMBOL_TEXT.get(ch, ch)
            elif kind == "super":
                ch = SUPERSCRIPT[ch]
            elif kind == "under":
                ch = SUBSCRIPT[ch]
            if ch in THIN_SPACE:
                ch = " "
            flow = kind in ("symbol", "super", "under")
            atoms.append({"kind": "text" if flow else kind, "c": ch, "bbox": fitz.Rect(c["bbox"])})
    if not atoms:
        return []

    runs = []
    for a in atoms:
        # A crop atom joins the previous crop run only if it is close
        # enough horizontally to be part of the same expression - a
        # fraction's numerator and denominator are within a point or
        # two of each other, a superscript on the next word is not.
        if runs and runs[-1]["kind"] == a["kind"] == "crop" and a["bbox"].x0 - runs[-1]["bbox"].x1 <= MATH_RUN_GAP_PT:
            runs[-1]["bbox"] |= a["bbox"]
            continue
        if runs and runs[-1]["kind"] == a["kind"] != "crop":
            runs[-1]["text"] += a["c"]
            runs[-1]["bbox"] |= a["bbox"]
            continue
        runs.append({"kind": a["kind"], "text": a["c"], "bbox": fitz.Rect(a["bbox"])})
    return runs


def merge_stacked(runs, all_lines, line_bbox):
    """Grows each crop run to swallow anything stacked directly above or
    below it. A fraction is typeset as two separate 'lines' plus a rule
    between them, so without this the numerator and denominator would be
    cropped as unrelated fragments on different lines - which is exactly
    how naive extraction turns 22/7 into '28_' and '9'."""
    for r in runs:
        if r["kind"] != "crop":
            continue
        grown = True
        while grown:
            grown = False
            for lb, _ in all_lines:
                if lb == line_bbox:
                    continue
                # directly above or below, and horizontally overlapping
                vertical_gap = min(abs(lb.y0 - r["bbox"].y1), abs(r["bbox"].y0 - lb.y1))
                overlap = min(lb.x1, r["bbox"].x1) - max(lb.x0, r["bbox"].x0)
                if vertical_gap < 6 and overlap > 0.5 * min(lb.width, r["bbox"].width) and lb.width < 60:
                    new = fitz.Rect(r["bbox"]) | lb
                    if new != r["bbox"]:
                        r["bbox"] = new
                        grown = True
    return runs


# How far apart two paths can be and still be one drawing. Overlap
# alone is not enough: line art is drawn as separate strokes that MEET
# rather than cross, so a stick figure, the sight line from its eye and
# the monument it looks at (3I Q14) are three boxes that touch at their
# corners and share no area at all. Small enough that two diagrams in
# neighbouring cells - always tens of points apart - never join.
FIG_JOIN_PT = 6.0


def touching(a, b):
    """True if two paths belong to the same drawing."""
    inter = a & b
    if not inter.is_empty and inter.get_area() > 0.10 * min(a.get_area(), b.get_area()):
        return True
    dx = max(a.x0 - b.x1, b.x0 - a.x1, 0.0)
    dy = max(a.y0 - b.y1, b.y0 - a.y1, 0.0)
    return dx <= FIG_JOIN_PT and dy <= FIG_JOIN_PT


def page_figures(page: fitz.Page, y_floor: float):
    """Every real figure on the page, resolved ONCE for the whole page.

    Figures must be assigned globally rather than searched per question.
    Doing it per question compares each candidate against that one
    question's band by area overlap, which lets a tall drawing be
    claimed by a question it merely overlaps - observed as a 298pt
    figure starting 100pt above the band that claimed it, so a circle
    question rendered a neighbour's trapezium. Resolving the page first
    and then giving each figure to exactly one owner (see assign_figures)
    makes double- and mis-attribution impossible rather than unlikely."""
    raw = []
    for d in page.get_drawings():
        raw.append(fitz.Rect(d["rect"]))
    for i in page.get_image_info():
        raw.append(fitz.Rect(i["bbox"]))

    parts = []
    for r in raw:
        # Small paths are kept as merge candidates rather than dropped:
        # an angle arc, a tick, a right-angle square is 6pt across and
        # is part of the drawing it sits on. Dropped here they were
        # missing from the union, so the crop was cut through them -
        # that is what sliced the arc off the top of 3H Q6's ladder.
        # Anything that fails to merge into a real figure is discarded
        # by too_small() at the end.
        if r.width < 3 or r.height < 3:
            continue
        if r.y1 < y_floor:
            continue
        if r.x1 < QNUM_X[1]:  # left-margin icon or rule
            continue
        # Page furniture: full-width rules, panel borders, the tier band.
        if r.width > 0.80 * page.rect.width:
            continue
        parts.append(r)

    # One diagram is drawn as many paths, so they have to be unioned -
    # but only on genuine overlap, and never past the height a single
    # diagram plausibly occupies. Without the ceiling a chain of near
    # touches merges separate diagrams into one page-tall streak.
    MAX_FIG_H = 0.32 * page.rect.height
    merged = []
    for r in sorted(parts, key=lambda b: (b.y0, b.x0)):
        placed = False
        for m in merged:
            if not touching(m, r):
                continue
            grown = m | r
            if grown.height > MAX_FIG_H:
                continue
            m.x0, m.y0, m.x1, m.y1 = grown.x0, grown.y0, grown.x1, grown.y1
            placed = True
            break
        if not placed:
            merged.append(fitz.Rect(r))
    # Merging is order-dependent and one pass only joins a piece to a
    # box that already exists, so a drawing whose pieces arrive out of
    # order needs another sweep - the stick figure, the sight line and
    # the monument of 3I Q14 chain together, but only two at a time.
    changed = True
    while changed:
        changed = False
        for i, a in enumerate(merged):
            for b in merged[i + 1:]:
                if not touching(a, b):
                    continue
                grown = a | b
                if grown.height > MAX_FIG_H:
                    continue
                a.x0, a.y0, a.x1, a.y1 = grown.x0, grown.y0, grown.x1, grown.y1
                merged.remove(b)
                changed = True
                break
            if changed:
                break

    keep = []
    for r in merged:
        if too_small(r) or r.height > MAX_FIG_H:
            continue
        # Rules and coloured bands (an "Exercise 10C" underline measures
        # 427x24) are long, flat and never a diagram. Judged on aspect
        # rather than width alone, since a genuinely wide diagram is also
        # tall enough to keep its ratio reasonable.
        if r.width > 6.0 * r.height and r.height < 40:
            continue
        keep.append(r)
    return keep


def assign_figures(figs, bands):
    """Gives each figure to exactly one question: the band its TOP falls
    in. A figure that starts above every band (page furniture that
    survived the filters) is dropped rather than forced onto whichever
    question happens to be nearest.

    The top, not the centre. A diagram set in the right margin is
    routinely taller than the question that owns it - 10G's farmer's
    field is 91pt against a two-line question - so its middle lands in
    the question BELOW, which is where the centre rule sent it. The
    yacht question, which has no diagram of its own in the book, printed
    the bottom half of the farmer's triangle; the farmer's question
    printed the top half. A reader pairs a diagram with the text beside
    the point where it starts, and that is what this now does."""
    owned = {i: [] for i in range(len(bands))}
    for f in figs:
        for i, (y0, y1) in enumerate(bands):
            if y0 <= f.y0 < y1:
                owned[i].append(f)
                break
    return {i: reading_order(v) for i, v in owned.items()}


def reading_order(figs):
    """Sorts figures the way they are read: by visual row, then left to
    right within it.

    Sorting on raw y first looks equivalent but is not. Two diagrams
    printed side by side are never typeset at exactly the same y - here
    the right-hand one starts 0.94pt ABOVE its left-hand partner - so a
    plain (y, x) sort interleaves the columns and emits them b, a, d, c.
    Snapping to rows first is what makes the order match the labels."""
    if not figs:
        return []
    rows = []
    for f in sorted(figs, key=lambda r: r.y0):
        for row in rows:
            # same row if they overlap vertically by a real fraction of
            # their height - tolerant of the point or two of stagger,
            # intolerant of a genuinely separate row below
            top, bottom = row["top"], row["bottom"]
            overlap = min(bottom, f.y1) - max(top, f.y0)
            if overlap > 0.45 * min(bottom - top, f.height):
                row["items"].append(f)
                row["top"] = min(top, f.y0)
                row["bottom"] = max(bottom, f.y1)
                break
        else:
            rows.append({"top": f.y0, "bottom": f.y1, "items": [f]})
    out = []
    for row in rows:
        out.extend(sorted(row["items"], key=lambda r: r.x0))
    return out


def clip_to_question(f, region, lines, band_rows):
    """Cuts a figure back to its own question's region - but only as far
    as it has to.

    The clip is there so a diagram cannot take ink belonging to the
    question below it. Applied flat it does damage of its own: the book
    sets a diagram out in the right margin alongside a question whose
    text is two lines long, and such a drawing routinely hangs well past
    the last of that text. Cutting it at the question boundary took the
    bottom off 10H's notched rectangle and the top off 10G's field -
    each printed as a fragment with the measurements sheared away.

    Nothing is out there to steal, which is the test used here: the
    overhang is kept when no text and no tier banner lies across it.
    Text of its own - a dimension label hanging below the drawing - does
    not count, because that label is the figure's and absorb_labels is
    about to pull it in anyway."""
    clipped = f & region
    if clipped.is_empty or clipped == f:
        return clipped
    over = fitz.Rect(f.x0, f.y0, f.x1, f.y1)
    for y0, y1 in ((f.y0, region.y0), (region.y1, f.y1)):
        if y1 <= y0:
            continue
        for b0, b1 in band_rows:
            if b0 < y1 and b1 > y0:
                return clipped
        for bbox, spans in lines:
            if bbox.y1 <= y0 or bbox.y0 >= y1:
                continue
            if bbox.x1 <= over.x0 or bbox.x0 >= over.x1:
                continue
            text = "".join(c["c"] for s in spans for c in s.chars).strip()
            if len(text) > LABEL_MAX_CHARS:
                return clipped
    return over


def owned_figures(page: fitz.Page, region: fitz.Rect, text_right_edge: float):
    """Figures genuinely belonging to this question: substantial, and
    mostly *inside* its region rather than a section container passing
    through it (the orange Building Understanding panel spans whole
    sections and would otherwise be claimed by every question in one).
    Their bboxes come straight from the PDF, so unlike the hand-cropped
    pipeline there is nothing here to mis-measure."""
    out = []
    cands = [d["rect"] for d in page.get_drawings()]
    cands += [fitz.Rect(i["bbox"]) for i in page.get_image_info()]
    for r in cands:
        if too_small(r):
            continue
        inter = r & region
        if inter.is_empty:
            continue
        if (inter.get_area() / r.get_area()) < 0.5:
            continue
        if r.x1 < QNUM_X[1]:  # margin icon, not content
            continue
        out.append(fitz.Rect(r))
    # A single diagram is drawn as dozens of separate paths, so they have
    # to be unioned back together - but only where they genuinely
    # overlap. Merging on any contact at all lets one union cascade
    # across unrelated diagrams and page rules until the "figure" spans
    # most of the sheet, which renders as a giant diagonal streak.
    merged = []
    for r in sorted(out, key=lambda b: (b.y0, b.x0)):
        for m in merged:
            inter = m & r
            if inter.is_empty:
                continue
            if inter.get_area() > 0.15 * min(m.get_area(), r.get_area()):
                m |= r
                break
        else:
            merged.append(fitz.Rect(r))

    # Sanity limits. Anything this large is a page decoration, a panel
    # border or a runaway union - never one question's own diagram - and
    # is dropped rather than shipped as a figure.
    page_h = page.rect.height
    page_w = page.rect.width
    keep = []
    for r in merged:
        if r.height > 0.45 * page_h or r.width > 0.80 * page_w:
            continue
        if too_small(r):
            continue
        keep.append(r)
    return keep


# How far outside its own bbox a diagram's labels are allowed to sit.
# Shared by absorb_labels and the prose loop so the two can never
# disagree about whether a "4t" is part of the drawing or part of the
# sentence - when they did, the label was cropped out of the diagram
# AND flowed into the text, where it attached itself to whichever part
# happened to be open ("5t4t" turning up as the text of part i).
LABEL_MARGIN_PT = 14.0
# Longest a line can be and still be a dimension label rather than prose.
LABEL_MAX_CHARS = 24


def hugs_a_figure(bbox, text, figs):
    """True if this line reads as a diagram's annotation.

    Only ever used to REPORT one that no crop took (see LOST_LABELS).
    What a crop actually contains is what decides whether a line is in
    the bitmap - this used to decide it instead, and the two disagreed:
    a line within the margin of a figure was taken out of the prose
    whether or not the crop had grown to include it, so a label that
    failed to be absorbed was lost from the page altogether, and the
    word "necessary." at the end of 3F Q7's stem - a line that happens
    to end just above a diagram - was lost with them."""
    if not text or len(text) > LABEL_MAX_CHARS:
        return False
    m = LABEL_MARGIN_PT
    centre = fitz.Point(0.5 * (bbox.x0 + bbox.x1), 0.5 * (bbox.y0 + bbox.y1))
    return any(
        fitz.Rect(f.x0 - m, f.y0 - m, f.x1 + m, f.y1 + m).contains(centre)
        for f in figs
    )


def rect_gap(r, p):
    """Distance from a point to a rectangle - 0 when it is inside."""
    dx = max(r.x0 - p.x, 0.0, p.x - r.x1)
    dy = max(r.y0 - p.y, 0.0, p.y - r.y1)
    return (dx * dx + dy * dy) ** 0.5


def absorb_labels(figs, lines, region, body_left, others=()):
    """Grows each figure box to swallow its own dimension labels.

    A diagram's "5 cm" / "2.5 mm" annotations are typeset as ordinary
    text lines sitting just outside the drawing's own bbox, so without
    this they get two things wrong at once: the figure is cropped
    without the measurements that make it answerable, and the labels
    land in the prose as noise ("...rectangles. i ii 2.5 mm5 cm").

    Only short lines are eligible, and only ones sitting clear of the
    body text column - a full sentence beside a figure is prose that
    should keep flowing, not a label.

    `region` is also the ceiling on growth, not just a filter on which
    lines are eligible. Unbounded, a figure reaches past its own cell
    and takes the NEXT part's labels with it, which loses them twice
    over: absent from the crop that needs them, and clipped away from
    the one that stole them."""
    grown = [fitz.Rect(f) for f in figs]
    changed = True
    while changed:
        changed = False
        for bbox, spans in lines:
            if not region.contains(fitz.Point(bbox.x0, bbox.y0)):
                continue
            text = "".join(c["c"] for s in spans for c in s.chars).strip()
            if len(text) > LABEL_MAX_CHARS:
                continue
            # A part marker is not a dimension label. It looks like one
            # (a single character, right beside the drawing), and cells
            # begin AT the marker, so without this the letter is drawn
            # into the bitmap and then printed again beside it.
            if marker_parse(spans, 0):
                continue
            for g in grown:
                near = fitz.Rect(g.x0 - 14, g.y0 - 14, g.x1 + 14, g.y1 + 14)
                if not near.intersects(bbox):
                    continue
                # A label indented to the body column's own left edge is
                # far more likely to be a part letter or a short sentence
                # than an annotation hanging off the drawing.
                if bbox.x0 < body_left + 2 and bbox.y0 < g.y0:
                    continue
                new = (g | bbox) & region
                # A label belongs to whichever drawing it sits nearest.
                # This used to be enforced by padding every other figure
                # by the label margin and refusing to grow into the pad,
                # which is the same idea done bluntly: the pad reaches
                # 14pt past a figure in every direction, far enough to
                # cover a label that plainly belongs to its neighbour -
                # and once refused here, is_label_line had already taken
                # the label out of the prose, so it vanished from the
                # page entirely. That is what took the "4" off 3E Q1b,
                # the "3" off Q1c, the "5" off Q1e, the "5t" off Q1g and
                # the "A" off the second triangle in 3F Q10.
                # Ownership is judged against EVERY other figure, not
                # just the ones inside this region: the diagram that owns
                # a label is often the one in the next cell down, which
                # is precisely why this figure must not take it. Judged
                # only against its own region, part (d) of 3E Q1 could
                # not see part (g) below it and swallowed g's "5t".
                mid = fitz.Point(0.5 * (bbox.x0 + bbox.x1), 0.5 * (bbox.y0 + bbox.y1))
                rivals = [o for o in grown if o is not g] + list(others)
                if any(rect_gap(o, mid) < rect_gap(g, mid) - 0.5 for o in rivals):
                    continue
                # Overlap, though, can only happen inside the region -
                # growth is clipped to it, so a figure outside cannot be
                # reached and must not veto anything.
                blocked = [o for o in grown if o is not g]
                blocked += [o for o in others if o.intersects(region)]
                # Growing must never reach another figure - any other
                # figure in the question, not just one in the same
                # group. A question's own diagram is absorbed against
                # the whole question region (it has no cell), so
                # without this it grew down the page until it enclosed
                # the NEXT diagram, which then printed twice: once
                # inside this crop and once as itself.
                if any(o.intersects(new) for o in blocked):
                    continue
                if not new.is_empty and new != g:
                    g.x0, g.y0, g.x1, g.y1 = new.x0, new.y0, new.x1, new.y1
                    changed = True
                break
    return grown


def crop_png(page, rect, path, pad=1.0):
    r = fitz.Rect(rect.x0 - pad, rect.y0 - pad, rect.x1 + pad, rect.y1 + pad)
    pix = page.get_pixmap(matrix=fitz.Matrix(CROP_ZOOM, CROP_ZOOM), clip=r)
    Image.open(io.BytesIO(pix.tobytes("png"))).save(path)
    return r


def is_qnum(spans, bbox):
    """A question-number marker: the publisher's dedicated rounded-bold
    face, in the left gutter, reading as a bare number.

    The size floor matters: the same face is reused at 6pt for the
    little "Example 5" cross-reference tags in the margin, which sit at
    a similar x and would otherwise each be read as the start of a new
    question - shredding the page into fragments named after examples."""
    for i in range(len(spans)):
        m = marker_parse(spans, i)
        if m and "num" in m:
            return m["num"]
    return None


def exercise_start_y(page):
    """Where the graded exercise begins on this page, if it does.

    A section page carries its intro, Lesson starter, Key Ideas panel and
    worked examples before ever reaching the exercise, and none of that
    is question-shaped: it is multi-column, panelled, and full of text at
    display sizes. Flowing it produces the word-salad this gate exists to
    prevent. Everything above the marker stays the bitmap pipeline's
    job - which handles panels perfectly well, since a panel genuinely
    IS one indivisible picture."""
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                if s["size"] >= 14 and s["text"].strip().lower().startswith("exercise"):
                    return fitz.Rect(l["bbox"]).y1
    return None


def marker_parse(spans, i):
    """Reads the structural marker at span i: its question number, its
    part letter, or both.

    Both, because the book sometimes sets them in ONE span. Question 17
    opens with the single span " 17  a ", so a test that asked whether
    the span read as a bare number said no, and a test that asked
    whether it read as a bare letter also said no. The question was
    therefore never opened and the part never seen: its whole page of
    text flowed into question 16 above it, and once question 16 was
    correctly ended at the tier banner, that text was dropped
    altogether. Parsing the span into its parts is what makes a fused
    marker behave exactly like a split one.

    Returns None for anything that is not a marker, else a dict with
    "num" and/or "letter" (and the letter's own bbox, which the figure
    grid needs to know which column it labels)."""
    s = spans[i]
    if not s.font.startswith(QNUM_FONT) or s.size < QNUM_MIN_SIZE or not s.chars:
        return None
    text = "".join(c["c"] for c in s.chars)
    toks = text.split()
    if not toks:
        return None
    # Markers are consumed greedily, in the order the book sets them:
    # question number, then part letter, then roman sub-part. Any of
    # the three may be absent, and any two may share one span - "17 a"
    # opens a question and its first part, "b i" opens a part and its
    # first sub-part. Testing for each in isolation matched none of the
    # fused forms, so those markers stayed in the prose and the
    # structure they announced was never built.
    out = {}
    rest = list(toks)
    x0 = s.chars[0]["bbox"][0]
    if rest and rest[0].isdigit() and QNUM_X[0] <= x0 <= QNUM_X[1]:
        out["num"] = rest.pop(0)
    # Lowercase only. This series letters its parts a, b, c and uses
    # CAPITALS for other things set in the same face - question 7 labels
    # two students' competing solutions "A" and "B", in the marker font
    # in the marker column. Read as parts they took over the letters of
    # the real parts a and b, so those parts' text and diagrams were
    # merged into the worked solutions above them.
    if rest and len(rest[0]) == 1 and rest[0].islower() and ("num" in out or x0 >= PART_X[0]):
        out["letter"] = rest.pop(0)
        for c in s.chars:
            if c["c"] == out["letter"]:
                out["lbox"] = c["bbox"]
                break
    # A single "i" is deliberately NOT read as a roman on its own: it
    # is ambiguous with a ninth part, and prune_letters resolves that
    # by sequence (h then i is a part, c then i is not). Following a
    # part letter in the same span there is no ambiguity.
    roman = r"i{1,3}|iv|vi{0,3}|ix|xi{0,3}"
    if rest and re.fullmatch(roman, rest[0]) and x0 >= PART_X[0]:
        if "letter" in out or len(rest[0]) > 1:
            want = rest.pop(0)
            out["roman"] = want
            # Where the marker sits, so the renderer can reproduce the
            # book's own column count for a run of sub-items.
            for c in s.chars:
                if c["c"] == want[0]:
                    out["rbox"] = c["bbox"]
                    break
    # Anything left over means this was never a marker span - a stray
    # word in the marker face, not structure.
    return out if (out and not rest) else None


def is_part_letter(spans):
    """A part marker ('a', 'b', ...) - same rounded-bold face as a
    question number but a single letter, anywhere past the question
    number's own gutter.

    Deliberately NOT restricted to the left margin. A diagram-grid
    question labels its parts in columns - measured here at x=70 for
    a/c/e and x=286.5 for b/d/f - so a narrow left-margin window sees
    only every other part. That both loses half the structure and
    scrambles what remains, since the parts that ARE found no longer
    line up with the diagrams beside them."""
    for i, s in enumerate(spans):
        if part_label(spans, i):
            return part_label(spans, i)
    return None


def part_label(spans, i):
    """The part letter at span i, or None.

    Two conditions, and both are needed. The letter must be set in the
    marker face at label size, and it must OPEN its line. Position
    alone cannot decide it: dropping the right-hand bound to reach the
    second column (x=286) also admits every inline marker-face letter,
    so "rounded to: i two decimal places" starts reporting a part i.
    Opening the line is what a label does and what an inline letter
    never does, so it separates them wherever on the page they sit."""
    if i != 0:
        return None
    m = marker_parse(spans, i)
    return m.get("letter") if m else None


def part_markers(lines, y0, y1):
    """Every part label in a question's band, with its position.

    Returned in the book's own reading order (row by row, left to right
    within a row) rather than raw y order - the two columns of a diagram
    grid are never typeset at identical y, so raw y interleaves them."""
    marks = []
    for bbox, spans in lines:
        if not (y0 <= bbox.y0 < y1):
            continue
        for i in range(len(spans)):
            m = marker_parse(spans, i) if i == 0 else None
            if m and "letter" in m:
                cb = m.get("lbox") or spans[i].chars[0]["bbox"]
                marks.append({"letter": m["letter"], "x": cb[0], "y": cb[1]})
    rows = []
    for m in sorted(marks, key=lambda k: k["y"]):
        for row in rows:
            if abs(row["y"] - m["y"]) <= 6:
                row["items"].append(m)
                break
        else:
            rows.append({"y": m["y"], "items": [m]})
    out = []
    for row in rows:
        out.extend(sorted(row["items"], key=lambda k: k["x"]))
    return out


def marker_columns(marks):
    """How many columns the book itself sets this question's parts in.

    Read from the part labels' x positions rather than guessed from how
    many parts there are. The book varies it deliberately - nine ratio
    triangles go three across, sixteen small ones go four - and copying
    that is both denser than a fixed guess and the reason a rebuilt
    page looks like the original rather than merely similar."""
    cols = []
    for x in sorted(m["x"] for m in marks):
        if not cols or x - cols[-1] > 12:
            cols.append(x)
    return max(1, len(cols))


def prune_letters(letters):
    """Keeps only the labels that really are this question's part letters.

    A single italic letter in the part column is not proof of a part.
    Roman-numeral sub-parts (i, ii, iii) are set the same way one level
    in, so "i" reads as a part letter and lands after c as a fifth part
    - and a question with two sub-lists contributes "i" twice, which
    then sorts into two parts with the same name. Real parts advance
    through the alphabet in order and never repeat, so that is the
    test: keep a letter only if it follows the last kept one by at most
    one gap. It admits a genuine ninth part i (h then i) and rejects a
    sub-part i (c then i), which is exactly the distinction the letter
    alone cannot make."""
    # Part lists start at "a". Anything before the first one is a
    # sub-item belonging to the stem, and letting it anchor the sequence
    # loses the real parts entirely: question 7 opens "For each of the
    # following: i ... ii ...", then sets parts a-d, and anchoring on
    # that "i" rejected a, b, c and d as out of sequence - so all four
    # triangles ended up on a single part called i.
    if "a" in letters:
        letters = letters[letters.index("a"):]
    acc = []
    for l in letters:
        if l in acc:
            continue
        if not acc or 0 < ord(l) - ord(acc[-1]) <= 2:
            acc.append(l)
    return acc


def merge_near(figs, gap=8.0):
    """Unions figures that are all but touching.

    One drawing is often reported as several rects that do not quite
    overlap - a flag pole's shadow triangle and the flag on top of it
    are 4pt apart - and page_figures only unions on real overlap, on
    purpose, so that a grid of separate diagrams stays separate. Here,
    where the figures are already known to belong to one question with
    no parts to tell apart, near-touching means one picture. Left
    apart, the flag printed beside its own diagram as a second image."""
    out = [fitz.Rect(f) for f in figs]
    changed = True
    while changed:
        changed = False
        for i in range(len(out)):
            for j in range(i + 1, len(out)):
                a, b = out[i], out[j]
                grown = fitz.Rect(a.x0 - gap, a.y0 - gap, a.x1 + gap, a.y1 + gap)
                if grown.intersects(b):
                    out[i] = a | b
                    del out[j]
                    changed = True
                    break
            if changed:
                break
    return out


def margin_figure(f, marks):
    """True for a diagram set out in the right margin, alongside a whole
    single column of parts rather than inside any one part's row."""
    if not marks:
        return False
    single_col = len({round(m["x"]) for m in marks}) == 1
    return single_col and f.x0 > min(m["x"] for m in marks) + 200


# How far above its own part letter a diagram's topmost stroke may sit
# and still belong to that part. The book sets the letter level with the
# top of the drawing, but only about level: a circle's apex routinely
# clears its letter by a few points. Two rules below depend on this and
# they must agree - the row rule allowed 8pt while the first-row rule
# allowed 2, so a grid of circles whose tops cleared the "a" and "b" by
# 3pt was read as one diagram belonging to no part at all. Both circles
# then printed unlabelled above part a's box, and part b vanished from
# the booklet along with its answer space.
LABEL_TOP_SLACK_PT = 8.0
# How far a line of prose may reach past a figure's reported top and
# still count as sitting above it rather than being part of it. Kept
# small: a figure's own dimension label often overlaps its drawing by
# much more than this, and must not be pushed out.
PROSE_CLEAR_PT = 2.0
# Narrower than this and a line above a figure is a label, not prose.
PROSE_MIN_WIDTH_PT = 40.0
# Clear of the prose by more than crop_png's own padding, or the pad
# reaches back over the line and takes the descenders off it.
PROSE_GAP_PT = 3.0


def label_figures(figs, marks):
    """Attaches each figure to the part label that names it, and clips it
    to that label's cell.

    A reader pairs a diagram with the nearest label above-and-left of
    it, so that is the rule here. Doing it by label rather than by
    position is also what fixes ordering for good: parts come out in
    a, b, c, d order because the book SAYS so, not because their
    geometry happened to sort that way.

    Clipping matters as much as attribution. A diagram is drawn as many
    separate paths and the unioning in page_figures is deliberately
    generous, so part a's rect routinely swallows the label and the top
    arc of part c below it - the crop then shows one and a bit circles.
    The labels themselves are the cell grid the book was typeset on, so
    they are exactly the right ruler: a figure may not cross into the
    next label row below it, nor into the next label column across.

    Returns (by_letter, cells) - the cell each letter owns is published
    because absorbing a diagram's labels needs the same walls. Absorbed
    without them, part d's rect grew down across the row boundary and
    swallowed part g's letter and both of ITS labels, which then went
    missing from g's crop."""
    row_ys = []
    for m in sorted(marks, key=lambda k: k["y"]):
        if not row_ys or m["y"] - row_ys[-1] > 6:
            row_ys.append(m["y"])
    cells = {}
    for m in marks:
        floor = next((y for y in row_ys if y > m["y"] + 6), None)
        wall = min((o["x"] for o in marks
                    if abs(o["y"] - m["y"]) <= 6 and o["x"] > m["x"] + 6), default=None)
        cells[m["letter"]] = fitz.Rect(
            # Same slack at the top as the attribution rule above uses,
            # and for the same reason. A cell that stopped dead at its
            # letter did not quite contain a circle whose apex cleared
            # that letter by a hair, so the absorption below fell back to
            # the whole question for bounds and pulled the tail of the
            # stem's second line down into the crop.
            m["x"] - 2, m["y"] - LABEL_TOP_SLACK_PT,
            (wall - 4) if wall is not None else 1e5,
            (floor - 3) if floor is not None else 1e5,
        )
    first_row = row_ys[0] if row_ys else None
    by_letter = {}
    for f in figs:
        # A diagram that starts ABOVE the first part label cannot belong
        # to a part - nothing has been lettered yet where it sits. It is
        # the question's own diagram, set in the margin beside the stem
        # ("In calculating the value of x for THIS triangle..."), and
        # forcing it onto the nearest label put it in the wrong column
        # under the wrong letter.
        if first_row is not None and f.y0 < first_row - LABEL_TOP_SLACK_PT:
            by_letter.setdefault(None, []).append(f)
            continue
        best, best_d = None, None
        for m in marks:
            # the label must sit above the figure's bottom and no
            # further right than the figure itself
            if m["y"] > f.y1 or m["x"] > f.x1 + 6:
                continue
            d = (f.y0 - m["y"]) ** 2 + 0.35 * (f.x0 - m["x"]) ** 2
            if best_d is None or d < best_d:
                best, best_d = m, d
        if best is not None:
            # The label's own top line is the ceiling. It is NOT below
            # the label: the book sets the letter level with the top of
            # its diagram (measured 95.3 against 95.6), so clipping
            # under the letter takes the top off every circle. What is
            # above that line belongs to the row before, and is the
            # stray arc that was appearing across the top of a crop.
            # ...and only if it reaches well above it. The book sets a
            # letter level with the top of its diagram, so a drawing
            # whose topmost arc sits a few points higher is that
            # diagram's own top, not a leftover from the row before -
            # cutting at the letter took the arc off 3H Q6's ladder.
            if f.y0 < best["y"] - LABEL_TOP_SLACK_PT:
                f.y0 = best["y"] - 2
            # The letter itself sits just left of the diagram, so on a
            # figure it is level with it lands inside the crop and
            # prints twice - once in the bitmap and once as the part's
            # own rendered letter. Trimming that column removes it
            # without touching a diagram lower down the cell.
            if f.y0 <= best["y"] + 12:
                f.x0 = max(f.x0, best["x"] + 8)
            # A diagram out in the right margin beside a single column
            # of parts is not IN any part's row - it is set alongside
            # several of them and is routinely taller than one. Clipped
            # to the row its top happens to fall in, it lost its lower
            # half, and the labels that went with that half then leaked
            # into the next part's text ("...to two decimal places.20").
            floor = next((y for y in row_ys if y > best["y"] + 6), None)
            # Only a figure that actually reaches the next row is cut
            # back off it. The 3pt margin is there to keep the next
            # row's letter out of the crop, not to shave the last of a
            # drawing that already stops above it - which is what took
            # the bottom vertex off 3E Q1's part (d).
            if floor is not None and f.y1 > floor and not margin_figure(f, marks):
                f.y1 = floor - 3
            wall = min((m["x"] for m in marks
                        if abs(m["y"] - best["y"]) <= 6 and m["x"] > best["x"] + 6),
                       default=None)
            if wall is not None:
                f.x1 = min(f.x1, wall - 4)
            if too_small(f):
                continue
        key = best["letter"] if best else None
        by_letter.setdefault(key, []).append(f)
    return by_letter, cells


def body_spans(spans):
    """Drops the structural markers (question number, part letter) from a
    line, leaving only what is actually body text. They are rendered
    separately as structure - a number in its own gutter column - so
    letting them through here would print them twice and, worse, weld
    "6" onto the front of the sentence as one unsplittable text run."""
    out = []
    for i, s in enumerate(spans):
        txt = "".join(c["c"] for c in s.chars).strip()
        # Margin cross-reference tags ("Example 5", "Example 6a") are set
        # in the marker face at 6pt out in the margin. They are an index
        # for the teacher, not part of the sentence, and splice into the
        # middle of it if kept ("...correct to two Example 6adecimal
        # places").
        if s.font.startswith(QNUM_FONT) and s.size < QNUM_MIN_SIZE:
            continue
        # Markers are stripped by the SAME parse that recognises them
        # upstream. When the two drifted apart, a second-column label
        # was recognised as a part and also left in the prose, printing
        # it twice ("b b Find the area").
        #
        # Only where a marker can actually open something: at the head
        # of the line, or a bare number in the question gutter. These
        # questions also CITE their own parts mid-sentence, in the same
        # face ("your two answers from parts a i and ii above"), and
        # stripping those left the sentence pointing at nothing.
        m = marker_parse(spans, i)
        if m and (i == 0 or "num" in m):
            continue
        out.append(s)
    return out


def tier_of(spans):
    """A tier band ('FLUENCY', 'PROBLEM-SOLVING', ...) - condensed bold
    caps. Returns a normalised key matching the renderer's tier names."""
    for s in spans:
        if not s.font.startswith(TIER_FONT_PREFIX):
            continue
        txt = "".join(c["c"] for c in s.chars).strip()
        key = re.sub(r"[^a-z]", "", txt.lower())
        # Prefix match, not equality: an Enrichment band carries its own
        # title ("ENRICHMENT: Planetary circumnavigation"), so an exact
        # comparison fails to recognise it as a band at all - and the
        # whole row then flows into the preceding question as text
        # ("Radius 3 mmENRICHMENT: Planetary circumnavigation").
        for name in ("fluency", "problemsolving", "reasoning", "enrichment"):
            if key.startswith(name):
                return name
    return None


def runs_to_json(runs, page, crops_dir, prefix, counter, baseline):
    """Turns a line's runs into the renderer's content stream. A crop run
    is written out as a small PNG and carries its own mm height so the
    renderer can size it against the surrounding line rather than
    against the page - that is what keeps inline math the same visual
    size as the text it sits in, at any column width."""
    out = []
    for r in runs:
        if r["kind"] == "crop":
            counter[0] += 1
            cid = f"{prefix}_m{counter[0]}"
            actual = crop_png(page, r["bbox"], os.path.join(crops_dir, cid + ".png"))
            out.append({
                "m": cid,
                "hMm": round(mm(actual.height), 2),
                "wMm": round(mm(actual.width), 2),
                # How far the fragment's BOTTOM sits below the text
                # baseline, which is exactly what an inline image's
                # vertical-align needs. Without it every fragment would
                # sit on the baseline: a fraction's denominator would
                # ride up level with the words, and a superscript "2"
                # would drop down into them.
                "dropMm": round(mm(actual.y1 - baseline), 2),
            })
        else:
            txt = r["text"]
            if not txt.strip():
                if out and out[-1].get("t", "").endswith(" "):
                    continue
                txt = " "
            out.append({"t": txt} if r["kind"] == "text" else {"t": txt, "i": True})
    return out


def append_line(target, stream):
    """Adds a line's runs to a growing block, with the word break the
    line ending itself was.

    A line break IS a space once the text reflows, and neither side of
    it carries one: the sentence ends "...is 1 metre tall." and the
    next line starts "Answer the following", so joining them directly
    printed "tall.Answer". Only inserted where there is not already
    whitespace on one side, so it cannot double up a space."""
    if target and stream:
        prev = target[-1].get("t", "")
        nxt = stream[0].get("t", "")
        needs = (not prev or not prev[-1].isspace()) and (not nxt or not nxt[0].isspace())
        if needs:
            target.append({"t": " "})
    target += stream


def tidy(stream):
    """Collapses adjacent text runs and squeezes runs of spaces - the
    per-character walk upstream is deliberately naive so that run
    boundaries stay exact; cleaning up here keeps the stored document
    small without risking those boundaries."""
    out = []
    for r in stream:
        if "t" in r and out and "t" in out[-1] and out[-1].get("i") == r.get("i"):
            out[-1]["t"] += r["t"]
        else:
            out.append(dict(r))
    for r in out:
        if "t" in r:
            r["t"] = re.sub(r"\s+", " ", r["t"])
    return [r for r in out if r.get("t") != "" ]


def extract_questions(doc, pno, crops_dir, prefix, want_tier=None, y_floor=None):
    """Segments one page into questions using the book's own markers, and
    returns them already split into stem/parts with figures attached.

    Everything here keys off structure the publisher actually encodes
    (gutter position + marker font), so a question's extent is derived
    rather than guessed - the property that makes this pipeline immune
    to the clipping/bleed bugs that come with hand-picked rectangles."""
    page = doc[pno]
    lines = page_lines(page)

    # Marker sweep first: where does each question start, and which tier
    # is in force at that point. Done as its own pass because a question's
    # end is only knowable from where the *next* one begins.
    marks = []
    tier = want_tier
    # Rows occupied by a tier band. The band is not just its own word:
    # the same row carries the publisher's per-tier question ranges
    # ("6, 7 | 6-8 | 7-9") off to the right, which are navigation for
    # the teacher, not question content, and read as garbage if flowed.
    band_rows = []
    for bbox, spans in lines:
        t = tier_of(spans)
        if t:
            tier = t
            marks.append(("tier", bbox.y0, t))
            band_rows.append((bbox.y0 - 2, bbox.y1 + 2))
            continue
        n = is_qnum(spans, bbox)
        if n and (y_floor is None or bbox.y0 >= y_floor):
            marks.append(("q", bbox.y0, n))

    def in_band(bbox):
        return any(y0 <= bbox.y0 <= y1 for y0, y1 in band_rows)

    starts = [(y, n, ) for kind, y, n in marks if kind == "q"]
    if not starts:
        return [], tier

    # Bands and figures are both resolved for the whole page up front,
    # so every figure has exactly one owner (see page_figures).
    bands = []
    for i, (ystart, _n) in enumerate(starts):
        yend = starts[i + 1][0] - 1 if i + 1 < len(starts) else page.rect.y1 - 40
        bands.append((ystart - 4, yend))
    fig_owner = assign_figures(page_figures(page, (y_floor or 0.0)), bands)

    questions = []
    counter = [0]
    for i, (ystart, number) in enumerate(starts):
        yend = bands[i][1]
        # A tier banner ("PROBLEM SOLVING") that falls inside this
        # question's band belongs to the NEXT tier, not to this
        # question. It is a filled bar the width of a few words, so it
        # passes the page-furniture filters and gets unioned into the
        # last diagram above it - the crop then shows a circle with a
        # blue banner stuck to its foot.
        nxt = min((y for kind, y, _ in marks if kind == "tier" and y > ystart + 4),
                  default=None)
        if nxt is not None:
            yend = min(yend, nxt - 2)
        # The publisher closes a section with a full-width coloured
        # panel ("Using a CAS calculator 3G: Trigonometry - this
        # activity is in the Interactive Textbook"). It is not part of
        # the exercise and there is nothing to answer in it, but it sits
        # inside the last question's band, so its wording was running on
        # to the end of that question's last part.
        panel = min((fitz.Rect(d["rect"]).y0 for d in page.get_drawings()
                     if d.get("fill")
                     and fitz.Rect(d["rect"]).width > 0.75 * page.rect.width
                     and fitz.Rect(d["rect"]).height > 12
                     and fitz.Rect(d["rect"]).y0 > ystart + 8),
                    default=None)
        if panel is not None:
            yend = min(yend, panel - 2)
        region = fitz.Rect(40, ystart - 4, page.rect.x1 - 40, yend)

        figs = [clip_to_question(fitz.Rect(f), region, lines, band_rows) for f in fig_owner[i]]
        figs = [f for f in figs if not f.is_empty and not too_small(f)]
        # Attribution and clipping have to happen BEFORE the crops are
        # written, since clipping is what decides the rect each PNG is
        # cut from. Done afterwards it changed only the bookkeeping: the
        # images on disk still carried the next row's label and the top
        # of its diagram.
        pmarks = part_markers(lines, ystart - 4, yend)
        keep = prune_letters([m["letter"] for m in pmarks])
        pmarks = [m for m in pmarks if m["letter"] in keep]
        # With no part labels there is nothing to attach figures TO, so
        # they all belong to the question itself. Falling through to an
        # empty mapping instead would silently drop every figure on any
        # question without lettered parts.
        cells = {}
        if pmarks and len(figs) > 1:
            figs_by_letter, cells = label_figures(figs, pmarks)
        else:
            # ONE diagram serving SEVERAL parts is shared context, not
            # any single part's - "the triangle shown on the right",
            # then six ratios to read off it. Attributed to a part it
            # was drawn under the wrong letter, in the wrong column,
            # and sometimes clipped to that part's cell until it was
            # too small to keep and vanished. Counting is what
            # separates the two cases: a per-part grid has a diagram
            # for each part, a shared one has exactly one.
            # A question with no parts has one illustration, however
            # many paths the typesetter drew it with - an aeroplane, its
            # flight path and the mountain it clears are one picture
            # even though the plane sits 19pt clear of the peak. Merged
            # generously here because there are no parts to tell apart;
            # a grid of separate diagrams never reaches this branch.
            gap = 24.0 if len(pmarks) == 0 else 8.0
            figs_by_letter = {None: merge_near(figs, gap=gap)}
        # Everything above the first part label is the question's own
        # prose; below it, a line overhead is more likely a diagram's
        # measurement (see the stem rule in the absorption loop).
        stem_floor = min((m["y"] for m in pmarks), default=None)
        # Dimension labels are absorbed only AFTER each figure knows
        # which cell it lives in, and never past that cell's walls.
        # Run before the grid existed, a figure grew into the row below
        # and took the next part's labels with it.
        for letter, group in figs_by_letter.items():
            cell = cells.get(letter)
            elsewhere = [f for k, v in figs_by_letter.items() if k != letter for f in v]
            out = []
            for f in group:
                # A figure that already reaches past its cell is one
                # label_figures deliberately did not confine to a row -
                # a margin diagram set alongside several parts. Bounding
                # its label absorption by the cell would clip it back to
                # that row anyway, taking off the half of the triangle
                # that made it answerable.
                bounds = region if (cell is None or not cell.contains(f)) else cell
                # Siblings in the SAME group are obstacles too. Absorbed
                # one figure at a time, a figure had no siblings in view
                # and grew across its neighbour, so both crops ended up
                # containing both diagrams.
                near = elsewhere + [g for g in group if g is not f]
                box = bounds & region
                # A diagram out in the right margin gets a label's worth
                # of vertical slack, because the cell is the wrong ruler
                # for it: the cell begins and ends at part letters down
                # the left, while a margin diagram is set alongside
                # several parts and its topmost and bottommost
                # annotations fall wherever the drawing does. That is
                # where the vertex labels A, B and C of 3F Q10's second
                # triangle were going - above and below a cell whose top
                # is part (d)'s own line. The slack is only safe here:
                # a diagram in a grid cell has the next row's tier band
                # or part row a few points below it, and 14pt of reach
                # was enough to pull a slice of the band's own text into
                # the crop.
                if margin_figure(f, pmarks):
                    m = LABEL_MARGIN_PT
                    box = fitz.Rect(box.x0, box.y0 - m, box.x1, box.y1 + m)
                # Never into a tier band. The band's own text is the
                # publisher's per-tier question list ("7 | 7-9 | 8-10"),
                # short lines sitting right where a diagram's labels
                # would - so a crop that reaches one takes a slice of
                # the coloured banner and a stray number with it.
                for b0, b1 in band_rows:
                    if b0 >= f.y1:
                        box.y1 = min(box.y1, b0)
                    if b1 <= f.y0:
                        box.y0 = max(box.y0, b1)
                # And never into the question's own stem. A drawing's
                # reported rect is not its ink: a circle's came back 9pt
                # taller than the arc, far enough to overlap the last
                # line of the stem by half a point - which the crop's
                # padding then widened into a legible strip of
                # "...decimal places." above the diagram.
                #
                # Only text ABOVE the first part label counts, because
                # only that is prose. Applied to every line overhead it
                # took the labels off nineteen Trigonometry diagrams:
                # inside a cell the line above a drawing is usually its
                # own measurement, sitting a line's height into the rect
                # exactly as this rule looks for.
                if stem_floor is not None:
                    for lb, _ls in lines:
                        if lb.y1 > stem_floor or lb.y1 > f.y0 + PROSE_CLEAR_PT:
                            continue
                        if lb.y0 >= f.y0 or lb.x1 <= f.x0 or lb.x0 >= f.x1:
                            continue
                        # Prose runs from the text column's left edge and
                        # is a line long. A vertex label sits over the
                        # drawing and is a glyph wide - and 3F Q8's "C",
                        # above the apex of a triangle set beside the
                        # stem, is above the first part label too, so
                        # position alone did not tell them apart.
                        if lb.x0 > f.x0 or lb.width < PROSE_MIN_WIDTH_PT:
                            continue
                        f.y0 = max(f.y0, lb.y1 + PROSE_GAP_PT)
                        box.y0 = max(box.y0, lb.y1 + PROSE_GAP_PT)
                # The ceiling says how far a crop may GROW to reach a
                # label; it must never cut the drawing it is growing
                # from. absorb_labels intersects with it on every
                # absorption, so a diagram taller than its own question
                # (see clip_to_question) was sheared back to the question
                # the moment it took in its first measurement - 10G's
                # field kept "18 m" and "26 m" and lost two thirds of the
                # triangle under them.
                box |= f
                out += absorb_labels([f], lines, box, PART_X[1], others=near)
            figs_by_letter[letter] = out
        figs = [f for v in figs_by_letter.values() for f in v]
        fig_json = {}
        for fi, fr in enumerate(figs):
            cid = f"{prefix}q{number}_f{fi}"
            actual = crop_png(page, fr, os.path.join(crops_dir, cid + ".png"), pad=2.0)
            fig_json[id(fr)] = {
                "crop": cid,
                "wMm": round(mm(actual.width), 2),
                "hMm": round(mm(actual.height), 2),
            }

        # Which tier band was most recently passed above this question.
        cur_tier = want_tier
        for kind, y, val in marks:
            if kind == "tier" and y <= ystart:
                cur_tier = val

        # Fractions are found once per question, since a single one
        # spans three consecutive lines (see find_fractions).
        qlines = [(b, s) for b, s in lines if ystart - 4 <= b.y0 < yend]
        fracs = find_fractions(qlines)
        emitted_fracs = set()

        stem, parts = [], []
        cur_part = None
        cur_sub = None
        # In a multi-column grid, content cannot be routed to "whichever
        # part was opened last". A stacked fraction is typeset as three
        # separate lines, and the denominators of all three columns
        # share one line BELOW all three markers - so the last column
        # collected every denominator on the row ("cos 33 = x 4 3 6")
        # while the other two lost theirs. The marker cells say which
        # column a line is in, which is the question the router has to
        # answer.
        multi_col = bool(pmarks) and marker_columns(pmarks) > 1
        part_by_letter = {}
        for bbox, spans in lines:
            if not (ystart - 4 <= bbox.y0 < yend):
                continue
            if in_band(bbox):
                continue
            # A label living inside a figure belongs to that figure's
            # bitmap, not to the prose - pulling "7 cm" out of a circle
            # and into the flow would both corrupt the sentence and
            # strip the diagram of its dimensions.
            line_text = "".join(c["c"] for s in spans for c in s.chars).strip()
            if any((fr & bbox).get_area() > 0.6 * bbox.get_area() for fr in figs):
                continue
            # Labels just OUTSIDE the drawing are the same thing, and
            # they are the ones that leak: a diagram grid opens all of
            # its part markers in one row, so by the time the labels are
            # reached every part is already open and they all land on
            # the last one.
            # Labels just OUTSIDE the drawing are the same thing, and
            # they are the ones that leak: a diagram grid opens all of
            # its part markers in one row, so by the time the labels are
            # reached every part is already open and they all land on
            # the last one. A pronumeral label ("h", "x") reads as a
            # sub-part marker too, and opens a phantom sub-item.
            #
            # A line starting at the body column is prose, however close
            # to a diagram it happens to end - the same test absorb_
            # labels uses to refuse it, so the two cannot disagree about
            # what is a label. Without it the last line of 3F Q7's stem,
            # "necessary.", was read as an annotation of the diagram
            # below it and dropped from the page.
            if hugs_a_figure(bbox, line_text, figs) and bbox.x0 >= PART_X[1] + 2:
                # A label the prose gives up and no crop actually
                # contains is gone from the booklet altogether - a side
                # length a student needs, silently missing. Reported
                # rather than repaired here: the repair belongs upstream
                # in absorb_labels, and the report is what proves it
                # worked on every figure of every chapter, instead of
                # one spot-check at a time. A part letter is structure,
                # printed beside the crop from the part list, so it is
                # not missing just because the bitmap has no copy of it.
                if not any(fr.contains(bbox) for fr in figs) and not marker_parse(spans, 0):
                    LOST_LABELS.append(f"p{pno + 1} q{number}: {line_text!r}")
                continue

            # The part is opened as soon as its label is seen, BEFORE the
            # empty-line test. A label very often sits alone on its own
            # line - every diagram-grid label does, and so does a
            # sub-part marker - and such a line has no body text left
            # once the marker is stripped. Testing for emptiness first
            # therefore threw the label away with the line, so the prose
            # that followed silently joined the previous part.
            m0 = marker_parse(spans, 0) if spans else None
            letter = m0.get("letter") if m0 else None
            roman = m0.get("roman") if m0 else None
            if letter:
                cur_part = {"letter": letter, "content": [], "subs": [],
                            "x": (m0.get("lbox") or [0])[0]}
                parts.append(cur_part)
                part_by_letter.setdefault(letter, cur_part)
                cur_sub = None
                # "b i" opens the part AND its first sub-item. Without
                # this the first item lost its marker while ii and iii
                # kept theirs, so the list read b, ii, iii.
                if roman:
                    cur_sub = {"letter": roman, "content": [], "x": (m0.get("rbox") or [0])[0]}
                    cur_part["subs"].append(cur_sub)
            elif roman:
                # A roman marker opens a sub-item of the part above it,
                # kept as its own line rather than spliced into that
                # part's sentence.
                cur_sub = {"letter": roman, "content": [], "x": (m0.get("rbox") or [0])[0]}
                if cur_part is not None:
                    cur_part["subs"].append(cur_sub)
                else:
                    cur_part = {"letter": roman, "content": [], "subs": []}
                    parts.append(cur_part)
                    cur_sub = None
            body_only = body_spans(spans)
            if not body_only:
                continue
            baseline = baseline_of(body_only)
            body = body_size_of(body_only)
            runs = build_runs(body_only, baseline, body, fracs, emitted_fracs)
            stream = runs_to_json(runs, page, crops_dir, f"{prefix}q{number}", counter, baseline)

            # A continuation line in a column grid belongs to the column
            # it sits in, not to the part opened most recently.
            if multi_col and not letter and not roman:
                pt = fitz.Point(bbox.x0 + 1, bbox.y0 + 1)
                owner = next(
                    (part_by_letter[L] for L, cell in cells.items()
                     if L in part_by_letter and cell.contains(pt)),
                    None,
                )
                if owner is not None and owner is not cur_part:
                    cur_part, cur_sub = owner, None

            if cur_sub is not None:
                append_line(cur_sub["content"], stream)
            elif cur_part is not None:
                append_line(cur_part["content"], stream)
            else:
                append_line(stem, stream)

        # Attach each figure to the part that labels it, so a diagram
        # grid comes back as real parts (a, b, c, d - each with its own
        # diagram and its own answer space) instead of one flat row of
        # pictures sharing a single box. Ordering follows the letters,
        # which is why it is now stable regardless of how the two
        # columns happen to be staggered on the page.
        # A label the sequence test rejected is a sub-part marker, not a
        # part - it becomes a sub-item of the part above it, keeping its
        # own line and its own marker. Folded into that part's prose
        # instead, three separate questions ran together into one
        # unreadable sentence.
        merged, by_letter, stem_items = [], {}, 0
        for p in parts:
            p.setdefault("subs", [])
            if p["letter"] in keep and p["letter"] not in by_letter:
                by_letter[p["letter"]] = p
                merged.append(p)
            elif merged:
                merged[-1]["subs"].append(
                    {"letter": p["letter"], "content": p["content"], "x": p.get("x", 0)})
                merged[-1]["subs"] += p["subs"]
            else:
                # A rejected label before any part has opened folds back
                # into the stem - and so do ITS sub-items. Dropping them
                # silently lost half the instruction: question 7 reads
                # "For each of the following: i use Pythagoras' theorem
                # ... ii find the ratios for sin, cos and tan", and only
                # the first survived.
                stem += [{"t": f" {p['letter']} "}] + p["content"]
                for s in p["subs"]:
                    stem += [{"t": f" {s['letter']} "}] + s["content"]
                stem_items += 1 + len(p["subs"])
        parts = merged
        seen = {p["letter"] for p in parts}
        for m in pmarks:
            if m["letter"] not in seen and m["letter"] in figs_by_letter:
                parts.append({"letter": m["letter"], "content": [], "subs": []})
                seen.add(m["letter"])

        def fig_entries(letter):
            return [fig_json[id(f)] for f in figs_by_letter.get(letter, []) if id(f) in fig_json]

        part_json = []
        for p in sorted(parts, key=lambda k: k["letter"]):
            entry = {
                "letter": p["letter"],
                "content": tidy(p["content"]),
                "figures": fig_entries(p["letter"]),
            }
            # assign_working_space runs later, over these very dicts, and
            # adds each sub-item's own box.
            subs = [
                {"letter": s["letter"], "content": tidy(s["content"])}
                for s in p.get("subs", [])
                if tidy(s["content"])
            ]
            if subs:
                entry["subs"] = subs
                # The book sets a run of short sub-items across the
                # page - "i 10  ii 28  iii 54  iv 81" on one line - and
                # printing each on its own full-width row instead is
                # what made these questions run several pages with a
                # gap at the foot of each.
                entry["subColumns"] = marker_columns(
                    [{"x": s.get("x", 0), "y": 0} for s in p.get("subs", [])
                     if tidy(s["content"])]
                )
            part_json.append(entry)

        q = {
            "type": "flowquestion",
            "id": f"{prefix}q{number}",
            "number": number,
            "tier": cur_tier,
            "stem": tidy(stem),
            "parts": part_json,
            # The book's own column count for this grid, so the rebuilt
            # page reproduces the source layout instead of guessing one.
            "columns": marker_columns(pmarks) if pmarks else 1,
            # How many separate instructions the stem itself lists. A
            # part under "i do this ... ii then do that" is answering
            # both, so its box has to hold both.
            "stemItems": stem_items,
            # Only figures no part claimed stay at question level - a
            # lone photo beside a one-part question, typically.
            "figures": fig_entries(None),
        }
        questions.append(q)
    return questions, tier


# Section titles ("10C Circles, pi and circumference") are set far larger
# than anything else on the page, near its top - so they need no page
# map supplied by hand, unlike the bitmap pipeline where every section
# boundary was a hand-entered page number.
SECTION_SIZE_MIN = 16.0
SECTION_Y_MAX = 130.0


def section_title(page):
    """The section heading on this page, or None. Returns (code, text)."""
    big = []
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            if fitz.Rect(l["bbox"]).y0 > SECTION_Y_MAX:
                continue
            for s in l["spans"]:
                if s["size"] >= SECTION_SIZE_MIN and s["text"].strip():
                    big.append((fitz.Rect(s["bbox"]), s["text"].strip()))
    if not big:
        return None
    big.sort(key=lambda t: (t[0].y0, t[0].x0))
    joined = " ".join(t for _, t in big)
    joined = re.sub(r"\s+", " ", joined).strip()
    # The code ("10C") is its own span and does not always come first in
    # positional order, so it is matched anywhere in the assembled
    # heading and lifted out rather than assumed to lead.
    # "Exercise 3F" is set at heading size near the top of the page too,
    # but it opens the exercise WITHIN a section rather than opening a
    # new one. Treated as a section title it emitted a second, empty
    # "3F Exercise" heading and reset the section's tier state halfway
    # through it.
    if re.fullmatch(r"(?i)exercise\s+\d+[A-Z]", joined):
        return None
    m = re.search(r"\b(\d+[A-Z])\b", joined)
    if m:
        rest = (joined[: m.start()] + " " + joined[m.end():]).strip()
        return m.group(1), re.sub(r"\s+", " ", rest)
    return None, joined


# The renderer's paper: squares are 5mm and ruled lines 10mm apart, so
# every height below is a whole number of them and no box is drawn with
# a clipped last row.
GRID_MM = 5
RULE_MM = 10
# The booklet's own page geometry, mirrored from static/model.js - only
# needed to work out how much room a teaching panel leaves for the box
# under it (see panel_blocks).
CONTENT_WIDTH_MM = 186.0
USABLE_HEIGHT_MM = 270.0
# What a teaching panel prints at, as a fraction of the content width.
# Must match DEFAULT_SECTION_SCALE in static/model.js. The panels are
# cropped ~150mm wide from a book that prints them at that size, so
# rendering them to fill the 186mm column blew them up to 123% of the
# original for no reason; this brings them back under it.
SECTION_SCALE = 0.65

# What a question ASKS is what decides how much room it needs - not its
# tier, and not how many parts it happens to have. These patterns are
# read off this chapter's actual wording (all 60 questions were dumped
# and grouped before the table was written), most specific first.
#
# The sizes are reasoned from the work itself, in 5mm squares:
#   evaluate  a calculator keypress and a number                 2 sq
#   ratio     one fraction, written out                          3 sq
#   equation  rearrange, substitute, solve, round                4 sq
#   triangle  name the sides, pick the ratio, then all of that   5 sq
#   worded    all of the above, PLUS drawing the triangle first  9 sq
#   draw      a construction with room to get it wrong           8 sq
# Prose answers switch to ruled lines, because asking a student to
# write a sentence inside grid squares is the wrong paper.
WORKING_RULES = [
    ("prose", r"\b(explain|justify|investigate|describe|discuss|comment|"
              r"decide (if|whether)|give (a )?reasons?|notice|why)\b"),
    ("draw", r"\b(draw|sketch|construct|complete the (diagram|table))\b"),
    ("evaluate", r"\b(use a calculator to evaluate|evaluate the following)\b"),
    ("ratio", r"\b((write|find)( down)? (a|an|the)[^.]{0,40}\bratio|"
              r"in (simplified )?fraction form)\b"),
    ("expression", r"\b(find an expression|write a rule|in terms of)\b"),
]


SQUARES = {
    # A ratio answer is a FRACTION - two storeys and a rule between
    # them - so three squares is the floor, not two. Written into two
    # it runs out of room vertically before it runs out horizontally.
    "evaluate": 2, "ratio": 4, "equation": 4, "triangle": 5,
    "expression": 6, "draw": 8, "worded": 9,
}


def flat_text(runs):
    return re.sub(r"\s+", " ", "".join(r.get("t", "") for r in runs)).lower()


def part_text(p):
    """A part's own words, including any sub-items it carries."""
    return " ".join([flat_text(p["content"])] + [flat_text(s["content"]) for s in p.get("subs", [])])


def question_text(q):
    """Everything the question says, stem and parts, as flat lowercase."""
    return " ".join([flat_text(q["stem"])] + [part_text(p) for p in q["parts"]])


def working_kind(text, has_figs, has_parts):
    """Which archetype a piece of question text is - see WORKING_RULES."""
    for kind, pattern in WORKING_RULES:
        if re.search(pattern, text):
            return kind
    if not has_parts:
        # A worded problem states a situation in prose and gives no
        # diagram, so the student has to draw one before any trig can
        # start. That is the case that needs real room, and it is most
        # of section 3I.
        return "worded" if len(text) > 110 else "equation"
    return "triangle" if has_figs else "equation"


def space_for(kind, whole):
    """The box for one archetype: ruled lines for prose, squares for
    calculation. A part gets a square less than the whole question
    would, since it is one step of the same job rather than all of it,
    but never less than two - one line of handwriting."""
    if kind == "prose":
        return {"style": "lines", "heightMm": RULE_MM * (4 if whole else 3)}
    sq = SQUARES[kind]
    return {"style": "grid", "heightMm": GRID_MM * (sq if whole else max(2, sq - 1))}


def assign_working_space(q):
    """Sets the answer space for a question and for each of its parts.

    Every part gets its own box, and is sized on its OWN wording rather
    than the question's. Questions here routinely mix the two kinds -
    "find the size of angle C ... explain why the ratios are equal" -
    so one verdict for the whole question puts half of it on the wrong
    paper: ruled lines to do trigonometry on, or grid squares to write
    a sentence in."""
    has_figs = bool(q["figures"]) or any(p.get("figures") for p in q["parts"])
    stem = flat_text(q["stem"])
    whole = working_kind(question_text(q), has_figs, bool(q["parts"]))
    q["workingSpace"] = space_for(whole, True)
    if not q["parts"]:
        return
    # The stem carries the instruction that governs every part ("find
    # the value of x"), so a part is read as stem + its own text.
    for p in q["parts"]:
        own = part_text(p)
        kind = working_kind(
            (stem + " " + own).strip(), bool(p.get("figures")) or has_figs, True
        )
        # A part that asks for prose in its own words overrides the
        # stem, which is usually a bare "For the triangle shown:".
        for name, pattern in WORKING_RULES:
            if name == "prose" and re.search(pattern, own):
                kind = "prose"
        # A sub-item is a question in its own right, so it gets its own
        # box, sized on its own words. Giving the part one box scaled by
        # how many sub-items it had produced a single 90mm slab for
        # three one-line answers, and still left nowhere to write "ii"
        # that was recognisably ii's.
        subs = p.get("subs", [])
        for s in subs:
            # A sub-item's instruction lives in its PARENT PART, not in
            # the question stem - "use your measurements to find an
            # approximate ratio for:" then "cos 40". Read against the
            # stem alone, "cos 40" says nothing about what to do with
            # it, and every such sub-item got the largest default box.
            stext = " ".join([stem, flat_text(p["content"]), flat_text(s["content"])]).strip()
            skind = working_kind(stext, bool(p.get("figures")) or has_figs, True)
            for name, pattern in WORKING_RULES:
                if name == "prose" and re.search(pattern, flat_text(s["content"])):
                    skind = "prose"
            s["workingSpace"] = space_for(skind, False)
        # A part that has sub-items takes no box of its own. Its text is
        # the instruction those sub-items are answered under ("use your
        # measurements from part a to find a ratio for:") - there is
        # nothing to write against it, and a box there printed an empty
        # extra grid between the last sub-item and the next part.
        ws = {"style": "none", "heightMm": 0} if subs else space_for(kind, False)
        # Where the STEM lists several instructions ("i use Pythagoras'
        # theorem to find the unknown side ... ii find the ratios for
        # sin, cos and tan"), the part is answering all of them in one
        # box, so the box has to hold all of them.
        n_stem = max(1, q.get("stemItems", 0))
        if n_stem > 1 and ws["style"] == "grid":
            ws["heightMm"] = min(GRID_MM * 10, ws["heightMm"] * n_stem)
        p["workingSpace"] = ws


# --- teaching panels -------------------------------------------------
#
# The pages before an exercise are not question-shaped: Key Ideas,
# Building Understanding and the worked Examples are multi-column
# panels with their own background, and a panel genuinely IS one
# indivisible picture - so these are cropped as bitmaps rather than
# flowed. What the flow pipeline contributes is knowing where each one
# starts and stops, which is read from the panel headings themselves
# rather than from background colours (a colour is a styling decision
# and changes between chapters; the headings do not).
PANEL_HEAD = re.compile(r"(?i)^(key ideas|building understanding|example\s+\d+|now you try)\b")
PANEL_KIND = [
    ("keyideas", re.compile(r"(?i)^key ideas\b")),
    ("building", re.compile(r"(?i)^building understanding\b")),
    ("example", re.compile(r"(?i)^example\s+\d+\b")),
    ("nowyoutry", re.compile(r"(?i)^now you try\b")),
]
# The Solution column ends and the Explanation column begins here.
# Measured: the solution's algebra runs to x=130 and the explanation's
# prose starts at x=306, with the explanation's own diagrams between
# them at x=178 - so the split belongs just left of those diagrams,
# which illustrate the explanation rather than the working.
SOL_SPLIT_X = 172.0
# Fallback height of the running footer, which is never part of a panel.
# Only used when the footer can't be found by its own text (below) - it
# is a deliberately safe over-estimate, and on this series it cuts 26pt
# above where the footer really starts, which is enough to slice the
# last line off a Key Ideas panel that runs to the bottom of its page.
PAGE_FOOTER_PT = 46.0
# The publisher's strip at the foot of every page. Matching it gives the
# real boundary rather than a guessed one, so a panel can use the full
# height it actually occupies.
FOOTER_TEXT = re.compile(
    r"(?i)(ISBN\s|Cambridge University Press|Photocopying is restricted"
    r"|Essential Mathematics for)"
)
PANEL_HEAD_MIN_SIZE = 11.0
PANEL_CONTINUED = re.compile(r"(?i)continued\s+on\s+next\s+page")
# How close a panel's last line has to be to the bottom edge of its own
# coloured box for the crop to be taken flush with that edge instead of
# tight to the content.
PANEL_FLUSH_PT = 20.0


def footer_top(page):
    """Where this page's running footer starts."""
    ys = []
    for bbox, spans in page_lines(page):
        if bbox.y0 < page.rect.y1 * 0.75:
            continue
        text = "".join(c["c"] for s in spans for c in s.chars)
        if FOOTER_TEXT.search(text):
            ys.append(bbox.y0)
    return min(ys) - 2 if ys else page.rect.y1 - PAGE_FOOTER_PT


def panel_marks(page):
    """Teaching-panel headings on this page, in reading order."""
    out = []
    for bbox, spans in page_lines(page):
        text = "".join(c["c"] for s in spans for c in s.chars).strip()
        size = max((s.size for s in spans), default=0)
        if re.match(r"(?i)^solution\b", text) and size >= 8.0:
            out.append({"y": bbox.y0, "kind": "solution", "text": text})
            continue
        if size < PANEL_HEAD_MIN_SIZE or not PANEL_HEAD.match(text):
            continue
        for kind, pat in PANEL_KIND:
            if pat.match(text):
                out.append({"y": bbox.y0, "kind": kind, "text": text})
                break
    out.sort(key=lambda m: m["y"])
    return out


def content_box(page, y0, y1):
    """The ink actually present in a horizontal band, padded a little.

    Measured rather than assumed so a panel crop is tight on both sides
    without needing this series' margins hard-coded."""
    box = None
    for bbox, _spans in page_lines(page):
        if y0 <= bbox.y0 < y1:
            box = bbox if box is None else (box | bbox)
    for d in page.get_drawings():
        r = fitz.Rect(d["rect"])
        if r.width > 0.9 * page.rect.width or r.height > 0.9 * page.rect.height:
            continue  # page furniture, not content
        if y0 <= r.y0 < y1 and r.width > 2 and r.height > 2:
            box = r if box is None else (box | r)
    for i in page.get_image_info():
        r = fitz.Rect(i["bbox"])
        if y0 <= r.y0 < y1:
            box = r if box is None else (box | r)
    if box is None:
        return None
    return fitz.Rect(
        max(box.x0 - 4, 40), max(box.y0 - 4, y0 - 2),
        min(box.x1 + 4, page.rect.x1 - 40), min(box.y1 + 4, y1),
    )


def panel_floor(page, y):
    """The bottom of the coloured box a panel heading sits in, if any.

    The heading tells us where a panel STARTS; nothing in the text says
    where it stops, so without this a panel runs on to the next heading
    and swallows whatever sits between - on the Building Understanding
    page, a full-width decorative photograph. The panel's own
    background is drawn as one wide rectangle, which is exactly the
    answer, so it is used as a ceiling on the extent measured from the
    text."""
    # Content that a cut here would slice through. The panel's own
    # backgrounds are excluded - they are what we are measuring, and
    # they overlap each other freely.
    items = [b for b, _s in page_lines(page)]
    for d in page.get_drawings():
        r = fitz.Rect(d["rect"])
        if r.width >= 0.55 * page.rect.width and r.height >= 40:
            continue
        items.append(r)
    for i in page.get_image_info():
        items.append(fitz.Rect(i["bbox"]))

    best = None
    for d in page.get_drawings():
        r = fitz.Rect(d["rect"])
        if r.width < 0.55 * page.rect.width or r.width > 0.95 * page.rect.width:
            continue
        if r.height < 40 or r.height > 0.95 * page.rect.height:
            continue
        if not (r.y0 - 8 <= y <= r.y1):
            continue
        # Only a floor that lands in a clear horizontal gap is a real
        # panel edge. These backgrounds are stacked and overlapping, so
        # the lowest one containing a heading is often some enclosing
        # box rather than that heading's own - on a worked example it
        # was the whole page's background, and cutting there sliced the
        # "Now you try" diagrams in half.
        if any(it.y0 < r.y1 + 6 and it.y1 > r.y1 - 6 for it in items):
            continue
        if best is None or r.y1 < best:
            best = r.y1
    return best


def panel_bands(page):
    """The wide coloured rectangles teaching panels are drawn on."""
    out = []
    for d in page.get_drawings():
        if not d.get("fill"):
            continue
        r = fitz.Rect(d["rect"])
        w = r.width / page.rect.width
        if w < 0.55 or w > 0.95:
            continue  # the page's own background, or something inside a panel
        if r.height < 8 or r.height > 0.95 * page.rect.height:
            continue
        out.append(r)
    return out


def band_top_above(bands, y, reach=24.0):
    """The top edge of the coloured box a heading at y sits inside.

    A sub-panel's heading ("Solution", "Now you try") is set a few
    points down from the top of its own box, so cutting the panel above
    it at the heading leaves a sliver of the next box's edge hanging off
    the bottom of the crop. This finds the edge itself to cut at."""
    tops = [b.y0 for b in bands if y - reach <= b.y0 <= y]
    return max(tops) if tops else None


def panel_ink_bottom(page, y0, y1, bands):
    """The lowest real content in a band - backgrounds don't count."""
    bottom = None
    def note(r):
        nonlocal bottom
        if y0 <= r.y0 < y1:
            bottom = r.y1 if bottom is None else max(bottom, r.y1)
    for bbox, spans in page_lines(page):
        text = "".join(c["c"] for s in spans for c in s.chars)
        # The book's own cross-reference to the page turn its layout
        # forced. This booklet reunites the two halves of the working in
        # one column, so the line is not just noise in the crop - it is
        # wrong, pointing at a next page that no longer holds anything.
        if PANEL_CONTINUED.search(text):
            continue
        note(bbox)
    for d in page.get_drawings():
        r = fitz.Rect(d["rect"])
        if r.width > 0.55 * page.rect.width or r.height > 0.9 * page.rect.height:
            continue  # a panel background or page furniture, not content
        if r.width > 2 and r.height > 2:
            note(r)
    for i in page.get_image_info():
        note(fitz.Rect(i["bbox"]))
    return bottom


def panel_frame(page, y0, y1, bands):
    """The crop for one panel, flush with its own coloured background.

    A panel is drawn on a wide coloured rectangle, and that rectangle -
    not the ink inside it - is the edge a reader sees. Measuring the
    crop from ink alone put its left and right wherever the widest glyph
    on that particular panel happened to fall, so no two panels were cut
    at quite the same place; worse, on an Example page it reached past
    the box entirely and took a slice of the video-thumbnail icon
    sitting out in the margin with it.

    Vertically a panel is only sometimes a whole box: an Example's
    question and its worked Solution are two slices of one continuous
    background, so the bottom snaps to a box edge when the content ends
    near one and stays tight to the content when it doesn't."""
    own = [b for b in bands if b.y0 < y1 - 2 and b.y1 > y0 + 2]
    box = content_box(page, y0, y1)
    if box is None or not own:
        return box
    # Only a box edge right about where the panel starts: a heading set
    # part-way down a longer background (a "Now you try" under an
    # Example's working, say) starts where its text does, not at the top
    # of the box it happens to be sitting on. Lowest such edge, so a
    # panel led by a coloured title bar keeps the bar rather than
    # starting below it.
    tops = [b.y0 for b in own if y0 - 12 <= b.y0 <= y0 + 8]
    ink = panel_ink_bottom(page, y0, y1, bands)
    bottom = min(y1, (ink + 4) if ink is not None else y1)
    edges = [b.y1 for b in own if bottom - 4 <= b.y1 <= min(y1, bottom + PANEL_FLUSH_PT)]
    return fitz.Rect(
        min(b.x0 for b in own), min(tops) if tops else y0,
        max(b.x1 for b in own), min(edges) if edges else bottom,
    )


# Below the running head ("668 / Chapter 10 Measurement"), which is page
# furniture rather than content and must not reach a panel crop.
PANEL_TOP_PT = 40.0


def page_panels(page, stop_y, carry=False):
    """The teaching panels on this page as (kind, rect, text) tuples.

    A panel runs from its own heading to the next one. An Example is
    split three ways at its inner headings - the question, then the
    worked Solution/Explanation, then "Now you try" - because those
    three want different treatment: the middle one is what the teacher
    workthrough print blanks out, and the last one is a question the
    student answers and so needs an answer box."""
    marks = [m for m in panel_marks(page) if m["y"] < stop_y]
    if not marks and not carry:
        return []
    # Solution headings subdivide an Example; every other kind starts a
    # new panel, and so ends the one before it.
    breaks = [m["y"] for m in marks if m["kind"] != "solution"] + [stop_y]
    bands = panel_bands(page)
    out = []
    # A worked example routinely straddles a page break in the source:
    # the Example sets the question at the foot of one page and its
    # working runs on over the top of the next, under a "Continued on
    # next page". Whatever sits above this page's first panel heading is
    # that continuation - it is never a panel of its own, because a
    # panel starts at a heading. The loop below only ever reaches a
    # worked answer through the Example heading that owns it, so left to
    # itself it dropped the continuation on the floor and the booklet
    # printed half a solution: part a worked, part b missing.
    #
    # `carry` is the caller's open example. Without it a page that
    # simply opens with leftover prose would have that prose cropped in
    # as if it were somebody's working.
    if carry:
        end = breaks[0]
        if end < stop_y:
            end = band_top_above(bands, end) or end
        lead = next((m for m in marks if m["kind"] == "solution" and m["y"] < end), None)
        top = (band_top_above(bands, lead["y"]) or lead["y"] - 4) if lead else PANEL_TOP_PT
        wbox = panel_frame(page, top, end, bands)
        if wbox and wbox.height > 8:
            out.append(("worked", wbox, lead["text"] if lead else "Solution"))
    for i, m in enumerate(marks):
        if m["kind"] == "solution":
            continue
        end = next(y for y in breaks if y > m["y"] + 1)
        if end < stop_y:
            end = band_top_above(bands, end) or end
        floor = panel_floor(page, m["y"])
        if floor is not None:
            end = min(end, floor + 3)
        if m["kind"] != "example":
            box = panel_frame(page, m["y"] - 4, end, bands)
            if box:
                out.append((m["kind"], box, m["text"]))
            continue
        # An Example: question above its Solution heading, worked
        # answer below it.
        sol = next((s["y"] for s in marks if s["kind"] == "solution"
                    and m["y"] < s["y"] < end), None)
        split = (band_top_above(bands, sol) or sol - 4) if sol else end
        qbox = panel_frame(page, m["y"] - 4, split, bands)
        if qbox:
            out.append(("example", qbox, m["text"]))
        if sol:
            wbox = panel_frame(page, split, end, bands)
            if wbox:
                out.append(("worked", wbox, m["text"]))
    return out


def band_text(page, rect):
    """The plain text inside a rect - used to size a Now-you-try box."""
    out = []
    for bbox, spans in page_lines(page):
        if rect.contains(fitz.Point(bbox.x0 + 1, bbox.y0 + 1)):
            out += [c["c"] for s in spans for c in s.chars]
    return re.sub(r"\s+", " ", "".join(out)).lower()


def rendered_mm(box):
    """How tall a panel crop prints in the booklet, at section scale."""
    if box.width <= 0:
        return 0.0
    return mm(box.height) * (CONTENT_WIDTH_MM * SECTION_SCALE / mm(box.width))


def panel_blocks(page, panels, crops_dir, pid_prefix, state):
    """Crops each teaching panel and returns the blocks that show it.

    A worked Example becomes the renderer's three-image workthrough
    trio: the combined Solution+Explanation strip that normally shows,
    plus the Solution and Explanation halves it fronts for, so the
    "teacher workthrough" print can blank the working and keep the
    explanation. "Now you try" becomes a question with an answer box -
    it is the one part of a worked example the student is meant to do.

    `state` carries the half-finished example across the call, because a
    worked example routinely straddles a page break in the source - the
    Example sets the question at the foot of one page and the "Now you
    try" opens the next. Held per page, that break orphaned the "Now you
    try" from its example: the two were sized separately and the
    landscape layout was free to put them in different columns."""
    blocks = []
    # How much of a sheet the example above this "Now you try" has
    # already used, so its box can be sized to what is left of half a
    # page rather than to a fixed guess - which is what decides whether
    # two worked examples fit on one sheet or only one does.
    trio_mm = state.get("trio_mm", 0.0)
    # An Example, its worked answer and its "Now you try" share an id, so
    # the renderer can size the three of them together - a landscape
    # column has to hold the whole thing, and they have to be scaled as
    # one or the solution comes out a different size from the question.
    group = state.get("group")
    for n, (kind, box, _text) in enumerate(panels):
        base = f"{pid_prefix}p{n}"
        if kind == "example":
            group = base
        # The crop's true printed size, so the renderer can work out how
        # tall it will be at any width without loading the image first.
        size = {"wMm": round(mm(box.width), 2), "hMm": round(mm(box.height), 2)}
        if kind in ("example", "worked"):
            trio_mm += rendered_mm(box)
        if kind == "worked":
            # Combined first, then the two halves it stands in front of.
            split = min(max(SOL_SPLIT_X, box.x0 + 20), box.x1 - 20)
            trio = [
                (f"{base}_work", box),
                (f"{base}_sol", fitz.Rect(box.x0, box.y0, split, box.y1)),
                (f"{base}_exp", fitz.Rect(split, box.y0, box.x1, box.y1)),
            ]
            for cid, r in trio:
                # pad=0: the frame is already flush with the panel's own
                # coloured edge (see panel_frame), and padding it back
                # out would put a sliver of whatever sits beyond that
                # edge - the next panel's box, the margin icons - back
                # into the crop.
                crop_png(page, r, os.path.join(crops_dir, cid + ".png"), pad=0)
            blocks.append({
                "type": "image", "id": trio[0][0], "contentKind": "diagram",
                "teacherSolutionId": trio[1][0], "section": True, **size,
                "exampleId": group,
                # The worked answer belongs with the "Now you try" that
                # follows it, so the pair is never split across a sheet.
                "glueForward": True,
            })
            blocks.append({
                "type": "image", "id": trio[1][0], "contentKind": "diagram",
                "teacherExplanation": trio[2][0], "section": True,
            })
            blocks.append({"type": "image", "id": trio[2][0], "contentKind": "diagram", "section": True})
            continue
        cid = f"{base}_{kind}"
        crop_png(page, box, os.path.join(crops_dir, cid + ".png"), pad=0)
        if kind == "nowyoutry":
            text = band_text(page, box)
            has_figs = bool(page_figures(page, box.y0))
            ws = space_for(working_kind(text, has_figs, False), True)
            # A "Now you try" often sets three lettered triangles, and
            # the whole panel is one bitmap - so its single box is the
            # only place all three answers can go. One question's worth
            # of room for three questions is not enough.
            n = len(part_markers(page_lines(page), box.y0, box.y1)) or 1
            step = RULE_MM if ws["style"] == "lines" else GRID_MM
            want = min(GRID_MM * 12, ws["heightMm"] * n)
            # Half a sheet, less what the example, its worked answer and
            # this panel have already taken, less the margins between
            # them - so the example and the one after it share a page
            # instead of taking one each. Whatever is left over goes to
            # the box: it is the only part of a worked example a student
            # writes in, so it gets the room rather than the sheet.
            room = USABLE_HEIGHT_MM / 2 - (trio_mm + rendered_mm(box)) - 8
            fit = max(step * 2, min(want, int(room / step) * step))
            ws["heightMm"] = fit
            trio_mm = 0.0
            blocks.append({
                "type": "question", "id": cid, "contentKind": "diagram",
                "contextImage": None, "workingSpace": ws, "section": True,
                "exampleId": group, **size,
            })
            group = None
        else:
            blocks.append({"type": "image", "id": cid, "contentKind": "diagram",
                           "section": True, **size,
                           **({"exampleId": group} if kind == "example" else {}),
                           # An Example's question glues to the worked
                           # answer that explains it.
                           **({"glueForward": True} if kind == "example" else {})})
    state["group"] = group
    state["trio_mm"] = trio_mm
    return blocks


def build_flow_document(pdf, first, last, title, out_dir, prefix):
    """Walks a page range and emits the flow document: section headings,
    tier headings and flowquestion blocks, with every figure and inline
    math fragment already cropped into out_dir/crops."""
    doc = fitz.open(pdf)
    crops_dir = os.path.join(out_dir, "crops")
    os.makedirs(crops_dir, exist_ok=True)

    pages = []
    tier = None
    seen_tier = None
    in_exercise = False
    # Ids (and therefore crop filenames) must be scoped per section.
    # Every section restarts its numbering at 1, so a chapter-wide
    # prefix gives 10C's question 3 and 10J's question 3 the same id -
    # and the same crop filename, so the later section silently
    # overwrites the earlier one's figures on disk. The text survives
    # (it lives in the JSON) which makes the failure look like bad
    # figure attribution rather than a name collision.
    sec_prefix = prefix
    pending_title = None
    panel_state = {}
    stats = {"questions": 0, "math": 0, "figures": 0, "sections": 0, "panels": 0}

    for pno in range(first, last + 1):
        page = doc[pno]
        sect = section_title(page)
        blocks = []
        if sect:
            code, text = sect
            tier = None
            seen_tier = None
            in_exercise = False
            sec_prefix = f"{prefix}{(code or 'sec').lower()}_"
            panel_state = {}
            # Held back rather than emitted here. The chapter's own
            # dividers ("Progress quiz", "Applications and problem-
            # solving") are set exactly like section titles, and those
            # pages contribute nothing to this booklet - emitting the
            # heading immediately left them behind as titles with no
            # section under them.
            pending_title = {
                "type": "heading",
                "id": f"{prefix}{(code or 'sec').lower()}_title",
                "text": f"{code} {text}".strip() if code else text,
                "style": "title",
            }

        # Exercise gating. A section runs [title][intro/Key Ideas/worked
        # examples][Exercise NN][questions...], and only that last part
        # is question-shaped. `in_exercise` latches on at the marker and
        # stays on across page breaks (an exercise usually spans several
        # pages with no repeated marker), then clears at the next section
        # title above.
        ex_y = exercise_start_y(page)
        # Teaching panels are read BEFORE the exercise latch flips, and
        # only from the part of the page above the exercise. Once an
        # exercise is running, an "Example 12b" in the margin is a
        # cross-reference tag, not a panel.
        if not in_exercise:
            stop = ex_y if ex_y is not None else footer_top(page)
            # A group left open by the last page is a worked example whose
            # "Now you try" has not been reached yet, so its working runs
            # on over the top of this page (see page_panels).
            found = page_panels(page, stop, carry=bool(panel_state.get("group")))
            if found:
                if pending_title is not None:
                    blocks.append(pending_title)
                    pending_title = None
                    stats["sections"] += 1
                new = panel_blocks(page, found, crops_dir, f"{sec_prefix}{pno}", panel_state)
                stats["panels"] += len(found)
                blocks.extend(new)
        if ex_y is not None:
            in_exercise = True
            y_floor = ex_y
        elif in_exercise:
            y_floor = 0.0
        else:
            y_floor = None

        qs, tier = ([], tier) if y_floor is None else extract_questions(
            doc, pno, crops_dir, sec_prefix, tier, y_floor
        )
        for q in qs:
            if pending_title is not None:
                blocks.append(pending_title)
                pending_title = None
                stats["sections"] += 1
            # One tier heading per run of questions under it, not one per
            # question - the band is a section divider in the source too.
            if q["tier"] and q["tier"] != seen_tier:
                seen_tier = q["tier"]
                label = {
                    "fluency": "Fluency",
                    "problemsolving": "Problem-solving",
                    "reasoning": "Reasoning",
                    "enrichment": "Enrichment",
                }[q["tier"]]
                blocks.append({
                    "type": "heading",
                    "id": f"{q['id']}_tier",
                    "text": label,
                    "style": "tier",
                    "tier": q["tier"],
                })
            assign_working_space(q)
            stats["questions"] += 1
            stats["figures"] += len(q["figures"])
            stats["math"] += sum(1 for r in q["stem"] if "m" in r)
            stats["math"] += sum(1 for p in q["parts"] for r in p["content"] if "m" in r)
            blocks.append(q)

        if blocks:
            pages.append({"blocks": blocks})

    return {
        "title": title,
        "flowVersion": 1,
        "pages": pages,
    }, stats


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--pages", required=True, help="0-based inclusive page range, e.g. 15-74")
    ap.add_argument("--title", required=True)
    ap.add_argument("--prefix", default="f_", help="id prefix for this chapter's blocks")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--project-id", help="reuse an existing project id instead of minting one")
    ap.add_argument(
        "--landscape-teaching",
        action="store_true",
        help="default this chapter to two-up A5 teaching sheets on A4 landscape",
    )
    args = ap.parse_args()

    first, last = (int(x) for x in args.pages.split("-"))
    pid = args.project_id or uuid.uuid4().hex[:12]
    out_dir = os.path.join(args.data_dir, pid)
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    wb, stats = build_flow_document(args.pdf, first, last, args.title, out_dir, args.prefix)
    wb["buildVersion"] = uuid.uuid4().hex[:8]
    if args.landscape_teaching:
        wb["landscapeTeaching"] = True
    with open(os.path.join(out_dir, "workbook.json"), "w", encoding="utf-8") as f:
        json.dump(wb, f, ensure_ascii=False, indent=1)

    index_path = os.path.join(args.data_dir, "index.json")
    index = json.load(open(index_path, encoding="utf-8")) if os.path.exists(index_path) else []
    index = [e for e in index if e["id"] != pid]
    index.append({"id": pid, "title": args.title})
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    print(
        f"wrote {out_dir}: {stats['sections']} sections, {stats['questions']} questions, "
        f"{stats['figures']} figures, {stats['panels']} teaching panels, "
        f"{stats['math']} inline math crops, id={pid}"
    )
    if LOST_LABELS:
        print("\nWARNING: diagram labels that reached neither the crop nor")
        print("the text. Each is a measurement missing from the page - check")
        print("the figure's cell and what is blocking absorb_labels:")
        for line in LOST_LABELS:
            print(f"  {line}")
    if UNMAPPED_PUA:
        print("\nWARNING: unmapped private-use glyphs reached the text.")
        print("Each is a character missing from the prose. Render it, read")
        print("it, and add it to PUA_GLYPHS before shipping this chapter:")
        for (font, code), n in sorted(UNMAPPED_PUA.items(), key=lambda kv: -kv[1]):
            print(f"  {n:5d}x  {font:18s} {code:#06x}")


if __name__ == "__main__":
    main()
