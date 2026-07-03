// On-board guidance, computed 100% CLIENT-SIDE against the cached route polyline.
// This is the headline "works offline" feature (CORRECTION #2). No network, no
// server round-trip, no raw GPS leaves the device.
//
// Algorithm per GPS fix:
//   1. Project the GPS point onto the route polyline (point-to-segment, in a
//      local metres frame) -> distance ALONG the route + lateral (off-route) gap.
//   2. Compare "along" distance to each stop's precomputed cumulative distance
//      (route_stops.dist_m, shipped in the Core Pack) to find passed/next stop.
//   3. Emit a landmark cue ("you'll pass X, your stop is N more after that") and
//      an alight prompt when the destination is next/reached.
//   4. Off-route detection: lateral gap > 150 m for 3 consecutive fixes.

import { decode } from '@/lib/geo/polyline';
import { haversineM } from '@/lib/geo/haversine';
import type { PackRoute } from '@/lib/corepack/types';

export interface MatchResult {
  alongM: number;            // metres travelled along the route at the snapped point
  lateralM: number;          // perpendicular distance from the route (off-route signal)
  segIndex: number;
  snapped: [number, number]; // [lat, lng] of the snapped point
}

export interface Guidance {
  alongM: number;
  offRoute: boolean;
  confidence: 'high' | 'low';
  stopsPassed: number;
  stopsRemaining: number;
  passedStopId: string | null;
  nextStopId: string | null;
  nextStopName: string | null;
  metresToNext: number | null;
  stopsToDestination: number | null;
  alightSoon: boolean;
  arrived: boolean;
  cue: string | null;
}

const OFF_ROUTE_M = 150;
const OFF_ROUTE_TICKS = 3; // consecutive off-route fixes before we declare off-route
const PASSED_EPS_M = 10;    // treat a stop within 10 m behind as "passed"
const ARRIVE_EPS_M = 40;

export class RouteMatcher {
  private pts: [number, number][]; // [lat, lng] polyline vertices
  private cum: number[];           // cumulative metres at each vertex
  private readonly mPerLat = 111_320;
  private readonly mPerLng: number;
  private readonly origin: [number, number];
  private offRouteTicks = 0;

  constructor(
    private route: PackRoute,
    private stopName: (id: string) => string = (id) => id,
  ) {
    this.pts = decode(route.polyline, 6); // polyline6 -> [lat,lng][]
    this.origin = this.pts[0] ?? [5.6, -0.2];
    this.mPerLng = 111_320 * Math.cos((this.origin[0] * Math.PI) / 180);
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) {
      this.cum[i] =
        this.cum[i - 1] +
        haversineM(this.pts[i - 1][0], this.pts[i - 1][1], this.pts[i][0], this.pts[i][1]);
    }
  }

  /** Local equirectangular metres frame (good enough over an Accra-sized route). */
  private xy(lat: number, lng: number): [number, number] {
    return [(lng - this.origin[1]) * this.mPerLng, (lat - this.origin[0]) * this.mPerLat];
  }

  /** Project a GPS fix onto the polyline. */
  match(lat: number, lng: number): MatchResult {
    const [px, py] = this.xy(lat, lng);
    let best = { d2: Infinity, along: 0, seg: 0, sx: px, sy: py };

    for (let i = 0; i < this.pts.length - 1; i++) {
      const [ax, ay] = this.xy(this.pts[i][0], this.pts[i][1]);
      const [bx, by] = this.xy(this.pts[i + 1][0], this.pts[i + 1][1]);
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1e-9;
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t)); // clamp to the segment
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      const d2 = (px - cx) ** 2 + (py - cy) ** 2;
      if (d2 < best.d2) {
        best = { d2, along: this.cum[i] + t * Math.sqrt(len2), seg: i, sx: cx, sy: cy };
      }
    }

    return {
      alongM: best.along,
      lateralM: Math.sqrt(best.d2),
      segIndex: best.seg,
      snapped: [this.origin[0] + best.sy / this.mPerLat, this.origin[1] + best.sx / this.mPerLng],
    };
  }

  /** Turn a GPS fix into a human cue for a given destination stop. */
  guidance(lat: number, lng: number, destStopId: string): Guidance {
    const m = this.match(lat, lng);

    this.offRouteTicks = m.lateralM > OFF_ROUTE_M ? this.offRouteTicks + 1 : 0;
    const offRoute = this.offRouteTicks >= OFF_ROUTE_TICKS;

    const stops = [...this.route.stops].sort((a, b) => a.seq - b.seq);
    const passedStops = stops.filter((s) => s.distM <= m.alongM + PASSED_EPS_M);
    const remainingStops = stops.filter((s) => s.distM > m.alongM + PASSED_EPS_M);
    const passed = passedStops.length ? passedStops[passedStops.length - 1] : null;
    const next = remainingStops.length ? remainingStops[0] : null;

    const dest = stops.find((s) => s.stopId === destStopId) ?? null;
    const arrived = !!dest && m.alongM >= dest.distM - ARRIVE_EPS_M;
    const metresToNext = next ? Math.max(0, Math.round(next.distM - m.alongM)) : null;
    const stopsToDestination = dest ? Math.max(0, dest.seq - (passed?.seq ?? 0)) : null;
    const alightSoon = !!dest && (arrived || (!!next && next.stopId === dest.stopId));

    let cue: string | null = null;
    if (offRoute) {
      cue = 'You may be off this route — check that you boarded the right trotro.';
    } else if (arrived) {
      cue = `This is your stop — get down at ${this.stopName(dest!.stopId)}.`;
    } else if (dest && passed) {
      const remaining = dest.seq - passed.seq;
      cue =
        remaining <= 1
          ? `Next stop is yours: ${this.stopName(dest.stopId)}. Tell the mate now.`
          : `You'll pass ${this.stopName(passed.stopId)} — your stop is ${remaining - 1} more after that.`;
    } else if (next) {
      cue = `Heading toward ${this.stopName(next.stopId)} (${metresToNext} m).`;
    }

    return {
      alongM: Math.round(m.alongM),
      offRoute,
      confidence: offRoute ? 'low' : 'high',
      stopsPassed: passedStops.length,
      stopsRemaining: remainingStops.length,
      passedStopId: passed?.stopId ?? null,
      nextStopId: next?.stopId ?? null,
      nextStopName: next ? this.stopName(next.stopId) : null,
      metresToNext,
      stopsToDestination,
      alightSoon,
      arrived,
      cue,
    };
  }
}
