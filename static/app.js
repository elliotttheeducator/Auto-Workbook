import * as db from "./db.js";
import {
  applyOverrides,
  defaultScaleFor,
  escapeHtml,
  extractOverrides,
  groupIdFor,
  growImageOneStep,
  IMAGE_SCALE_MAX,
  IMAGE_SCALE_MIN,
  IMAGE_SCALE_STEP,
  resolvedDefaultScales,
  RULE_MM,
  shrinkImageOneStep,
  shrinkOneStep,
  SIZE_PRESETS_MM,
} from "./model.js";
import { alignSplitRows, buildFilterContext, defaultScaleBarHtml, filterBarHtml, printSelectionBarHtml, renderEditor, waitForImages } from "./render.js";

// The tier a given block sits under (needed only to pick the right
// split-scale default - see defaultScaleFor in model.js), recomputed on
// demand rather than cached: buildFilterContext is a cheap single walk
// over the workbook, and app.js's own edits (delete, restore, layout
// changes) never touch which tier a block is under, so there is no
// staleness risk to guard against by caching it.
function tierFor(workbook, id) {
  const gid = groupIdFor(id) || id;
  return buildFilterContext(workbook).context[gid]?.tier;
}
import { openCropModal } from "./crop.js";

const appEl = document.getElementById("app");
const topbarActions = document.getElementById("topbar-actions");
const filterBarMount = document.getElementById("filter-bar-mount");

// Booklet vs 100% view (see applyViewMode below) - a display preference
// tied to this machine's actual screen, not a document setting, so it's
// kept in localStorage (survives reloads) rather than saved into the
// workbook like everything else in db.js.
const VIEW_MODE_KEY = "wb-view-mode";
let viewMode = localStorage.getItem(VIEW_MODE_KEY) || "booklet";

// Native pixel width and physical width for each monitor 100% mode gets
// used on, not one generic constant (see applyViewMode). CSS "mm" units
// are already supposed to render at true physical size, but only if the
// OS's own display-scaling setting happens to exactly match that
// screen's real pixel density; deriving the ratio straight from a
// screen's own known physical width sidesteps that assumption rather
// than trusting it. There's no browser API for a monitor's actual
// physical size or PPI - devicePixelRatio alone can't tell a 24" 1080p
// panel from a 32" one at the same resolution - so this is a small
// manually-measured lookup table switched by hand (see MONITOR_KEY
// below), not something auto-detected from the screen itself.
const MONITOR_PROFILES = {
  work: { label: "Work (Surface)", nativePxWidth: 4500, physicalWidthMm: 637.35 },
  home: { label: "Home (27\" 1080p)", nativePxWidth: 1920, physicalWidthMm: 596.74 },
};
const MONITOR_KEY = "wb-monitor-profile";
let monitorProfile = MONITOR_PROFILES[localStorage.getItem(MONITOR_KEY)] ? localStorage.getItem(MONITOR_KEY) : "work";

// The browser's own baked-in CSS mm scale (96 CSS px/inch, the same
// constant render.js's pagination math uses) - what "booklet" mode
// already renders at. Comparing that against this screen's own
// measured px-per-mm gives the correction factor 100% mode needs.
const CSS_PX_PER_MM = 96 / 25.4;

function truePxPerMm() {
  const dpr = window.devicePixelRatio || 1;
  const { nativePxWidth, physicalWidthMm } = MONITOR_PROFILES[monitorProfile];
  return nativePxWidth / dpr / physicalWidthMm;
}

function toggleMonitorProfile() {
  monitorProfile = monitorProfile === "work" ? "home" : "work";
  localStorage.setItem(MONITOR_KEY, monitorProfile);
  applyViewMode();
  if (viewMode === "actual") {
    alignSplitRows(appEl);
    layoutHangingControls();
  }
}

// Booklet is the default (2-up spread, sized in CSS mm) - good for
// flipping through the whole document quickly. 100% forces every page
// to this screen's actual measured physical size, single page at a
// time, so a diagram or line of working space can be checked for real
// print readability instead of guessing from whatever size the browser
// happened to lay the mm units out at.
//
// Applied as a CSS zoom on .page (see app.css), not by overriding
// --page-width/--page-height directly - everything inside a page
// (working-space boxes, crops) is itself sized in real mm units, so an
// independent width/height override on just the outer box would pull
// it out of proportion with its own contents instead of scaling them
// together. zoom scales the whole rendered page - box and contents -
// as one unit, and (unlike transform:scale) actually reflows layout to
// the new size, so pages stacked in a column really do take up the
// right amount of space instead of overlapping or leaving gaps.
function applyViewMode() {
  const root = document.documentElement;
  if (viewMode === "actual") {
    root.style.setProperty("--actual-zoom", (truePxPerMm() / CSS_PX_PER_MM).toFixed(4));
    root.classList.add("mode-actual");
  } else {
    root.classList.remove("mode-actual");
  }
  const btn = document.getElementById("view-mode-btn");
  if (btn) btn.textContent = viewMode === "actual" ? "Booklet view" : "100% size";
  // Only meaningful once 100% mode is actually on - hidden otherwise so
  // it doesn't sit there doing nothing in booklet view.
  const monitorBtn = document.getElementById("monitor-profile-btn");
  if (monitorBtn) {
    monitorBtn.textContent = MONITOR_PROFILES[monitorProfile].label;
    monitorBtn.style.display = viewMode === "actual" ? "" : "none";
  }
}

