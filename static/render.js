// Builds the exact same DOM for on-screen editing and for print export -
// there is no separate print layout; @media print in app.css just hides
// the controls (topbar, pickers, layout radios) on this same markup, so
// what you see in the booklet view is what prints.
import {
  BOX_WIDTH_MM,
  GRID_MM,
  RULE_MM,
  SIZE_PRESETS_MM,
  escapeHtml,
  iterRenderUnits,
  snapDown,
} from "./model.js";

function cropHtml(cropsBaseUrl, crop, contextImage, widthMm) {
  let contextHtml = "";
  if (contextImage) {
    contextHtml = `<img src="${escapeHtml(cropsBaseUrl)}/${escapeHtml(contextImage)}.png">`;
  }
  const style = widthMm ? ` style="width:${widthMm}mm"` : "";
  return `<div class="block-crop"${style}>${contextHtml}<img src="${escapeHtml(cropsBaseUrl)}/${escapeHtml(crop)}.png"></div>`;
}

function ruleLinesHtml(height, spacing) {
  let inner = "";
  for (let y = spacing; y < height; y += spacing) {
    inner += `<div class="rule-line" style="top:${y}mm"></div>`;
  }
  return inner;
}

function gridBoxHtml(height, spacing) {
  let inner = "";
  for (let x = spacing; x < BOX_WIDTH_MM; x += spacing) {
    inner += `<div class="grid-line-v" style="left:${x}mm"></div>`;
  }
  for (let y = spacing; y < height; y += spacing) {
    inner += `<div class="grid-line-h" style="top:${y}mm"></div>`;
  }
  return `<div class="working-space" style="height:${height}mm">${inner}</div>`;
}

function workingSpaceHtml(ws) {
  if (ws.style === "none") return "";
  const spacing = ws.style === "lines" ? RULE_MM : GRID_MM;
  const height = snapDown(ws.heightMm, spacing);
  if (ws.style === "grid") return gridBoxHtml(height, spacing);
  if (ws.columns === 2) {
    const col = `<div class="working-space" style="height:${height}mm">${ruleLinesHtml(height, spacing)}</div>`;
    return `<div class="working-space-row">${col}${col}</div>`;
  }
  return `<div class="working-space" style="height:${height}mm">${ruleLinesHtml(height, spacing)}</div>`;
}

function stylePickerHtml(target, kind, activeStyle) {
  const opts = [
    ["none", "None"],
    ["grid", "Grid"],
    ["lines", "Written response"],
  ];
  const buttons = opts
    .map(
      ([value, label]) =>
        `<button class="${activeStyle === value ? "active" : ""}" data-action="set-style" data-target="${target}" data-kind="${kind}" data-style="${value}">${label}</button>`
    )
    .join("");
  return `<div class="style-picker">${buttons}</div>`;
}

function columnsPickerHtml(target, kind, columns) {
  const opts = [[1, "1 col"], [2, "2 col"]];
  const buttons = opts
    .map(
      ([value, label]) =>
        `<button class="${columns === value ? "active" : ""}" data-action="set-columns" data-target="${target}" data-kind="${kind}" data-columns="${value}">${label}</button>`
    )
    .join("");
  return `<div class="columns-picker">${buttons}</div>`;
}

function sizeControlHtml(target, kind, ws) {
  if (ws.style === "none") return "";
  if (ws.style === "lines") {
    const rows = Math.max(1, Math.round(ws.heightMm / RULE_MM));
    return (
      '<div class="lines-picker">' +
      `<button data-action="step-height" data-target="${target}" data-kind="${kind}" data-spacing="${RULE_MM}" data-delta="-1">−</button>` +
      `<span>${rows} line${rows !== 1 ? "s" : ""}</span>` +
      `<button data-action="step-height" data-target="${target}" data-kind="${kind}" data-spacing="${RULE_MM}" data-delta="1">+</button>` +
      "</div>" +
      columnsPickerHtml(target, kind, ws.columns === 2 ? 2 : 1)
    );
  }
  const presetButtons = Object.entries(SIZE_PRESETS_MM)
    .map(([name, mm]) => {
      const active = ws.heightMm === mm ? "active" : "";
      return `<button class="${active}" data-action="set-size" data-target="${target}" data-kind="${kind}" data-size="${name}">${name[0].toUpperCase()}</button>`;
    })
    .join("");
  return (
    `<div class="size-picker">${presetButtons}` +
    `<button data-action="step-height" data-target="${target}" data-kind="${kind}" data-spacing="${GRID_MM}" data-delta="-1">−</button>` +
    `<span>${ws.heightMm}mm</span>` +
    `<button data-action="step-height" data-target="${target}" data-kind="${kind}" data-spacing="${GRID_MM}" data-delta="1">+</button>` +
    "</div>"
  );
}

