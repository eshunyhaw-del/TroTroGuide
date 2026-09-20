import { describe, it, expect } from 'vitest';
import { encode } from '@/lib/geo/polyline';
import type { PackRoute, PackRouteStop } from '@/lib/corepack/types';
import { RouteMatcher } from './mapmatch';
import {
  matchLegs,
  normaliseTransfer,
  progressFromAlong,
  riddenStops,
  type LegGeometry,
  type RideStop,
} from './ride-progress';

// Same straight WEST→EAST device as mapmatch.test.ts: at a constant latitude, distance along the
// route is exactly (lng - 0) * metresPerDegreeLng, so every expectation below is exact rather than
// approximate.
const LAT = 5.6;
const M_PER_LNG = 111_320 * Math.cos((LAT * Math.PI) / 180);
const lngAt = (metres: number): number => metres / M_PER_LNG;

// 11 stops, one per kilometre, on a 10 km line.
const STOPS: PackRouteStop[] = Array.from({ length: 11 }, (_, i) => ({
  stopId: `stop_${i + 1}`,
  seq: i + 1,
  distM: i * 1000,
}));

const route: PackRoute = {
  id: 'r1',
  name: 'Straight Test Line',
  mateShout: 'test',
  polyline: encode(
    [
      [LAT, 0],
      [LAT, lngAt(10_000)],
    ],
    6,
  ),
  stops: STOPS,
};

// The rider and the stops must live in one along-route space.
const RIDE_STOPS: RideStop[] = STOPS.map((s) => ({
  stopId: s.stopId,
  seq: s.seq,
  alongM: s.distM,
}));

const leg = (boardSeq: number, alightSeq: number, matcher = true): LegGeometry => ({
  routeId: 'r1',
  matcher: matcher ? new RouteMatcher(route) : null,
  boardSeq,
  alightSeq,
  stops: RIDE_STOPS,
});

describe('riddenStops', () => {
  it('returns only the board..alight window, ascending', () => {
    const w = riddenStops(leg(3, 6));
    expect(w.map((s) => s.seq)).toEqual([3, 4, 5, 6]);
  });
});

describe('progressFromAlong — the dot must MOVE', () => {
  const legs = [leg(2, 8)]; // board at 1000 m, alight at 7000 m

  it('advances the highlighted stop as the rider travels (the reported bug)', () => {
    const seqAt = (m: number) => progressFromAlong(legs, 0, m, 0)!.seq;
    // Boarding stop, then each kilometre onward: the row must not stay pinned.
    expect(seqAt(1000)).toBe(2);
    expect(seqAt(2000)).toBe(3);
    expect(seqAt(3500)).toBe(4);
    expect(seqAt(4000)).toBe(5);
    expect(seqAt(6100)).toBe(7);
  });

  it('counts down the stops remaining on the leg', () => {
    expect(progressFromAlong(legs, 0, 1000, 0)!.stopsRemaining).toBe(6);
    expect(progressFromAlong(legs, 0, 6000, 0)!.stopsRemaining).toBe(1);
  });

  it('reports the metres to the next stop', () => {
    const p = progressFromAlong(legs, 0, 2400, 0)!;
    expect(p.nextStopId).toBe('stop_4');
    expect(p.metresToNext).toBe(600);
  });

  it('treats a stop as reached slightly before it (within the eps)', () => {
    expect(progressFromAlong(legs, 0, 2990, 0)!.seq).toBe(4); // 3000 m stop
  });

  it('is "approaching" while the rider is still short of the boarding stop', () => {
    const p = progressFromAlong(legs, 0, 200, 0)!;
    expect(p.phase).toBe('approaching');
    expect(p.seq).toBe(2); // dot waits at the board stop
    expect(p.metresToNext).toBe(800);
  });

  it('is "arrived" at the alight stop', () => {
    const p = progressFromAlong(legs, 0, 7000, 0)!;
    expect(p.phase).toBe('arrived');
    expect(p.seq).toBe(8);
    expect(p.stopsRemaining).toBe(0);
  });

  it('never walks past the leg window, even if the fix projects beyond it', () => {
    const p = progressFromAlong(legs, 0, 9500, 0)!;
    expect(p.seq).toBe(8); // clamped to the alight stop, not stop_10
    expect(p.phase).toBe('arrived');
  });
});