function toggleViewMode() {
  viewMode = viewMode === "actual" ? "booklet" : "actual";
  localStorage.setItem(VIEW_MODE_KEY, viewMode);
  applyViewMode();
  // Content/pagination didn't change, just the page's own CSS size - no
  // need for a full renderEditorOnce(), just a re-measure of whatever
  // depends on the page's actual on-screen dimensions.
  alignSplitRows(appEl);
  layoutHangingControls();
}

let currentWorkbook = null;
let currentProjectId = null;
// Which chapters (by their title heading id) should survive into a
// print/export - see printSelectionBarHtml in render.js. null means
// "everything" (every checkbox starts checked) - the common case, and
// the only state that ever needs saving nowhere: this is a per-visit
// print-time choice, not a document edit, so it resets to "everything"
// on reload same as viewMode does *not* (viewMode is a real per-device
// preference; this isn't even that - just today's print job). Reset
// per project load in renderEditorView.
let printSelection = null;
// Group ids whose layout (split/combined) the user has explicitly picked
// *this session* - see persistAndRerenderEditor for why saving only these
// (not every group's current value) matters: workbook.json's own
// groupLayout carries a real default for every group already (see
// plan_group_defaults in add_chapter.py), and that default can improve
// over time as chapters get rebuilt with better rules. Reset per project
// load, never seeded from a previously-saved override - there's no way
// to tell, from a blanket-saved override blob, which of its entries were
// a deliberate choice versus just whatever the default happened to be
// the first time anything in the project was edited.
let touchedGroupLayoutIds = new Set();

// Which controls panels (see .controls-hang/.group-controls in app.css)
// a user has expanded *this session* - purely local UI state, never
// saved to overrides. Every edit re-renders the whole document from
// scratch (appEl.innerHTML = ...), which would otherwise reset every
// panel straight back to collapsed on the very next click inside one -
// restoreExpandedControls() re-applies this set's membership right
// after each such render so an open panel actually stays open while
// its own controls are being used. Keyed by each toggle's own
// data-controls-id (the same raw id/ids controlsHangHtml already put
// in its title tooltip - see friendlyLabel in render.js), not the
// friendly label text, since two different panels can share a label
// (e.g. a stem and its group both reading "BU1"). Reset per project
// load, same as touchedGroupLayoutIds.
let expandedControlIds = new Set();

function restoreExpandedControls() {
  if (expandedControlIds.size === 0) return;
  for (const toggle of appEl.querySelectorAll(".controls-toggle")) {
    if (!expandedControlIds.has(toggle.dataset.controlsId)) continue;
    const panel = toggle.closest(".controls-hang, .group-controls");
    if (panel) panel.classList.add("expanded");
  }
}

function findBlock(id) {
  for (const page of currentWorkbook.pages) {
    for (const b of page.blocks) if (b.id === id) return b;
  }
  return null;
}

function setBlockStyle(id, style) {
  const b = findBlock(id);
  if (!b || b.type !== "question") return;
  b.workingSpace.style = style;
  if (style !== "none" && !b.workingSpace.heightMm) {
    b.workingSpace.heightMm = style === "lines" ? RULE_MM * 5 : SIZE_PRESETS_MM.medium;
  }
}

function setBlockHeight(id, heightMm) {
  const b = findBlock(id);
  if (!b || b.type !== "question") return;
  b.workingSpace.heightMm = heightMm;
}

function stepBlockHeight(id, spacing, delta) {
  const b = findBlock(id);
  if (!b || b.type !== "question") return;
  b.workingSpace.heightMm = Math.max(spacing, b.workingSpace.heightMm + delta);
}

function setBlockColumns(id, columns) {
  const b = findBlock(id);
  if (!b || b.type !== "question") return;
  b.workingSpace.columns = columns;
}

// The combined ("whole question") view of a group isn't a real block in
// the page flow - it's a separate crop (named after the group id) with
// its own working space, stored here rather than derived from the split
// parts, so it keeps its own size/style across toggling back and forth.
function ensureCombinedBlock(gid) {
  if (!currentWorkbook.combinedBlocks) currentWorkbook.combinedBlocks = {};
  if (!currentWorkbook.combinedBlocks[gid]) {
    currentWorkbook.combinedBlocks[gid] = { workingSpace: { style: "grid", heightMm: SIZE_PRESETS_MM.large } };
  }
  return currentWorkbook.combinedBlocks[gid];
}

function setGroupStyle(gid, style) {
  const ws = ensureCombinedBlock(gid).workingSpace;
  ws.style = style;
  if (style !== "none" && !ws.heightMm) {
    ws.heightMm = style === "lines" ? RULE_MM * 5 : SIZE_PRESETS_MM.large;
  }
}

function setGroupHeight(gid, heightMm) {
  ensureCombinedBlock(gid).workingSpace.heightMm = heightMm;
}

function stepGroupHeight(gid, spacing, delta) {
  const ws = ensureCombinedBlock(gid).workingSpace;
  ws.heightMm = Math.max(spacing, ws.heightMm + delta);
}

