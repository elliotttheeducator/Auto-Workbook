import * as db from "./db.js";
import {
  applyOverrides,
  escapeHtml,
  extractOverrides,
  growImageOneStep,
  RULE_MM,
  shrinkImageOneStep,
  shrinkOneStep,
  SIZE_PRESETS_MM,
} from "./model.js";
import { renderEditor } from "./render.js";

const appEl = document.getElementById("app");
const topbarActions = document.getElementById("topbar-actions");

let currentWorkbook = null;
let currentProjectId = null;

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

async function persistAndRerenderEditor() {
  await db.saveOverrides(currentProjectId, extractOverrides(currentWorkbook));
  appEl.innerHTML = await renderEditor(currentWorkbook, `data/${currentProjectId}/crops`);
  layoutHangingControls();
}

async function renderHomeView() {
  currentWorkbook = null;
  currentProjectId = null;
  topbarActions.innerHTML = "";

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
  applyOverrides(workbook, await db.loadOverrides(id));
  currentWorkbook = workbook;
  currentProjectId = id;

  topbarActions.innerHTML =
    '<a href="#/" class="secondary">Home</a> ' +
    '<button id="export-btn" title="Your browser\'s print dialog will open - choose \'Save as PDF\' and turn off headers/footers and margins for a clean export.">Export PDF</button>';
  document.getElementById("export-btn").onclick = () => window.print();

  appEl.innerHTML = await renderEditor(workbook, `data/${id}/crops`);
  layoutHangingControls();
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

appEl.addEventListener("click", (e) => {
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
    currentWorkbook.groupLayout[el.dataset.group] = el.dataset.mode;
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
      if (shrinkOneStep(entryFor(kind, id))) changed = true;
    }
    if (changed) persistAndRerenderEditor();
    return;
  }

  const isGroup = el.dataset.kind === "group";
  // A control's data-target is usually one id, but a split row's shared
  // "Both" panel (see bothControlsHtml in render.js) puts two ids there
  // separated by a comma to apply the same change to both parts at
  // once - every action below just loops over however many it got, so
  // the single-id case (the common one) is just a one-element loop.
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
      if (entry && (delta > 0 ? growImageOneStep(entry) : shrinkImageOneStep(entry))) changed = true;
    }
    if (!changed) return;
  } else if (action === "toggle-break-before") {
    for (const t of targets) toggleBreakBefore(el.dataset.kind, t);
  } else {
    return;
  }
  persistAndRerenderEditor();
});

window.addEventListener("hashchange", route);
route();