describe('stops that are out of order on the ground', () => {
  // Real pack case: on "Trotro 275 : Madina-Adenta → Kaneshie", the stop "Atomic First" (seq 11) sits
  // further along the road than "Atomic Second" (seq 12), so projected distances are not monotonic in
  // seq. The dot must still resolve to a real row inside the ridden window.
  const jumbled: LegGeometry = {
    routeId: 'r-jumbled',
    matcher: new RouteMatcher(route),
    boardSeq: 1,
    alightSeq: 5,
    stops: [
      { stopId: 'a', seq: 1, alongM: 0 },
      { stopId: 'b', seq: 2, alongM: 1000 },
      { stopId: 'atomic_first', seq: 3, alongM: 3200 }, // further along…
      { stopId: 'atomic_second', seq: 4, alongM: 2900 }, // …than its successor
      { stopId: 'e', seq: 5, alongM: 5000 },
    ],
  };

  it('still resolves to a row inside the ridden window', () => {
    for (const m of [0, 500, 2950, 3100, 3300, 4800, 5200]) {
      const p = progressFromAlong([jumbled], 0, m, 0);
      expect(p).not.toBeNull();
      expect(p!.seq).toBeGreaterThanOrEqual(1);
      expect(p!.seq).toBeLessThanOrEqual(5);
    }
  });

  it('prefers the later ROW when two stops are both behind the rider', () => {
    // At 3300 m both jumbled stops are behind; the row that wins is the one further down the
    // rendered list, so the dot keeps moving downward.
    expect(progressFromAlong([jumbled], 0, 3300, 0)!.seq).toBe(4);
  });

  it('never reports negative metres to the next stop', () => {
    for (const m of [0, 1500, 2950, 3100, 4000]) {
      const p = progressFromAlong([jumbled], 0, m, 0)!;
      if (p.metresToNext != null) expect(p.metresToNext).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('matchLegs — which leg is the rider on', () => {
  const legs = [leg(2, 5), leg(5, 9)]; // 1000–4000 m, then 4000–8000 m

  it('picks the leg whose ridden window contains the rider', () => {
    expect(matchLegs(legs, LAT, lngAt(2000))!.legIndex).toBe(0);
    expect(matchLegs(legs, LAT, lngAt(6000))!.legIndex).toBe(1);
  });

  it('reports the projected distance along the route', () => {
    const m = matchLegs(legs, LAT, lngAt(2000))!;
    expect(m.alongM).toBeGreaterThan(1990);
    expect(m.alongM).toBeLessThan(2010);
  });

  it('skips legs with no usable polyline', () => {
    const m = matchLegs([leg(2, 5, false), leg(5, 9)], LAT, lngAt(2000));
    expect(m!.legIndex).toBe(1); // leg 0 unusable, so leg 1 wins despite the penalty
  });

  it('returns null when no leg has geometry', () => {
    expect(matchLegs([leg(2, 5, false)], LAT, lngAt(2000))).toBeNull();
  });
});

describe('normaliseTransfer', () => {
  const legs = [leg(2, 5), leg(5, 9)];

  it('re-attributes leg 2’s board row to leg 1’s alight row', () => {
    // The transfer stop is rendered ONCE (as leg 1's alight); highlighting leg 2's board seq would
    // target a row the list never renders.
    const raw = progressFromAlong(legs, 1, 4000, 0)!;
    expect(raw.seq).toBe(5);
    const fixed = normaliseTransfer(legs, raw);
    expect(fixed.legIndex).toBe(0);
    expect(fixed.seq).toBe(5);
  });

  it('leaves a mid-leg position untouched', () => {
    const raw = progressFromAlong(legs, 1, 6000, 0)!;
    const fixed = normaliseTransfer(legs, raw);
    expect(fixed.legIndex).toBe(1);
    expect(fixed.seq).toBe(raw.seq);
  });

  it('leaves the first leg untouched', () => {
    const raw = progressFromAlong(legs, 0, 1000, 0)!;
    expect(normaliseTransfer(legs, raw).legIndex).toBe(0);
  });
});
