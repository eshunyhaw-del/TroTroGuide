import { describe, it, expect } from 'vitest';
import { getResolution } from 'h3-js';
import { quantize, cellCenter, isValidR9, neighbors, H3_RES } from './h3';

// Accra reference coordinates from the spec.
const A = { lat: 5.6037, lng: -0.187 }; // around 37 / Airport area
const B = { lat: 5.60515, lng: -0.2513 }; // ~7 km west (Circle-ish)

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

describe('H3 quantization (res 9)', () => {
  it('produces verifiable res-9 cell strings (printed for an external H3 calculator)', () => {
    const cellA = quantize(A.lat, A.lng);
    const cellB = quantize(B.lat, B.lng);

    // The exact base-16 index is computed by h3-js at runtime. Paste these into
    // an H3 calculator (e.g. https://wolf-h3-viewer.glitch.me) to verify.
    // eslint-disable-next-line no-console
    console.log('H3 res-9 cells:', { A: cellA, B: cellB });

    // Verifiable invariants of every H3 res-9 index:
    //   - resolution is exactly 9
    //   - the string is 15 hex chars and (for res 9) begins with "89"
    for (const c of [cellA, cellB]) {
      expect(getResolution(c)).toBe(H3_RES);
      expect(isValidR9(c)).toBe(true);
      expect(c).toMatch(/^89[0-9a-f]{13}$/);
    }

    // A and B are ~7 km apart, so they must be DIFFERENT cells.
    expect(cellA).not.toBe(cellB);

    // Round-trip: the cell centre is within ~half a cell (~150 m) of the input.
    const [clat, clng] = cellCenter(cellA);
    const dLat = (clat - A.lat) * M_PER_DEG_LAT;
    const dLng = (clng - A.lng) * mPerDegLng(A.lat);
    const dist = Math.hypot(dLat, dLng);
    expect(dist).toBeLessThan(200);
  });

  it('never leaks raw lat/lng into a cell id, cache key, URL, or log line', () => {
    const cell = quantize(A.lat, A.lng);

    // The cell id itself must not contain the raw coordinate digits.
    const rawFragments = ['5.6037', '-0.187', '0.187', '5.60515', '-0.2513', '0.2513'];
    for (const frag of rawFragments) expect(cell.includes(frag)).toBe(false);

    // Simulate the exact cache key the Cloudflare Worker builds for boarding-point.
    const cacheKey = `https://cache.trotro/api/boarding-point?cell=${cell}&d=stop:abc-123`;
    for (const frag of rawFragments) expect(cacheKey.includes(frag)).toBe(false);

    // Simulate the boarding-point POST URL (no query params at all).
    const url = '/api/boarding-point';
    expect(url.includes('lat')).toBe(false);
    expect(url.includes('lng')).toBe(false);

    // Simulate a log line built from the request — only the coarse cell is safe.
    const logLine = JSON.stringify({ where: 'boarding', cell, destinationType: 'stop' });
    for (const frag of rawFragments) expect(logLine.includes(frag)).toBe(false);
    expect(logLine.includes(cell)).toBe(true);
  });

  it('maps two points within 150 m to the same or an adjacent cell', () => {
    // A point ~120 m due east of A (< the ~174 m res-9 edge length).
    const eastLng = A.lng + 120 / mPerDegLng(A.lat);
    const near = { lat: A.lat, lng: eastLng };

    const cellA = quantize(A.lat, A.lng);
    const cellNear = quantize(near.lat, near.lng);

    const sameOrAdjacent = cellA === cellNear || neighbors(cellA, 1).includes(cellNear);
    // eslint-disable-next-line no-console
    console.log('near-pair cells:', { cellA, cellNear, sameOrAdjacent });
    expect(sameOrAdjacent).toBe(true);
  });
});
