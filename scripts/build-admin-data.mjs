// ============================================================================
// PHASE 2 (data) — build the lean OSM dataset the admin dashboard reads.
// ============================================================================
// Reads the raw Overpass dumps (data/osm_raw/) and writes a compact, dashboard-
// shaped JSON to public/admin/osm-data.json (served as a static asset, fetched
// client-side — keeps the admin page offline-first with NO backend / Supabase).
//
// This is still ODbL scaffold: it shows the operator WHERE to verify; it is
// never the proprietary product. Run locally (NOT in the Vercel build, since
// data/ is .vercelignore'd) then deploy:  npm run build:admin
//
// Shape:
//   { generatedAt, attribution, license, summary,
//     neighborhoods:[{name,routeCount}],
//     stops:[{ref,name,lat,lng,edited,bucket,routes:[ref],hood}],
//     routes:[{ref,relRef,name,from,to,operator,bucket,stops:[stopRef]}],
//     stopIndex:{ ref: {name,lat,lng,bucket} } }  // covers every route-member stop

import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'osm_raw');
const OUT_DIR = join(ROOT, 'public', 'admin');
const OUT = join(OUT_DIR, 'osm-data.json');

const NOW = Date.now();
const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const ATTRIBUTION = '© OpenStreetMap contributors';
const LICENSE = 'ODbL-1.0';

const readJson = (n) => JSON.parse(readFileSync(join(RAW, n), 'utf8'));
const readJsonSafe = (n) => {
  try { return JSON.parse(readFileSync(join(RAW, n), 'utf8')); } catch { return null; }
};

// Collapse an OSM landmark's tags to one coarse category for the popup label/icon.
function landmarkType(tags = {}) {
  const a = tags.amenity;
  if (a === 'marketplace') return 'market';
  if (a === 'fuel') return 'fuel';
  if (a === 'hospital' || a === 'clinic') return 'hospital';
  if (a === 'place_of_worship') {
    if (tags.religion === 'christian') return 'church';
    if (tags.religion === 'muslim') return 'mosque';
    return 'worship';
  }
  if (a === 'university' || a === 'college' || a === 'library') return 'school';
  if (a === 'bank') return 'bank';
  if (a === 'police' || a === 'fire_station' || a === 'courthouse') return 'civic';
  if (a === 'bus_station') return 'station';
  if (a === 'cinema' || a === 'theatre') return 'cinema';
  if (a === 'fast_food') return 'food';
  if (a === 'townhall') return 'civic';
  if (tags.shop === 'mall') return 'mall';
  if (tags.shop) return 'shop';
  if (tags.tourism === 'hotel') return 'hotel';
  if (tags.tourism) return 'landmark';
  if (tags.leisure === 'stadium') return 'stadium';
  return 'landmark';
}

// Landmark elements can be nodes (lat/lon) or ways/relations (center.lat/lon).
function landmarkPoint(el) {
  if (el.lat != null && el.lon != null) return { lat: el.lat, lng: el.lon };
  if (el.center) return { lat: el.center.lat, lng: el.center.lon };
  return null;
}

// Freshness buckets the admin filters on.
function bucket(ts) {
  if (!ts) return 'ghost';
  const ageY = (NOW - Date.parse(ts)) / YEAR_MS;
  if (ageY < 2) return 'fresh';
  if (ageY <= 5) return 'stale';
  return 'verystale';
}

function deriveRef(tags) {
  if (tags.ref) return String(tags.ref);
  const m = (tags.name || '').match(/trotro\s+([0-9a-z]+)/i);
  return m ? m[1] : '';
}
function isTrotro(tags) {
  const net = tags.network || '';
  if (net === 'trô trô' || net === 'wikidata:Q2454552') return true;
  if (tags.bus === 'unofficial') return true;
  return /^tro\s*tro|^trotro/i.test(tags.name || '');
}

