// Build the Accra Core Pack from the DB and write versioned, immutable files.

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from '../lib/geo/polyline';
import type {
  CorePack,
  PackLandmark,
  PackNeighborhood,
  PackRoute,
  PackRouteStop,
  PackStop,
  PackSynonym,
} from '../lib/corepack/types';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');

// Shape of core.export_core_pack()'s jsonb. Routes carry GeoJSON here and are converted to
// polyline6 below.
interface RawRoute {
  id: string;
  name: string;
  mateShout: string;
  geometry: { coordinates: [number, number][] }; // [lng, lat]
  stops: PackRouteStop[];
}
interface RawExport {
  bbox: [number, number, number, number];
  stops: PackStop[];
  routes: RawRoute[];
  landmarks: PackLandmark[];
  neighborhoods: PackNeighborhood[];
  synonyms: PackSynonym[];
}

async function main(): Promise<void> {
  const db = createClient(url!, serviceKey!, { auth: { persistSession: false } });

  const { data, error } = await db.schema('core').rpc('export_core_pack');
  if (error) throw error;
  const raw = (data ?? {}) as RawExport;

  const routes: PackRoute[] = (raw.routes ?? []).map((r) => {
    const coords: [number, number][] = (r.geometry?.coordinates ?? []).map(
      ([lng, lat]) => [lat, lng] as [number, number],
    );
    return { id: r.id, name: r.name, mateShout: r.mateShout, polyline: encode(coords, 6), stops: r.stops };
  });

  const version = Date.now();
  const pack: CorePack = {
    version,
    bbox: raw.bbox,
    stops: raw.stops ?? [],
    routes,
    landmarks: raw.landmarks ?? [],
    neighborhoods: raw.neighborhoods ?? [],
    synonyms: raw.synonyms ?? [],
  };

  const body = JSON.stringify(pack);
  const bytes = Buffer.byteLength(body, 'utf8');
  const sha256 = createHash('sha256').update(body).digest('hex');

  const dir = join('public', 'core-pack', `v${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'accra-core.json'), body, 'utf8');

  const manifest = { version, url: `/core-pack/v${version}/accra-core.json`, bytes, sha256 };
  writeFileSync(join('public', 'core-pack', 'manifest.json'), JSON.stringify(manifest), 'utf8');

  console.log(
    `Core Pack v${version}: ${pack.stops.length} stops, ${pack.routes.length} routes, ` +
      `${pack.landmarks.length} landmarks, ${(bytes / 1024).toFixed(1)} KB`,
  );
  if (bytes > 1_200_000) {
    console.warn('WARNING: pack > 1.2 MB target — prune or simplify before shipping on metered data.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
