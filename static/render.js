// Builds the exact same DOM for on-screen editing and for print export -
// there is no separate print layout; @media print in app.css just hides
// the controls (topbar, pickers, layout radios) on this same markup, so
// what you see in the booklet view is what prints.
//
// That parity depends on every ".page" div already being exactly one
// physical sheet's worth of content before it ever reaches the browser's
// print engine - print can only break a page where a ".page" div ends,
// so pagination (deciding which units land on which sheet) has to happen
// here in JS, once, rather than being left to CSS to figure out
// differently on screen vs. in print. See paginateUnits() below.
import {
  BOX_WIDTH_MM,
  CONTENT_WIDTH_MM,
  GRID_MM,
  PAGE_HEIGHT_MM,
  PAGE_MARGIN_MM,
  RULE_MM,
  SIZE_PRESETS_MM,
  escapeHtml,
  iterRenderUnits,
  snapDown,
} from "./model.js";

const CSS_PX_PER_MM = 96 / 25.4;
// A few mm of slack against sub-pixel measurement/rounding differences
// between this on-screen measurement and the browser's own print layout
// pass - packing right up to the exact edge risks a unit that measured
// as "just fits" rendering a hair taller at print time and spilling onto
// a second sheet anyway.
const PAGE_SAFETY_MARGIN_MM = 3;
const USABLE_HEIGHT_PX = (PAGE_HEIGHT_MM - 2 * PAGE_MARGIN_MM - PAGE_SAFETY_MARGIN_MM) * CSS_PX_PER_MM;

let measurerEl = null;
function getMeasurer() {
  if (!measurerEl) {
    measurerEl = document.createElement("div");
    // position:absolute both moves this off-screen and gives it its own
    // block formatting context, so a first/last child's margin renders
    // fully inside the measured box instead of collapsing out through it.
    measurerEl.style.position = "absolute";
    measurerEl.style.visibility = "hidden";
    measurerEl.style.pointerEvents = "none";
    measurerEl.style.left = "-99999px";
    measurerEl.style.top = "0";
    measurerEl.style.width = `${CONTENT_WIDTH_MM}mm`;
    document.body.appendChild(measurerEl);
  }
  return measurerEl;
}

function waitForImages(container) {
  const imgs = Array.from(container.querySelectorAll("img"));
  return Promise.all(
    imgs.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          })
    )
  );
}

// A heading - or a question's shared stem/context image sitting right
// before its first split part - is never worth printing alone at the
// bottom of a sheet with its own content pushed to the next one: find
// how far a "glued bundle" starting at such a unit extends, through any
// run of consecutive headings (an exercise title followed by a tier
// heading, say) plus one more unit beyond them, so the bundle always
// ends on real content.
function bundleEnd(units, i) {
  let j = i;
  while (j < units.length - 1 && units[j].glueForward) j++;
  return j;
}

// Packs a logical workbook page's render units into as few physical
// sheets as fit them, in order, never splitting a unit (question/group/
// image/heading) across two sheets - the same atomicity break-inside:
// avoid already gives these in print, just decided up front instead.
// Returns an array of sheets, each an array of the unit objects on it
// (almost always a single sheet; more only if content overflows one).
async function paginateUnits(units) {
  if (units.length <= 1) return [units];

  const measurer = getMeasurer();
  measurer.innerHTML = units.map((u) => u.html).join("");
  await waitForImages(measurer);
  const containerTop = measurer.getBoundingClientRect().top;
  const bottoms = Array.from(measurer.children).map((el) => el.getBoundingClientRect().bottom - containerTop);
  measurer.innerHTML = "";
  const heights = bottoms.map((bottom, i) => (i === 0 ? bottom : bottom - bottoms[i - 1]));

  const sheets = [[]];
  let sheetHeight = 0;
  for (let i = 0; i < units.length; i++) {
    let requiredHeight = heights[i];
    if (units[i].glueForward) {
      for (let k = i + 1; k <= bundleEnd(units, i); k++) requiredHeight += heights[k];
    }
    if (sheets[sheets.length - 1].length > 0 && sheetHeight + requiredHeight > USABLE_HEIGHT_PX) {
      sheets.push([]);
      sheetHeight = 0;
    }
    sheets[sheets.length - 1].push(units[i]);
    sheetHeight += heights[i];
  }
  return sheets;
}

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

