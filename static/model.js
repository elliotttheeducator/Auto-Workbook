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
// vs combined, working-space style/size/columns) - the only state that
// needs to survive a reload. Deliberately never the page/block content
// itself (crops, ids, text): that always comes fresh from workbook.json,
// so a content or crop fix pushed to the repo is visible immediately,
// even to a browser that already saved edits for this project.
export function extractOverrides(workbook) {
  const blockWorkingSpace = {};
  for (const page of workbook.pages) {
    for (const b of page.blocks) {
      if (b.type === "question") blockWorkingSpace[b.id] = b.workingSpace;
    }
  }
  return {
    groupLayout: { ...(workbook.groupLayout || {}) },
    combinedBlocks: { ...(workbook.combinedBlocks || {}) },
    blockWorkingSpace,
  };
}

// Layers previously-saved overrides onto a freshly-fetched workbook, in
// place - skipping any group/block id the fresh content no longer has,
// so a removed or renamed block can never leave a dangling override
// pointing at nothing.
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
  if (overrides.blockWorkingSpace) {
    for (const page of workbook.pages) {
      for (const b of page.blocks) {
        if (b.type === "question" && overrides.blockWorkingSpace[b.id]) {
          b.workingSpace = overrides.blockWorkingSpace[b.id];
        }
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
