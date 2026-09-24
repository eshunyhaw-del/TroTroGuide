// Find the nearest stop to a user and estimate walking time. Pure geometry, no network, no GPS
// leaves the device.

import { haversineM } from './haversine';

const WALK_M_PER_MIN = 80; // ~4.8 km/h, a realistic Accra pavement pace.

/** Minutes to walk `metres` at a steady pace; never rounds below 1. */
export function walkingMinutes(metres: number, paceMetresPerMin = WALK_M_PER_MIN): number {
  return Math.max(1, Math.round(metres / paceMetresPerMin));
}

export interface NearestStop<T> {
  stop: T;
  distanceMeters: number;
  walkingTimeMinutes: number;
}

/**
 * Nearest stop to (userLat,userLng) among `stops`. Pass `canBoard` to consider only
 * boarding-enabled stops (the rest are alight-only).
 */
export function findNearestStop<T extends { lat: number; lng: number }>(
  userLat: number,
  userLng: number,
  stops: readonly T[],
  canBoard: (stop: T) => boolean = () => true,
): NearestStop<T> | null {
  let best: NearestStop<T> | null = null;
  for (const stop of stops) {
    if (!canBoard(stop)) continue;
    const distanceMeters = haversineM(userLat, userLng, stop.lat, stop.lng);
    if (!best || distanceMeters < best.distanceMeters) {
      best = { stop, distanceMeters, walkingTimeMinutes: walkingMinutes(distanceMeters) };
    }
  }
  return best;
}
