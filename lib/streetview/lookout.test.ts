import { describe, it, expect } from 'vitest';
import { pickNextTarget, bearingAtAlong, AHEAD_EPS_M, type LookoutTarget } from './lookout';
import type { PackLandmark } from '@/lib/corepack/types';

const lm = (id: string): PackLandmark => ({ id, name: id, lat: 5.6, lng: -0.2 });

function target(id: string, legIndex: number, alongM: number): LookoutTarget {
  return { landmark: lm(id), legIndex, alongM, bearing: null };
}

describe('pickNextTarget', () => {
  // Single leg, landmarks at 500 / 1500 / 3000 m.
  const single = [target('a', 0, 500), target('b', 0, 1500), target('c', 0, 3000)];

  it('returns the nearest landmark ahead on the current leg', () => {
    const next = pickNextTarget(single, 0, 800);
    expect(next?.target.landmark.id).toBe('b');
    expect(next?.sameLeg).toBe(true);
  });

  it('skips a landmark the rider is already on top of (within AHEAD_EPS_M)', () => {
    // Rider essentially at "b" (1500), it should look past it to "c".
    const next = pickNextTarget(single, 0, 1500 - AHEAD_EPS_M + 1);
    expect(next?.target.landmark.id).toBe('c');
  });

  it('advances to the next landmark once the current one is passed', () => {
    expect(pickNextTarget(single, 0, 200)?.target.landmark.id).toBe('a');
    expect(pickNextTarget(single, 0, 1200)?.target.landmark.id).toBe('b');
    expect(pickNextTarget(single, 0, 2000)?.target.landmark.id).toBe('c');
  });

  it('returns null when nothing remains ahead', () => {
    expect(pickNextTarget(single, 0, 5000)).toBeNull();
  });

  it('crosses to a later leg after a transfer, flagging sameLeg=false', () => {
    const multi = [
      target('a', 0, 500),
      target('b', 1, 400),
      target('c', 1, 1200),
    ];
    // Past everything on leg 0 → first landmark on leg 1.
    const next = pickNextTarget(multi, 0, 900);
    expect(next?.target.landmark.id).toBe('b');
    expect(next?.sameLeg).toBe(false);
  });

  it('prefers a same-leg landmark ahead over jumping to the next leg', () => {
    const multi = [target('a', 0, 2000), target('b', 1, 100)];
    const next = pickNextTarget(multi, 0, 500);
    expect(next?.target.landmark.id).toBe('a');
    expect(next?.sameLeg).toBe(true);
  });
});

describe('bearingAtAlong', () => {
  // A straight due-north line: two vertices, ~1113 m apart.
  const line: [number, number][] = [[5.60, -0.20], [5.61, -0.20]];
  const cum = [0, 1113];

  it('returns the segment bearing (~0° / north) along a northbound line', () => {
    const b = bearingAtAlong(line, cum, 500);
    expect(b).not.toBeNull();
    expect(Math.abs((b as number) - 0)).toBeLessThan(1);
  });

  it('clamps past-the-end distances onto the last segment', () => {
    expect(bearingAtAlong(line, cum, 999999)).not.toBeNull();
  });

  it('returns null for a degenerate line', () => {
    expect(bearingAtAlong([[5.6, -0.2]], [0], 10)).toBeNull();
  });
});
