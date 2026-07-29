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
export const IMAGE_SCALE_STEP = 15;

// What a diagram renders at before anyone has touched its own +/-
// control - three buckets, tunable workbook-wide from the top of the
// editor (see the default-scale controls in app.js) rather than fixed
// forever the moment a chapter's built:
//   - split: one part of a multi-part question in "split" layout.
//   - section: a Key Ideas summary or worked-example diagram (see the
//     "section" flag below) - informational content, not a question a
//     student answers, so it wants its own starting point separate from
//     an actual question's combined/standalone crop.
//   - combined: everything else - a combined group's whole-question
//     crop, a standalone single question, or a plain diagram-only image
//     with no "section" flag.
export const DEFAULT_SPLIT_SCALE = 70;
export const DEFAULT_SECTION_SCALE = 70;
export const DEFAULT_COMBINED_SCALE = 100;

function findBlockById(workbook, id) {
  for (const page of workbook.pages) {
    for (const b of page.blocks) if (b.id === id) return b;
  }
  return null;
}

// Which of the three workbook-wide defaults above applies to a given
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
  return defaults.combined ?? DEFAULT_COMBINED_SCALE;
}

// All three workbook-wide defaults resolved together, with fallbacks
// applied once - render.js computes this a single time per render
// rather than re-deriving it per block, since (unlike defaultScaleFor)
// it already knows structurally which of the three applies at each call
// site.
export function resolvedDefaultScales(workbook) {
  const defaults = workbook.defaultScales || {};
  return {
    split: defaults.split ?? DEFAULT_SPLIT_SCALE,
    section: defaults.section ?? DEFAULT_SECTION_SCALE,
    combined: defaults.combined ?? DEFAULT_COMBINED_SCALE,
  };
}

function canShrinkImage(entry, defaultScale) {
  return (entry.imageScale ?? defaultScale) > IMAGE_SCALE_MIN;
}

export function shrinkImageOneStep(entry, defaultScale) {
  if (!canShrinkImage(entry, defaultScale)) return false;
  entry.imageScale = Math.max(IMAGE_SCALE_MIN, (entry.imageScale ?? defaultScale) - IMAGE_SCALE_STEP);
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
// group's combinedBlocks entry. `defaultScale` is whichever of the two
// workbook-wide defaults applies to this entry (see defaultScaleFor/
// resolvedDefaultScales above) - always required now that "unset" no
// longer means a single fixed constant.
export function canShrink(entry, defaultScale) {
  return !!entry && (canShrinkImage(entry, defaultScale) || canShrinkWorkingSpace(entry.workingSpace));
}

// Diagram first, then working space - shrinking the diagram is usually
// the more useful step, so a single generic "shrink" action (the
// squeeze-in prompt) reaches for it before falling back to trimming the
// answer box. Returns false (no-op) when canShrink() would already say
// there's nothing left to shrink.
export function shrinkOneStep(entry, defaultScale) {
  if (!entry) return false;
  if (shrinkImageOneStep(entry, defaultScale)) return true;
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
      if (b.type === "question") o.workingSpace = b.workingSpace;
      if (b.type === "question" || b.type === "image") o.imageScale = b.imageScale;
      o.breakBefore = b.breakBefore;
      blockOverrides[b.id] = o;
    }
  }
  return {
    groupLayout: { ...(workbook.groupLayout || {}) },
    combinedBlocks: { ...(workbook.combinedBlocks || {}) },
    blockOverrides,
    // Both 100% user-authored (no shipped server-side default either
    // could ever mask), so unlike groupLayout there's nothing to lose by
    // saving the whole thing every time.
    tierFilters: workbook.tierFilters || { global: {}, chapters: {} },
    deletedIds: [...(workbook.deletedIds || [])],
    defaultScales: { ...(workbook.defaultScales || {}) },
  };
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
        if (o.imageScale !== undefined) b.imageScale = o.imageScale;
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
