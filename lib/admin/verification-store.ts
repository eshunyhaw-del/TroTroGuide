'use client';
// Admin field store.

export interface Verification {
  osmRef: string; // 'node/12345' — primary key + provenance.osm_ref
  osmName: string | null; // formal OSM name at save time (for export convenience)
  exists: boolean;
  mateShout: string;
  localName: string;
  myLat: number | null; // operator's OWN GPS
  myLng: number | null;
  notes: string;
  verifiedAt: number; // epoch ms
}

export type BoardAlight = 'board' | 'alight' | 'both';

export interface NewStop {
  stopId: string; // client-generated uuid — NOT an OSM id
  name: string;
  localName: string;
  mateShout: string;
  boardAlight: BoardAlight;
  myLat: number | null; // YOUR GPS — required to be useful
  myLng: number | null;
  routeRef: string; // which route this belongs to
  sequence: number; // where it fits in the route order
  notes: string;
  verifiedAt: number;
}

export const CHANGE_TYPES = [
  { k: 'extended', label: 'Route extended (new terminal)' },
  { k: 'shortened', label: 'Route shortened (terminal removed)' },
  { k: 'new_stops', label: 'New stops added' },
  { k: 'removed', label: 'Stops removed' },
  { k: 'discontinued', label: 'Route no longer exists' },
  { k: 'terminal_changed', label: 'Terminal changed' },
] as const;

export interface RouteChange {
  id: string;
  routeRef: string;
  changeTypes: string[]; // any of CHANGE_TYPES[].k
  description: string;
  newTerminal: string;
  oldTerminal: string;
  stopsAdded: number | null;
  stopsRemoved: number | null;
  verifiedAt: number;
}

const DB = 'trotro-admin';
const VERIF = 'verifications';
const NEW = 'newStops';
const CHANGES = 'routeChanges';

function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VERIF)) db.createObjectStore(VERIF, { keyPath: 'osmRef' });
      if (!db.objectStoreNames.contains(NEW)) db.createObjectStore(NEW, { keyPath: 'stopId' });
      if (!db.objectStoreNames.contains(CHANGES)) db.createObjectStore(CHANGES, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(store: string, val: unknown): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(val);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function del(store: string, key: string): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function all<T>(store: string): Promise<T[]> {
  const db = await open();
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const r = db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => resolve((r.result as T[]) ?? []);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

// verifications (existing OSM stops)
export const saveVerification = (v: Verification) => put(VERIF, v);
export const deleteVerification = (osmRef: string) => del(VERIF, osmRef);
export const listVerifications = () => all<Verification>(VERIF);
export async function loadVerificationMap(): Promise<Map<string, Verification>> {
  return new Map((await listVerifications()).map((v) => [v.osmRef, v]));
}

// new stops (NOT in OSM)
export const saveNewStop = (s: NewStop) => put(NEW, s);
export const deleteNewStop = (stopId: string) => del(NEW, stopId);
export const listNewStops = () => all<NewStop>(NEW);

// route changes
export const saveRouteChange = (c: RouteChange) => put(CHANGES, c);
export const deleteRouteChange = (id: string) => del(CHANGES, id);
export const listRouteChanges = () => all<RouteChange>(CHANGES);

const iso = (ms: number) => new Date(ms).toISOString();

export interface VerificationExport {
  exported_at: string;
  verifier: string | null;
  source: 'admin-dashboard';
  verified_stops: Array<Record<string, unknown>>;
  new_stops: Array<Record<string, unknown>>;
  route_changes: Array<Record<string, unknown>>;
}

/**
 * Download payload — three arrays (Feature 3). Keys match the documented format the promote script
 * consumes.
 */
export async function buildExport(): Promise<VerificationExport> {
  const [verifs, news, changes] = await Promise.all([listVerifications(), listNewStops(), listRouteChanges()]);
  const verifier = (typeof localStorage !== 'undefined' && localStorage.getItem('tg-admin-verifier')) || null;
  return {
    exported_at: new Date().toISOString(),
    verifier,
    source: 'admin-dashboard',
    verified_stops: verifs.map((v) => ({
      osm_ref: v.osmRef,
      name: v.osmName,
      local_name: v.localName,
      mate_shout: v.mateShout,
      exists: v.exists,
      my_lat: v.myLat,
      my_lng: v.myLng,
      notes: v.notes,
      verified_at: iso(v.verifiedAt),
    })),
    new_stops: news.map((s) => ({
      stop_id: s.stopId,
      name: s.name,
      local_name: s.localName,
      mate_shout: s.mateShout,
      board_alight: s.boardAlight,
      my_lat: s.myLat,
      my_lng: s.myLng,
      route_ref: s.routeRef,
      sequence: s.sequence,
      notes: s.notes,
      is_new_stop: true,
      source: 'fieldwork',
      verified_at: iso(s.verifiedAt),
    })),
    route_changes: changes.map((c) => ({
      route_ref: c.routeRef,
      change_type: c.changeTypes[0] ?? null,
      change_types: c.changeTypes,
      description: c.description,
      new_terminal: c.newTerminal || null,
      old_terminal: c.oldTerminal || null,
      stops_added: c.stopsAdded,
      stops_removed: c.stopsRemoved,
      verified_at: iso(c.verifiedAt),
    })),
  };
}
