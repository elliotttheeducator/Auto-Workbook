export const PAGE_WIDTH_MM = 210;
export const PAGE_HEIGHT_MM = 297;
export const PAGE_MARGIN_MM = 12;
export const CONTENT_WIDTH_MM = PAGE_WIDTH_MM - 2 * PAGE_MARGIN_MM;

export const GRID_MM = 5;
export const RULE_MM = 10;

// Largest multiple of GRID_MM that fits inside the content area, so the
// box's own right edge always lands exactly on a gridline.
export const BOX_WIDTH_MM = Math.floor(CONTENT_WIDTH_MM / GRID_MM) * GRID_MM;

export const SIZE_PRESETS_MM = { small: 20, medium: 40, large: 60 };

export function snapDown(valueMm, spacingMm) {
  const steps = Math.max(1, Math.floor(valueMm / spacingMm));
  return steps * spacingMm;
}

function canShrinkWorkingSpace(ws) {
  if (!ws || ws.style === "none") return false;
  const floor = ws.style === "lines" ? RULE_MM * 2 : SIZE_PRESETS_MM.small;
  return ws.heightMm > floor;
}

function shrinkWorkingSpaceOneStep(ws) {
  if (!canShrinkWorkingSpace(ws)) return false;
  if (ws.style === "lines") {
    ws.heightMm = Math.max(RULE_MM * 2, ws.heightMm - RULE_MM);
    return true;
  }
  const smallerPresets = Object.values(SIZE_PRESETS_MM).filter((mm) => mm < ws.heightMm);
  ws.heightMm = smallerPresets.length ? Math.max(...smallerPresets) : SIZE_PRESETS_MM.small;
  return true;
}

// A diagram/crop renders at this percentage of its container's width
// (100 = full). The +/- control's own floor/ceiling - deliberately wide
// (a shrunk-down diagram symbol can want to go well under half size; an
// oversized one is a real, if riskier, way to make a single sparse
// question read as less empty) - this is just how far a step can push a
// diagram, not what it starts at unset (see DEFAULT_SPLIT_SCALE_2/_3/
// DEFAULT_COMBINED_SCALE below for that).
export const IMAGE_SCALE_MAX = 200;
export const IMAGE_SCALE_MIN = 10;
// 5% - fine enough to nudge a diagram without the jumps themselves
// being the reason it doesn't quite fit.
export const IMAGE_SCALE_STEP = 5;

// What a diagram renders at before anyone has touched its own +/-
// control - four buckets, tunable workbook-wide from the top of the
// editor (see the default-scale controls in app.js) rather than fixed
// forever the moment a chapter's built:
//   - split: one part of a multi-part question in "split" layout.
//   - section: a Key Ideas summary or worked-example diagram (see the
//     "section" flag below) - informational content, not a question a
//     student answers, so it wants its own starting point separate from
//     an actual question's combined/standalone crop.
//   - answers: an answer-key page image (see the "answers" flag below) -
//     these used to render at a fixed real-world mm width (matching the
//     source PDF exactly) with no way to shrink them at all; now just
//     another adjustable bucket, so a chapter's answer pages can
//     actually be packed onto fewer sheets.
//   - combined: everything else - a combined group's whole-question
//     crop, a standalone single question, or a plain diagram-only image
//     with none of the above flags.
// Split parts default smaller the more of them share a row - a 3-across
// row (Building Understanding/Fluency's usual shape) has less width per
// part to begin with, so its parts need to start further down than a
// 2-across row's do for a freshly-built chapter to already read as
// "basically done" before anyone touches an individual +/- control.
export const DEFAULT_SPLIT_SCALE_2 = 40;
export const DEFAULT_SPLIT_SCALE_3 = 50;
export const DEFAULT_SECTION_SCALE = 70;
// Percentage of an *answer row's own column* (see buildAnswerRowUnit in
// render.js - two answer-key images share one row, each in a ~half-
// width column, the same two-up layout a split question's parts already
// use), not of the full page width the way it was before that changed.
// Set to 100% (full column width) per explicit request - answers should
// read at full size by default, not pre-shrunk; a chapter whose answer
// pages don't fit one sheet at this size can still be shrunk from the
// editor's own per-image scale control.
export const DEFAULT_ANSWERS_SCALE = 100;
export const DEFAULT_COMBINED_SCALE = 100;

function findBlockById(workbook, id) {
  for (const page of workbook.pages) {
    for (const b of page.blocks) if (b.id === id) return b;
  }
  return null;
}

