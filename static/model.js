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

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