function setGroupColumns(gid, columns) {
  ensureCombinedBlock(gid).workingSpace.columns = columns;
}

// The whole block/group entry (not just its working space) - shrinking
// or growing a diagram, or toggling a manual page break, applies to any
// block (image or question), not only ones with an answer area.
function entryFor(kind, id) {
  if (kind === "group") return ensureCombinedBlock(id);
  return findBlock(id);
}

function toggleBreakBefore(kind, id) {
  const entry = entryFor(kind, id);
  if (entry) entry.breakBefore = !entry.breakBefore;
}

// "Split with next question" (see pairWithNextControlHtml/
// pairQuestionUnits in render.js) is always block-kind - a standalone
// question, never a group - and the toggle can fire from either its own
// unpaired panel or the shared paired-row panel's "Unpair" button
// (which always targets the *first* question of the pair), so this
// never needs to worry about which one it was clicked from.
function togglePairWithNext(id) {
  const entry = findBlock(id);
  if (entry) entry.pairWithNext = !entry.pairWithNext;
}

// Resolves once with whether `src` actually loads - used below to
// probe for a "<id>__full.png" source image without ever leaving the
// crop tool pointed at a 404. Only chapters built after the tight-
// default/generous-source crop split (see CROP_TIGHT_PAD_PX in
// add_chapter.py) have one; older chapters still ship a single
// "<id>.png" and fall back to it exactly as before.
function imageExists(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

// Opens the manual-crop tool (see crop.js) on this block/group's true
// source image - the generous "<id>__full.png" the build script kept
// real margin in (falling back to plain "<id>.png" for older chapters
// that don't have one), never a previously-applied manual crop. crop.js
// can only ever sub-select pixels from whatever image it's handed;
// pointing it at an already-cropped result would make anything trimmed
// off in an earlier crop unrecoverable except by throwing the whole
// crop away via "Reset to original". The initial selection box is
// whatever was saved last time (manualCropRect), or - the first time
// anyone opens this crop - the same tight rect already showing by
// default (defaultCropRect), so the box starts exactly where the
// visible crop already is and can be dragged back out from there.
async function handleOpenCrop(kind, id) {
  const entry = entryFor(kind, id);
  if (!entry) return;
  // ?v= busts any stale browser/CDN cache of this exact filename from
  // before the most recent rebuild - see buildVersion's own comment in
  // add_chapter.py.
  const v = currentWorkbook.buildVersion ? `?v=${encodeURIComponent(currentWorkbook.buildVersion)}` : "";
  const fullSrc = `data/${currentProjectId}/crops/${id}__full.png${v}`;
  const tightSrc = `data/${currentProjectId}/crops/${id}.png${v}`;
  const hasFull = await imageExists(fullSrc);
  const originalSrc = hasFull ? fullSrc : tightSrc;
  const initialRect = entry.manualCropRect || (hasFull ? entry.defaultCropRect : undefined);
  const result = await openCropModal(originalSrc, initialRect);
  if (result === null) return;
  if (result === "RESET") {
    delete entry.manualCropSrc;
    delete entry.manualCropRect;
  } else {
    entry.manualCropSrc = result.dataUrl;
    entry.manualCropRect = result.rect;
  }
  await persistAndRerenderEditor();
}

// A block/group id a user explicitly dropped (see the delete buttons on
// every question's controls) - independent of, and always wins over,
// the automatic tier odds/evens filter: deleting something the filter
// would already have hidden is a no-op today but stays deleted if the
// filter later changes to show it again.
function deleteId(id) {
  if (!currentWorkbook.deletedIds) currentWorkbook.deletedIds = [];
  if (!currentWorkbook.deletedIds.includes(id)) currentWorkbook.deletedIds.push(id);
}

function restoreIds(ids) {
  if (!currentWorkbook.deletedIds) return;
  const drop = new Set(ids);
  currentWorkbook.deletedIds = currentWorkbook.deletedIds.filter((id) => !drop.has(id));
}

function setTierFilter(tier, mode, chapterId) {
  if (!currentWorkbook.tierFilters) currentWorkbook.tierFilters = { global: {}, chapters: {} };
  if (chapterId) {
    if (!currentWorkbook.tierFilters.chapters[chapterId]) currentWorkbook.tierFilters.chapters[chapterId] = {};
    currentWorkbook.tierFilters.chapters[chapterId][tier] = mode;
  } else {
    currentWorkbook.tierFilters.global[tier] = mode;
  }
}

function resetChapterFilter(chapterId) {
  if (currentWorkbook.tierFilters?.chapters) delete currentWorkbook.tierFilters.chapters[chapterId];
}

function stepDefaultScale(mode, delta) {
  if (!currentWorkbook.defaultScales) currentWorkbook.defaultScales = {};
  const current = resolvedDefaultScales(currentWorkbook)[mode];
  const next = Math.max(IMAGE_SCALE_MIN, Math.min(IMAGE_SCALE_MAX, current + delta * IMAGE_SCALE_STEP));
  currentWorkbook.defaultScales[mode] = next;
}

// The two bars living outside #app (see filterBarMount) - always
// rendered together, always from current workbook state, so every call
// site that touches either one just calls this instead of reassembling
// the same two pieces by hand.
function renderTopBars() {
  filterBarMount.innerHTML =
    filterBarHtml(currentWorkbook, null) + defaultScaleBarHtml(currentWorkbook) + printSelectionBarHtml(currentWorkbook, printSelection);
}

// Applies the current print-selection choice to whatever's actually in
// #app right now: toggles which physical pages carry .print-excluded
// (see that rule in app.css, print-only) and fills in the cover's own
// note (see cover-print-note in render.js) with which chapters are
// missing, if any. Cheap DOM-only work, never a re-render - called
// after every fresh render (the pages are new elements then) and again
// on its own after every checkbox click (the pages are unchanged, only
// which ones are marked excluded needs to move).
function applyPrintSelection() {
  for (const el of appEl.querySelectorAll(".page[data-chapter]")) {
    const included = !printSelection || printSelection.has(el.dataset.chapter);
    el.classList.toggle("print-excluded", !included);
  }
  const note = appEl.querySelector(".cover-print-note");
  if (!note) return;
  const { chapters } = buildFilterContext(currentWorkbook);
  const included = printSelection ? chapters.filter((c) => printSelection.has(c.id)) : chapters;
  note.textContent =
    !printSelection || included.length === chapters.length
      ? ""
      : `Printing: ${included.map((c) => (c.text || "").split(/\s+/)[0]).join(", ") || "no chapters selected"}`;
}

// Every block/group's hanging panel (see .controls-hang in app.css) is
// positioned against its own block, top:0 - fine on its own, but a
// panel taller than the block it belongs to (there's often more to
// show in the controls than there is content next to them) spills into
// whatever's below it in the same margin column, and two panels that
// both land there overlap into an unreadable jumble. CSS alone can't
// fix this - it doesn't know one block's panel height when laying out
// the next - so this runs after every render, walks each page's panels
// in document order, and nudges any panel down (via transform, so it
// never touches the actual page layout or pagination) just far enough
// to clear whatever landed directly above it in that same column.
function layoutHangingControls() {
  for (const page of appEl.querySelectorAll(".page")) {
    let cursorBottom = null;
    for (const panel of page.querySelectorAll(".controls-hang")) {
      panel.style.transform = "";
      const rect = panel.getBoundingClientRect();
      let nudge = 0;
      if (cursorBottom !== null && rect.top < cursorBottom) {
        nudge = cursorBottom - rect.top;
        panel.style.transform = `translateY(${nudge}px)`;
      }
      cursorBottom = rect.top + nudge + rect.height + 4;
    }
  }
}

// extractOverrides() mirrors every group's *current* layout value,
// touched or not - saving that whole-object snapshot verbatim would
// freeze every group's layout forever at whatever it happened to be the
// first time the user edited anything in the project, silently masking
// any later improvement to the server-side default (see
// touchedGroupLayoutIds above) for every group the user never actually
// chose a layout for. Keep only the ones actually picked through the
// split/combined radios before saving.
async function renderEditorOnce() {
  const overrides = extractOverrides(currentWorkbook);
  overrides.groupLayout = Object.fromEntries(
    Object.entries(overrides.groupLayout).filter(([gid]) => touchedGroupLayoutIds.has(gid))
  );
  await db.saveOverrides(currentProjectId, overrides);
  renderTopBars();
  appEl.innerHTML = await renderEditor(currentWorkbook, `data/${currentProjectId}/crops`);
  await waitForImages(appEl);
  alignSplitRows(appEl);
  restoreExpandedControls();
  layoutHangingControls();
  applyPrintSelection();
}

// A full re-render walks every page's pagination from scratch, which on
// a large workbook (100+ pages) can take a couple of seconds - too slow
// to run once per click. Every state mutation already lands on
// currentWorkbook synchronously (see handleControlClick), so a burst of
// rapid clicks (someone holding the +/- zoom button down, say) doesn't
// need one render per click, just one more render after the in-flight
// one finishes to pick up wherever currentWorkbook ended up. Without
// this, each click kicked off its own overlapping renderEditor() call -
// all of them competing for the same CPU and racing to overwrite
// appEl.innerHTML - so the page would sit visually frozen for however
// long that pile-up took to drain, then jump straight to the last one
// standing. Coalescing means the UI updates once as soon as possible,
// and always ends on the true latest state.
let renderInFlight = null;
let renderQueued = false;

async function persistAndRerenderEditor() {
  renderQueued = true;
  if (renderInFlight) return renderInFlight;
  renderInFlight = (async () => {
    while (renderQueued) {
      renderQueued = false;
      await renderEditorOnce();
    }
    renderInFlight = null;
  })();
  return renderInFlight;
}

// Splits a project title like "Year 9 - Chapter 3: Pythagoras' Theorem
// (3A-3C)" into a book key ("Year 9") and the rest as its chapter label
// ("Chapter 3: Pythagoras' Theorem (3A-3C)") - falls back to putting the
// whole title under a single "Other" book if it doesn't start with a
// recognisable "Year N" prefix, so an oddly-titled project never just
// disappears from the list.
function splitBookTitle(title) {
  const m = title.match(/^(Year\s+\d+)\s*[-:]?\s*(.*)$/i);
  if (m && m[2]) return { book: m[1], chapter: m[2] };
  return { book: "Other", chapter: title };
}

// Groups every project under its book, each book getting one card with a
// single chapter dropdown instead of a flat list repeating "Year 9"
// across every one of its chapters - the more chapters accumulate per
// book, the more this actually saves over one row each.
async function renderHomeView() {
  currentWorkbook = null;
  currentProjectId = null;
  topbarActions.innerHTML = "";
  filterBarMount.innerHTML = "";

  let projects = [];
  try {
    const res = await fetch("data/index.json");
    if (res.ok) projects = await res.json();
  } catch (err) {
    console.error(err);
  }

  if (!projects.length) {
    appEl.innerHTML =
      '<div class="home-main"><div class="project-list">No projects yet - send Claude a chapter PDF in chat and it\'ll add one here.</div></div>';
    return;
  }

  const books = new Map();
  for (const p of projects) {
    const { book, chapter } = splitBookTitle(p.title);
    if (!books.has(book)) books.set(book, []);
    books.get(book).push({ id: p.id, chapter });
  }
  // Numeric-aware: "Year 9" before "Year 10", "Other" last regardless.
  const bookNames = [...books.keys()].sort((a, b) =>
    a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b, undefined, { numeric: true })
  );

  const cards = bookNames
    .map((book) => {
      const chapters = books.get(book);
      const options = chapters.map((c) => `<option value="${c.id}">${escapeHtml(c.chapter)}</option>`).join("");
      return `
        <div class="book-card" data-book="${escapeHtml(book)}">
          <div class="book-title">${escapeHtml(book)}</div>
          <div class="book-row">
            <select class="chapter-select" data-action="select-chapter">${options}</select>
            <a href="#/editor/${chapters[0].id}" class="open-chapter-btn">Open editor</a>
            <button data-action="delete-project" data-id="${chapters[0].id}" class="danger">Reset edits</button>
          </div>
        </div>`;
    })
    .join("");

  appEl.innerHTML = `<div class="home-main"><div class="project-list">${cards}</div></div>`;

  // Keep the "Open editor" link and "Reset edits" button in sync with
  // whichever chapter the card's own dropdown currently has selected -
  // they only ever act on one project at a time, so they need to track
  // the selection rather than the book.
  for (const select of appEl.querySelectorAll(".chapter-select")) {
    select.addEventListener("change", () => {
      const card = select.closest(".book-card");
      const openBtn = card.querySelector(".open-chapter-btn");
      const deleteBtn = card.querySelector('[data-action="delete-project"]');
      openBtn.href = `#/editor/${select.value}`;
      deleteBtn.dataset.id = select.value;
    });
  }
}

