// Single source of truth for the "mate shouts are under review" disclaimer.
//
// While every route's mate shout is still being field-verified, the app warns
// riders in two places: a one-time popup when they open the app, and a quiet
// always-visible caution on the Step 2 "Board your trotro" card (the point of
// use). Both are gated on the flag below.
//
// TO REMOVE once verification is complete: set SHOUTS_UNDER_REVIEW to false.
// That alone hides BOTH the popup and the inline note — no other change needed.
// (Or delete this module and its two consumers: components/ShoutDisclaimer.tsx
// and the note in components/Trotro.tsx.)

export const SHOUTS_UNDER_REVIEW = true;

// Bump this when the disclaimer wording materially changes, so riders who
// already dismissed the old message see the new one once. Acknowledgement is
// stored per-version in localStorage.
export const SHOUT_DISCLAIMER_VERSION = '1';

// The one-line caution shown on the Step 2 shout card (and echoed in the popup).
export const SHOUT_REVIEW_NOTE =
  'Mate shouts are still being field-verified — if in doubt, confirm your destination with the mate.';
