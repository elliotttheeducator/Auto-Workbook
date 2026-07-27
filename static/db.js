// IndexedDB wrapper for in-progress edits. Project *content* (pages,
// blocks, crop filenames) always comes fresh from data/<id>/workbook.json
// on every load - Claude commits and pushes those - so a content or crop
// fix is visible immediately. This store only holds the small set of
// *overrides* a user makes through the editor's own controls (split vs
// combined, working-space style/size/columns), layered on top of that
// fresh content on load (see model.js's applyOverrides/extractOverrides).
import { extractOverrides } from "./model.js";

const DB_NAME = "worksheet-builder";
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const upgradeTx = req.transaction;
      if (!db.objectStoreNames.contains("overrides")) {
        db.createObjectStore("overrides", { keyPath: "id" });
      }
      // v1 stored the *entire* workbook here, keyed by project id - which
      // is exactly the bug this migration exists to fix: any browser that
      // had ever saved one edit would keep re-rendering that frozen full
      // copy forever, forever blind to every later content/crop fix
      // pushed to the repo. Salvage just the override fields out of each
      // old entry rather than losing a user's layout/size choices
      // outright, then drop the old store so nothing can read the frozen
      // copy again.
      if (event.oldVersion < 2 && db.objectStoreNames.contains("projects")) {
        const oldStore = upgradeTx.objectStore("projects");
        const overridesStore = upgradeTx.objectStore("overrides");
        oldStore.getAll().onsuccess = (e) => {
          for (const oldWorkbook of e.target.result) {
            overridesStore.put({ id: oldWorkbook.id, ...extractOverrides(oldWorkbook) });
          }
          db.deleteObjectStore("projects");
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

export async function saveOverrides(id, overrides) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "overrides", "readwrite").put({ id, ...overrides });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function loadOverrides(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "overrides", "readonly").get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteOverrides(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "overrides", "readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
