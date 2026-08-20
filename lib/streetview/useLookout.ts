'use client';

// Drives the "Look out for" card: turns the live ride position into a single
// upcoming landmark + its best street image, updating automatically as the
// trotro moves — and doing so WITHOUT hammering the provider (#7).
//
// How it stays cheap:
//   * The surfaced target only changes when the rider crosses a landmark, so the
//     image fetch is keyed on the landmark id — GPS ticks that don't change the
//     target trigger no network at all (the movement gate).
//   * The NEXT landmark is prefetched, so it's already cached when the rider
//     reaches it (route-based prefetching).
//   * client.ts adds a coarse-grid cache + in-flight de-dupe on top.
//
// Privacy: we pass the LANDMARK's public coordinates to the fetch, never the
// rider's GPS (see the API route). The rider's position is used only on-device,
// to choose which landmark is next.

import { useEffect, useMemo, useState } from 'react';
import { getRoute, getLandmarksNearRoute, type BoardingOption } from '@/lib/corepack/client';
import { decode } from '@/lib/geo/polyline';
import { haversineM } from '@/lib/geo/haversine';
import type { LiveRide } from '@/lib/onboard/useRideProgress';
import { fetchStreetImage, prefetchStreetImage } from './client';
import { bearingAtAlong, pickNextTarget, type LookoutTarget } from './lookout';
import type { ImageResult } from './types';

export interface Lookout {
  target: LookoutTarget;
  /** Metres ahead on the current leg, or null when the target is beyond a transfer. */
  distanceAheadM: number | null;
  /** Image state for the target: 'loading' until the first result lands. */
  image: ImageResult | 'loading';
}

/** Build the ordered landmark targets for a whole trip. Memo-heavy work, done
 *  once per trip (keyed by tripKey), not per GPS tick. */
function buildTargets(legs: readonly BoardingOption[]): LookoutTarget[] {
  const targets: LookoutTarget[] = [];
  legs.forEach((leg, legIndex) => {
    const route = getRoute(leg.route_id);
    if (!route) return;
    const line = decode(route.polyline, 6);
    if (line.length < 2) return;
    const cum: number[] = [0];
    for (let i = 1; i < line.length; i++) {
      cum[i] = cum[i - 1] + haversineM(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
    }
    for (const rl of getLandmarksNearRoute(leg.route_id, {
      boardStopId: leg.board_stop_id,
      alightStopId: leg.alight_stop_id,
    })) {
      targets.push({
        landmark: rl.landmark,
        legIndex,
        alongM: rl.alongM,
        bearing: bearingAtAlong(line, cum, rl.alongM),
      });
    }
  });
  // Sorted by (legIndex, alongM) — the order pickNextTarget expects.
  targets.sort((a, b) => a.legIndex - b.legIndex || a.alongM - b.alongM);
  return targets;
}

export function useLookout(
  legs: readonly BoardingOption[] | null,
  live: LiveRide | null,
  enabled: boolean,
): Lookout | null {
  const tripKey = useMemo(
    () => (legs ?? []).map((l) => `${l.route_id}:${l.board_seq}:${l.alight_seq}`).join('>'),
    [legs],
  );

  const targets = useMemo(() => (legs && legs.length ? buildTargets(legs) : []), [tripKey]);

  // Rider position → next target. Before a live fix exists, preview from the
  // start of the first leg so the card still shows the first landmark ahead.
  const legIndex = live?.progress.legIndex ?? 0;
  const alongM = live?.progress.alongM ?? 0;
  const next = useMemo(
    () => (targets.length ? pickNextTarget(targets, legIndex, alongM) : null),
    [targets, legIndex, alongM],
  );

  const target = next?.target ?? null;
  const distanceAheadM =
    next && next.sameLeg ? Math.max(0, Math.round(next.target.alongM - alongM)) : null;

  const [image, setImage] = useState<ImageResult | 'loading'>('loading');

  // Fetch is keyed on the LANDMARK id (+bearing bucket): the effect re-runs only
  // when the surfaced landmark actually changes, not on every GPS tick.
  const landmarkId = target?.landmark.id ?? null;
  useEffect(() => {
    if (!enabled || !target) {
      setImage('loading');
      return;
    }
    const ac = new AbortController();
    setImage('loading');
    fetchStreetImage({
      lat: target.landmark.lat,
      lng: target.landmark.lng,
      bearing: target.bearing,
      signal: ac.signal,
    }).then((res) => {
      if (!ac.signal.aborted) setImage(res);
    });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, landmarkId, target?.bearing]);

  // Prefetch the landmark AFTER the current one, so it's warm on arrival.
  useEffect(() => {
    if (!enabled || !target) return;
    const idx = targets.indexOf(target);
    const upcoming = idx >= 0 ? targets[idx + 1] : undefined;
    if (upcoming) {
      prefetchStreetImage({
        lat: upcoming.landmark.lat,
        lng: upcoming.landmark.lng,
        bearing: upcoming.bearing,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, landmarkId]);

  // "Look out for" is a live-journey feature: only surface it once there's a
  // real GPS fix driving position. Before that, showing it would mean a
  // permanent skeleton (fetching is gated on `enabled`) or a speculative
  // landmark — neither is honest, so the card stays hidden.
  if (!enabled || !target) return null;
  return { target, distanceAheadM, image };
}
