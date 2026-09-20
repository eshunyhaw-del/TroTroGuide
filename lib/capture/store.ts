'use client';
// Field-capture store: route contributions and ride records.

import { isConnectionMetered } from '@/lib/corepack/client';

export interface TracePoint {
  t: number; // epoch ms
  lat: number;
  lng: number;
  speed: number | null; // m/s if the device reports it
}

export interface RideIssue {
  t: number;
  guidance: string; // what the app was telling the user at the moment
  stopsRemaining: number | null;
  description: string; // what the user says was wrong
}

export interface RouteContribution {
  id: string;
  kind: 'route-contrib';
  startedAt: number;
  endedAt: number | null;
  trace: TracePoint[];
  mateShout: string;
  boardStop: string;
  alightStop: string;
  synced: boolean;
}

export interface RideRecord {
  id: string;
  kind: 'ride';
  startedAt: number;
  endedAt: number | null;
  routeId: string;
  routeName: string;
  trace: TracePoint[];
  issues: RideIssue[];
  synced: boolean;
}

// Lightweight demand signal: a rider searched for somewhere we don't cover yet and asked us to map
// it.
export interface MapRequest {
  id: string;
  kind: 'map-request';
  createdAt: number;
  destination: string; // where they tried to go
  detail: string; // what happened (free text)
  synced: boolean;
}

// Post-ride feedback. Rates ROUTE ACCURACY (not a driver), flags
// issues, and opportunistically crowdsources the fare.
export interface RouteRating {
  id: string;
  kind: 'route-rating';
  createdAt: number;
  routeId: string;
  routeName: string;
  stars: number; // 1–5 (accuracy)
  issues: string[]; // e.g. ['stop_missing','wrong_mate_shout','route_changed','wrong_fare']
  landmark: string; // free-text landmark / note
  fare: number | null; // GHS the rider paid, if shared
  synced: boolean;
}

export type Capture = RouteContribution | RideRecord | MapRequest | RouteRating;

const DB = 'trotro-captures';
const STORE = 'captures';

function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCapture(c: Capture): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(c);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function listCaptures(): Promise<Capture[]> {
  const db = await open();
  try {
    return await new Promise<Capture[]>((resolve, reject) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      r.onsuccess = () => resolve((r.result as Capture[]) ?? []);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

export async function countUnsynced(): Promise<number> {
  return (await listCaptures()).filter((c) => !c.synced).length;
}

/** Opportunistic sync. Only runs when online AND un-metered (Wi-Fi). */
export async function syncCaptures(): Promise<{ synced: number; remaining: number }> {
  if (typeof navigator === 'undefined' || !navigator.onLine) {
    return { synced: 0, remaining: await countUnsynced() };
  }
  const metered = isConnectionMetered();
  let synced = 0;
  for (const c of await listCaptures()) {
    if (c.synced) continue;
    // On mobile data send only the tiny text captures; hold GPS traces (large) for Wi-Fi.
    if (metered && (c.kind === 'ride' || c.kind === 'route-contrib')) continue;
    try {
      const res = await fetch('/api/contribute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(c),
      });
      if (res.ok) {
        await saveCapture({ ...c, synced: true });
        synced++;
      }
    } catch {
      // offline / origin down -> leave queued
    }
  }
  return { synced, remaining: await countUnsynced() };
}

/** Unique-enough id for a capture (browser-only; epoch ms + perf counter). */
export function newId(kind: Capture['kind']): string {
  return `${kind}-${Date.now()}-${Math.floor(performance.now())}`;
}
