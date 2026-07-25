// IndexedDB wrapper for in-progress edits. Project source data (workbook
// structure + crop images) lives as plain files in the repo's data/
// folder - Claude commits and pushes those, so nothing needs uploading.
// This store only holds *edits* made in the browser (S/M/L, split/
// combined, etc.) layered on top of that source data for this session.
const DB_NAME = "worksheet-builder";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("projects")) {
        db.createObjectStore("projects", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

export async function saveProject(workbook) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "projects", "readwrite").put(workbook);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function loadProject(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "projects", "readonly").get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteProject(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "projects", "readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
