// Chooses which CorePack to build at deploy time (runs inside `npm run build`):
//   public/admin/osm-data.json present  -> beta pack (OSM + verified core), the public app's pack
//   else data/core_verified.json        -> verified-only pack
//   else                                -> demo fixture, blocked in production unless ALLOW_DEMO_PACK=1

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const osmData = join(root, 'public', 'admin', 'osm-data.json');
const verified = join(root, 'data', 'core_verified.json');
const routes = join(root, 'data', 'routes.json');

if (existsSync(osmData)) {
  console.log('prepare-core-pack: building BETA pack (OSM beta + verified core)');
  execFileSync('node', [join(here, 'build-core-pack-beta.mjs')], { stdio: 'inherit' });
} else if (existsSync(verified)) {
  const args = [join(here, 'build-core-pack-from-verified.mjs'), '--core', verified];
  if (existsSync(routes)) args.push('--routes', routes);
  console.log('prepare-core-pack: no OSM data -> VERIFIED-only pack');
  execFileSync('node', args, { stdio: 'inherit' });
} else {
  // FIREWALL GUARD: the fixture builder emits PLACEHOLDER geodata (incl. the hand-authored Abeka
  // Lapaz -> Dome Kwabenya route).
  const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  if (isProd && process.env.ALLOW_DEMO_PACK !== '1') {
    console.error(
      'prepare-core-pack: REFUSING to ship the demo/placeholder pack to production.\n' +
        '  No OSM (public/admin/osm-data.json) or verified (data/core_verified.json) data found.\n' +
        '  Run "npm run build:admin" (beta) or promote fieldwork (verified) first,\n' +
        '  or set ALLOW_DEMO_PACK=1 to deploy placeholder data on purpose.',
    );
    process.exit(1);
  }
  console.log('prepare-core-pack: no source data -> demo fixture (PLACEHOLDER data)');
  execFileSync('node', [join(here, 'build-fixture-pack.mjs')], { stdio: 'inherit' });
}
