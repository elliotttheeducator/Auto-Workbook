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
  IMAGE_SCALE_MAX,
  IMAGE_SCALE_MIN,
  PAGE_HEIGHT_MM,
  PAGE_MARGIN_MM,
  RULE_MM,
  SIZE_PRESETS_MM,
  canShrink,
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
// Below this, a sheet's trailing blank space is just normal slack from
// bin-packing (the next unit genuinely didn't fit) - not worth surfacing
// as an actionable prompt. At or above it, there's room for a real
// "shrink to fit more in" suggestion to make sense of.
const MIN_SQUEEZE_MM = SIZE_PRESETS_MM.small;
const MIN_SQUEEZE_PX = MIN_SQUEEZE_MM * CSS_PX_PER_MM;

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
// ends on real content. Also stops one unit early whenever the *next*
// unit has a manual "start on a new page" override - that's a
// deliberate, explicit split point, so it has to be able to cut through
// an otherwise-glued chain (a heading gluing forward into what it
// introduces, say) rather than being swallowed into a bundle that never
// lets pagination even consider breaking there.
function bundleEnd(units, i) {
  let j = i;
  while (j < units.length - 1 && units[j].glueForward && !units[j + 1].breakBefore) j++;
  return j;
}

// Packs a logical workbook page's render units into as few physical
// sheets as fit them, in order, never splitting a unit (question/group/
// image/heading) across two sheets - the same atomicity break-inside:
// avoid already gives these in print, just decided up front instead.
// Returns { sheets, leftoverPx }: sheets is an array of sheets, each an
// array of the unit objects on it (almost always a single sheet; more
// only if content overflows one); leftoverPx[i] is how much usable
// height sheet i finished with unused, for the "squeeze in" prompt to
// judge whether a sheet has room worth offering to reclaim.
async function paginateUnits(units) {
  const measurer = getMeasurer();
  measurer.innerHTML = units.map((u) => u.html).join("");
  await waitForImages(measurer);
  const containerTop = measurer.getBoundingClientRect().top;
  const bottoms = Array.from(measurer.children).map((el) => el.getBoundingClientRect().bottom - containerTop);
  measurer.innerHTML = "";
  const heights = bottoms.map((bottom, i) => (i === 0 ? bottom : bottom - bottoms[i - 1]));

  const sheets = [[]];
  const sheetHeights = [];
  let sheetHeight = 0;
  // Walk whole bundles at a time, not unit by unit - a glued bundle (see
  // bundleEnd) is meant to be atomic, but checking fit again at every
  // unit *inside* an already-placed bundle re-litigates a decision
  // that's already been made: once the bundle's anchor unit has decided
  // it fits (or doesn't, and started a fresh sheet), every later member
  // of that same bundle would independently see "sheet already has
  // content" and re-run its own fit check against just the bundle's
  // remaining tail - which, for a bundle taller than one page, can fail
  // even though the bundle-as-a-whole decision was already correct,
  // splitting the bundle across sheets after all.
  let i = 0;
  while (i < units.length) {
    const bundleLast = units[i].glueForward ? bundleEnd(units, i) : i;
    let bundleHeight = 0;
    for (let k = i; k <= bundleLast; k++) bundleHeight += heights[k];

    const sheetHasContent = sheets[sheets.length - 1].length > 0;
    // A manual "start on a new page" override always wins, even over a
    // heading directly above it that would otherwise glue forward to it
    // - it's a deliberate, explicit choice for the one case automatic
    // pagination got wrong, not something worth second-guessing. Checked
    // across the whole bundle: the toggle usually lives on the real
    // question at the bundle's tail (its stem is what's glued in front
    // of it), not the anchor unit fit is being decided from.
    let forcedBreak = false;
    for (let k = i; k <= bundleLast && !forcedBreak; k++) forcedBreak = !!units[k].breakBefore;
    forcedBreak = sheetHasContent && forcedBreak;

    if (sheetHasContent && (forcedBreak || sheetHeight + bundleHeight > USABLE_HEIGHT_PX)) {
      sheets.push([]);
      sheetHeights.push(sheetHeight);
      sheetHeight = 0;
    }
    for (let k = i; k <= bundleLast; k++) {
      sheets[sheets.length - 1].push(units[k]);
      sheetHeight += heights[k];
    }
    i = bundleLast + 1;
  }
  sheetHeights.push(sheetHeight);

  const leftoverPx = sheetHeights.map((used) => USABLE_HEIGHT_PX - used);
  return { sheets, leftoverPx };
}

