// Provider registry, the single seam where the app picks WHICH image provider is active.

import type { ImageProvider } from './types';
import { MapillaryProvider } from './mapillary';

// Ordered by preference. The first configured provider wins.
const REGISTRY: ImageProvider[] = [new MapillaryProvider()];

/** The active provider (first one that has its config), or null if none do. */
export function activeProvider(): ImageProvider | null {
  return REGISTRY.find((p) => p.isConfigured()) ?? null;
}
