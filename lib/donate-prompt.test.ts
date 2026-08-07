import { describe, it, expect } from 'vitest';
import {
  COOLDOWN_MS,
  DONATED_COOLDOWN_MS,
  parseRecord,
  recordFor,
  shouldShowPrompt,
} from './donate-prompt';

const T0 = 1_700_000_000_000; // fixed clock; nothing here reads Date.now()

describe('shouldShowPrompt', () => {
  it('shows on a first run (no stored record)', () => {
    expect(shouldShowPrompt(null, T0)).toBe(true);
  });

  it('stays away for a week after being dismissed', () => {
    const r = recordFor('shown', T0);
    expect(shouldShowPrompt(r, T0)).toBe(false);
    expect(shouldShowPrompt(r, T0 + COOLDOWN_MS - 1)).toBe(false);
    expect(shouldShowPrompt(r, T0 + COOLDOWN_MS)).toBe(true);
  });

  it('treats "maybe later" with the same week-long cooldown', () => {
    const r = recordFor('later', T0);
    expect(shouldShowPrompt(r, T0 + COOLDOWN_MS - 1)).toBe(false);
    expect(shouldShowPrompt(r, T0 + COOLDOWN_MS)).toBe(true);
  });

  it('backs off for two months once someone has donated', () => {
    const r = recordFor('donated', T0);
    expect(shouldShowPrompt(r, T0 + COOLDOWN_MS)).toBe(false);
    expect(shouldShowPrompt(r, T0 + DONATED_COOLDOWN_MS - 1)).toBe(false);
    expect(shouldShowPrompt(r, T0 + DONATED_COOLDOWN_MS)).toBe(true);
  });

  it('never nags when the device clock has moved backwards', () => {
    // A record "from the future" must not read as an elapsed cooldown.
    const r = recordFor('shown', T0);
    expect(shouldShowPrompt(r, T0 - 60_000)).toBe(false);
  });
});

describe('parseRecord', () => {
  it('round-trips a real record', () => {
    const r = recordFor('later', T0);
    expect(parseRecord(JSON.stringify(r))).toEqual(r);
  });

  it('returns null for missing or malformed storage', () => {
    expect(parseRecord(null)).toBeNull();
    expect(parseRecord('')).toBeNull();
    expect(parseRecord('not json')).toBeNull();
    expect(parseRecord('{}')).toBeNull();
    expect(parseRecord('{"lastShownAt":"nope"}')).toBeNull();
    expect(parseRecord('{"lastShownAt":null}')).toBeNull();
  });

  it('falls back to the short cooldown when the action is unrecognised', () => {
    const parsed = parseRecord(`{"lastShownAt":${T0},"lastAction":"weird"}`);
    expect(parsed).toEqual({ lastShownAt: T0, lastAction: 'shown' });
  });
});
