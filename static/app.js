import * as db from "./db.js";
import { escapeHtml, newProjectId, RULE_MM, SIZE_PRESETS_MM } from "./model.js";
import { buildProjectFromPdf } from "./pdf-import.js";
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

async function onCreateProject() {
  const title = document.getElementById("new-title").value.trim() || "Untitled chapter";
  const pdfFile = document.getElementById("new-pdf").files[0];
  const jsonFile = document.getElementById("new-json").files[0];
  if (!pdfFile || !jsonFile) {
    alert("Choose both a chapter PDF and a detection JSON file.");
    return;
  }

  const button = document.getElementById("create-project");
  button.disabled = true;
  button.textContent = "Building...";
  try {
    const proposals = JSON.parse(await jsonFile.text());
    const id = newProjectId();
    const { workbook, blobsToSave } = await buildProjectFromPdf({ id, title, pdfFile, proposals });
    for (const { blockId, blob } of blobsToSave) {
      await db.saveBlob(id, blockId, blob);
    }
    await db.saveProject(workbook);
    location.hash = `#/editor/${id}`;
  } catch (err) {
    console.error(err);
    alert("Couldn't build project: " + err.message);
  } finally {
    button.disabled = false;
    button.textContent = "Create project";
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
    : "<div>No projects yet - upload a chapter PDF and its detection JSON below to start one.</div>";

  appEl.innerHTML = `
    <div class="home-main">
      <div class="upload-box">
        <h3>New project</h3>
        <label>Chapter title</label>
        <input type="text" id="new-title" placeholder="Y9 Chapter 7 - Angles and triangles">
        <label>Chapter PDF</label>
        <input type="file" id="new-pdf" accept="application/pdf">
        <label>Detection JSON</label>
        <input type="file" id="new-json" accept="application/json">
        <div class="hint">Ask Claude to read your chapter PDF and produce this detection JSON - it does the
        same "which regions are which question" reasoning a live API call would, at no per-page API cost.</div>
        <button id="create-project">Create project</button>
      </div>
      <div class="project-list">${rows}</div>
    </div>`;

  document.getElementById("create-project").onclick = onCreateProject;
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
