'use client';

// One-time "mate shouts are under review" disclaimer, shown when the app opens.
//
// Appears once per disclaimer version, then never again (acknowledgement is
// stored in localStorage). Gated on SHOUTS_UNDER_REVIEW — flip that off when
// verification is done and this stops rendering entirely.
//
// Modal mechanics mirror DonatePopup: scrim, focus trap, Esc to close, focus
// restored on close. It records acknowledgement on dismissal so a rider only
// ever sees it once.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Megaphone, X } from 'lucide-react';
import {
  SHOUTS_UNDER_REVIEW,
  SHOUT_DISCLAIMER_VERSION,
  SHOUT_REVIEW_NOTE,
} from '@/lib/shout-review';

const STORAGE_KEY = 'trotro:shoutDisclaimer';

/** Read the acknowledged version, tolerating disabled/private storage. */
function readAck(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // private mode — treat as not yet acknowledged
  }
}

function writeAck(): void {
  try {
    localStorage.setItem(STORAGE_KEY, SHOUT_DISCLAIMER_VERSION);
  } catch {
    // Storage unavailable: the disclaimer simply isn't remembered on this
    // device. Never let it break the app.
  }
}

export function ShoutDisclaimer() {
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    writeAck();
    setOpen(false);
  }, []);

  // Decide once on mount. A short delay lets the app paint first, so the
  // disclaimer lands on a ready screen rather than a cold flash.
  useEffect(() => {
    if (!SHOUTS_UNDER_REVIEW) return;
    if (readAck() === SHOUT_DISCLAIMER_VERSION) return;
    const id = setTimeout(() => setOpen(true), 500);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      const root = cardRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
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

  if (!SHOUTS_UNDER_REVIEW || !open) return null;

  return (
    <div className="tg-disclaimer-scrim" onClick={close}>
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tg-disclaimer-title"
        className="tg-disclaimer glass tg-rise"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="tg-disclaimer-x" onClick={close} aria-label="Close">
          <X size={18} strokeWidth={2} aria-hidden="true" />
        </button>

        <span className="tg-disclaimer-icon" aria-hidden="true">
          <Megaphone size={24} strokeWidth={2} />
        </span>

        <h2 id="tg-disclaimer-title" className="tg-disclaimer-title">
          A quick heads-up on mate shouts
        </h2>
        <p className="tg-disclaimer-body">
          {SHOUT_REVIEW_NOTE} We&rsquo;re checking every route on the ground, and this note
          goes away once they&rsquo;re all confirmed. Everything else — stops, routes and
          directions — works as normal.
        </p>

        <div className="tg-disclaimer-actions">
          <button className="tg-btn tg-btn--primary" onClick={close}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
