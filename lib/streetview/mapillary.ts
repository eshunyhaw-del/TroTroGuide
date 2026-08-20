// Mapillary implementation of ImageProvider — SERVER ONLY.
//
// This module reads the secret MAPILLARY_TOKEN from env and must NEVER be
// imported into a client component (same rule as lib/moolre.ts). The browser
// only ever talks to /api/streetview, which calls this. The token never ships
// to the client.
//
// Official API: Mapillary Graph API v4 (https://graph.mapillary.com), the
// documented, supported entry point — we do NOT scrape mapillary.com or guess
// image URLs. Auth is the client access token (starts "MLY|") sent as an
// `Authorization: OAuth <token>` header. Get one, free, at
// https://www.mapillary.com/dashboard/developers.
//
// Endpoint used:
//   GET /images?fields=id,computed_geometry,geometry,compass_angle,captured_at,
//                      thumb_1024_url,thumb_2048_url
//              &bbox=<minLng>,<minLat>,<maxLng>,<maxLat>&limit=<n>
// Response envelope: { data: Image[] }. captured_at is epoch MILLISECONDS.
//
// Image usage & attribution: Mapillary imagery is licensed CC BY-SA 4.0. We
// therefore ALWAYS surface an attribution string + a link back to the image
// (attributionUrlFor). We store nothing — images are fetched live and rendered
// by URL; no caching to disk, in line with the terms. Short-lived in-memory
// response caching (for rate-limit sanity) lives in the API route, not here.

import type { ImageCandidate, ImageProvider, ImageQuery } from './types';

const GRAPH_BASE = 'https://graph.mapillary.com';
const TIMEOUT_MS = 8_000;

/** Fields we ask Mapillary for. computed_geometry is the refined position; we
 *  fall back to raw geometry when the SfM-computed one is absent. */
const FIELDS = [
  'id',
  'computed_geometry',
  'geometry',
  'compass_angle',
  'captured_at',
  'thumb_1024_url',
  'thumb_2048_url',
].join(',');

/** Shape of a Mapillary image entity (only the fields we request). */
interface MapillaryImage {
  id: string;
  computed_geometry?: { type: 'Point'; coordinates: [number, number] }; // [lng, lat]
  geometry?: { type: 'Point'; coordinates: [number, number] };
  compass_angle?: number;
  captured_at?: number; // epoch ms
  thumb_1024_url?: string;
  thumb_2048_url?: string;
}

/**
 * Convert a centre point + radius into a [minLng,minLat,maxLng,maxLat] bbox.
 * Small-angle flat-earth approximation — fine at the ≤200 m radii we query,
 * where curvature error is far below GPS noise.
 */
export function radiusToBbox(
  lat: number,
  lng: number,
  radiusM: number,
): [number, number, number, number] {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

export class MapillaryProvider implements ImageProvider {
  readonly name = 'mapillary';

  private token(): string | undefined {
    return process.env.MAPILLARY_TOKEN;
  }

  isConfigured(): boolean {
    return Boolean(this.token());
  }

  async findCandidates(query: ImageQuery): Promise<ImageCandidate[]> {
    const token = this.token();
    if (!token) return []; // caller checks isConfigured() first; guard anyway

    const [minLng, minLat, maxLng, maxLat] = radiusToBbox(query.lat, query.lng, query.radiusM);
    const url =
      `${GRAPH_BASE}/images?fields=${FIELDS}` +
      `&bbox=${minLng},${minLat},${maxLng},${maxLat}` +
      `&limit=25`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `OAuth ${token}` },
        signal: ac.signal,
      });
      if (!res.ok) {
        // Surface as an error to the route (which maps it to status:'error'),
        // never as fake data. 4xx here usually means a bad/expired token.
        throw new Error(`Mapillary /images HTTP ${res.status}`);
      }
      const json = (await res.json()) as { data?: MapillaryImage[] };
      const data = json.data ?? [];
      const out: ImageCandidate[] = [];
      for (const img of data) {
        const pt = img.computed_geometry?.coordinates ?? img.geometry?.coordinates;
        const thumb = img.thumb_1024_url ?? img.thumb_2048_url;
        if (!pt || !thumb) continue; // unusable without a location or a picture
        out.push({
          id: img.id,
          lng: pt[0],
          lat: pt[1],
          bearing: typeof img.compass_angle === 'number' ? img.compass_angle : null,
          capturedAt: typeof img.captured_at === 'number' ? img.captured_at : null,
          thumbUrl: thumb,
          fullUrl: img.thumb_2048_url ?? null,
        });
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  attributionFor(): string {
    // CC BY-SA 4.0 imagery from the Mapillary community.
    return '© Mapillary contributors · CC BY-SA';
  }

  attributionUrlFor(candidate: ImageCandidate): string {
    return `https://www.mapillary.com/app/?focus=photo&pKey=${encodeURIComponent(candidate.id)}`;
  }
}