async function renderEditorView(id) {
  // Content (pages/blocks/crops) always comes fresh from the repo, never
  // from a previous save - only the user's own layout/size choices are
  // layered on top, so a content or crop fix pushed to data/<id> shows up
  // immediately even in a browser that already edited this project.
  let workbook;
  try {
    const res = await fetch(`data/${id}/workbook.json`);
    if (!res.ok) throw new Error(`no such project: ${id}`);
    workbook = await res.json();
  } catch (err) {
    console.error(err);
    location.hash = "#/";
    return;
  }
  // Both entirely user-authored - workbook.json never ships either, so
  // there's no server-side default to layer them onto (see extractOverrides
  // in model.js). applyOverrides only replaces them when a save actually
  // set one, so this default has to be seeded first.
  workbook.tierFilters = workbook.tierFilters || { global: {}, chapters: {} };
  workbook.deletedIds = workbook.deletedIds || [];
  workbook.defaultScales = workbook.defaultScales || {};
  workbook.groupSplitColumns = workbook.groupSplitColumns || {};
  applyOverrides(workbook, await db.loadOverrides(id));
  currentWorkbook = workbook;
  currentProjectId = id;
  touchedGroupLayoutIds = new Set();
  expandedControlIds = new Set();
  printSelection = null;

  topbarActions.innerHTML =
    '<a href="#/" class="secondary">Home</a> ' +
    `<button id="view-mode-btn" class="secondary" title="Booklet is a 2-page spread sized in CSS mm. 100% forces every page to this screen's actual measured physical size (one page at a time) so you can check real print readability.">${viewMode === "actual" ? "Booklet view" : "100% size"}</button> ` +
    `<button id="monitor-profile-btn" class="secondary" title="Which screen's own measured size 100% mode scales to - switch this when you open the editor on a different monitor, so 100% stays true physical size on either one." style="display:${viewMode === "actual" ? "" : "none"}">${MONITOR_PROFILES[monitorProfile].label}</button> ` +
    '<button id="autofit-btn" title="Tries to get Building Understanding and each worked example onto one page, then fills in any other page with real leftover room - never shrinks a diagram below a readable size on its own.">Auto-fit</button> ' +
    '<button id="undo-autofit-btn" class="secondary" disabled title="Reverts everything Auto-fit just changed.">Undo auto-fit</button> ' +
    '<button id="export-btn" title="Your browser\'s print dialog will open - choose \'Save as PDF\' and turn off headers/footers and margins for a clean export.">Export PDF</button>';
  document.getElementById("export-btn").onclick = () => window.print();
  document.getElementById("view-mode-btn").onclick = toggleViewMode;
  document.getElementById("monitor-profile-btn").onclick = toggleMonitorProfile;
  document.getElementById("autofit-btn").onclick = autoFitDocument;
  document.getElementById("undo-autofit-btn").onclick = undoAutoFit;
  preAutoFitSnapshot = null;

  applyViewMode();
  renderTopBars();
  appEl.innerHTML = await renderEditor(workbook, `data/${id}/crops`);
  await waitForImages(appEl);
  alignSplitRows(appEl);
  restoreExpandedControls();
  layoutHangingControls();
  applyPrintSelection();
}