function main() {
  const stopsRaw = readJson('stops.json');
  const routesRaw = readJson('routes.json');

  const nodeMap = new Map();
  for (const n of routesRaw.elements) if (n.type === 'node') nodeMap.set(n.id, n);
  for (const n of stopsRaw.elements) nodeMap.set(n.id, n); // stops.json wins (has tags + meta)
  const relations = routesRaw.elements.filter((e) => e.type === 'relation');

  // stop -> set of route refs that pass through it; routes -> ordered stop refs
  const refsByStop = new Map();
  const routes = [];
  for (const rel of relations) {
    const tags = rel.tags ?? {};
    const ref = deriveRef(tags);
    const stopRefs = [];
    for (const m of rel.members ?? []) {
      if (m.type !== 'node') continue;
      if (m.role && !['platform', 'stop', ''].includes(m.role)) continue;
      stopRefs.push(`node/${m.ref}`);
      if (ref) {
        if (!refsByStop.has(m.ref)) refsByStop.set(m.ref, new Set());
        refsByStop.get(m.ref).add(ref);
      }
    }
    routes.push({
      ref,
      relRef: `relation/${rel.id}`,
      name: tags.name ?? '(unnamed route)',
      from: (tags.from ?? '').trim(),
      to: (tags.to ?? '').trim(),
      operator: tags.operator ?? null,
      trotro: isTrotro(tags),
      bucket: bucket(rel.timestamp),
      stops: stopRefs,
    });
  }

  // stopIndex covers every node referenced (named stops + route-member-only nodes)
  const stopIndex = {};
  const ensureIndex = (id) => {
    const key = `node/${id}`;
    if (stopIndex[key]) return stopIndex[key];
    const n = nodeMap.get(id);
    const rec = {
      name: n?.tags?.name ?? null,
      lat: n?.lat ?? null,
      lng: n?.lon ?? null,
      bucket: bucket(n?.timestamp),
    };
    stopIndex[key] = rec;
    return rec;
  };
  for (const r of routes) for (const sr of r.stops) ensureIndex(Number(sr.split('/')[1]));

  // primary stop list = all extracted stops (named, with coords + meta)
  const stops = stopsRaw.elements.map((n) => {
    ensureIndex(n.id);
    return {
      ref: `node/${n.id}`,
      name: n.tags?.name ?? null,
      lat: n.lat,
      lng: n.lon,
      edited: n.timestamp ?? null,
      bucket: bucket(n.timestamp),
      routes: [...(refsByStop.get(n.id) ?? [])].sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0)),
      hood: null, // filled below
    };
  });

  // Neighborhood list (trotro routes only) + centroids from terminal stops.
  const hoodRoutes = new Map(); // name -> count of distinct routes touching it
  const hoodPts = new Map(); // name -> {sumLat,sumLng,n}
  const touch = (name, stopRef, relRef) => {
    if (!name) return;
    if (!hoodRoutes.has(name)) hoodRoutes.set(name, new Set());
    hoodRoutes.get(name).add(relRef);
    const s = stopIndex[stopRef];
    if (s && s.lat != null) {
      if (!hoodPts.has(name)) hoodPts.set(name, { sumLat: 0, sumLng: 0, n: 0 });
      const p = hoodPts.get(name);
      p.sumLat += s.lat;
      p.sumLng += s.lng;
      p.n += 1;
    }
  };
  for (const r of routes) {
    if (!r.trotro || !r.stops.length) continue;
    touch(r.from, r.stops[0], r.relRef);
    touch(r.to, r.stops[r.stops.length - 1], r.relRef);
  }
  const neighborhoods = [...hoodRoutes.entries()]
    .map(([name, set]) => ({ name, routeCount: set.size }))
    .sort((a, b) => b.routeCount - a.routeCount || a.name.localeCompare(b.name));

  const centroids = [...hoodPts.entries()]
    .filter(([, p]) => p.n > 0)
    .map(([name, p]) => ({ name, lat: p.sumLat / p.n, lng: p.sumLng / p.n }));

  // Assign each stop to nearest neighborhood centroid (squared deg distance; fine at city scale).
  for (const s of stops) {
    if (s.lat == null || !centroids.length) continue;
    let best = null;
    let bestD = Infinity;
    for (const c of centroids) {
      const d = (s.lat - c.lat) ** 2 + (s.lng - c.lng) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c.name;
      }
    }
    s.hood = best;
  }

  // Navigation landmarks (optional — only present if the extract pulled them).
  // ODbL scaffold, same as everything else here. The beta pack builder decides
  // which of these actually ship (near a route line) and keeps them OSM-attributed.
  const landmarksRaw = readJsonSafe('landmarks.json');
  const landmarks = [];
  if (landmarksRaw?.elements?.length) {
    for (const el of landmarksRaw.elements) {
      const tags = el.tags ?? {};
      if (!tags.name) continue;
      const pt = landmarkPoint(el);
      if (!pt) continue;
      landmarks.push({
        ref: `${el.type}/${el.id}`,
        name: tags.name,
        local: tags.alt_name || tags.loc_name || null,
        type: landmarkType(tags),
        lat: pt.lat,
        lng: pt.lng,
        edited: el.timestamp ?? null,
      });
    }
  }

  const tally = (arr, key) => arr.reduce((m, x) => ((m[x[key]] = (m[x[key]] ?? 0) + 1), m), {});
  const fb = tally(stops, 'bucket');
  const summary = {
    stops: stops.length,
    named: stops.filter((s) => s.name).length,
    routes: routes.length,
    trotroRoutes: routes.filter((r) => r.trotro).length,
    neighborhoods: neighborhoods.length,
    landmarks: landmarks.length,
    fresh: fb.fresh ?? 0,
    stale: fb.stale ?? 0,
    verystale: fb.verystale ?? 0,
    ghost: fb.ghost ?? 0,
  };

  const data = {
    generatedAt: new Date(NOW).toISOString(),
    attribution: ATTRIBUTION,
    license: LICENSE,
    note: 'ODbL scaffold for internal fieldwork planning. Never shown in the public app; never sold.',
    summary,
    neighborhoods,
    stops,
    routes,
    landmarks,
    stopIndex,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify(data));
  const kb = (statSync(OUT).size / 1024).toFixed(0);
  console.log('admin data built:');
  console.log(`  file: ${OUT} (${kb} KB)`);
  console.log(`  stops: ${summary.stops} (named ${summary.named}) | routes: ${summary.routes} (trotro ${summary.trotroRoutes}) | areas: ${summary.neighborhoods} | landmarks: ${summary.landmarks}`);
  console.log(`  freshness: fresh ${summary.fresh}, stale ${summary.stale}, very-stale ${summary.verystale}, ghost ${summary.ghost}`);
  console.log(`  top areas: ${neighborhoods.slice(0, 6).map((h) => `${h.name}(${h.routeCount})`).join(', ')}`);
}

main();