// widthMm is a fixed size set at content-authoring time (add_chapter.py -
// used for a handful of explicitly-sized answer images); imageScale is
// the user's own runtime "shrink the diagram" choice, a percentage of
// the container. widthMm wins when both are present - it's deliberate
// and rare enough that a runtime scale on top of it would be surprising.
function cropHtml(cropsBaseUrl, crop, contextImage, widthMm, imageScale) {
  let contextHtml = "";
  if (contextImage) {
    contextHtml = `<img src="${escapeHtml(cropsBaseUrl)}/${escapeHtml(contextImage)}.png">`;
  }
  let style = "";
  if (widthMm) style = ` style="width:${widthMm}mm"`;
  else if (imageScale && imageScale !== IMAGE_SCALE_MAX) style = ` style="width:${imageScale}%"`;
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

// A diagram is usually the bigger lever for fitting more onto a page
// than the working-space box is (see IMAGE_SCALE_MAX in model.js), so
// this is offered as its own direct control, not just something the
// "squeeze in" prompt reaches for automatically.
function imageScaleControlHtml(target, kind, imageScale) {
  const pct = imageScale || IMAGE_SCALE_MAX;
  return (
    '<div class="image-scale-picker">' +
    "<span>Diagram:</span>" +
    `<button data-action="step-image-scale" data-target="${target}" data-kind="${kind}" data-delta="-1" ${pct <= IMAGE_SCALE_MIN ? "disabled" : ""}>−</button>` +
    `<span>${pct}%</span>` +
    `<button data-action="step-image-scale" data-target="${target}" data-kind="${kind}" data-delta="1" ${pct >= IMAGE_SCALE_MAX ? "disabled" : ""}>+</button>` +
    "</div>"
  );
}

// Manual escape hatch for the rare case automatic pagination gets a
// call wrong - pins this question/group to always start a fresh sheet,
// regardless of how much room is left on the one before it.
function breakBeforeControlHtml(target, kind, breakBefore) {
  return (
    `<button class="break-before-toggle ${breakBefore ? "active" : ""}" ` +
    `data-action="toggle-break-before" data-target="${target}" data-kind="${kind}">` +
    `${breakBefore ? "✓ Starts on a new page" : "Start on a new page"}</button>`
  );
}

function renderQuestionControls(target, kind, ws, imageScale, breakBefore) {
  return (
    sizeControlHtml(target, kind, ws) +
    stylePickerHtml(target, kind, ws.style) +
    imageScaleControlHtml(target, kind, imageScale) +
    breakBeforeControlHtml(target, kind, breakBefore)
  );
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
    const saved = combinedBlocks[gid];
    const ws = (saved && saved.workingSpace) || DEFAULT_COMBINED_WS;
    // A read-only stand-in for canShrink()/the controls below - the
    // group might never have been customized yet, so there's no real
    // combinedBlocks[gid] to point at; app.js's ensureCombinedBlock()
    // creates the real one on first edit, this is just for display.
    const entry = { workingSpace: ws, imageScale: saved && saved.imageScale, breakBefore: saved && saved.breakBefore };
    const crop = cropHtml(cropsBaseUrl, gid, undefined, undefined, entry.imageScale);
    // A combined crop spans close to the page's own width, so its
    // controls hang off the outer margin (see .controls-hang) instead
    // of stacking inline below it - unlike a split row's parts, which
    // stay inline (see partHtml below): those are only half-width and
    // sit mid-page, with no clean page edge to hang off of.
    const hangingControls = `<div class="controls-hang">${controls}${renderQuestionControls(gid, "group", ws, entry.imageScale, entry.breakBefore)}</div>`;
    const html = `<div class="group">${crop}${workingSpaceHtml(ws)}${hangingControls}</div>`;
    const wsTargets = [{ kind: "group", id: gid, canShrink: canShrink(entry) }];
    return [{ html, heading: false, groupId: gid, groupFirstRow: true, wsTargets, breakBefore: entry.breakBefore }];
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
    const crop = cropHtml(cropsBaseUrl, b.id, b.contextImage, undefined, b.imageScale);
    return `<div class="block question">${crop}${workingSpaceHtml(b.workingSpace)}</div>`;
  };

  const units = [];
  for (let i = 0; i < blocks.length; i += 2) {
    const rowBlocks = [blocks[i], blocks[i + 1]].filter(Boolean);
    const partsHtml = rowBlocks.map(partHtml).join("");
    // A row's two parts are locked to one shared size/style/scale - a
    // matched pair never has a real reason to size differently, and one
    // shared panel (instead of a part's own panel either side plus a
    // third "Both" panel squeezed between them) is what actually fixes
    // the hanging-controls overlap: layoutHangingControls() only has to
    // stack whole rows top-to-bottom then, not referee three panels
    // fighting over the same vertical space at the same row height. The
    // panel's data-target carries both ids comma-joined, so every action
    // in app.js's click handler already applies to both parts at once
    // (see the targets.split(",") loop there) - no separate "apply to
    // both" affordance needed.
    const anchor = rowBlocks[0];
    const targets = rowBlocks.map((b) => b.id).join(",");
    const hangingControls = `<div class="controls-hang">${renderQuestionControls(targets, "block", anchor.workingSpace, anchor.imageScale, anchor.breakBefore)}</div>`;
    const rowHtml = `<div class="split-row">${partsHtml}${hangingControls}</div>`;
    const isFirstRow = i === 0;
    const html = `<div class="group">${isFirstRow ? controls : ""}${rowHtml}</div>`;
    const wsTargets = rowBlocks.map((b) => ({ kind: "block", id: b.id, canShrink: canShrink(b) }));
    // A break-before toggled on either part in a row breaks before the
    // whole row - the two parts are always paginated as one atomic unit,
    // so "break before this part" can only ever mean "break before its
    // row."
    const breakBefore = rowBlocks.some((b) => b.breakBefore);
    units.push({ html, heading: false, groupId: gid, groupFirstRow: isFirstRow, wsTargets, breakBefore });
  }
  return units;
}