// A single-level safety net for Auto-fit specifically (not a general undo
// stack) - it changes a lot of diagrams across the whole document in one
// go, on its own judgement, so there needs to be one obvious way back to
// exactly how things were right before it ran.
let preAutoFitSnapshot = null;

function updateUndoButton() {
  const btn = document.getElementById("undo-autofit-btn");
  if (btn) btn.disabled = !preAutoFitSnapshot;
}

async function undoAutoFit() {
  if (!preAutoFitSnapshot || !currentProjectId) return;
  const res = await fetch(`data/${currentProjectId}/workbook.json`);
  const fresh = await res.json();
  fresh.tierFilters = fresh.tierFilters || { global: {}, chapters: {} };
  fresh.deletedIds = fresh.deletedIds || [];
  fresh.defaultScales = fresh.defaultScales || {};
  applyOverrides(fresh, preAutoFitSnapshot);
  currentWorkbook = fresh;
  await db.saveOverrides(currentProjectId, preAutoFitSnapshot);
  preAutoFitSnapshot = null;
  renderTopBars();
  appEl.innerHTML = await renderEditor(currentWorkbook, `data/${currentProjectId}/crops`);
  await waitForImages(appEl);
  alignSplitRows(appEl);
  restoreExpandedControls();
  layoutHangingControls();
  applyPrintSelection();
  updateUndoButton();
}

