// Street-level imagery: provider-agnostic types.
//
// The navigation system must NEVER depend on Mapillary directly — Mapillary is
// one replaceable ImageProvider behind this interface (see provider.ts). A
// future WikimediaProvider / LocalLandmarkProvider / UserSubmittedProvider just
// implements the same shape, and nothing in the UI or ranking changes.
//
// Nothing here imports Mapillary, React, or Node — these types cross the
// server↔client boundary (the /api/streetview route returns `StreetImage`), so
// they stay pure data.

/** A point the rider wants imagery for — usually an upcoming landmark. */
export interface ImageQuery {
  /** Landmark / target latitude. */
  lat: number;
  /** Landmark / target longitude. */
  lng: number;
  /**
   * Direction of travel at this point, degrees clockwise from north (0–360).
   * Optional: when present, ranking prefers imagery that faces roughly the way
   * the rider is moving, so the photo matches what they'll actually see.
   */
  bearing?: number | null;
  /** Search radius around (lat,lng) in metres. */
  radiusM: number;
}

/**
 * A raw imagery candidate from a provider, normalised into one shape before
 * ranking. All providers must express their results as this — Mapillary's
 * `compass_angle` becomes `bearing`, its `captured_at` becomes `capturedAt`,
 * etc. Ranking (rank.ts) only ever sees this, never a provider's own payload.
 */
export interface ImageCandidate {
  /** Provider-scoped id (opaque to us). */
  id: string;
  /** Where the photo was actually taken. */
  lat: number;
  lng: number;
  /** Camera heading in degrees (0–360), or null when the provider lacks it. */
  bearing: number | null;
  /** Capture time as epoch ms, or null when unknown. */
  capturedAt: number | null;
  /** Displayable thumbnail URL (already sized by the provider). */
  thumbUrl: string;
  /** Larger URL for a tap-to-expand view, when the provider offers one. */
  fullUrl?: string | null;
}

/**
 * The image handed to the UI: a ranked candidate plus the attribution the
 * provider's terms require us to show. `provider` lets the card label the
 * source and lets us swap providers without the UI guessing.
 */
export interface StreetImage {
  id: string;
  thumbUrl: string;
  fullUrl?: string | null;
  bearing: number | null;
  capturedAt: number | null;
  /** e.g. "mapillary" — drives the attribution label + link. */
  provider: string;
  /** Human attribution string, shown verbatim (never hidden — see terms). */
  attribution: string;
  /** Canonical link back to the image on the provider, for attribution. */
  attributionUrl?: string | null;
}

/**
 * The result envelope the /api/streetview route returns and the client hook
 * consumes. `status` is explicit so the UI can distinguish "provider has no
 * photo here" (a normal, common outcome) from "the provider isn't configured"
 * from "the request failed" — each renders a different, honest state, and none
 * of them break navigation.
 */
export type ImageResult =
  | { status: 'ok'; image: StreetImage }
  | { status: 'empty' } // provider reached, genuinely no imagery near the point
  | { status: 'not_configured' } // no API token set — feature dormant, not broken
  | { status: 'error' }; // provider/network failure — navigation continues

/**
 * A street-level image provider. Implementations live server-side (they hold
 * secret tokens) and are reached only through /api/streetview.
 */
export interface ImageProvider {
  /** Short stable id used in `StreetImage.provider` and logs. */
  readonly name: string;
  /** True when the provider has the config (e.g. token) it needs to run. */
  isConfigured(): boolean;
  /**
   * Return raw candidates near the query point. MUST NOT rank or pick — that is
   * rank.ts's job, kept separate so it's testable and provider-independent.
   * Returns [] when the provider is reached but has no imagery there.
   */
  findCandidates(query: ImageQuery): Promise<ImageCandidate[]>;
  /** Attribution string this provider's terms require (shown in the UI). */
  attributionFor(candidate: ImageCandidate): string;
  /** Canonical provider URL for a candidate, for the attribution link. */
  attributionUrlFor(candidate: ImageCandidate): string | null;
}
