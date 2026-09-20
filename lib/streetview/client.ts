'use client';

// Client-side access to /api/streetview, with the caching and de-duplication that keep us far under
// any provider rate limit.

import type { ImageResult } from './types';

const GRID = 0.0001; // ~11 m — coords rounded to this share a cache entry
const BEARING_BUCKET = 45; // degrees
const MAX_ENTRIES = 200;
// The server already bounds its own call to Mapillary at 8s (mapillary.ts), but that does nothing
// for a request that never reaches the server — a weak trotro-window connection that hangs rather
// than fails outright.
const FETCH_TIMEOUT_MS = 6_000;

function keyFor(lat: number, lng: number, bearing: number | null): string {
  const rl = Math.round(lat / GRID) * GRID;
  const rg = Math.round(lng / GRID) * GRID;
  const rb = bearing == null ? 'x' : Math.round(bearing / BEARING_BUCKET) * BEARING_BUCKET % 360;
  return `${rl.toFixed(4)},${rg.toFixed(4)},${rb}`;
}

const cache = new Map<string, ImageResult>();
const inFlight = new Map<string, Promise<ImageResult>>();

function remember(key: string, result: ImageResult): void {
  // Don't cache transient failures — a later attempt may succeed. 'not_configured' is stable for
  // the session, so caching it avoids pointless repeat calls.
  if (result.status === 'error') return;
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, result);
}

export interface FetchImageArgs {
  lat: number;
  lng: number;
  bearing: number | null;
  radiusM?: number;
  signal?: AbortSignal;
}

/**
 * Fetch the best street image for a landmark point. Returns a normalised ImageResult and NEVER
 * throws — an abort or network failure resolves to { status:
 */
export async function fetchStreetImage({
  lat,
  lng,
  bearing,
  radiusM = 120,
  signal,
}: FetchImageArgs): Promise<ImageResult> {
  const key = keyFor(lat, lng, bearing);

  const cached = cache.get(key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const params = new URLSearchParams({
    lat: lat.toFixed(6),
    lng: lng.toFixed(6),
    radius: String(radiusM),
  });
  if (bearing != null) params.set('bearing', bearing.toFixed(1));

  const p = (async (): Promise<ImageResult> => {
    const ownController = new AbortController();
    const timer = setTimeout(() => ownController.abort(), FETCH_TIMEOUT_MS);
    // Abort our own controller if the caller's signal fires first (target landmark changed,
    // component unmounted) — either way the fetch stops.
    const onCallerAbort = () => ownController.abort();
    signal?.addEventListener('abort', onCallerAbort);

    try {
      const res = await fetch(`/api/streetview?${params.toString()}`, {
        signal: ownController.signal,
      });
      const json = (await res.json()) as ImageResult;
      remember(key, json);
      return json;
    } catch {
      // Includes both a hung connection hitting our timeout and a genuine AbortError — either way,
      // a soft no-image; don't cache a transient miss.
      return { status: 'error' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return p;
}

/** Fire-and-forget prefetch: warms the cache for an upcoming landmark. */
export function prefetchStreetImage(args: Omit<FetchImageArgs, 'signal'>): void {
  const key = keyFor(args.lat, args.lng, args.bearing);
  if (cache.has(key) || inFlight.has(key)) return;
  void fetchStreetImage(args);
}
