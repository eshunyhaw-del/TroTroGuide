// Image selection scoring — PURE and provider-independent. No network, no React, no
// Mapillary.

import type { ImageCandidate, ImageQuery } from './types';
import { haversineM } from '@/lib/geo/haversine';

/** Weights for the three signals. Tunable; kept summing to 1 for readability. */
export const WEIGHTS = {
  proximity: 0.5, // how close the photo was taken to the landmark
  facing: 0.3, // whether the camera faced the rider's direction of travel
  recency: 0.2, // how fresh the imagery is
} as const;

/** Imagery older than this (years) scores 0 on recency; newer decays linearly. */
export const RECENCY_HORIZON_YEARS = 8;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Smallest circle-difference between two compass bearings, in degrees (0–180). */
export function bearingDiffDeg(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** 1 when the camera faces the travel direction, 0 when it faces backwards. */
function facingScore(candidateBearing: number | null, travelBearing: number | null | undefined): number {
  // Neutral (0.5) when either heading is unknown: we neither reward nor punish a candidate for
  // metadata the provider didn't supply.
  if (candidateBearing == null || travelBearing == null) return 0.5;
  const diff = bearingDiffDeg(candidateBearing, travelBearing);
  return (Math.cos((diff * Math.PI) / 180) + 1) / 2;
}

/** 1 for a photo at the point, decaying to 0 at the search radius. */
function proximityScore(distM: number, radiusM: number): number {
  if (radiusM <= 0) return distM <= 0 ? 1 : 0;
  return Math.max(0, 1 - distM / radiusM);
}

/** 1 for imagery captured now, decaying linearly to 0 at RECENCY_HORIZON_YEARS. */
function recencyScore(capturedAt: number | null, now: number): number {
  if (capturedAt == null) return 0.4; // unknown age: mildly penalised, not excluded
  const ageYears = Math.max(0, now - capturedAt) / MS_PER_YEAR;
  return Math.max(0, 1 - ageYears / RECENCY_HORIZON_YEARS);
}

export interface ScoredCandidate {
  candidate: ImageCandidate;
  score: number;
  /** Component breakdown, exposed for tests, tuning, and debugging. */
  parts: { proximity: number; facing: number; recency: number; distM: number };
}

/** Score every candidate against the query. */
export function rankCandidates(
  candidates: readonly ImageCandidate[],
  query: ImageQuery,
  now: number,
): ScoredCandidate[] {
  const scored = candidates.map((candidate) => {
    const distM = haversineM(query.lat, query.lng, candidate.lat, candidate.lng);
    const proximity = proximityScore(distM, query.radiusM);
    const facing = facingScore(candidate.bearing, query.bearing);
    const recency = recencyScore(candidate.capturedAt, now);
    const score =
      WEIGHTS.proximity * proximity + WEIGHTS.facing * facing + WEIGHTS.recency * recency;
    return { candidate, score, parts: { proximity, facing, recency, distM } };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.parts.distM - b.parts.distM ||
      (b.candidate.capturedAt ?? 0) - (a.candidate.capturedAt ?? 0),
  );
  return scored;
}

/** Convenience: the single best candidate, or null when there are none. */
export function bestCandidate(
  candidates: readonly ImageCandidate[],
  query: ImageQuery,
  now: number,
): ImageCandidate | null {
  return rankCandidates(candidates, query, now)[0]?.candidate ?? null;
}