function renderQuestionControls(target, kind, ws) {
  return `${sizeControlHtml(target, kind, ws)}${stylePickerHtml(target, kind, ws.style)}`;
}

function headingHtml(b) {
  const text = escapeHtml(b.text);
  if (b.style === "title") return `<div class="heading heading-title">${text}</div>`;
  if (b.style === "tier") return `<div class="heading heading-tier tier-${b.tier || "default"}">${text}</div>`;
  return `<div class="heading">${text}</div>`;
}

const DEFAULT_COMBINED_WS = { style: "grid", heightMm: SIZE_PRESETS_MM.large };

function renderGroup(gid, blocks, layout, cropsBaseUrl, combinedBlocks) {
  const safeGid = escapeHtml(gid);
  const controls =
    `<div class="group-controls"><strong>${safeGid}</strong> layout: ` +
    `<label><input type="radio" name="layout-${safeGid}" ${layout !== "combined" ? "checked" : ""} data-action="set-layout" data-group="${safeGid}" data-mode="split"> Split (small, per part)</label>` +
    `<label><input type="radio" name="layout-${safeGid}" ${layout === "combined" ? "checked" : ""} data-action="set-layout" data-group="${safeGid}" data-mode="combined"> Combined (large, whole question)</label>` +
    "</div>";

  if (layout === "combined") {
    // The combined view is a real crop of the whole question exactly as
    // printed (all parts together), not a stack of the individual part
    // crops - that's what keeps it looking like a clean single block
    // instead of an awkward recomposition.
    const ws = (combinedBlocks[gid] && combinedBlocks[gid].workingSpace) || DEFAULT_COMBINED_WS;
    const crop = cropHtml(cropsBaseUrl, gid);
    return `<div class="group">${controls}${crop}${workingSpaceHtml(ws)}${renderQuestionControls(gid, "group", ws)}</div>`;
  }

  const parts = blocks
    .map((b) => {
      const crop = cropHtml(cropsBaseUrl, b.id, b.contextImage);
      return `<div class="block question">${crop}${workingSpaceHtml(b.workingSpace)}${renderQuestionControls(b.id, "block", b.workingSpace)}</div>`;
    })
    .join("");
  return `<div class="group">${controls}${parts}</div>`;
}

export function renderEditor(workbook, cropsBaseUrl) {
  const combinedBlocks = workbook.combinedBlocks || {};
  const pagesHtml = workbook.pages.map((page) => {
    const blocksHtml = iterRenderUnits(page.blocks)
      .map((unit) => {
        if (unit.kind === "single") {
          const b = unit.blocks[0];
          if (b.type === "heading") return headingHtml(b);
          const crop = cropHtml(cropsBaseUrl, b.id, b.contextImage, b.widthMm);
          if (b.type === "image") return `<div class="block">${crop}</div>`;
          return `<div class="block question">${crop}${workingSpaceHtml(b.workingSpace)}${renderQuestionControls(b.id, "block", b.workingSpace)}</div>`;
        }
        const layout = workbook.groupLayout[unit.gid] || "split";
        return renderGroup(unit.gid, unit.blocks, layout, cropsBaseUrl, combinedBlocks);
      })
      .join("");
    const pageClass = page.cover ? "page page-cover" : "page";
    return `<div class="${pageClass}">${blocksHtml}</div>`;
  });

  const spreads = [];
  for (let i = 0; i < pagesHtml.length; i += 2) {
    spreads.push(`<div class="spread">${pagesHtml.slice(i, i + 2).join("")}</div>`);
  }
  return spreads.join("");
}
