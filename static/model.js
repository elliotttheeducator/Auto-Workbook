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
// diagram, not what it starts at unset (see DEFAULT_SPLIT_SCALE/
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
export const DEFAULT_SPLIT_SCALE = 70;
export const DEFAULT_SECTION_SCALE = 70;
// Percentage of an *answer row's own column* now (see buildAnswerRowUnit
// in render.js - two answer-key images share one row, each in a ~half-
// width column, the same two-up layout a split question's parts already
// use), not of the full page width the way it was before that changed.
// Verified against this project's actual answer pages, in that two-up
// layout: 55% keeps every "X Answers" section on one physical sheet
// while still reading as a reasonably-sized crop, not a postage stamp;
// 65%+ starts pushing the two busiest chapters (three separate answer
// images each) back onto two sheets.
export const DEFAULT_ANSWERS_SCALE = 55;
export const DEFAULT_COMBINED_SCALE = 100;

function findBlockById(workbook, id) {
  for (const page of workbook.pages) {
    for (const b of page.blocks) if (b.id === id) return b;
  }
  return null;
}

// Which of the four workbook-wide defaults above applies to a given
// block/group. Needed by app.js at click time (a step-image-scale or
// squeeze-in action only has a bare (kind, id) to work from, not the
// render-time context that already knows which bucket applies) -
// render.js itself never needs this, since it already knows structurally
// which bucket applies at each call site.
export function defaultScaleFor(workbook, kind, id) {
  const defaults = workbook.defaultScales || {};
  if (kind === "group") return defaults.combined ?? DEFAULT_COMBINED_SCALE;
  const gid = groupIdFor(id);
  const isSplitPart = !!gid && (workbook.groupLayout?.[gid] || "split") !== "combined";
  if (isSplitPart) return defaults.split ?? DEFAULT_SPLIT_SCALE;
  const block = findBlockById(workbook, id);
  if (block?.section) return defaults.section ?? DEFAULT_SECTION_SCALE;
  if (block?.answers) return defaults.answers ?? DEFAULT_ANSWERS_SCALE;
  return defaults.combined ?? DEFAULT_COMBINED_SCALE;
}

// All four workbook-wide defaults resolved together, with fallbacks
// applied once - render.js computes this a single time per render
// rather than re-deriving it per block, since (unlike defaultScaleFor)
// it already knows structurally which of the four applies at each call
// site.
export function resolvedDefaultScales(workbook) {
  const defaults = workbook.defaultScales || {};
  return {
    split: defaults.split ?? DEFAULT_SPLIT_SCALE,
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
