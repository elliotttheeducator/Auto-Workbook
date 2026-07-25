import * as db from "./db.js";
import { escapeHtml, RULE_MM, SIZE_PRESETS_MM } from "./model.js";
import { renderEditor } from "./render.js";

const appEl = document.getElementById("app");
const topbarActions = document.getElementById("topbar-actions");

let currentWorkbook = null;
let currentBlobUrls = null;

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

async function persistAndRerenderEditor() {
  await db.saveProject(currentWorkbook);
  appEl.innerHTML = renderEditor(currentWorkbook, currentBlobUrls);
}

async function onImportBundle() {
  const bundleFile = document.getElementById("bundle-file").files[0];
  if (!bundleFile) {
    alert("Choose a project bundle file.");
    return;
  }

  const button = document.getElementById("import-bundle");
  button.disabled = true;
  button.textContent = "Importing...";
  try {
    const bundle = JSON.parse(await bundleFile.text());
    const { crops, ...workbook } = bundle;
    for (const [blockId, dataUri] of Object.entries(crops || {})) {
      const blob = await (await fetch(dataUri)).blob();
      await db.saveBlob(workbook.id, blockId, blob);
    }
    await db.saveProject(workbook);
    location.hash = `#/editor/${workbook.id}`;
  } catch (err) {
    console.error(err);
    alert("Couldn't import bundle: " + err.message);
  } finally {
    button.disabled = false;
    button.textContent = "Import project";
  }
}

async function renderHomeView() {
  currentWorkbook = null;
  currentBlobUrls = null;
  topbarActions.innerHTML = "";

  const projects = await db.listProjects();
  const rows = projects.length
    ? projects
        .map(
          (p) => `
        <div class="project-row">
          <div><strong>${escapeHtml(p.title)}</strong><br><span class="status">${p.id}</span></div>
          <div class="actions">
            <a href="#/editor/${p.id}">Open editor</a>
            <button data-action="delete-project" data-id="${p.id}" class="danger">Delete</button>
          </div>
        </div>`
        )
        .join("")
    : "<div>No projects yet - import a project bundle below to start one.</div>";

  appEl.innerHTML = `
    <div class="home-main">
      <div class="upload-box">
        <h3>New project</h3>
        <label>Project bundle</label>
        <input type="file" id="bundle-file" accept="application/json">
        <div class="hint">Send Claude your chapter PDF in chat - it reads it, crops every question, and
        hands you back one bundle file. Upload that here and you'll go straight to the editor.</div>
        <button id="import-bundle">Import project</button>
      </div>
      <div class="project-list">${rows}</div>
    </div>`;

  document.getElementById("import-bundle").onclick = onImportBundle;
}

async function renderEditorView(id) {
  const workbook = await db.loadProject(id);
  if (!workbook) {
    location.hash = "#/";
    return;
  }
  currentWorkbook = workbook;
  currentBlobUrls = new Map();
  for (const page of workbook.pages) {
    for (const b of page.blocks) {
      if (b.type === "heading") continue;
      const blob = await db.loadBlob(id, b.id);
      if (blob) currentBlobUrls.set(b.id, URL.createObjectURL(blob));
    }
  }

  topbarActions.innerHTML =
    '<a href="#/" class="secondary">Home</a> ' +
    '<button id="export-btn" title="Your browser\'s print dialog will open - choose \'Save as PDF\' and turn off headers/footers and margins for a clean export.">Export PDF</button>';
  document.getElementById("export-btn").onclick = () => window.print();

  appEl.innerHTML = renderEditor(workbook, currentBlobUrls);
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
    if (confirm("Delete this project? This can't be undone.")) {
      db.deleteProject(el.dataset.id).then(renderHomeView);
    }
    return;
  }

  if (!currentWorkbook) return;
  if (action === "set-layout") {
    currentWorkbook.groupLayout[el.dataset.group] = el.dataset.mode;
  } else if (action === "set-style") {
    for (const id of el.dataset.target.split(",")) setBlockStyle(id, el.dataset.style);
  } else if (action === "set-size") {
    for (const id of el.dataset.target.split(",")) setBlockHeight(id, SIZE_PRESETS_MM[el.dataset.size]);
  } else if (action === "step-height") {
    const spacing = Number(el.dataset.spacing);
    const delta = Number(el.dataset.delta) * spacing;
    for (const id of el.dataset.target.split(",")) stepBlockHeight(id, spacing, delta);
  } else {
    return;
  }
  persistAndRerenderEditor();
});

window.addEventListener("hashchange", route);
route();
