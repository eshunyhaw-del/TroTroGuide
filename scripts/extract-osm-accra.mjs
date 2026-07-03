// ============================================================================
// TASK 1 — OSM "Treasure Map": RAW extraction only.
// ============================================================================
// Pull the AccraMobile3 / GUMAP trotro data out of OpenStreetMap via the
// Overpass API and dump the responses VERBATIM to data/osm_raw/. This is the
// ODbL "parking lot": scaffold that tells us WHERE to look in the field. There
// is deliberately NO conversion to CorePack and NO database here — that mixing
// is forbidden by the license firewall (see LICENSE-BOUNDARY.md, later task).
//
//   Run:    node scripts/extract-osm-accra.mjs
//           node scripts/extract-osm-accra.mjs --dry-run        # print queries, no fetch
//           node scripts/extract-osm-accra.mjs --strict         # exact prompt queries (area + bus=unofficial)
//           node scripts/extract-osm-accra.mjs --endpoint https://overpass.kumi.systems/api/interpreter
//           node scripts/extract-osm-accra.mjs --bbox 5.40,-0.70,6.10,0.30   # south,west,north,east
//
//   Output (data/osm_raw/):
//     stops.json          raw Overpass JSON: trotro stops / platforms
//     route_masters.json  raw Overpass JSON: route_master relations (the "line")
//     routes.json         raw Overpass JSON: route relations (each direction) + member geometry
//     _manifest.json      counts, freshness, tag histograms, exact queries, ODbL attribution
//     ATTRIBUTION.txt     ODbL notice — this whole folder is © OpenStreetMap contributors
//
// Pure Node 18+ (global fetch), zero deps, no Supabase. Safe to run standalone.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Greater Accra — the SAME box the app's geofence + fixture pack use
// (db/migrations/0001 geofence polygon, scripts/build-fixture-pack bbox).
// Order here is [south, west, north, east] = Overpass bbox order.
const DEFAULT_BBOX = [5.4, -0.7, 6.1, 0.3];

// Public Overpass mirrors, tried in order. The API is shared + rate-limited;
// we fall through to the next mirror on overload (429/504) after retries.
const DEFAULT_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const USER_AGENT =
  'TrotroGuide-OSM-Extractor/1.0 (offline trotro navigation; treasure-map extraction; +https://openstreetmap.org/copyright)';

const ATTRIBUTION = '© OpenStreetMap contributors';
const LICENSE = 'ODbL-1.0';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { strict: false, dryRun: false, endpoint: null, bbox: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') args.strict = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--endpoint') args.endpoint = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--bbox') args.bbox = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/extract-osm-accra.mjs [--dry-run] [--strict] [--endpoint URL] [--bbox s,w,n,e] [--out DIR]');
      process.exit(0);
    }
  }
  return args;
}

