// WHEN, if ever, should the donate popup interrupt someone?

export type DonateAction =
  | 'shown'   // displayed, then dismissed via X / Esc / backdrop
  | 'later'   // "Maybe later"
  | 'donated'; // followed the donate link

export interface DonatePromptRecord {
  lastShownAt: number;
  lastAction: DonateAction;
}

/** Normal gap between prompts. */
export const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** Someone who has already given should not be asked again for a long while. */
export const DONATED_COOLDOWN_MS = 60 * 24 * 60 * 60 * 1000;
/**
 * How long the results stay uninterrupted first. Long enough to read the walk step, the mate's
 * shout and the first few stops before anything appears.
 */
export const SHOW_DELAY_MS = 15_000;

export function cooldownFor(action: DonateAction): number {
  return action === 'donated' ? DONATED_COOLDOWN_MS : COOLDOWN_MS;
}

/**
 * Is the prompt allowed to appear right now? `record` is whatever was persisted from a previous
 * visit (null on a first run).
 */
export function shouldShowPrompt(record: DonatePromptRecord | null, now: number): boolean {
  if (!record) return true;
  const elapsed = now - record.lastShownAt;
  if (elapsed < 0) return false;
  return elapsed >= cooldownFor(record.lastAction);
}

export function recordFor(action: DonateAction, now: number): DonatePromptRecord {
  return { lastShownAt: now, lastAction: action };
}

/** Tolerant parse, anything malformed means "no record", i.e. safe to show. */
export function parseRecord(raw: string | null): DonatePromptRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<DonatePromptRecord>;
    if (typeof r?.lastShownAt !== 'number' || !Number.isFinite(r.lastShownAt)) return null;
    const action: DonateAction =
      r.lastAction === 'donated' || r.lastAction === 'later' ? r.lastAction : 'shown';
    return { lastShownAt: r.lastShownAt, lastAction: action };
  } catch {
    return null;
  }
}