// Building Understanding and Fluency groups default to 3 parts per split
// row, everything else to 2 - see groupLayoutPickerHtml/renderGroup in
// render.js, the actual consumer. Lives here (not render.js) so both
// render.js and defaultScaleFor/resolveSplitColumns below - and app.js,
// for the click-time +/- controls - share exactly one source of truth for
// "how many columns does this group render at by default."
export function defaultSplitColumnsFor(gid, tier) {
  return /bu\d/.test(gid) || tier === "fluency" ? 3 : 2;
}

// The actual split-column count a group renders at: whatever the user
// explicitly picked (workbook.groupSplitColumns), else the tier-based
// starting point above. Needed anywhere a split part's default scale has
// to be derived from scratch (see defaultScaleFor) rather than read off
// the splitColumns a render pass already resolved for itself.
export function resolveSplitColumns(workbook, gid, tier) {
  return workbook.groupSplitColumns?.[gid] || defaultSplitColumnsFor(gid, tier);
}

// The split-scale default depends on how many parts share a row (see
// DEFAULT_SPLIT_SCALE_2/_3 above) - "split2" applies at 1-2 columns,
// "split3" at 3 or more (a 4-split row is rare enough not to warrant its
// own bucket, and reads fine at the 3-up size). `scales` is an already-
// resolved resolvedDefaultScales() result.
export function splitScaleFor(scales, splitColumns) {
  return splitColumns >= 3 ? scales.split3 : scales.split2;
}

// Which of the five workbook-wide defaults above applies to a given
// block/group. Needed by app.js at click time (a step-image-scale or
// squeeze-in action only has a bare (kind, id) to work from, not the
// render-time context that already knows which bucket applies) -
// render.js itself never needs this, since it already knows structurally
// which bucket applies at each call site. `tier` is the caller's best
// guess at the block's tier (see buildFilterContext in render.js) - only
// needed to pick the split part's own column count when it hasn't been
// explicitly set; every other bucket ignores it.
export function defaultScaleFor(workbook, kind, id, tier) {
  const scales = resolvedDefaultScales(workbook);
  if (kind === "group") return scales.combined;
  const gid = groupIdFor(id);
  const isSplitPart = !!gid && (workbook.groupLayout?.[gid] || "split") !== "combined";
  if (isSplitPart) return splitScaleFor(scales, resolveSplitColumns(workbook, gid, tier));
  const block = findBlockById(workbook, id);
  if (block?.section) return scales.section;
  if (block?.answers) return scales.answers;
  return scales.combined;
}

// All the workbook-wide defaults resolved together, with fallbacks
// applied once - render.js computes this a single time per render
// rather than re-deriving it per block, since (unlike defaultScaleFor)
// it already knows structurally which bucket applies at each call site.
// split2/split3 are two independent buckets (not one "split" bucket
// picked by column count) so each has its own stepper in the settings
// bar and its own override, matching how differently-sized rows actually
// need to be tuned.
export function resolvedDefaultScales(workbook) {
  const defaults = workbook.defaultScales || {};
  return {
    split2: defaults.split2 ?? DEFAULT_SPLIT_SCALE_2,
    split3: defaults.split3 ?? DEFAULT_SPLIT_SCALE_3,
    section: defaults.section ?? DEFAULT_SECTION_SCALE,
    answers: defaults.answers ?? DEFAULT_ANSWERS_SCALE,
    combined: defaults.combined ?? DEFAULT_COMBINED_SCALE,
  };
}

// Any *automatic* shrink (squeeze-in, Auto-fit, section compaction) stops
// here by default, well short of IMAGE_SCALE_MIN - a diagram the system
// shrinks on its own without being asked about each one specifically
// shouldn't end up too small to read just because it technically still
// could shrink further. A manual +/- click is a deliberate, one-at-a-time
// choice and stays exempt (see app.js's step-image-scale handler, the one
// call site that passes IMAGE_SCALE_MIN through explicitly instead).
export const READABILITY_FLOOR_SCALE = 55;

function canShrinkImage(entry, defaultScale, floor = READABILITY_FLOOR_SCALE) {
  return (entry.imageScale ?? defaultScale) > floor;
}

export function shrinkImageOneStep(entry, defaultScale, floor = READABILITY_FLOOR_SCALE) {
  if (!canShrinkImage(entry, defaultScale, floor)) return false;
  entry.imageScale = Math.max(floor, (entry.imageScale ?? defaultScale) - IMAGE_SCALE_STEP);
  return true;
}

