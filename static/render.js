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

function cropHtml(cropsBaseUrl, block) {
  const src = `${cropsBaseUrl}/${block.id}.png`;
  let contextHtml = "";
  if (block.contextImage) {
    contextHtml = `<img src="${escapeHtml(cropsBaseUrl)}/${escapeHtml(block.contextImage)}.png">`;
  }
  return `<div class="block-crop">${contextHtml}<img src="${escapeHtml(src)}"></div>`;
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

function stylePickerHtml(target, activeStyle) {
  const opts = [
    ["none", "None"],
    ["grid", "Grid"],
    ["lines", "Written response"],
  ];
  const buttons = opts
    .map(
      ([value, label]) =>
        `<button class="${activeStyle === value ? "active" : ""}" data-action="set-style" data-target="${target}" data-style="${value}">${label}</button>`
    )
    .join("");
  return `<div class="style-picker">${buttons}</div>`;
}

function columnsPickerHtml(target, columns) {
  const opts = [[1, "1 col"], [2, "2 col"]];
  const buttons = opts
    .map(
      ([value, label]) =>
        `<button class="${columns === value ? "active" : ""}" data-action="set-columns" data-target="${target}" data-columns="${value}">${label}</button>`
    )
    .join("");
  return `<div class="columns-picker">${buttons}</div>`;
}

function sizeControlHtml(target, ws) {
  if (ws.style === "none") return "";
  if (ws.style === "lines") {
    const rows = Math.max(1, Math.round(ws.heightMm / RULE_MM));
    return (
      '<div class="lines-picker">' +
      `<button data-action="step-height" data-target="${target}" data-spacing="${RULE_MM}" data-delta="-1">−</button>` +
      `<span>${rows} line${rows !== 1 ? "s" : ""}</span>` +
      `<button data-action="step-height" data-target="${target}" data-spacing="${RULE_MM}" data-delta="1">+</button>` +
      "</div>" +
      columnsPickerHtml(target, ws.columns === 2 ? 2 : 1)
    );
  }
  const presetButtons = Object.entries(SIZE_PRESETS_MM)
    .map(([name, mm]) => {
      const active = ws.heightMm === mm ? "active" : "";
      return `<button class="${active}" data-action="set-size" data-target="${target}" data-size="${name}">${name[0].toUpperCase()}</button>`;
    })
    .join("");
  return (
    `<div class="size-picker">${presetButtons}` +
    `<button data-action="step-height" data-target="${target}" data-spacing="${GRID_MM}" data-delta="-1">−</button>` +
    `<span>${ws.heightMm}mm</span>` +
    `<button data-action="step-height" data-target="${target}" data-spacing="${GRID_MM}" data-delta="1">+</button>` +
    "</div>"
  );
}

function renderQuestionControls(target, ws) {
  return `${sizeControlHtml(target, ws)}${stylePickerHtml(target, ws.style)}`;
}

function headingHtml(b) {
  const text = escapeHtml(b.text);
  if (b.style === "title") return `<div class="heading heading-title">${text}</div>`;
  if (b.style === "tier") return `<div class="heading heading-tier tier-${b.tier || "default"}">${text}</div>`;
  return `<div class="heading">${text}</div>`;
}

function renderGroup(gid, blocks, layout, cropsBaseUrl) {
  const idsCsv = blocks.map((b) => b.id).join(",");
  let controls = "";
  if (blocks.length > 1) {
    const safeGid = escapeHtml(gid);
    controls =
      `<div class="group-controls"><strong>${safeGid}</strong> layout: ` +
      `<label><input type="radio" name="layout-${safeGid}" ${layout !== "combined" ? "checked" : ""} data-action="set-layout" data-group="${safeGid}" data-mode="split"> Split</label>` +
      `<label><input type="radio" name="layout-${safeGid}" ${layout === "combined" ? "checked" : ""} data-action="set-layout" data-group="${safeGid}" data-mode="combined"> Combined</label>` +
      "</div>";
  }
  const cropsHtml = blocks.map((b) => cropHtml(cropsBaseUrl, b)).join("");

  if (layout === "combined" && blocks.length > 1) {
    const sharedWs = {
      style: blocks[0].workingSpace.style,
      heightMm: Math.max(...blocks.map((b) => b.workingSpace.heightMm)),
    };
    return `<div class="group">${controls}${cropsHtml}${workingSpaceHtml(sharedWs)}${renderQuestionControls(idsCsv, sharedWs)}</div>`;
  }

  const parts = blocks
    .map((b) => {
      return `<div class="block question">${cropHtml(cropsBaseUrl, b)}${workingSpaceHtml(b.workingSpace)}${renderQuestionControls(b.id, b.workingSpace)}</div>`;
    })
    .join("");
  return `<div class="group">${controls}${parts}</div>`;
}

export function renderEditor(workbook, cropsBaseUrl) {
  const pagesHtml = workbook.pages.map((page) => {
    const blocksHtml = iterRenderUnits(page.blocks)
      .map((unit) => {
        if (unit.kind === "single") {
          const b = unit.blocks[0];
          if (b.type === "heading") return headingHtml(b);
          if (b.type === "image") return `<div class="block">${cropHtml(cropsBaseUrl, b)}</div>`;
          return `<div class="block question">${cropHtml(cropsBaseUrl, b)}${workingSpaceHtml(b.workingSpace)}${renderQuestionControls(b.id, b.workingSpace)}</div>`;
        }
        const layout = workbook.groupLayout[unit.gid] || "split";
        return renderGroup(unit.gid, unit.blocks, layout, cropsBaseUrl);
      })
      .join("");
    return `<div class="page">${blocksHtml}</div>`;
  });

  const spreads = [];
  for (let i = 0; i < pagesHtml.length; i += 2) {
    spreads.push(`<div class="spread">${pagesHtml.slice(i, i + 2).join("")}</div>`);
  }
  return spreads.join("");
}
