// Minimal promise wrapper over IndexedDB — vendored so we don't depend on `idb`. One object store,
// get/put by key.

function assertBrowser(): void {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable (this code must run in the browser).');
  }
}

function open(dbName: string, store: string): Promise<IDBDatabase> {
  assertBrowser();
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(dbName: string, store: string, key: string): Promise<T | undefined> {
  const db = await open(dbName, store);
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const r = db.transaction(store, 'readonly').objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result as T | undefined);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

export async function idbPut(dbName: string, store: string, key: string, val: unknown): Promise<void> {
  const db = await open(dbName, store);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