function resolveBbox(raw) {
  if (!raw) return DEFAULT_BBOX;
  const parts = raw.split(',').map((x) => Number(x.trim()));
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    throw new Error(`--bbox must be "south,west,north,east", got "${raw}"`);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Query builders
//
// ROBUST (default): bbox-scoped, drops the dubious bus=unofficial filter, and
//   uses `out meta` so every element carries its last-edit timestamp (Task 2
//   needs freshness; the original prompt's `out body` would discard it).
// STRICT: reproduces the prompt's exact selection — area["name"="Accra"] +
//   ["bus"="unofficial"] — for side-by-side comparison. (Still `out meta`:
//   that only ADDS metadata to the same elements, it never changes selection.)
//
// We intentionally OVER-capture (all route=bus in the box) rather than guess
// the exact AccraMobile tag. Task 1 is raw extraction; classifying/filtering is
// a later step, informed by the tag histogram this script prints.
// ---------------------------------------------------------------------------
function buildQueries({ strict, bbox }) {
  const [s, w, n, e] = bbox;
  const box = `(${s},${w},${n},${e})`;
  const prelude = strict ? 'area["name"="Accra"]->.searchArea;\n' : '';
  const scope = strict ? '(area.searchArea)' : box;
  const unofficial = strict ? '["bus"="unofficial"]' : '';

  const stops =
    `[out:json][timeout:90];\n` +
    prelude +
    `(\n` +
    `  node["highway"="bus_stop"]["bus"="yes"]${scope};\n` +
    `  node["public_transport"="platform"]["bus"="yes"]${scope};\n` +
    `);\n` +
    `out meta;`;

  const route_masters =
    `[out:json][timeout:90];\n` +
    prelude +
    `relation["type"="route_master"]["route_master"="bus"]${unofficial}${scope};\n` +
    `out meta;`;

  // `>;` pulls member ways + their nodes so route geometry can be rebuilt later
  // (Task 6: polyline6 + cumulative distM). `out skel qt` emits coords only.
  const routes =
    `[out:json][timeout:120];\n` +
    prelude +
    `relation["type"="route"]["route"="bus"]${unofficial}${scope};\n` +
    `out meta;\n` +
    `>;\n` +
    `out skel qt;`;

  // NAVIGATION LANDMARKS — named POIs that riders actually use to orient
  // ("get down at the Shell", "before Kaneshie Market"). Curated categories
  // only; a `["name"]` filter drops the thousands of unnamed nodes. `nwr`
  // covers node/way/relation; `out center` gives ways/relations one coord.
  // Still ODbL scaffold — these ship ONLY in the public BETA pack, never the
  // sellable verified pack (the beta builder enforces near-a-route + firewall).
  const L_AMENITY = 'marketplace|fuel|hospital|clinic|place_of_worship|university|college|bank|police|bus_station|cinema|theatre|townhall|fire_station|courthouse|library|fast_food';
  const L_SHOP = 'mall|supermarket|department_store';
  const L_TOURISM = 'hotel|attraction|museum';
  const landmarks =
    `[out:json][timeout:120];\n` +
    prelude +
    `(\n` +
    `  nwr["amenity"~"^(${L_AMENITY})$"]["name"]${scope};\n` +
    `  nwr["shop"~"^(${L_SHOP})$"]["name"]${scope};\n` +
    `  nwr["tourism"~"^(${L_TOURISM})$"]["name"]${scope};\n` +
    `  nwr["leisure"="stadium"]["name"]${scope};\n` +
    `);\n` +
    `out center meta;`;

  return { stops, route_masters, routes, landmarks };
}

// ---------------------------------------------------------------------------
// Overpass fetch with mirror fallback + backoff
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query, { endpoints, timeoutMs = 180_000, retries = 3 }) {
  let lastErr;
  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: 'data=' + encodeURIComponent(query),
          signal: ac.signal,
        });
        clearTimeout(timer);

        if ([429, 502, 503, 504].includes(res.status)) throw new Error(`HTTP ${res.status} (overloaded)`);
        if (!res.ok) {
          const snippet = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${snippet.slice(0, 300)}`);
        }

        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          // Overpass returns HTML/text on syntax or runtime errors even with 200
          throw new Error(`non-JSON response (likely query/runtime error): ${text.slice(0, 300)}`);
        }
        if (data.remark && /error|timed? ?out|rate_limited|exceeded/i.test(data.remark)) {
          throw new Error(`Overpass remark: ${data.remark}`);
        }
        return { text, data, endpoint };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        const wait = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
        console.warn(`    ! ${endpoint} attempt ${attempt}/${retries} failed: ${err.message}`);
        if (attempt < retries) {
          console.warn(`      retrying in ${wait / 1000}s ...`);
          await sleep(wait);
        }
      }
    }
    console.warn(`    ! exhausted ${endpoint}, falling through to next mirror`);
  }
  throw new Error(`all endpoints failed; last error: ${lastErr?.message}`);
}

// ---------------------------------------------------------------------------
// Summaries (printed + stored in _manifest.json so we can craft Task 2 filters)
// ---------------------------------------------------------------------------
function countByType(data) {
  const by = { node: 0, way: 0, relation: 0 };
  for (const el of data.elements ?? []) by[el.type] = (by[el.type] ?? 0) + 1;
  return { total: (data.elements ?? []).length, ...by };
}

function tagHistogram(elements, keys) {
  const hist = Object.fromEntries(keys.map((k) => [k, {}]));
  for (const el of elements) {
    if (!el.tags) continue;
    for (const k of keys) {
      const v = el.tags[k];
      if (v != null) hist[k][String(v)] = (hist[k][String(v)] ?? 0) + 1;
    }
  }
  return hist;
}

function editDateRange(elements) {
  let min = null;
  let max = null;
  for (const el of elements) {
    if (!el.timestamp) continue;
    if (min === null || el.timestamp < min) min = el.timestamp;
    if (max === null || el.timestamp > max) max = el.timestamp;
  }
  return { earliest: min, latest: max };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bbox = resolveBbox(args.bbox);
  const endpoints = args.endpoint ? [args.endpoint] : DEFAULT_ENDPOINTS;
  const outDir = args.out ? args.out : join(ROOT, 'data', 'osm_raw');
  const queries = buildQueries({ strict: args.strict, bbox });

  console.log(`Trotro Guide — OSM extraction (${args.strict ? 'STRICT/prompt' : 'robust/bbox'} mode)`);
  console.log(`  bbox (s,w,n,e): ${bbox.join(', ')}`);
  console.log(`  endpoints:      ${endpoints.join(', ')}`);
  console.log(`  output:         ${outDir}\n`);

  if (args.dryRun) {
    for (const [name, q] of Object.entries(queries)) {
      console.log(`--- ${name}.json query ---\n${q}\n`);
    }
    console.log('(dry run — no network calls made)');
    return;
  }

  mkdirSync(outDir, { recursive: true });

  const manifest = {
    generatedAt: new Date().toISOString(),
    mode: args.strict ? 'strict' : 'robust',
    bbox: { south: bbox[0], west: bbox[1], north: bbox[2], east: bbox[3] },
    license: LICENSE,
    attribution: ATTRIBUTION,
    source: 'https://www.openstreetmap.org/copyright',
    note: 'Raw OSM scaffold (ODbL). Treasure map only — do NOT copy into core.* / CorePack.',
    queries,
    files: {},
  };

  // Tag keys worth profiling — these answer "what did AccraMobile actually tag?"
  const STOP_KEYS = ['highway', 'public_transport', 'bus', 'official_status', 'name', 'ref', 'network', 'operator', 'alt_name', 'loc_name'];
  const ROUTE_KEYS = ['route', 'route_master', 'bus', 'official_status', 'ref', 'name', 'from', 'to', 'network', 'operator', 'colour', 'frequency', 'charge', 'duration'];
  const LANDMARK_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'religion', 'name'];

  let anyFailure = false;

  for (const [name, query] of Object.entries(queries)) {
    console.log(`> fetching ${name} ...`);
    try {
      const { text, data, endpoint } = await overpass(query, { endpoints });
      const file = join(outDir, `${name}.json`);
      writeFileSync(file, text); // verbatim — true raw store

      const counts = countByType(data);
      const relsOnly = (data.elements ?? []).filter((e) => e.type === 'relation');
      // stops & landmarks profile ALL elements; route queries profile relations only.
      const isNodeSet = name === 'stops' || name === 'landmarks';
      const taggedEls = isNodeSet ? (data.elements ?? []) : relsOnly;
      const histKeys = name === 'landmarks' ? LANDMARK_KEYS : name === 'stops' ? STOP_KEYS : ROUTE_KEYS;

      manifest.files[`${name}.json`] = {
        endpoint,
        bytes: Buffer.byteLength(text),
        counts,
        osmTimestampBase: data.osm3s?.timestamp_osm_base ?? null, // freshness of the OSM extract
        elementEditRange: editDateRange(isNodeSet ? data.elements ?? [] : relsOnly),
        tagHistogram: tagHistogram(taggedEls, histKeys),
      };

      const fresh = manifest.files[`${name}.json`].elementEditRange;
      console.log(
        `  ok ${name}.json — ${counts.total} elements ` +
          `(nodes ${counts.node}, ways ${counts.way}, relations ${counts.relation}), ` +
          `${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`,
      );
      if (fresh.earliest) console.log(`     last-edited range: ${fresh.earliest} → ${fresh.latest}`);
      if (counts.total === 0) {
        console.warn(`     WARNING: 0 elements — tagging/area may differ; try --strict or widen --bbox`);
      }
    } catch (err) {
      anyFailure = true;
      manifest.files[`${name}.json`] = { error: String(err.message ?? err) };
      console.error(`  FAILED ${name}: ${err.message ?? err}`);
    }
    await sleep(1500); // be polite to the shared API between queries
  }

  writeFileSync(join(outDir, '_manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(outDir, 'ATTRIBUTION.txt'), attributionText());

  // Print the tag histograms so we can SEE the real AccraMobile tagging and
  // design the precise Task 2 filter (e.g. is it bus=unofficial or
  // official_status=unofficial? which operator/network values exist?).
  const routeFile = manifest.files['routes.json'];
  if (routeFile && !routeFile.error) {
    console.log('\nRoute relation tag distribution (top values):');
    printHist(routeFile.tagHistogram, ['route', 'bus', 'official_status', 'network', 'operator']);
  }
  const stopFile = manifest.files['stops.json'];
  if (stopFile && !stopFile.error) {
    console.log('\nStop tag distribution (top values):');
    printHist(stopFile.tagHistogram, ['highway', 'public_transport', 'bus', 'official_status']);
  }
  const landmarkFile = manifest.files['landmarks.json'];
  if (landmarkFile && !landmarkFile.error) {
    console.log('\nLandmark tag distribution (top values):');
    printHist(landmarkFile.tagHistogram, ['amenity', 'shop', 'tourism', 'leisure']);
  }

  console.log(`\nWrote ${outDir}\\_manifest.json and ATTRIBUTION.txt`);
  if (anyFailure) {
    console.error('\nOne or more queries failed. Re-run, or pass --endpoint to pin a working mirror.');
    process.exit(1);
  }
  console.log('Done. Next: node scripts/osm-treasure-map.mjs (Task 2) once you verify these counts look sane.');
}

function printHist(hist, keys) {
  for (const k of keys) {
    const entries = Object.entries(hist[k] ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (entries.length) console.log(`  ${k}: ${entries.map(([v, c]) => `${v}=${c}`).join(', ')}`);
  }
}

function attributionText() {
  return [
    'This directory contains data derived from OpenStreetMap.',
    '',
    `${ATTRIBUTION}.  Licensed under the Open Database License (ODbL) v1.0.`,
    'https://www.openstreetmap.org/copyright   |   https://opendatacommons.org/licenses/odbl/1-0/',
    '',
    'Provenance: AccraMobile3 (2017, Jungle Bus + AFD + OSM Ghana) and GUMAP (2020-2022)',
    'trotro routes & stops across Greater Accra.',
    '',
    'LICENSE FIREWALL — READ THIS:',
    '  This is SCAFFOLD ("treasure map") data. It MUST remain in the ODbL parking lot',
    '  (data/osm_raw/ on disk; the osm_mirror schema in the DB). Do NOT copy geometry,',
    '  names, or tags from here into the proprietary core dataset or the shipped CorePack.',
    '  core.* references OSM only by osm_ref text, and only AFTER independent field',
    '  verification. Keeping these separate is what makes the core dataset legally',
    '  non-derived and therefore sellable. See LICENSE-BOUNDARY.md.',
    '',
  ].join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
