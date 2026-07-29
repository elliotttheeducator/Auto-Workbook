import * as db from "./db.js";
import {
  applyOverrides,
  defaultScaleFor,
  escapeHtml,
  extractOverrides,
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
import { alignSplitRows, defaultScaleBarHtml, filterBarHtml, renderEditor, waitForImages } from "./render.js";

const appEl = document.getElementById("app");
const topbarActions = document.getElementById("topbar-actions");
const filterBarMount = document.getElementById("filter-bar-mount");

let currentWorkbook = null;
let currentProjectId = null;
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
  filterBarMount.innerHTML = filterBarHtml(currentWorkbook, null) + defaultScaleBarHtml(currentWorkbook);
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
async function persistAndRerenderEditor() {
  const overrides = extractOverrides(currentWorkbook);
  overrides.groupLayout = Object.fromEntries(
    Object.entries(overrides.groupLayout).filter(([gid]) => touchedGroupLayoutIds.has(gid))
  );
  await db.saveOverrides(currentProjectId, overrides);
  renderTopBars();
  appEl.innerHTML = await renderEditor(currentWorkbook, `data/${currentProjectId}/crops`);
  await waitForImages(appEl);
  alignSplitRows(appEl);
  layoutHangingControls();
}

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

  const rows = projects.length
    ? projects
        .map(
          (p) => `
        <div class="project-row">
          <div><strong>${escapeHtml(p.title)}</strong><br><span class="status">${p.id}</span></div>
          <div class="actions">
            <a href="#/editor/${p.id}">Open editor</a>
            <button data-action="delete-project" data-id="${p.id}" class="danger">Reset edits</button>
          </div>
        </div>`
        )
        .join("")
    : "<div>No projects yet - send Claude a chapter PDF in chat and it'll add one here.</div>";

  appEl.innerHTML = `<div class="home-main"><div class="project-list">${rows}</div></div>`;
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
  applyOverrides(workbook, await db.loadOverrides(id));
  currentWorkbook = workbook;
  currentProjectId = id;
  touchedGroupLayoutIds = new Set();

  topbarActions.innerHTML =
    '<a href="#/" class="secondary">Home</a> ' +
    '<button id="autofit-btn" title="Tries to get Building Understanding and each worked example onto one page, then fills in any other page with real leftover room - never shrinks a diagram below a readable size on its own.">Auto-fit</button> ' +
    '<button id="undo-autofit-btn" class="secondary" disabled title="Reverts everything Auto-fit just changed.">Undo auto-fit</button> ' +
    '<button id="export-btn" title="Your browser\'s print dialog will open - choose \'Save as PDF\' and turn off headers/footers and margins for a clean export.">Export PDF</button>';
  document.getElementById("export-btn").onclick = () => window.print();
  document.getElementById("autofit-btn").onclick = autoFitDocument;
  document.getElementById("undo-autofit-btn").onclick = undoAutoFit;
  preAutoFitSnapshot = null;

  renderTopBars();
  appEl.innerHTML = await renderEditor(workbook, `data/${id}/crops`);
  await waitForImages(appEl);
  alignSplitRows(appEl);
  layoutHangingControls();
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
  layoutHangingControls();
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
      if (!bundle || !bundleSpansMultiplePages(bundle)) break;
      let changed = false;
      for (const { kind, id } of shrinkableTargetsInBundle(bundle)) {
        if (shrinkOneStep(entryFor(kind, id), defaultScaleFor(currentWorkbook, kind, id))) changed = true;
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
        if (shrinkOneStep(entryFor(kind, id), defaultScaleFor(currentWorkbook, kind, id))) changed = true;
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

  if (!currentWorkbook) return;
  if (action === "set-layout") {
    touchedGroupLayoutIds.add(el.dataset.group);
    currentWorkbook.groupLayout[el.dataset.group] = el.dataset.mode;
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
      if (shrinkOneStep(entryFor(kind, id), defaultScaleFor(currentWorkbook, kind, id))) changed = true;
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
      const defaultScale = defaultScaleFor(currentWorkbook, el.dataset.kind, t);
      // The one place that gets the full IMAGE_SCALE_MIN range instead of
      // the automatic-shrink readability floor (see READABILITY_FLOOR_SCALE
      // in model.js) - a direct +/- click is a deliberate, single-diagram
      // choice, not the system shrinking something on its own.
      if (entry && (delta > 0 ? growImageOneStep(entry, defaultScale) : shrinkImageOneStep(entry, defaultScale, IMAGE_SCALE_MIN))) changed = true;
    }
    if (!changed) return;
  } else if (action === "toggle-break-before") {
    for (const t of targets) toggleBreakBefore(el.dataset.kind, t);
  } else {
    return;
  }
  persistAndRerenderEditor();
}

appEl.addEventListener("click", handleControlClick);
filterBarMount.addEventListener("click", handleControlClick);

window.addEventListener("hashchange", route);
route();
