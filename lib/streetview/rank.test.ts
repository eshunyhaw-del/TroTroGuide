import { describe, it, expect } from 'vitest';
import { rankCandidates, bestCandidate, bearingDiffDeg, WEIGHTS } from './rank';
import type { ImageCandidate, ImageQuery } from './types';

// A landmark on an Accra-ish corridor, rider heading roughly east (bearing 90).
const QUERY: ImageQuery = { lat: 5.654, lng: -0.185, bearing: 90, radiusM: 120 };
const NOW = 1_800_000_000_000; // fixed clock so scoring is deterministic
const YEAR = 365.25 * 24 * 60 * 60 * 1000;

// Tiny offset helper: ~1 m in latitude degrees.
const mLat = (m: number) => m / 111_320;

function candidate(over: Partial<ImageCandidate>): ImageCandidate {
  return {
    id: 'c', lat: QUERY.lat, lng: QUERY.lng, bearing: 90,
    capturedAt: NOW, thumbUrl: 'http://x/t.jpg', ...over,
  };
}

describe('bearingDiffDeg', () => {
  it('wraps around 360 and is symmetric', () => {
    expect(bearingDiffDeg(10, 350)).toBe(20);
    expect(bearingDiffDeg(350, 10)).toBe(20);
    expect(bearingDiffDeg(0, 180)).toBe(180);
    expect(bearingDiffDeg(90, 90)).toBe(0);
  });
});

describe('rankCandidates', () => {
  it('prefers the closer image, all else equal', () => {
    const near = candidate({ id: 'near', lat: QUERY.lat + mLat(5) });
    const far = candidate({ id: 'far', lat: QUERY.lat + mLat(90) });
    const ranked = rankCandidates([far, near], QUERY, NOW);
    expect(ranked[0].candidate.id).toBe('near');
  });

  it('prefers imagery facing the direction of travel', () => {
    const aligned = candidate({ id: 'aligned', bearing: 90 }); // matches travel
    const opposite = candidate({ id: 'opposite', bearing: 270 }); // faces backwards
    const ranked = rankCandidates([opposite, aligned], QUERY, NOW);
    expect(ranked[0].candidate.id).toBe('aligned');
    expect(ranked[0].parts.facing).toBeGreaterThan(ranked[1].parts.facing);
  });

  it('prefers more recent imagery, all else equal', () => {
    const fresh = candidate({ id: 'fresh', capturedAt: NOW });
    const old = candidate({ id: 'old', capturedAt: NOW - 6 * YEAR });
    const ranked = rankCandidates([old, fresh], QUERY, NOW);
    expect(ranked[0].candidate.id).toBe('fresh');
  });

  it('lets strong proximity outweigh a wrong facing (weights honoured)', () => {
    // At the point but facing backwards vs. far away but facing forwards.
    const closeWrongWay = candidate({ id: 'close', lat: QUERY.lat, bearing: 270 });
    const farRightWay = candidate({ id: 'far', lat: QUERY.lat + mLat(115), bearing: 90 });
    const ranked = rankCandidates([farRightWay, closeWrongWay], QUERY, NOW);
    // proximity weight (0.5) > facing weight (0.3), so the on-point image wins.
    expect(ranked[0].candidate.id).toBe('close');
    expect(WEIGHTS.proximity).toBeGreaterThan(WEIGHTS.facing);
  });

  it('breaks equal scores by proximity, order-independently', () => {
    // Same facing + recency, but "b" sits slightly closer. The distance
    // tiebreak must make "b" win regardless of input order (deterministic).
    const a = candidate({ id: 'a', lat: QUERY.lat + mLat(40) });
    const b = candidate({ id: 'b', lat: QUERY.lat + mLat(20) });
    expect(rankCandidates([a, b], QUERY, NOW)[0].candidate.id).toBe('b');
    expect(rankCandidates([b, a], QUERY, NOW)[0].candidate.id).toBe('b');
  });

  it('treats unknown bearing/date neutrally rather than excluding it', () => {
    const noMeta = candidate({ id: 'nometa', bearing: null, capturedAt: null });
    const ranked = rankCandidates([noMeta], QUERY, NOW);
    expect(ranked[0].parts.facing).toBeCloseTo(0.5, 5);
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it('bestCandidate returns null on an empty set', () => {
    expect(bestCandidate([], QUERY, NOW)).toBeNull();
  });
});