// The two things Auto-fit tries to actively compact onto one physical
// sheet, not just opportunistically react to leftover gaps (see the
// squeeze-in pass below) - a Building Understanding section (marked
// data-bu-heading, see render.js) and each worked example's own bundle
// (marked data-glue-example, the same flag that already keeps an example
// glued to its "Now you try" during pagination). Read straight off the
// rendered DOM in document order (".page > *" is exactly the sequence of
// top-level pagination units - see renderEditor in render.js) rather than
// recomputed from the source data, since "does this actually span more
// than one physical sheet" can only be answered from what's already
// on the page.
function compactionBundles() {
  const units = Array.from(appEl.querySelectorAll(".page > *"));
  const bundles = [];
  for (let i = 0; i < units.length; i++) {
    const el = units[i];
    const isBuHeading = el.matches(".heading-unit[data-bu-heading]");
    const isExample = el.matches("[data-glue-example]");
    if (!isBuHeading && !isExample) continue;
    const els = [el];
    for (let j = i + 1; j < units.length; j++) {
      const next = units[j];
      // Any heading ends a Building Understanding section outright; an
      // example's own bundle also ends at the next example (its "Now you
      // try" never runs longer than that).
      if (next.matches(".heading-unit")) break;
      if (isExample && next.matches("[data-glue-example]")) break;
      els.push(next);
    }
    bundles.push({ label: isBuHeading ? "Building Understanding" : "Example", els });
  }
  return bundles;
}

function bundleSpansMultiplePages(bundle) {
  const pages = new Set(bundle.els.map((el) => el.closest(".page")));
  return pages.size > 1;
}

// A glued bundle (see bundleEnd() in render.js) that's too tall for one
// page doesn't always get split across two .page divs the way
// bundleSpansMultiplePages() checks for - a bundle held together on a
// single sheet just makes that one sheet taller than physical A4 instead
// (see growth-locked in app.css, which render.js marks on exactly this
// case). Auto-fit needs to catch that too, not just the multi-sheet
// case, or it'll walk straight past a bundle that's already overflowing.
function bundleOversizedOnOnePage(bundle) {
  return bundle.els.some((el) => el.classList.contains("growth-locked"));
}

function shrinkableTargetsInBundle(bundle) {
  const targets = [];
  for (const el of bundle.els) {
    for (const btn of el.querySelectorAll('[data-action="step-image-scale"][data-delta="-1"]')) {
      for (const t of (btn.dataset.target || "").split(",").filter(Boolean)) {
        targets.push({ kind: btn.dataset.kind, id: t });
      }
    }
  }
  return targets;
}

// Bundle elements are stale (detached) the instant persistAndRerenderEditor
// replaces #app's contents, so each bundle has to be re-found by its
// position after every shrink - never held onto across a render. Index
// position is stable across re-renders (shrinking never adds, removes, or
// reorders a Building Understanding section or an example), so re-running
// compactionBundles() and indexing into it is enough.
async function compactSections(btn) {
  const bundleCount = compactionBundles().length;
  for (let idx = 0; idx < bundleCount; idx++) {
    let rounds = 0;
    const MAX_ROUNDS_PER_BUNDLE = 30;
    while (rounds < MAX_ROUNDS_PER_BUNDLE) {
      const bundle = compactionBundles()[idx];
      if (!bundle || !(bundleSpansMultiplePages(bundle) || bundleOversizedOnOnePage(bundle))) break;
      let changed = false;
      for (const { kind, id } of shrinkableTargetsInBundle(bundle)) {
        if (shrinkOneStep(entryFor(kind, id), defaultScaleFor(currentWorkbook, kind, id, tierFor(currentWorkbook, id)))) changed = true;
      }
      // Every diagram in this bundle already at the readability floor -
      // it just doesn't fit one page without going further than Auto-fit
      // is willing to push on its own; leave it and move on.
      if (!changed) break;
      rounds++;
      btn.textContent = `Auto-fitting… (${bundle.label})`;
      await persistAndRerenderEditor();
    }
  }
}

