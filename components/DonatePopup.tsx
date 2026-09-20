'use client';

// The donate prompt on the results screen. Timing rules (and the reasoning behind them) live in
// lib/donate-prompt.ts.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Heart, X } from 'lucide-react';
import { SUPPORT_URL, SUPPORT_ENABLED } from '@/lib/support';
import {
  SHOW_DELAY_MS,
  parseRecord,
  recordFor,
  shouldShowPrompt,
  type DonateAction,
} from '@/lib/donate-prompt';

const STORAGE_KEY = 'trotro:donatePrompt';

function readRecord() {
  try {
    return parseRecord(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null; // private mode / storage disabled — treat as first run
  }
}

function writeRecord(action: DonateAction) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recordFor(action, Date.now())));
  } catch {
    // Storage unavailable. The prompt simply isn't rate-limited on this device;
    // never let it break the results screen.
  }
}

export interface DonatePopupProps {
  /** True while a usable set of directions is on screen. */
  armed: boolean;
}

export function DonatePopup({ armed }: DonatePopupProps) {
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  const close = useCallback((action: DonateAction | null) => {
    if (action) writeRecord(action);
    setOpen(false);
  }, []);

  // Arm the delay. Re-running when `armed` flips false also cancels a pending timer, so leaving the
  // results screen before it fires shows nothing.
  useEffect(() => {
    if (!SUPPORT_ENABLED || !armed) return;
    if (!shouldShowPrompt(readRecord(), Date.now())) return;

    const id = setTimeout(() => {
      writeRecord('shown'); // an ignored prompt still starts the cooldown
      setOpen(true);
    }, SHOW_DELAY_MS);
    return () => clearTimeout(id);
  }, [armed]);

  // Never outlive the results it was attached to.
  useEffect(() => {
    if (!armed) setOpen(false);
  }, [armed]);

  // Modal behaviour: focus in, Esc to leave, Tab stays inside, focus restored.
  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      const root = cardRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null); // already recorded as 'shown'
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      const f = root.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      restoreFocusTo.current?.focus?.();
    };
  }, [open, close]);

  if (!SUPPORT_ENABLED || !open) return null;

  return (
    <div className="tg-donate-scrim" onClick={() => close(null)}>
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tg-donate-title"
        className="tg-donate glass tg-rise"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="tg-donate-x" onClick={() => close(null)} aria-label="Close">
          <X size={18} strokeWidth={2} aria-hidden="true" />
        </button>

        <span className="tg-donate-heart" aria-hidden="true">
          <Heart size={24} strokeWidth={2} />
        </span>

        <h2 id="tg-donate-title" className="tg-donate-title">
          Found your trotro?
        </h2>
        <p className="tg-donate-body">
          TroTro Guide is built by one developer in Accra, and it stays free with no ads and no
          login. If it saved you a wrong turn today, a small gift keeps it running.
        </p>

        <div className="tg-donate-actions">
          <a
            className="tg-btn tg-btn--primary"
            href={SUPPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => close('donated')}
          >
            <Heart size={18} strokeWidth={2} aria-hidden="true" />
            Donate
          </a>
          <button className="tg-btn tg-btn--secondary" onClick={() => close('later')}>
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}
