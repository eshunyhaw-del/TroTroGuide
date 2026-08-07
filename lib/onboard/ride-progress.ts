// WHERE IS THE RIDER RIGHT NOW, across a whole planned trip?
//
// mapmatch.ts answers this for ONE route. A trip can be several legs (with a
// transfer between them), and the Step 3 ride list renders every leg's stops as
// one continuous timeline — so the "you are here" dot needs a trip-level answer:
// which leg, and which stop row on it.
//
// This module is deliberately pure (no React, no GPS, no clock) so the row-
// picking maths is unit-testable. The stateful parts — accepting/rejecting each
// GPS fix, smoothing jitter — live in useRideProgress.ts.
//
// IMPORTANT — what the geometry actually is. Core Pack polylines carry exactly
// one vertex per stop (verified across all 566 routes), i.e. straight chords
// between consecutive stops rather than real road shape. Two consequences:
//   * `lateralM` is NOT a usable off-route signal. Stops sit a median 303 m
//     apart but 783 segments exceed 1 km, and a rider following a curving road
//     is legitimately far from the straight chord. So we never declare
//     "off route" here (that is what RouteMatcher.guidance()'s OFF_ROUTE_M is
//     for, and it would false-positive on this data); we only use lateralM as a
//     relative score to decide WHICH leg the rider is on.
//   * Distances must be measured in ONE space. See RideStop below: the pack's
//     own `distM` is not that space, so the caller re-projects the stops.

import type { RouteMatcher } from './mapmatch';

/**
 * A stop placed in the SAME along-route space the rider is projected into.
 *
 * `alongM` is deliberately NOT the pack's `route_stops.distM`. That value is
 * pinned to a polyline vertex which, in the beta pack, can sit a long way from
 * the stop it labels — name-folding in the builder (STOP_DEDUP_M = 250) gives a
 * stop one canonical coordinate while its vertex keeps another. Measured across
 * the shipped pack: 21.7% of stops are >25 m from their own vertex, 7.1% are
 * >100 m, worst 470 m. Comparing a projected rider against vertex-derived stop
 * distances therefore lands on the wrong row surprisingly often — standing
 * exactly at a stop named the right stop only 91.5% of the time. Projecting the
 * STOP's own coordinate onto the same polyline instead cancels the error out
 * and lifts that to 98.0%, so the caller passes projected distances in here.
 */
export interface RideStop {
  stopId: string;
  seq: number;
  alongM: number;
}

/** A planned leg, pre-resolved to the geometry the matcher needs. */
export interface LegGeometry {
  routeId: string;
  /** null when the route has no usable polyline (fewer than 2 vertices). */
  matcher: RouteMatcher | null;
  boardSeq: number;
  alightSeq: number;
  /** The FULL route stop list, ascending by seq. */
  stops: RideStop[];
}

export interface LegMatch {
  legIndex: number;
  alongM: number;
  lateralM: number;
}

export type RidePhase =
  | 'approaching' // not yet at the boarding stop
  | 'riding'      // between board and alight
  | 'arrived';    // at/past the final alight stop

export interface RideProgress {
  legIndex: number;
  phase: RidePhase;
  /** seq of the stop the rider has most recently reached. */
  seq: number;
  stopId: string;
  alongM: number;
  lateralM: number;
  nextSeq: number | null;
  nextStopId: string | null;
  metresToNext: number | null;
  /** Stops still ahead on THIS leg, counting the alight stop. */
  stopsRemaining: number;
}

/** A stop counts as reached once the rider is within this much of it. */
export const REACHED_EPS_M = 25;

function stopAtSeq(leg: LegGeometry, seq: number): RideStop | null {
  return leg.stops.find((s) => s.seq === seq) ?? null;
}

function distAtSeq(leg: LegGeometry, seq: number): number {
  return stopAtSeq(leg, seq)?.alongM ?? 0;
}