// A sheet that finished with a meaningful gap, and a following sheet
// (for the same logical page) still to come, is worth flagging - offer
// to shrink every working space already on this sheet plus the very
// next unit queued after it, which is often enough to pull that unit up
// onto the space that's currently going to waste.
function squeezeInHtml(sheetUnits, nextSheetUnits) {
  // If the very next thing queued up is a heading, it's always
  // glueForward - pagination bundles it with whatever comes right after
  // it precisely so it never sits stranded on its own (see bundleEnd).
  // A heading itself has nothing shrinkable, so looking at just
  // nextSheetUnits[0] would frequently offer nothing even when the real
  // question right behind that heading has plenty of room to give -
  // walk the same glued bundle bundleEnd() would, to find it.
  const nextBundle = [];
  for (const u of nextSheetUnits) {
    nextBundle.push(u);
    if (!u.glueForward) break;
  }

  const targets = [];
  for (const u of sheetUnits) if (u.wsTargets) targets.push(...u.wsTargets);
  for (const u of nextBundle) if (u.wsTargets) targets.push(...u.wsTargets);
  // Nothing to offer if every candidate is already at its floor (e.g.
  // "None" style, or already the smallest preset) - the button would
  // just sit there doing nothing when clicked.
  if (!targets.some((t) => t.canShrink)) return "";
  const idsAttr = targets.map((t) => `${t.kind}:${escapeHtml(t.id)}`).join(",");
  return `<button class="squeeze-in" data-action="squeeze-in" data-ids="${idsAttr}">There's room here - shrink to squeeze in the next question ↓</button>`;
}

