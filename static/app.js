import * as db from "./db.js";
import { escapeHtml, RULE_MM, SIZE_PRESETS_MM } from "./model.js";
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

async function persistAndRerenderEditor() {
  await db.saveProject(currentWorkbook);
  appEl.innerHTML = renderEditor(currentWorkbook, `data/${currentProjectId}/crops`);
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
  let workbook = await db.loadProject(id);
  if (!workbook) {
    try {
      const res = await fetch(`data/${id}/workbook.json`);
      if (!res.ok) throw new Error(`no such project: ${id}`);
      workbook = await res.json();
    } catch (err) {
      console.error(err);
      location.hash = "#/";
      return;
    }
  }
  currentWorkbook = workbook;
  currentProjectId = id;

  topbarActions.innerHTML =
    '<a href="#/" class="secondary">Home</a> ' +
    '<button id="export-btn" title="Your browser\'s print dialog will open - choose \'Save as PDF\' and turn off headers/footers and margins for a clean export.">Export PDF</button>';
  document.getElementById("export-btn").onclick = () => window.print();

  appEl.innerHTML = renderEditor(workbook, `data/${id}/crops`);
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
      db.deleteProject(el.dataset.id).then(renderHomeView);
    }
    return;
  }

  if (!currentWorkbook) return;
  if (action === "set-layout") {
    currentWorkbook.groupLayout[el.dataset.group] = el.dataset.mode;
    persistAndRerenderEditor();
    return;
  }

  const isGroup = el.dataset.kind === "group";
  const target = el.dataset.target;
  if (action === "set-style") {
    isGroup ? setGroupStyle(target, el.dataset.style) : setBlockStyle(target, el.dataset.style);
  } else if (action === "set-size") {
    const mm = SIZE_PRESETS_MM[el.dataset.size];
    isGroup ? setGroupHeight(target, mm) : setBlockHeight(target, mm);
  } else if (action === "step-height") {
    const spacing = Number(el.dataset.spacing);
    const delta = Number(el.dataset.delta) * spacing;
    isGroup ? stepGroupHeight(target, spacing, delta) : stepBlockHeight(target, spacing, delta);
  } else if (action === "set-columns") {
    const columns = Number(el.dataset.columns);
    isGroup ? setGroupColumns(target, columns) : setBlockColumns(target, columns);
  } else {
    return;
  }
  persistAndRerenderEditor();
});

window.addEventListener("hashchange", route);
route();
