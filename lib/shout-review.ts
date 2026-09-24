// Single source of truth for the "mate shouts are under review" disclaimer.

export const SHOUTS_UNDER_REVIEW = true;

// Bump this when the disclaimer wording materially changes, so riders who already dismissed the old
// message see the new one once.
export const SHOUT_DISCLAIMER_VERSION = '1';

// The one-line caution shown on the Step 2 shout card (and echoed in the popup).
export const SHOUT_REVIEW_NOTE =
  'Mate shouts are still being checked on the ground. If in doubt, confirm your destination with the mate.';