// Returns one or more {html, heading} pagination units for a multi-part
// question group - never just one joined HTML string, because that
// would make the whole group one atomic block that pagination can only
// ever keep together or overflow, and a long split group very easily
// doesn't fit on one sheet (each part carries its own crop + working
// space + controls). The combined ("whole question") view really is a
// single crop image and stays atomic; split parts are independent and
// need to be free to land on different sheets, same as any other
// question would.
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
    const html = `<div class="group">${controls}${crop}${workingSpaceHtml(ws)}${renderQuestionControls(gid, "group", ws)}</div>`;
    return [{ html, heading: false, groupId: gid, groupFirstRow: true }];
  }

  // Split parts render two to a row (see .split-row) - most part crops
  // are far narrower than a full page, so one-per-row wasted most of the
  // sheet on blank margin either side of a small diagram. Each row is
  // its own pagination unit (never split part-from-partner), so a long
  // split question still breaks cleanly between rows across sheets; the
  // layout picker travels with the first row so it's never separated
  // from it. groupId/groupFirstRow let renderEditor glue a preceding
  // stem to this group's first row, and label any later row that ends
  // up starting a fresh sheet with which question it continues.
  const partHtml = (b) => {
    const crop = cropHtml(cropsBaseUrl, b.id, b.contextImage);
    return `<div class="block question">${crop}${workingSpaceHtml(b.workingSpace)}${renderQuestionControls(b.id, "block", b.workingSpace)}</div>`;
  };

  const units = [];
  for (let i = 0; i < blocks.length; i += 2) {
    const row = [partHtml(blocks[i])];
    if (blocks[i + 1]) row.push(partHtml(blocks[i + 1]));
    const rowHtml = `<div class="split-row">${row.join("")}</div>`;
    const isFirstRow = i === 0;
    const html = `<div class="group">${isFirstRow ? controls : ""}${rowHtml}</div>`;
    units.push({ html, heading: false, groupId: gid, groupFirstRow: isFirstRow });
  }
  return units;
}

export async function renderEditor(workbook, cropsBaseUrl) {
  const combinedBlocks = workbook.combinedBlocks || {};
  const physicalPagesHtml = [];

  for (const page of workbook.pages) {
    const units = [];
    for (const unit of iterRenderUnits(page.blocks)) {
      if (unit.kind === "single") {
        const b = unit.blocks[0];
        if (b.type === "heading") {
          units.push({ html: headingHtml(b), heading: true });
        } else if (b.type === "image") {
          const crop = cropHtml(cropsBaseUrl, b.id, b.contextImage, b.widthMm);
          units.push({ html: `<div class="block">${crop}</div>`, heading: false });
        } else {
          const crop = cropHtml(cropsBaseUrl, b.id, b.contextImage, b.widthMm);
          const html = `<div class="block question">${crop}${workingSpaceHtml(b.workingSpace)}${renderQuestionControls(b.id, "block", b.workingSpace)}</div>`;
          units.push({ html, heading: false });
        }
        continue;
      }
      const layout = workbook.groupLayout[unit.gid] || "split";
      units.push(...renderGroup(unit.gid, unit.blocks, layout, cropsBaseUrl, combinedBlocks));
    }

    if (page.cover) {
      // A cover is always exactly one full-bleed image - never paginate it.
      physicalPagesHtml.push(`<div class="page page-cover">${units.map((u) => u.html).join("")}</div>`);
      continue;
    }

    // A heading, or a question's shared stem/context image sitting right
    // before its own first split part, is never worth stranding alone at
    // the bottom of a sheet - see bundleEnd() in paginateUnits().
    for (let i = 0; i < units.length; i++) {
      const next = units[i + 1];
      units[i].glueForward = units[i].heading || (!units[i].groupId && !!next && next.groupFirstRow);
    }

    const sheets = await paginateUnits(units);
    for (const sheet of sheets) {
      // A later row of a split question can still end up starting a
      // fresh sheet if the whole question doesn't fit one page - without
      // some marker, that sheet would open on bare parts with no visible
      // indication of which question they belong to ("the question
      // disappears"). Label it with the question's id when that happens.
      const first = sheet[0];
      const continued =
        first && first.groupId && !first.groupFirstRow
          ? `<div class="heading group-continued">${escapeHtml(first.groupId)} (continued)</div>`
          : "";
      physicalPagesHtml.push(`<div class="page">${continued}${sheet.map((u) => u.html).join("")}</div>`);
    }
  }

  const spreads = [];
  for (let i = 0; i < physicalPagesHtml.length; i += 2) {
    spreads.push(`<div class="spread">${physicalPagesHtml.slice(i, i + 2).join("")}</div>`);
  }
  return spreads.join("");
}