// True for a page whose content is the start of a new named section (an
// exercise, or an "X Answers" divider) - add_chapter.py calls this style
// "title", reserved for exactly that. Every other logical workbook page
// is just how the source content happened to be chunked, not a break
// anyone actually wants - flowing those together, instead of pinning
// each to its own sheet, is what lets a title/Key Ideas/Building
// Understanding page that's mostly blank on its own share a sheet with
// its neighbours instead of wasting the rest of the page.
function isSectionStart(page) {
  const first = page.blocks[0];
  return !!first && first.type === "heading" && first.style === "title";
}

export async function renderEditor(workbook, cropsBaseUrl) {
  const combinedBlocks = workbook.combinedBlocks || {};
  const physicalPagesHtml = [];
  let pending = [];

  // Packs and emits whatever's been queued up since the last hard break
  // (a cover, or a section start) as physical sheets - see paginateUnits
  // for why this has to happen across every logical page in the pending
  // run at once, not one logical page at a time: only that lets a stem
  // that landed at the end of one source page glue to its group's first
  // row on the next, and lets a short page's leftover room actually get
  // filled by whatever now-following content fits in it.
  async function flushPending() {
    if (pending.length === 0) return;
    const units = pending;
    pending = [];

    // A heading is never worth stranding alone at the bottom of a sheet -
    // it always glues to whatever comes right after it (one hop: just
    // the very next unit, whatever that is - not a chain, so a heading
    // followed by a large worked example doesn't drag along everything
    // after that example too). A plain context-only unit (an image with
    // no working space) only glues forward when it's *specifically* the
    // stem for the group it immediately precedes - matched by the
    // "{groupId}_stem" naming convention add_chapter.py uses for these,
    // not just "any image directly before any group": a worked example's
    // own diagram sitting right before an unrelated exercise's group is
    // still just an image with no working space, but it isn't that
    // group's stem, and gluing it in anyway produced bundles several
    // unrelated blocks deep and taller than a page (see bundleEnd() in
    // paginateUnits() for how an atomic bundle that doesn't fit still
    // gets kept together rather than split, which is exactly why an
    // unbounded chain here is dangerous).
    const groupStems = {};
    for (let i = 0; i < units.length; i++) {
      if (!units[i].groupId || !units[i].groupFirstRow) continue;
      const prev = units[i - 1];
      if (prev && prev.contextOnly && prev.id === `${units[i].groupId}_stem`) {
        prev.glueForward = true;
        groupStems[units[i].groupId] = prev.html;
      }
    }
    for (let i = 0; i < units.length; i++) {
      units[i].glueForward = units[i].glueForward || units[i].heading;
    }

    const { sheets, leftoverPx } = await paginateUnits(units);
    for (let i = 0; i < sheets.length; i++) {
      const sheet = sheets[i];
      // A later row of a split question can still end up starting a
      // fresh sheet if the whole question doesn't fit one page - without
      // some marker, that sheet would open on bare parts with no visible
      // indication of which question they belong to ("the question
      // disappears"). Repeat its stem if it has one; a bare id label is
      // the fallback for the (rare, best avoided going forward) group
      // that was never given a separate stem crop to begin with.
      const first = sheet[0];
      let continued = "";
      if (first && first.groupId && !first.groupFirstRow) {
        continued = groupStems[first.groupId] || `<div class="heading group-continued">${escapeHtml(first.groupId)} (continued)</div>`;
      }
      // Only a sheet with more content still queued behind it can
      // usefully squeeze anything in - the last sheet has nothing left
      // to pull forward.
      const squeeze =
        i < sheets.length - 1 && leftoverPx[i] >= MIN_SQUEEZE_PX ? squeezeInHtml(sheet, sheets[i + 1]) : "";
      // Which side of a two-up spread this sheet lands on - lets a
      // block's hanging controls (see .controls-hang in app.css) flip to
      // whichever outer margin is actually free, entirely in CSS.
      const side = physicalPagesHtml.length % 2 === 0 ? "page-left" : "page-right";
      physicalPagesHtml.push(`<div class="page ${side}">${continued}${sheet.map((u) => u.html).join("")}${squeeze}</div>`);
    }
  }

  for (const page of workbook.pages) {
    if (page.cover) {
      // A cover is always exactly one full-bleed image, and always its
      // own sheet - flush whatever was flowing before it, render it
      // directly (no controls: none of squeeze-in/diagram-scale/manual
      // break make sense on a page that's deliberately outside normal
      // pagination), then carry on with a clean slate after.
      await flushPending();
      const b = page.blocks[0];
      const crop = cropHtml(cropsBaseUrl, b.id, b.contextImage, b.widthMm);
      physicalPagesHtml.push(`<div class="page page-cover">${crop}</div>`);
      continue;
    }

    const renderUnits = iterRenderUnits(page.blocks);
    const units = [];
    renderUnits.forEach((unit, unitIndex) => {
      if (unit.kind === "single") {
        const b = unit.blocks[0];
        // A stem image cropped from the same source region as a group's
        // "combined" (whole-question) crop is already baked into that
        // crop - only show it separately when the group is split into
        // parts, or it'd print twice back to back in combined view.
        if (b.combinedIncludesStem) {
          const next = renderUnits[unitIndex + 1];
          const nextLayout = next && next.kind === "group" ? workbook.groupLayout[next.gid] || "split" : null;
          if (nextLayout === "combined") return;
        }
        if (b.type === "heading") {
          // Wrapped in one container, not two sibling top-level elements
          // (the heading div plus a bare button) - paginateUnits()
          // measures by reading one getBoundingClientRect() per DOM
          // child and assumes that lines up 1:1 with the units array;
          // two top-level children per unit desyncs every measurement
          // after the first heading in a run, corrupting every height
          // downstream of it.
          const html = `<div class="heading-unit">${headingHtml(b)}<div class="controls-hang">${breakBeforeControlHtml(b.id, "block", b.breakBefore)}</div></div>`;
          units.push({ html, heading: true, breakBefore: !!b.breakBefore });
        } else if (b.type === "image") {
          // No working space on a plain image, but it can still be the
          // tallest thing on a page (a full Key Ideas diagram, say) - it
          // still gets a diagram-scale control and can still be a
          // "squeeze in" target, just not the size/style pickers that
          // only make sense for an actual answerable question. Hung off
          // the page like a combined group's controls (see there) - a
          // plain image block is always full width.
          const crop = cropHtml(cropsBaseUrl, b.id, b.contextImage, b.widthMm, b.imageScale);
          const hangingControls = `<div class="controls-hang">${imageScaleControlHtml(b.id, "block", b.imageScale)}${breakBeforeControlHtml(b.id, "block", b.breakBefore)}</div>`;
          const html = `<div class="block">${crop}${hangingControls}</div>`;
          units.push({
            html,
            heading: false,
            contextOnly: true,
            id: b.id,
            wsTargets: [{ kind: "block", id: b.id, canShrink: canShrink(b) }],
            breakBefore: !!b.breakBefore,
          });
        } else {
          const crop = cropHtml(cropsBaseUrl, b.id, b.contextImage, b.widthMm, b.imageScale);
          const hangingControls = `<div class="controls-hang">${renderQuestionControls(b.id, "block", b.workingSpace, b.imageScale, b.breakBefore)}</div>`;
          const html = `<div class="block question">${crop}${workingSpaceHtml(b.workingSpace)}${hangingControls}</div>`;
          units.push({
            html,
            heading: false,
            wsTargets: [{ kind: "block", id: b.id, canShrink: canShrink(b) }],
            breakBefore: !!b.breakBefore,
          });
        }
        return;
      }
      const layout = workbook.groupLayout[unit.gid] || "split";
      units.push(...renderGroup(unit.gid, unit.blocks, layout, cropsBaseUrl, combinedBlocks));
    });

    if (isSectionStart(page)) await flushPending();
    pending.push(...units);
  }
  await flushPending();

  const spreads = [];
  for (let i = 0; i < physicalPagesHtml.length; i += 2) {
    spreads.push(`<div class="spread">${physicalPagesHtml.slice(i, i + 2).join("")}</div>`);
  }
  return spreads.join("");
}
