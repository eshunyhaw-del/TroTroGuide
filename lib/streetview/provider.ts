// Provider registry — the single seam where the app picks WHICH image provider
// is active. Adding a WikimediaProvider / LocalLandmarkProvider later means
// registering it here; no caller changes. SERVER ONLY (providers hold secrets).

import type { ImageProvider } from './types';
import { MapillaryProvider } from './mapillary';

// Ordered by preference. The first configured provider wins. Today that's just
// Mapillary; the array is the extension point for fallbacks (e.g. try Mapillary,
// then a local landmark-photo provider that's always configured).
const REGISTRY: ImageProvider[] = [new MapillaryProvider()];

/** The active provider (first one that has its config), or null if none do. */
export function activeProvider(): ImageProvider | null {
  return REGISTRY.find((p) => p.isConfigured()) ?? null;
}
