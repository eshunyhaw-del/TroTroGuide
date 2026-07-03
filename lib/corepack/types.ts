// The Accra Core Pack: a compact, versioned, APPROVED-only snapshot that ships
// to the device so SEARCH and on-board guidance work with ZERO network.
// Served at an immutable, versioned URL (CORRECTION #5 — no purge-by-tag):
//   /core-pack/v<version>/accra-core.json   (immutable, max-age=1y)
//   /core-pack/manifest.json                (tiny, short TTL, points at current)

export interface CorePackManifest {
  version: number;        // epoch ms, monotonically increasing
  url: string;            // versioned, immutable pack URL
  bytes: number;
  sha256: string;
}

/** Provenance/verification state of a record (BETA status model). Absent on the
 *  synthetic demo fixture; 'verified' on the sellable pack; mixed in the beta pack. */
export type RecordStatus = 'beta' | 'verified' | 'user_reported';

export interface PackStop {
  id: string;
  name: string;
  aliases: string[];
  lat: number;
  lng: number;
  routeIds: string[];
  landmark?: string | null;
  status?: RecordStatus;
}

export interface PackRouteStop {
  stopId: string;
  seq: number;
  distM: number;          // cumulative metres along the route to this stop
  board?: string | null;
  alight?: string | null;
  status?: RecordStatus;
}

export interface PackRoute {
  id: string;
  name: string;
  ref?: string;           // route number (e.g. "15", "282") when known
  mateShout: string;
  polyline: string;       // encoded polyline6 ([lat,lng], precision 6)
  stops: PackRouteStop[];
  status?: RecordStatus;
}

export interface PackLandmark {
  id: string;
  name: string;
  local?: string | null;
  type?: string | null;
  lat: number;
  lng: number;
}

export interface PackNeighborhood {
  id: string;
  name: string;
  localNames: string[];
  lat: number;
  lng: number;
}

export interface PackSynonym {
  token: string;
  canonical: string;
}

export interface CorePack {
  version: number;
  // True ONLY for the placeholder/demo fixture pack (hand-authored, unverified
  // data). Absent/false on real field-verified packs. The UI shows a banner when
  // set so demo data is never mistaken for real product data. See firewall memo.
  demo?: boolean;
  // Present on the public BETA pack, which merges ODbL OpenStreetMap data. ODbL
  // requires this be surfaced to users. Absent on the proprietary verified pack.
  attribution?: string;   // e.g. "© OpenStreetMap contributors"
  license?: string;       // e.g. "ODbL-1.0"
  bbox: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
  stops: PackStop[];
  routes: PackRoute[];
  landmarks: PackLandmark[];
  neighborhoods: PackNeighborhood[];
  synonyms: PackSynonym[];
}