export function growImageOneStep(entry, defaultScale) {
  const current = entry.imageScale ?? defaultScale;
  if (current >= IMAGE_SCALE_MAX) return false;
  entry.imageScale = Math.min(IMAGE_SCALE_MAX, current + IMAGE_SCALE_STEP);
  return true;
}

// Shared between render.js (deciding whether a "squeeze in" prompt would
// actually do anything before offering it) and app.js (acting on a
// click) - a single source of truth for "is there room to shrink this
// entry further," so the two can never disagree about it. `entry` is
// whatever owns a working space and a diagram - a question block, or a
// group's combinedBlocks entry. `defaultScale` is whichever of the four
// workbook-wide defaults applies to this entry (see defaultScaleFor/
// resolvedDefaultScales above) - always required now that "unset" no
// longer means a single fixed constant.
export function canShrink(entry, defaultScale, floor = READABILITY_FLOOR_SCALE) {
  return !!entry && (canShrinkImage(entry, defaultScale, floor) || canShrinkWorkingSpace(entry.workingSpace));
}

// Diagram first, then working space - shrinking the diagram is usually
// the more useful step, so a single generic "shrink" action (the
// squeeze-in prompt) reaches for it before falling back to trimming the
// answer box. Returns false (no-op) when canShrink() would already say
// there's nothing left to shrink.
export function shrinkOneStep(entry, defaultScale, floor = READABILITY_FLOOR_SCALE) {
  if (!entry) return false;
  if (shrinkImageOneStep(entry, defaultScale, floor)) return true;
  return shrinkWorkingSpaceOneStep(entry.workingSpace);
}

// Question ids follow "<prefix><digits><letter>" (e.g. ex1a, ex1b) - the
// same convention the sibling tutoring project uses. The group id is
// never stored, always derived from the id.
export function groupIdFor(id) {
  const m = id.match(/^(.+?)(\d+)([a-zA-Z])$/);
  return m ? m[1] + m[2] : null;
}

// Clusters consecutive question blocks that share a group id. A run of
// length 1 is just rendered as a normal single block - grouping only
// matters once there are 2+ parts to toggle between split/combined.
export function iterRenderUnits(blocks) {
  const units = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    // A decorative photo/diagram meant to sit beside a run of standalone
    // questions (not stacked above/below them, and not sliced into one
    // fragment per question - see besideQuestions in add_chapter.py) -
    // only actually forms a unit when the very next blocks are exactly
    // those questions, in that order; otherwise the data doesn't match
    // what this image thinks it's beside, and it falls through to
    // ordinary single-block handling instead of silently eating blocks
    // that don't belong to it.
    if (b.type === "image" && Array.isArray(b.besideQuestions) && b.besideQuestions.length) {
      const matched = [];
      let j = i + 1;
      for (const wantId of b.besideQuestions) {
        const next = blocks[j];
        if (!next || next.type !== "question" || next.id !== wantId) break;
        matched.push(next);
        j++;
      }
      if (matched.length === b.besideQuestions.length) {
        units.push({ kind: "sideImage", imageBlock: b, blocks: matched });
        i = j;
        continue;
      }
    }
    // A worked example's ordinary, seamless Solution+Explanation image
    // (see teacherSolutionId in add_chapter.py), immediately followed by
    // the Solution/Explanation crop pair it stands in front of normally -
    // same exact-match discipline as besideQuestions above, so a
    // combined image with no matching pair right behind it just falls
    // through to rendering as a plain image instead of silently being
    // treated as the front of a trio that doesn't exist. The combined
    // image is what actually shows, on screen and in a plain print/
    // export alike; only the "teacher workthrough" print toggle ever
    // swaps it out for the Solution (blanked)/Explanation pair - see the
    // "workthrough" branch in render.js, which renders all three
    // unconditionally and leaves the swap to a print-only CSS rule.
    if (b.type === "image" && b.teacherSolutionId) {
      const sol = blocks[i + 1];
      const expl = sol && sol.type === "image" && sol.teacherExplanation ? blocks[i + 2] : null;
      if (sol && sol.type === "image" && sol.id === b.teacherSolutionId && expl && expl.type === "image" && expl.id === sol.teacherExplanation) {
        units.push({ kind: "workthrough", combinedBlock: b, solutionBlock: sol, explanationBlock: expl });
        i += 3;
        continue;
      }
    }
    if (b.type !== "question") {
      units.push({ kind: "single", blocks: [b] });
      i++;
      continue;
    }
    const gid = groupIdFor(b.id);
    if (!gid) {
      units.push({ kind: "single", blocks: [b] });
      i++;
      continue;
    }
    const members = [b];
    let j = i + 1;
    while (j < blocks.length && blocks[j].type === "question" && groupIdFor(blocks[j].id) === gid) {
      members.push(blocks[j]);
      j++;
    }
    if (members.length > 1) {
      units.push({ kind: "group", gid, blocks: members });
    } else {
      units.push({ kind: "single", blocks: [b] });
    }
    i = j;
  }
  return units;
}

