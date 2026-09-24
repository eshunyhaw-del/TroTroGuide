// "Look out for" target selection, PURE (no React, no network).

import type { PackLandmark } from '@/lib/corepack/types';
import { bearingDeg } from '@/lib/geo/bearing';

export interface LookoutTarget {
  landmark: PackLandmark;
  /** Which trip leg this landmark sits on. */
  legIndex: number;
  /**
   * Distance along that leg's route to the landmark (same space as the rider's projected alongM,
   * see ride-progress.ts).
   */
  alongM: number;
  /** Direction of travel at the landmark, degrees from north, or null. */
  bearing: number | null;
}

export interface NextTarget {
  target: LookoutTarget;
  /** True when the target is on the leg the rider is currently on. */
  sameLeg: boolean;
}

/**
 * A landmark counts as "ahead" only once the rider is at least this far before it, so the card
 * doesn't cling to a landmark the trotro is already passing, and flips to the next one a touch
 * early (matching the "Passed → next" feel).
 */
export const AHEAD_EPS_M = 30;

/**
 * Pick the next landmark to look out for. `targets` must be sorted by (legIndex, alongM) ascending.
 */
export function pickNextTarget(
  targets: readonly LookoutTarget[],
  legIndex: number,
  alongM: number,
): NextTarget | null {
  // Ahead on the CURRENT leg: nearest landmark still in front of the rider.
  let bestSame: LookoutTarget | null = null;
  for (const t of targets) {
    if (t.legIndex !== legIndex) continue;
    if (t.alongM > alongM + AHEAD_EPS_M && (!bestSame || t.alongM < bestSame.alongM)) {
      bestSame = t;
    }
  }
  if (bestSame) return { target: bestSame, sameLeg: true };

  // Otherwise the first landmark on the earliest UPCOMING leg (after a transfer).
  let bestNext: LookoutTarget | null = null;
  for (const t of targets) {
    if (t.legIndex <= legIndex) continue;
    if (
      !bestNext ||
      t.legIndex < bestNext.legIndex ||
      (t.legIndex === bestNext.legIndex && t.alongM < bestNext.alongM)
    ) {
      bestNext = t;
    }
  }
  return bestNext ? { target: bestNext, sameLeg: false } : null;
}

/** Travel bearing at a given along-route distance, from the polyline geometry. */
export function bearingAtAlong(
  line: readonly [number, number][],
  cum: readonly number[],
  alongM: number,
): number | null {
  if (line.length < 2) return null;
  const clamped = Math.min(Math.max(alongM, 0), cum[cum.length - 1]);
  for (let i = 0; i < line.length - 1; i++) {
    if (clamped <= cum[i + 1] || i === line.length - 2) {
      return bearingDeg(line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]);
    }
  }
  return null;
}
