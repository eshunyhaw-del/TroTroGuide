'use client';

// Drives the "you are here" dot on the ride list from the live GPS watch.

import { useEffect, useMemo, useRef, useState } from 'react';
import { getRoute, getStop, type BoardingOption } from '@/lib/corepack/client';
import { decode } from '@/lib/geo/polyline';
import { RouteMatcher } from './mapmatch';
import {
  matchLegs,
  normaliseTransfer,
  progressFromAlong,
  type LegGeometry,
  type RideProgress,
  type RideStop,
} from './ride-progress';

/** Worse than this and the fix says nothing useful about which stop you're at. */
const MAX_ACCURACY_M = 200;
/** Above this the dot still moves, but we tell the rider it's approximate. */
const LOW_CONFIDENCE_M = 75;
/** Backwards movement smaller than this is treated as GPS jitter and ignored. */
const BACKWARD_TOLERANCE_M = 75;
/** No accepted fix in this long and the dot is stale rather than wrong. */
const STALE_AFTER_MS = 90_000;

export interface LiveRide {
  progress: RideProgress;
  confidence: 'high' | 'low';
  /** True when GPS has gone quiet, the dot is a last-known position. */
  stale: boolean;
}

export interface UseRideProgressOptions {
  /** Pass false when there is no real fix (permission denied, no GPS, etc.). */
  enabled: boolean;
  accuracyM: number | null;
}

export function useRideProgress(
  legs: readonly BoardingOption[] | null,
  pos: { lat: number; lng: number },
  { enabled, accuracyM }: UseRideProgressOptions,
): LiveRide | null {
  const [live, setLive] = useState<LiveRide | null>(null);

  // Identity of the planned trip. When this changes the rider picked a different route, so any
  // accumulated progress is meaningless.
  const tripKey = useMemo(
    () => (legs ?? []).map((l) => `${l.route_id}:${l.board_seq}:${l.alight_seq}`).join('>'),
    [legs],
  );

  const geometry = useMemo<LegGeometry[]>(() => {
    if (!legs || legs.length === 0) return [];
    return legs.map((leg) => {
      const route = getRoute(leg.route_id);
      // A polyline needs at least one segment to project onto.
      const usable = !!route && decode(route.polyline, 6).length >= 2;
      const matcher = usable ? new RouteMatcher(route!) : null;

      // Put the stops in the SAME space as the rider by projecting each stop's own coordinate onto
      // the polyline, rather than trusting the pack's vertex-derived distM (see RideStop for the
      // measurements).
      const stops: RideStop[] = route
        ? [...route.stops]
            .sort((a, b) => a.seq - b.seq)
            .map((rs) => {
              const s = matcher ? getStop(rs.stopId) : null;
              return {
                stopId: rs.stopId,
                seq: rs.seq,
                alongM: s ? matcher!.match(s.lat, s.lng).alongM : rs.distM,
              };
            })
        : [];

      return {
        routeId: leg.route_id,
        matcher,
        boardSeq: leg.board_seq,
        alightSeq: leg.alight_seq,
        stops,
      };
    });
  }, [tripKey]);

  /** Last accepted along-distance, per leg index. Survives across fixes. */
  const acceptedRef = useRef<Map<number, number>>(new Map());
  const lastFixAtRef = useRef<number | null>(null);

  // Reset accumulated progress whenever the planned trip changes.
  useEffect(() => {
    acceptedRef.current = new Map();
    lastFixAtRef.current = null;
    setLive(null);
  }, [tripKey]);

  useEffect(() => {
    if (!enabled || geometry.length === 0) {
      setLive(null);
      return;
    }
    if (accuracyM != null && accuracyM > MAX_ACCURACY_M) return; // keep last known

    const m = matchLegs(geometry, pos.lat, pos.lng);
    if (!m) {
      setLive(null);
      return;
    }

    // Forward-biased smoothing.
    const prev = acceptedRef.current.get(m.legIndex);
    let alongM = m.alongM;
    if (prev != null && alongM < prev && prev - alongM < BACKWARD_TOLERANCE_M) {
      alongM = prev;
    }
    acceptedRef.current.set(m.legIndex, alongM);
    lastFixAtRef.current = Date.now();

    const raw = progressFromAlong(geometry, m.legIndex, alongM, m.lateralM);
    if (!raw) {
      setLive(null);
      return;
    }

    setLive({
      progress: normaliseTransfer(geometry, raw),
      confidence: accuracyM != null && accuracyM > LOW_CONFIDENCE_M ? 'low' : 'high',
      stale: false,
    });
  }, [enabled, geometry, pos.lat, pos.lng, accuracyM]);

  // Flip to stale when the watch stops delivering, so the UI can say "last known" instead of
  // silently showing a dot that stopped being true.
  useEffect(() => {
    if (!live || live.stale) return;
    const id = setInterval(() => {
      const at = lastFixAtRef.current;
      if (at != null && Date.now() - at > STALE_AFTER_MS) {
        setLive((cur) => (cur && !cur.stale ? { ...cur, stale: true } : cur));
      }
    }, 15_000);
    return () => clearInterval(id);
  }, [live]);

  return live;
}
