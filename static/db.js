// IndexedDB wrapper. Two stores: "projects" (workbook JSON, keyed by id)
// and "blobs" (crop PNGs, keyed by "<projectId>::<blockId>"). Everything
// lives in this browser only - there is no server, so nothing is portable
// across devices unless the user exports it themselves.
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
      if (!db.objectStoreNames.contains("blobs")) {
        db.createObjectStore("blobs");
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

export async function listProjects() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "projects", "readonly").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteProject(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const req = tx(db, "projects", "readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  const range = IDBKeyRange.bound(`${id}::`, `${id}::￿`);
  await new Promise((resolve, reject) => {
    const store = tx(db, "blobs", "readwrite");
    const cursorReq = store.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

export async function saveBlob(projectId, blockId, blob) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "blobs", "readwrite").put(blob, `${projectId}::${blockId}`);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function loadBlob(projectId, blockId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "blobs", "readonly").get(`${projectId}::${blockId}`);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