// Everything a user can change through the editor's own controls (split
// vs combined, working-space style/size/columns, diagram scale, manual
// page breaks) - the only state that needs to survive a reload.
// Deliberately never the page/block content itself (crops, ids, text):
// that always comes fresh from workbook.json, so a content or crop fix
// pushed to the repo is visible immediately, even to a browser that
// already saved edits for this project.
export function extractOverrides(workbook) {
  const blockOverrides = {};
  for (const page of workbook.pages) {
    for (const b of page.blocks) {
      // Every block type can carry a manual page break; images (and
      // questions) can also carry a diagram scale; only questions have
      // a working space. Capturing per type here, rather than only for
      // "question", is what lets a heading's or plain image's own
      // overrides survive a reload too.
      const o = {};
      if (b.type === "question") {
        o.workingSpace = b.workingSpace;
        // Whether this standalone question asked to share a half-width
        // row with whichever one follows it (see pairWithNextControlHtml/
        // pairQuestionUnits in render.js) - only meaningful on a question
        // with no letter suffix (never grouped), but harmless to always
        // capture here same as every other per-block override.
        o.pairWithNext = b.pairWithNext;
      }
      if (b.type === "flowquestion") {
        // How many parts sit on each row of this question's grid, as an
        // array like [1, 2, 2]. A real layout decision rather than a
        // derived one: which parts share a row depends on where the
        // diagrams fall on the page, which only the person looking at
        // the page can see - so it persists like any other edit.
        o.rowPattern = b.rowPattern;
        // The answer boxes belonging to this question's parts, keyed by
        // part letter ("a") or sub-item path ("a.i") - present only for
        // the ones someone has resized by hand (see step-part-height in
        // app.js); the rest keep the height the build measured for them.
        o.partSpaces = b.partSpaces;
      }
      if (b.type === "question" || b.type === "image") {
        o.imageScale = b.imageScale;
        // A manually re-cropped PNG (see crop.js), stored as a data: URL
        // - present only once a user has actually used the crop tool on
        // this specific block, same "undefined means untouched" pattern
        // as imageScale. manualCropRect travels with it - the selection
        // (as a %-of-original rect) that produced manualCropSrc, so
        // reopening the crop tool later can start from where this
        // selection actually was instead of the full image every time.
        o.manualCropSrc = b.manualCropSrc;
        o.manualCropRect = b.manualCropRect;
      }
      o.breakBefore = b.breakBefore;
      blockOverrides[b.id] = o;
    }
  }
  // structuredClone, not a shallow {...spread} - a workingSpace object
  // (nested inside blockOverrides/combinedBlocks) would otherwise still
  // be the *same* object the live workbook keeps mutating in place (see
  // shrinkWorkingSpaceOneStep), so anything holding onto this result
  // past the current tick - Auto-fit's own pre-run snapshot for its Undo
  // button, notably - would silently see its "before" picture keep
  // changing along with the live document instead of staying frozen.
  return structuredClone({
    groupLayout: workbook.groupLayout || {},
    groupSplitColumns: workbook.groupSplitColumns || {},
    // Body text size for a flow chapter (see flowBodyPt in render.js).
    // A real document setting - it changes how text wraps and therefore
    // how the chapter paginates - so it persists like any other edit.
    flowBodyPt: workbook.flowBodyPt,
    combinedBlocks: workbook.combinedBlocks || {},
    blockOverrides,
    // Both 100% user-authored (no shipped server-side default either
    // could ever mask), so unlike groupLayout there's nothing to lose by
    // saving the whole thing every time.
    tierFilters: workbook.tierFilters || { global: {}, chapters: {} },
    deletedIds: workbook.deletedIds || [],
    defaultScales: workbook.defaultScales || {},
  });
}

