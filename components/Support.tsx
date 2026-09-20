import { Heart } from 'lucide-react';
import { SUPPORT_URL, SUPPORT_ENABLED } from '@/lib/support';

export function SupportCard() {
  if (!SUPPORT_ENABLED) return null;
  return (
    <a className="tg-support-card" href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
      <span className="tg-support-heart" aria-hidden="true">
        <Heart size={22} strokeWidth={2} />
      </span>
      <span className="tg-support-body">
        <strong className="tg-support-title">Support TroTro Guide</strong>
        <span className="tg-support-sub">
          Built by one developer for Accra&rsquo;s commuters. Free forever, your gift keeps it running and growing.
        </span>
      </span>
      <span className="tg-support-cta">Donate</span>
    </a>
  );
}

export function SupportLink() {
  if (!SUPPORT_ENABLED) return null;
  return (
    <a className="tg-support-inline" href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
      <Heart size={16} strokeWidth={2} aria-hidden="true" />
      Was this helpful? Support development
    </a>
  );
}
