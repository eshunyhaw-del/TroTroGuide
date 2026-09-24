'use client';

import { Heart } from 'lucide-react';
import { SUPPORT_ENABLED, openDonate } from '@/lib/support';

export function SupportCard() {
  if (!SUPPORT_ENABLED) return null;
  return (
    <button type="button" className="tg-support-card" onClick={openDonate}>
      <span className="tg-support-heart" aria-hidden="true">
        <Heart size={22} strokeWidth={2} />
      </span>
      <span className="tg-support-body">
        <strong className="tg-support-title">Support TroTro Guide</strong>
        <span className="tg-support-sub">
          TroTro Guide is free to use. Your gift pays for mapping more routes.
        </span>
      </span>
      <span className="tg-support-cta">Donate</span>
    </button>
  );
}

export function SupportLink() {
  if (!SUPPORT_ENABLED) return null;
  return (
    <button type="button" className="tg-support-inline" onClick={openDonate}>
      <Heart size={16} strokeWidth={2} aria-hidden="true" />
      Was this helpful? Support development
    </button>
  );
}
