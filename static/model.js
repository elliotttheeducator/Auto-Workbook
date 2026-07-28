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
// (100 = full, i.e. unset/default). Diagrams, not working space, are
// usually the bigger lever for fitting more onto a page - a whole-page-
// wide diagram scaled to 70% frees up real room, where trimming a grid
// box from Large to Medium barely moves the needle.
export const IMAGE_SCALE_MAX = 100;
export const IMAGE_SCALE_MIN = 40;
export const IMAGE_SCALE_STEP = 15;

function canShrinkImage(entry) {
  return (entry.imageScale ?? IMAGE_SCALE_MAX) > IMAGE_SCALE_MIN;
}

export function shrinkImageOneStep(entry) {
  if (!canShrinkImage(entry)) return false;
  entry.imageScale = Math.max(IMAGE_SCALE_MIN, (entry.imageScale ?? IMAGE_SCALE_MAX) - IMAGE_SCALE_STEP);
  return true;
}

export function growImageOneStep(entry) {
  const current = entry.imageScale ?? IMAGE_SCALE_MAX;
  if (current >= IMAGE_SCALE_MAX) return false;
  entry.imageScale = Math.min(IMAGE_SCALE_MAX, current + IMAGE_SCALE_STEP);
  return true;
}

// Shared between render.js (deciding whether a "squeeze in" prompt would
// actually do anything before offering it) and app.js (acting on a
// click) - a single source of truth for "is there room to shrink this
// entry further," so the two can never disagree about it. `entry` is
// whatever owns a working space and a diagram - a question block, or a
// group's combinedBlocks entry.
export function canShrink(entry) {
  return !!entry && (canShrinkImage(entry) || canShrinkWorkingSpace(entry.workingSpace));
}

// Diagram first, then working space - shrinking the diagram is usually
// the more useful step (see IMAGE_SCALE_MAX above), so a single generic
// "shrink" action (the squeeze-in prompt) reaches for it before falling
// back to trimming the answer box. Returns false (no-op) when
// canShrink() would already say there's nothing left to shrink.
export function shrinkOneStep(entry) {
  if (!entry) return false;
  if (shrinkImageOneStep(entry)) return true;
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

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