// First tries to actively compact Building Understanding and each
// example onto one page each (compactSections), then falls back to the
// same opportunistic gap-filling squeeze-in pass as before for whatever
// leftover room remains elsewhere - one button, two passes. Both respect
// the automatic-shrink readability floor (see READABILITY_FLOOR_SCALE in
// model.js) throughout; neither pushes a diagram down to the same
// bare-minimum size a manual +/- click still can.
async function autoFitDocument() {
  const btn = document.getElementById("autofit-btn");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  preAutoFitSnapshot = extractOverrides(currentWorkbook);
  updateUndoButton();
  let rounds = 0;
  const MAX_ROUNDS = 2000;
  try {
    await compactSections(btn);

    while (rounds < MAX_ROUNDS) {
      const squeeze = appEl.querySelector(".squeeze-in");
      if (!squeeze) break;
      const targets = (squeeze.dataset.ids || "")
        .split(",")
        .filter(Boolean)
        .map((spec) => {
          const sep = spec.indexOf(":");
          return { kind: spec.slice(0, sep), id: spec.slice(sep + 1) };
        });
      let changed = false;
      for (const { kind, id } of targets) {
        if (shrinkOneStep(entryFor(kind, id), defaultScaleFor(currentWorkbook, kind, id, tierFor(currentWorkbook, id)))) changed = true;
      }
      // Every target already at its floor would mean squeezeInHtml()
      // should never have offered this button in the first place - stop
      // rather than spin forever on a no-op if that ever happens.
      if (!changed) break;
      rounds++;
      btn.textContent = `Auto-fitting… (${rounds})`;
      await persistAndRerenderEditor();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

async function route() {
  const hash = location.hash || "#/";
  const editorMatch = hash.match(/^#\/editor\/([a-f0-9]+)$/);
  if (editorMatch) {
    await renderEditorView(editorMatch[1]);
  } else {
    await renderHomeView();
  }
}

// Shared by both appEl (the paginated document - most controls, plus
// each chapter's own filter row, live here) and filterBarMount (the
// workbook-wide filter bar - deliberately outside appEl, so it's never
// wiped out along with the rest of the document on every re-render, see
// persistAndRerenderEditor).
function handleControlClick(e) {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  if (action === "delete-project") {
    if (confirm("Reset your edits for this project back to Claude's original detection?")) {
      db.deleteOverrides(el.dataset.id).then(renderHomeView);
    }
    return;
  }

  // Pure DOM/CSS state, not a data edit - toggles the "expanded" class
  // read purely from live styles (see .controls-hang/.group-controls in
  // app.css). No persistAndRerenderEditor here: nothing about the
  // workbook itself changed, and a full re-render would collapse every
  // other panel a user might have open elsewhere on the same page for
  // no reason. layoutHangingControls() still needs to re-run though -
  // an expanding panel grows taller and may now overlap whatever's
  // hanging below it in the same margin column. Also recorded into
  // expandedControlIds so this panel survives the *next* full
  // re-render too - every actual edit inside an open panel (nudging a
  // size, picking a style...) still goes through persistAndRerenderEditor,
  // which replaces this whole panel's DOM outright; without this, the
  // very first click inside an opened panel would immediately look
  // like it closed the panel again, when what really happened is the
  // panel got rebuilt from scratch back at its default collapsed state.
  if (action === "toggle-controls") {
    const panel = el.closest(".controls-hang, .group-controls");
    const cid = el.dataset.controlsId;
    if (panel) {
      const isExpanded = panel.classList.toggle("expanded");
      if (cid) {
        if (isExpanded) expandedControlIds.add(cid);
        else expandedControlIds.delete(cid);
      }
    }
    layoutHangingControls();
    return;
  }

  if (!currentWorkbook) return;
  // A single picker (Combined / 1 split / 2 split / 3 split / 4 split -
  // see render.js's groupLayoutPickerHtml) sets both the layout and,
  // for a split choice, the column count in one click - previously two
  // separate controls (a layout radio, then a cols picker that only
  // showed up once split was already chosen), which meant switching
  // from "Combined" to "3 split" took two clicks through an
  // intermediate 2-column state. data-columns is only present on a
  // split option's own button, never on Combined's.
  if (action === "set-group-layout") {
    const gid = el.dataset.group;
    touchedGroupLayoutIds.add(gid);
    currentWorkbook.groupLayout[gid] = el.dataset.mode;
    if (el.dataset.columns) currentWorkbook.groupSplitColumns[gid] = Number(el.dataset.columns);
    persistAndRerenderEditor();
    return;
  }

  if (action === "set-tier-filter") {
    setTierFilter(el.dataset.tier, el.dataset.mode, el.dataset.chapter || null);
    persistAndRerenderEditor();
    return;
  }
  if (action === "reset-chapter-filter") {
    resetChapterFilter(el.dataset.chapter);
    persistAndRerenderEditor();
    return;
  }
  if (action === "step-default-scale") {
    stepDefaultScale(el.dataset.mode, Number(el.dataset.delta));
    persistAndRerenderEditor();
    return;
  }
  // The print-selection panel (see printSelectionBarHtml in render.js) -
  // deliberately never goes through persistAndRerenderEditor: it's not a
  // document edit (nothing here is saved), so a cheap direct DOM update
  // (applyPrintSelection) is enough, without paying for a full
  // from-scratch pagination pass on every checkbox click.
  if (action === "toggle-print-chapter") {
    if (!printSelection) {
      printSelection = new Set(buildFilterContext(currentWorkbook).chapters.map((c) => c.id));
    }
    if (el.checked) printSelection.add(el.dataset.chapter);
    else printSelection.delete(el.dataset.chapter);
    applyPrintSelection();
    return;
  }
  if (action === "print-selection-all") {
    printSelection = null;
    renderTopBars();
    applyPrintSelection();
    return;
  }
  if (action === "print-selection-none") {
    printSelection = new Set();
    renderTopBars();
    applyPrintSelection();
    return;
  }
  if (action === "delete") {
    deleteId(el.dataset.target);
    persistAndRerenderEditor();
    return;
  }
  if (action === "restore") {
    // A group with every one of its parts individually deleted (see
    // groupVisibility in render.js) needs all of them back at once - its
    // one restore placeholder carries every hidden id there, comma-joined.
    restoreIds(el.dataset.target.split(",").filter(Boolean));
    persistAndRerenderEditor();
    return;
  }
  if (action === "open-crop") {
    // Async, and manages its own re-render - nothing left to do in this
    // (synchronous) handler once it's kicked off.
    handleOpenCrop(el.dataset.kind, el.dataset.target);
    return;
  }

  if (action === "squeeze-in") {
    const targets = (el.dataset.ids || "")
      .split(",")
      .filter(Boolean)
      .map((spec) => {
        const sep = spec.indexOf(":");
        return { kind: spec.slice(0, sep), id: spec.slice(sep + 1) };
      });
    let changed = false;
    for (const { kind, id } of targets) {
      if (shrinkOneStep(entryFor(kind, id), defaultScaleFor(currentWorkbook, kind, id, tierFor(currentWorkbook, id)))) changed = true;
    }
    if (changed) persistAndRerenderEditor();
    return;
  }

  const isGroup = el.dataset.kind === "group";
  // A control's data-target is usually one id, but a split row's shared
  // panel (see renderGroup's split branch in render.js) puts both parts'
  // ids there separated by a comma - a matched pair is always locked to
  // one shared size, so a single change is meant to apply to both parts
  // at once. Every action below just loops over however many ids it
  // got, so the single-id case (the common one) is just a one-element
  // loop.
  const targets = (el.dataset.target || "").split(",").filter(Boolean);
  if (action === "set-style") {
    for (const t of targets) isGroup ? setGroupStyle(t, el.dataset.style) : setBlockStyle(t, el.dataset.style);
  } else if (action === "set-size") {
    const mm = SIZE_PRESETS_MM[el.dataset.size];
    for (const t of targets) isGroup ? setGroupHeight(t, mm) : setBlockHeight(t, mm);
  } else if (action === "step-height") {
    const spacing = Number(el.dataset.spacing);
    const delta = Number(el.dataset.delta) * spacing;
    for (const t of targets) isGroup ? stepGroupHeight(t, spacing, delta) : stepBlockHeight(t, spacing, delta);
  } else if (action === "set-columns") {
    const columns = Number(el.dataset.columns);
    for (const t of targets) isGroup ? setGroupColumns(t, columns) : setBlockColumns(t, columns);
  } else if (action === "step-image-scale") {
    // Diagram-only, deliberately not the combined shrinkOneStep() -
    // this is a dedicated control, so "-" should never silently fall
    // through to trimming the working space instead.
    const delta = Number(el.dataset.delta);
    let changed = false;
    for (const t of targets) {
      const entry = entryFor(el.dataset.kind, t);
      const defaultScale = defaultScaleFor(currentWorkbook, el.dataset.kind, t, tierFor(currentWorkbook, t));
      // The one place that gets the full IMAGE_SCALE_MIN range instead of
      // the automatic-shrink readability floor (see READABILITY_FLOOR_SCALE
      // in model.js) - a direct +/- click is a deliberate, single-diagram
      // choice, not the system shrinking something on its own.
      if (entry && (delta > 0 ? growImageOneStep(entry, defaultScale) : shrinkImageOneStep(entry, defaultScale, IMAGE_SCALE_MIN))) changed = true;
    }
    if (!changed) return;
  } else if (action === "toggle-break-before") {
    for (const t of targets) toggleBreakBefore(el.dataset.kind, t);
  } else if (action === "toggle-pair-with-next") {
    for (const t of targets) togglePairWithNext(t);
  } else {
    return;
  }
  persistAndRerenderEditor();
}

appEl.addEventListener("click", handleControlClick);
filterBarMount.addEventListener("click", handleControlClick);

window.addEventListener("hashchange", route);
route();
