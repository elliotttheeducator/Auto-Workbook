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

function cropHtml(blobUrls, block) {
  const src = blobUrls.get(block.id) || "";
  let contextHtml = "";
  if (block.contextImage && blobUrls.has(block.contextImage)) {
    contextHtml = `<img src="${escapeHtml(blobUrls.get(block.contextImage))}">`;
  }
  return `<div class="block-crop">${contextHtml}<img src="${escapeHtml(src)}"></div>`;
}

function workingSpaceHtml(ws) {
  if (ws.style === "none") return "";
  const spacing = ws.style === "lines" ? RULE_MM : GRID_MM;
  const height = snapDown(ws.heightMm, spacing);
  let inner = "";
  if (ws.style === "grid") {
    for (let x = spacing; x < BOX_WIDTH_MM; x += spacing) {
      inner += `<div class="grid-line-v" style="left:${x}mm"></div>`;
    }
    for (let y = spacing; y < height; y += spacing) {
      inner += `<div class="grid-line-h" style="top:${y}mm"></div>`;
    }
  } else {
    for (let y = spacing; y < height; y += spacing) {
      inner += `<div class="rule-line" style="top:${y}mm"></div>`;
    }
  }
  return `<div class="working-space" style="height:${height}mm">${inner}</div>`;
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

function sizeControlHtml(target, ws) {
  if (ws.style === "none") return "";
  if (ws.style === "lines") {
    const rows = Math.max(1, Math.round(ws.heightMm / RULE_MM));
    return (
      '<div class="lines-picker">' +
      `<button data-action="step-height" data-target="${target}" data-spacing="${RULE_MM}" data-delta="-1">−</button>` +
      `<span>${rows} line${rows !== 1 ? "s" : ""}</span>` +
      `<button data-action="step-height" data-target="${target}" data-spacing="${RULE_MM}" data-delta="1">+</button>` +
      "</div>"
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

function renderGroup(gid, blocks, layout, blobUrls) {
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
  const cropsHtml = blocks.map((b) => cropHtml(blobUrls, b)).join("");

  if (layout === "combined" && blocks.length > 1) {
    const sharedWs = {
      style: blocks[0].workingSpace.style,
      heightMm: Math.max(...blocks.map((b) => b.workingSpace.heightMm)),
    };
    return `<div class="group">${controls}${cropsHtml}${workingSpaceHtml(sharedWs)}${renderQuestionControls(idsCsv, sharedWs)}</div>`;
  }

  const parts = blocks
    .map((b) => {
      return `<div class="block question">${cropHtml(blobUrls, b)}${workingSpaceHtml(b.workingSpace)}${renderQuestionControls(b.id, b.workingSpace)}</div>`;
    })
    .join("");
  return `<div class="group">${controls}${parts}</div>`;
}

export function renderEditor(workbook, blobUrls) {
  const pagesHtml = workbook.pages.map((page) => {
    const blocksHtml = iterRenderUnits(page.blocks)
      .map((unit) => {
        if (unit.kind === "single") {
          const b = unit.blocks[0];
          if (b.type === "heading") return `<div class="heading">${escapeHtml(b.text)}</div>`;
          if (b.type === "image") return `<div class="block">${cropHtml(blobUrls, b)}</div>`;
          return `<div class="block question">${cropHtml(blobUrls, b)}${workingSpaceHtml(b.workingSpace)}${renderQuestionControls(b.id, b.workingSpace)}</div>`;
        }
        const layout = workbook.groupLayout[unit.gid] || "split";
        return renderGroup(unit.gid, unit.blocks, layout, blobUrls);
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
