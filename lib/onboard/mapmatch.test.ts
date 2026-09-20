import { describe, it, expect } from 'vitest';
import { encode } from '@/lib/geo/polyline';
import type { PackRoute } from '@/lib/corepack/types';
import { RouteMatcher } from './mapmatch';

// A straight WEST→EAST polyline at a constant latitude, so "distance along the route" is simply
// (lng - lng0) * metresPerDegreeLng.
const LAT = 5.6;
const M_PER_LNG = 111_320 * Math.cos((LAT * Math.PI) / 180);
const lngAt = (metres: number): number => metres / M_PER_LNG;

// Route is ~7 km long so all 5 stops fit on the single segment.
const route: PackRoute = {
  id: 'r1',
  name: 'Straight Test Line',
  mateShout: 'test',
  polyline: encode([
    [LAT, 0],
    [LAT, lngAt(7000)],
  ], 6),
  stops: [
    { stopId: 'stop_1', seq: 1, distM: 0 },
    { stopId: 'stop_2', seq: 2, distM: 1200 },
    { stopId: 'stop_3', seq: 3, distM: 2800 },
    { stopId: 'stop_4', seq: 4, distM: 4500 },
    { stopId: 'stop_5', seq: 5, distM: 6200 },
  ],
};

const matcher = () => new RouteMatcher(route); // identity stopName -> name === id

describe('on-board map-matching (straight-line)', () => {
  it('projects a GPS fix to the correct distance along the route', () => {
    const g = matcher().guidance(LAT, lngAt(3100), 'stop_5');
    expect(g.alongM).toBeGreaterThan(3090);
    expect(g.alongM).toBeLessThan(3110);
  });

  it('GPS at 3100 m: passed=3, next=stop_4, remaining=2 (correct math)', () => {
    // 3100 m is past the 2800 m stop; passed=2 / next=stop_3 is the state at ~2100 m (below).
    const g = matcher().guidance(LAT, lngAt(3100), 'stop_5');
    expect(g.stopsPassed).toBe(3);
    expect(g.stopsRemaining).toBe(2);
    expect(g.nextStopId).toBe('stop_4');
    expect(g.nextStopName).toBe('stop_4');
    expect(g.offRoute).toBe(false);
    expect(g.confidence).toBe('high');
  });

  it("reports passed=2, next=stop_3 at ~2100 m", () => {
    const g = matcher().guidance(LAT, lngAt(2100), 'stop_5');
    expect(g.stopsPassed).toBe(2); // stop_1 (0 m) + stop_2 (1200 m)
    expect(g.nextStopId).toBe('stop_3'); // the 2800 m stop is still ahead
  });

  it('GPS at 4700 m (past stop_4, before stop_5): remaining=1, alight_soon=true', () => {
    const g = matcher().guidance(LAT, lngAt(4700), 'stop_5');
    expect(g.stopsRemaining).toBe(1);
    expect(g.nextStopId).toBe('stop_5');
    expect(g.alightSoon).toBe(true);
    expect(g.cue).toContain('Tell the mate');
  });

  it('declares off_route + confidence=low after 4 consecutive fixes ~200 m off the line', () => {
    const m = matcher();
    const offLat = LAT + 200 / 111_320; // ~200 m north of the line
    const offLng = lngAt(3000);

    // Sanity: the lateral distance really is ~200 m.
    expect(m.match(offLat, offLng).lateralM).toBeGreaterThan(180);
    expect(m.match(offLat, offLng).lateralM).toBeLessThan(220);

    // Needs 3 consecutive off fixes before declaring off-route (debounce).
    expect(m.guidance(offLat, offLng, 'stop_5').offRoute).toBe(false); // tick 1
    expect(m.guidance(offLat, offLng, 'stop_5').offRoute).toBe(false); // tick 2
    expect(m.guidance(offLat, offLng, 'stop_5').offRoute).toBe(true); // tick 3
    const g4 = m.guidance(offLat, offLng, 'stop_5'); // tick 4
    expect(g4.offRoute).toBe(true);
    expect(g4.confidence).toBe('low');
    expect(g4.cue).toContain('off this route');
  });

  it('clears the off-route counter when the user returns to the line', () => {
    const m = matcher();
    const offLat = LAT + 200 / 111_320;
    m.guidance(offLat, lngAt(3000), 'stop_5');
    m.guidance(offLat, lngAt(3000), 'stop_5');
    // back on the line:
    const back = m.guidance(LAT, lngAt(3000), 'stop_5');
    expect(back.offRoute).toBe(false);
    expect(back.confidence).toBe('high');
  });
});
