// Street-level imagery: provider-agnostic types.

/** A point the rider wants imagery for — usually an upcoming landmark. */
export interface ImageQuery {
  /** Landmark / target latitude. */
  lat: number;
  /** Landmark / target longitude. */
  lng: number;
  /** Direction of travel at this point, degrees clockwise from north (0–360). */
  bearing?: number | null;
  /** Search radius around (lat,lng) in metres. */
  radiusM: number;
}

/** A raw imagery candidate from a provider, normalised into one shape before ranking. */
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
 * The image handed to the UI: a ranked candidate plus the attribution the provider's terms require
 * us to show.
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

/** The result envelope the /api/streetview route returns and the client hook consumes. */
export type ImageResult =
  | { status: 'ok'; image: StreetImage }
  | { status: 'empty' } // provider reached, genuinely no imagery near the point
  | { status: 'not_configured' } // no API token set — feature dormant, not broken
  | { status: 'error' }; // provider/network failure — navigation continues

/**
 * A street-level image provider. Implementations live server-side (they hold secret tokens) and are
 * reached only through /api/streetview.
 */
export interface ImageProvider {
  /** Short stable id used in `StreetImage.provider` and logs. */
  readonly name: string;
  /** True when the provider has the config (e.g. token) it needs to run. */
  isConfigured(): boolean;
  /**
   * Return raw candidates near the query point. MUST NOT rank or pick — that is rank.ts's job, kept
   * separate so it's testable and provider-independent.
   */
  findCandidates(query: ImageQuery): Promise<ImageCandidate[]>;
  /** Attribution string this provider's terms require (shown in the UI). */
  attributionFor(candidate: ImageCandidate): string;
  /** Canonical provider URL for a candidate, for the attribution link. */
  attributionUrlFor(candidate: ImageCandidate): string | null;
}
