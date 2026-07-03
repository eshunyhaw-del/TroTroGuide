'use client';

import { useCallback, useEffect, useState } from 'react';
import { ensurePack, isConnectionMetered, peekManifest } from './client';

// State machine for the first-run pack load:
//   loading       -> checking IndexedDB / non-metered auto-download
//   ready         -> pack present; search + on-board guidance work offline
//   needs-consent -> metered connection, no cached pack: ask before spending data
//   downloading   -> user accepted; fetching the pack
//   error         -> offline with nothing cached (retryable)
export type PackState = 'loading' | 'ready' | 'needs-consent' | 'downloading' | 'error';

export interface UsePack {
  state: PackState;
  sizeBytes: number | null;
  confirmDownload: () => void;
  retry: () => void;
}

const LOAD_TIMEOUT_MS = 5000;

export function usePack(): UsePack {
  const [state, setState] = useState<PackState>('loading');
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);

  const load = useCallback(async (allowMetered: boolean) => {
    setState(allowMetered ? 'downloading' : 'loading');
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Never leave the user stuck on "Loading…" — anything still pending
      // (slow network, blocked IndexedDB, etc.) falls back to a retryable error.
      setState('error');
    }, LOAD_TIMEOUT_MS);
    try {
      const pack = await ensurePack({ allowMeteredDownload: allowMetered });
      if (timedOut) return; // state already settled by the timeout above
      if (pack) {
        setState('ready');
        return;
      }
      // null => either metered + not cached (deferred), or an offline failure.
      if (isConnectionMetered()) {
        const m = await peekManifest();
        setSizeBytes(m?.bytes ?? null);
        setState('needs-consent');
      } else {
        setState('error');
      }
    } catch {
      if (!timedOut) setState('error');
    } finally {
      clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const confirmDownload = useCallback(() => void load(true), [load]);
  const retry = useCallback(() => void load(false), [load]);

  return { state, sizeBytes, confirmDownload, retry };
}