/** The leg's ridden window, ascending by seq. */
export function riddenStops(leg: LegGeometry): RideStop[] {
  return leg.stops
    .filter((s) => s.seq >= leg.boardSeq && s.seq <= leg.alightSeq)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Which leg is the rider on, and how far along it?
 *
 * Scored by lateral distance from the leg's line PLUS how far outside that
 * leg's ridden window the projection fell. The window penalty is what stops a
 * two-leg trip from claiming the rider is on leg 2 while they are still riding
 * leg 1 down a road the two legs happen to share.
 */
export function matchLegs(
  legs: readonly LegGeometry[],
  lat: number,
  lng: number,
): LegMatch | null {
  let best: LegMatch | null = null;
  let bestScore = Infinity;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (!leg.matcher) continue;

    const m = leg.matcher.match(lat, lng);
    const lo = distAtSeq(leg, leg.boardSeq);
    const hi = distAtSeq(leg, leg.alightSeq);
    const clamped = Math.min(Math.max(m.alongM, lo), hi);
    const outsideWindowM = Math.abs(m.alongM - clamped);

    const score = m.lateralM + outsideWindowM;
    if (score < bestScore) {
      bestScore = score;
      best = { legIndex: i, alongM: m.alongM, lateralM: m.lateralM };
    }
  }

  return best;
}

/**
 * Map an along-route distance onto the stop row the dot should sit on.
 *
 * `alongM` is passed in rather than measured here so the caller can smooth it
 * across fixes (see useRideProgress) without this function needing state.
 */
export function progressFromAlong(
  legs: readonly LegGeometry[],
  legIndex: number,
  alongM: number,
  lateralM: number,
): RideProgress | null {
  const leg = legs[legIndex];
  if (!leg) return null;

  const within = riddenStops(leg);
  if (within.length === 0) return null;

  const boardDist = distAtSeq(leg, leg.boardSeq);
  const alightDist = distAtSeq(leg, leg.alightSeq);

  // Still walking to / waiting at the boarding stop.
  if (alongM < boardDist - REACHED_EPS_M) {
    const first = within[0];
    const second = within[1] ?? null;
    return {
      legIndex,
      phase: 'approaching',
      seq: first.seq,
      stopId: first.stopId,
      alongM,
      lateralM,
      nextSeq: second?.seq ?? null,
      nextStopId: second?.stopId ?? null,
      metresToNext: Math.max(0, Math.round(boardDist - alongM)),
      stopsRemaining: within.length - 1,
    };
  }

  const reached = within.filter((s) => s.alongM <= alongM + REACHED_EPS_M);
  const ahead = within.filter((s) => s.alongM > alongM + REACHED_EPS_M);
  const current = reached.length > 0 ? reached[reached.length - 1] : within[0];
  const next = ahead.length > 0 ? ahead[0] : null;

  const atAlight = alongM >= alightDist - REACHED_EPS_M;

  return {
    legIndex,
    phase: atAlight ? 'arrived' : 'riding',
    seq: current.seq,
    stopId: current.stopId,
    alongM,
    lateralM,
    nextSeq: next?.seq ?? null,
    nextStopId: next?.stopId ?? null,
    metresToNext: next ? Math.max(0, Math.round(next.alongM - alongM)) : null,
    stopsRemaining: ahead.length,
  };
}

/**
 * Normalise a transfer point to a single row.
 *
 * A transfer stop is one physical place that appears on both legs — as leg N's
 * alight and leg N+1's board. The ride list renders it ONCE (it filters leg
 * N+1's board row out), so a progress result landing on leg N+1's board seq
 * would highlight a row that does not exist. Re-attribute it to the row that is
 * actually rendered: the previous leg's alight.
 */
export function normaliseTransfer(
  legs: readonly LegGeometry[],
  p: RideProgress,
): RideProgress {
  if (p.legIndex === 0 || p.seq !== legs[p.legIndex].boardSeq) return p;

  const prevIndex = p.legIndex - 1;
  const prev = legs[prevIndex];
  if (!prev) return p;

  const prevAlight = stopAtSeq(prev, prev.alightSeq);
  if (!prevAlight || prevAlight.stopId !== p.stopId) return p;

  return { ...p, legIndex: prevIndex, seq: prev.alightSeq, stopsRemaining: 0 };
}
