'use client';

// "Look out for", the passenger-facing card that shows the upcoming landmark with real
// street-level imagery, so a rider can recognise where they are and know when to get down.

import { useEffect, useState } from 'react';
import { Eye, MapPin, ImageOff } from 'lucide-react';
import type { Lookout } from '@/lib/streetview/useLookout';

function formatDist(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/** "450 m ahead" / "Approaching now" / "After your transfer". */
function distanceLine(distanceAheadM: number | null): string {
  if (distanceAheadM == null) return 'After your transfer';
  if (distanceAheadM <= 60) return 'Approaching now';
  return `${formatDist(distanceAheadM)} ahead`;
}

/** Years-ago label for the imagery, kept short. */
function capturedLabel(capturedAt: number | null): string | null {
  if (capturedAt == null) return null;
  const years = (Date.now() - capturedAt) / (365.25 * 24 * 60 * 60 * 1000);
  if (years < 1) return 'Recent street view';
  return `Street view · ${Math.round(years)} yr${years >= 2 ? 's' : ''} ago`;
}

export function LookOutFor({ lookout }: { lookout: Lookout }) {
  const { target, distanceAheadM, image } = lookout;
  const lm = target.landmark;
  const [imgFailed, setImgFailed] = useState(false);
  const [imgPainted, setImgPainted] = useState(false);

  const approaching = distanceAheadM != null && distanceAheadM <= 60;
  const hasImage = image !== 'loading' && image.status === 'ok' && !imgFailed;
  const loading = image === 'loading';

  // A resolved 'ok' just means the API returned a URL, on a slow trotro-window connection the
  // actual photo bytes can still take a moment.
  const imgSrc = hasImage && image.status === 'ok' ? image.image.thumbUrl : null;
  useEffect(() => {
    setImgPainted(false);
  }, [imgSrc]);

  return (
    <section className="tg-lookout" aria-label={`Look out for ${lm.name}`}>
      <p className="tg-lookout-kicker">
        <Eye size={14} strokeWidth={2.25} aria-hidden="true" />
        Look out for
      </p>

      <div className="tg-lookout-figure">
        {/* Skeleton covers both waiting on the API AND the photo bytes still
            downloading, on a slow connection those are two separate delays,
            and the figure would otherwise sit blank between them. */}
        {(loading || (hasImage && !imgPainted)) && (
          <div className="tg-lookout-skeleton" aria-hidden="true" />
        )}

        {!loading && hasImage && image.status === 'ok' && (
          <>
            {/* Plain <img> on purpose: we link directly to the provider's CDN
                rather than re-hosting CC BY-SA imagery through our optimizer. */}
            <img
              src={image.image.thumbUrl}
              alt={`Street-level view near ${lm.name}`}
              className={`tg-lookout-img${imgPainted ? ' is-loaded' : ''}`}
              loading="lazy"
              decoding="async"
              onLoad={() => setImgPainted(true)}
              onError={() => setImgFailed(true)}
            />
            <a
              className="tg-lookout-attrib"
              href={image.image.attributionUrl ?? 'https://www.mapillary.com'}
              target="_blank"
              rel="noopener noreferrer"
              // Attribution is required by the imagery licence, never hidden.
            >
              {image.image.attribution}
            </a>
          </>
        )}

        {!loading && !hasImage && (
          <div className="tg-lookout-noimg" role="note">
            <ImageOff size={20} strokeWidth={1.5} aria-hidden="true" />
            <span>No street image available</span>
          </div>
        )}
      </div>

      <div className="tg-lookout-body">
        <div className="tg-lookout-headline">
          <MapPin size={16} strokeWidth={2} aria-hidden="true" />
          <span className="tg-lookout-name">
            {lm.name}
            {lm.local ? <span className="tg-lookout-local"> · {lm.local}</span> : null}
          </span>
        </div>
        <p
          className={`tg-lookout-dist${approaching ? ' is-approaching' : ''}`}
          aria-live="polite"
        >
          {distanceLine(distanceAheadM)}
          {lm.type ? <span className="tg-lookout-type">{lm.type}</span> : null}
        </p>
        {hasImage && image.status === 'ok' && capturedLabel(image.image.capturedAt) && (
          <p className="tg-lookout-meta">{capturedLabel(image.image.capturedAt)}</p>
        )}
      </div>
    </section>
  );
}