// Layers previously-saved overrides onto a freshly-fetched workbook, in
// place - skipping any group/block id the fresh content no longer has,
// so a removed or renamed block can never leave a dangling override
// pointing at nothing. Also reads the pre-imageScale/breakBefore
// "blockWorkingSpace" shape some already-saved overrides may still be
// in, so upgrading doesn't reset anyone's saved sizes back to default.
export function applyOverrides(workbook, overrides) {
  if (!overrides) return workbook;
  if (overrides.groupLayout) {
    for (const gid of Object.keys(overrides.groupLayout)) {
      if (workbook.groupLayout && gid in workbook.groupLayout) {
        workbook.groupLayout[gid] = overrides.groupLayout[gid];
      }
    }
  }
  if (overrides.flowBodyPt !== undefined && overrides.flowBodyPt !== null) {
    workbook.flowBodyPt = overrides.flowBodyPt;
  }
  if (overrides.groupSplitColumns) {
    workbook.groupSplitColumns = workbook.groupSplitColumns || {};
    for (const gid of Object.keys(overrides.groupSplitColumns)) {
      workbook.groupSplitColumns[gid] = overrides.groupSplitColumns[gid];
    }
  }
  if (overrides.combinedBlocks) {
    for (const gid of Object.keys(overrides.combinedBlocks)) {
      if (workbook.combinedBlocks && gid in workbook.combinedBlocks) {
        workbook.combinedBlocks[gid] = overrides.combinedBlocks[gid];
      }
    }
  }
  if (overrides.tierFilters) workbook.tierFilters = overrides.tierFilters;
  if (overrides.deletedIds) workbook.deletedIds = overrides.deletedIds;
  if (overrides.defaultScales) workbook.defaultScales = overrides.defaultScales;

  const blockOverrides = overrides.blockOverrides || {};
  const legacyBlockWorkingSpace = overrides.blockWorkingSpace || {};
  for (const page of workbook.pages) {
    for (const b of page.blocks) {
      const o = blockOverrides[b.id];
      if (o) {
        if (o.workingSpace && b.type === "question") b.workingSpace = o.workingSpace;
        if (o.pairWithNext !== undefined) b.pairWithNext = o.pairWithNext;
        if (o.imageScale !== undefined) b.imageScale = o.imageScale;
        if (o.manualCropSrc !== undefined) b.manualCropSrc = o.manualCropSrc;
        if (o.manualCropRect !== undefined) b.manualCropRect = o.manualCropRect;
        if (o.breakBefore !== undefined) b.breakBefore = o.breakBefore;
        if (o.rowPattern !== undefined && b.type === "flowquestion") b.rowPattern = o.rowPattern;
        if (o.partSpaces !== undefined && b.type === "flowquestion") b.partSpaces = o.partSpaces;
      } else if (b.type === "question" && legacyBlockWorkingSpace[b.id]) {
        b.workingSpace = legacyBlockWorkingSpace[b.id];
      }
    }
  }
  return workbook;
}

// The four tier headings a question can sit under - the only sections
// the odds/evens paper-saving filters apply to (a warmup section like
// Building Understanding has no tier, and is never filtered).
export const TIERS = ["fluency", "problemsolving", "reasoning", "enrichment"];
export const FILTER_MODES = ["all", "odds", "evens"];

// A chapter's own filter choice wins over the workbook-wide one when
// it's been explicitly set; otherwise the chapter just follows whatever
// the top-of-workbook button says. workbook.tierFilters is entirely
// user-authored (there's no shipped default to layer onto, unlike
// groupLayout) - always safe to persist and restore in full, so unlike
// touchedGroupLayoutIds there's no "only save what was touched" concern
// here.
export function effectiveTierFilter(workbook, chapterId, tier) {
  const chapterMode = workbook.tierFilters?.chapters?.[chapterId]?.[tier];
  if (chapterMode) return chapterMode;
  return workbook.tierFilters?.global?.[tier] || "all";
}

// 1-based position, within whatever set it's being counted among (every
// sibling question in a (chapter, tier) pair for a whole question, or
// every sibling part within one group for Fluency's sub-part filter) -
// "odds" keeps position 1, 3, 5..., "evens" keeps 2, 4, 6....
export function passesTierFilter(mode, position) {
  if (mode === "odds") return position % 2 === 1;
  if (mode === "evens") return position % 2 === 0;
  return true;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
