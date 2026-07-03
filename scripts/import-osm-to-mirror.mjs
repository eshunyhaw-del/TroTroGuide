// ============================================================================
// PHASE 1.2 — Import raw OSM (data/osm_raw/) into osm_mirror.osm_features SQL.
// ============================================================================
// Reads the verbatim Overpass dumps from Task 1 and emits idempotent UPSERT SQL
// to data/osm_import.sql. This is the ODbL "parking lot" loader:
//
//   * writes ONLY osm_mirror.* — never touches core.* (license firewall)
//   * stamps every row with ODbL license + attribution + source_url
//   * idempotent: re-running UPSERTs by osm_ref and only updates rows whose
//     content_hash changed (so re-imports are cheap and never duplicate)
//
// Pure Node 18+, zero deps, no Supabase. The .sql file is applied separately
// (Supabase SQL editor / psql / MCP) AFTER db/migrations/0004 has run.
//
//   Run:  node scripts/import-osm-to-mirror.mjs   (or: npm run import:osm)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'osm_raw');
const OUT = join(ROOT, 'data', 'osm_import.sql');

const LICENSE = 'ODbL';
const ATTRIBUTION = '© OpenStreetMap contributors';
const NOW = Date.now();
const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const FRESHNESS_WINDOW_YEARS = 9; // 2017 survey .. today
const BATCH = 200;

const readJson = (name) => JSON.parse(readFileSync(join(RAW, name), 'utf8'));

// 0..100, higher = edited more recently. Linear over the 9-year window.
function freshnessScore(ts) {
  if (!ts) return null;
  const ageY = (NOW - Date.parse(ts)) / YEAR_MS;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - ageY / FRESHNESS_WINDOW_YEARS))));
}

function deriveRef(tags) {
  if (tags.ref) return String(tags.ref);
  const m = (tags.name || '').match(/trotro\s+([0-9a-z]+)/i);
  return m ? m[1] : '';
}

// --- SQL literal helpers ----------------------------------------------------
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"; // escape single quotes
const sqlText = (s) => (s == null ? 'NULL' : q(s));
const sqlTs = (s) => (s == null ? 'NULL' : q(s) + '::timestamptz');
const sqlInt = (n) => (n == null ? 'NULL' : String(n));
const sqlJsonb = (obj) => q(JSON.stringify(obj ?? {})) + '::jsonb';
const sqlTextArray = (arr) =>
  arr && arr.length ? 'ARRAY[' + arr.map((x) => q(x)).join(',') + ']::text[]' : "'{}'::text[]";
function sqlGeomPoint(lng, lat) {
  return `ST_GeomFromText('SRID=4326;POINT(${lng} ${lat})')`;
}
function sqlGeomLine(coords) {
  if (!coords || coords.length < 2) return 'NULL';
  return `ST_GeomFromText('SRID=4326;LINESTRING(${coords.map(([lng, lat]) => `${lng} ${lat}`).join(',')})')`;
}

function contentHash(parts) {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
}

// Greedy assembly of a route's member ways into one LINESTRING. Best-effort:
// orients/flips each segment to maintain continuity (the first segment may need
// flipping). Scaffold geometry only — no phase depends on its precision yet.
function stitchRoute(rel, wayMap, nodeMap) {
  const segs = [];
  for (const m of rel.members || []) {
    if (m.type !== 'way') continue;
    const w = wayMap.get(m.ref);
    if (!w || !w.nodes) continue;
    const pts = w.nodes.map((id) => nodeMap.get(id)).filter(Boolean).map((n) => [n.lon, n.lat]);
    if (pts.length >= 2) segs.push(pts);
  }
  if (!segs.length) return null;
  const d = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  let path = segs[0].slice();
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i];
    const pe = path[path.length - 1];
    const ps = path[0];
    const ss = seg[0];
    const se = seg[seg.length - 1];
    const opts = [
      { k: 'end_fwd', dist: d(pe, ss) },
      { k: 'end_rev', dist: d(pe, se) },
    ];
    if (i === 1) {
      opts.push({ k: 'start_fwd', dist: d(ps, se) }, { k: 'start_rev', dist: d(ps, ss) });
    }
    opts.sort((a, b) => a.dist - b.dist);
    switch (opts[0].k) {
      case 'end_fwd': path = path.concat(seg.slice(1)); break;
      case 'end_rev': path = path.concat(seg.slice().reverse().slice(1)); break;
      case 'start_fwd': path = seg.slice(0, -1).concat(path); break;
      case 'start_rev': path = seg.slice().reverse().slice(0, -1).concat(path); break;
    }
  }
  // round + drop consecutive duplicates
  const out = [];
  for (const p of path) {
    const r = [+p[0].toFixed(6), +p[1].toFixed(6)];
    const last = out[out.length - 1];
    if (!last || last[0] !== r[0] || last[1] !== r[1]) out.push(r);
  }
  return out.length >= 2 ? out : null;
}

function main() {
  const fetchedAtIso = (() => {
    try {
      return readJson('_manifest.json').generatedAt;
    } catch {
      return new Date(NOW).toISOString();
    }
  })();

  const stopsRaw = readJson('stops.json');
  const routesRaw = readJson('routes.json');
  let mastersRaw = { elements: [] };
  try {
    mastersRaw = readJson('route_masters.json');
  } catch {
    /* optional */
  }

  // Node coords: union of route geometry nodes + standalone stop nodes.
  const nodeMap = new Map();
  for (const n of routesRaw.elements) if (n.type === 'node') nodeMap.set(n.id, n);
  for (const n of stopsRaw.elements) if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
  const wayMap = new Map(routesRaw.elements.filter((e) => e.type === 'way').map((w) => [w.id, w]));
  const relations = routesRaw.elements.filter((e) => e.type === 'relation');

  // route_refs per stop id, computed from route membership.
  const refsByStop = new Map();
  for (const rel of relations) {
    const ref = deriveRef(rel.tags || {});
    if (!ref) continue;
    for (const m of rel.members || []) {
      if (m.type !== 'node') continue;
      if (m.role && !['platform', 'stop', ''].includes(m.role)) continue;
      if (!refsByStop.has(m.ref)) refsByStop.set(m.ref, new Set());
      refsByStop.get(m.ref).add(ref);
    }
  }

  // Build feature rows (de-duplicated by osm_ref).
  const rows = new Map();
  const addStop = (node) => {
    const osmRef = `node/${node.id}`;
    if (rows.has(osmRef)) return;
    const tags = node.tags ?? {};
    const lng = node.lon;
    const lat = node.lat;
    const routeRefs = [...(refsByStop.get(node.id) ?? [])].sort();
    rows.set(osmRef, {
      osm_ref: osmRef,
      kind: 'stop',
      tags,
      geom: lng != null && lat != null ? sqlGeomPoint(lng, lat) : 'NULL',
      content_hash: contentHash([osmRef, JSON.stringify(tags), `${lng},${lat}`]),
      last_edit: node.timestamp ?? null,
      freshness_score: freshnessScore(node.timestamp),
      route_refs: routeRefs,
      source_url: `https://www.openstreetmap.org/node/${node.id}`,
    });
  };

  // 1) all extracted stops
  for (const s of stopsRaw.elements) addStop(s);
  // 2) any route-member stop nodes missing from stops.json (coords-only completeness)
  for (const set of [refsByStop])
    for (const id of set.keys()) if (!rows.has(`node/${id}`) && nodeMap.has(id)) addStop(nodeMap.get(id));

  // 3) routes
  for (const rel of relations) {
    const osmRef = `relation/${rel.id}`;
    const tags = rel.tags ?? {};
    const line = stitchRoute(rel, wayMap, nodeMap);
    rows.set(osmRef, {
      osm_ref: osmRef,
      kind: 'route',
      tags,
      geom: sqlGeomLine(line),
      content_hash: contentHash([osmRef, JSON.stringify(tags), line ? JSON.stringify(line) : '']),
      last_edit: rel.timestamp ?? null,
      freshness_score: freshnessScore(rel.timestamp),
      route_refs: deriveRef(tags) ? [deriveRef(tags)] : [],
      source_url: `https://www.openstreetmap.org/relation/${rel.id}`,
    });
  }

  // 4) route_masters
  for (const rel of mastersRaw.elements) {
    const osmRef = `relation/${rel.id}`;
    const tags = rel.tags ?? {};
    rows.set(osmRef, {
      osm_ref: osmRef,
      kind: 'route_master',
      tags,
      geom: 'NULL',
      content_hash: contentHash([osmRef, JSON.stringify(tags), 'master']),
      last_edit: rel.timestamp ?? null,
      freshness_score: freshnessScore(rel.timestamp),
      route_refs: deriveRef(tags) ? [deriveRef(tags)] : [],
      source_url: `https://www.openstreetmap.org/relation/${rel.id}`,
    });
  }

  // --- emit SQL -------------------------------------------------------------
  const all = [...rows.values()];
  const COLS =
    '(osm_ref, kind, tags, geom, content_hash, fetched_at, last_edit, freshness_score, route_refs, license, attribution, source_url)';
  const UPDATE = [
    'kind', 'tags', 'geom', 'content_hash', 'fetched_at', 'last_edit', 'freshness_score', 'route_refs', 'license', 'attribution', 'source_url',
  ]
    .map((c) => `${c}=EXCLUDED.${c}`)
    .join(', ');

  const out = [];
  out.push('-- Trotro Guide — OSM -> osm_mirror import (Phase 1).');
  out.push(`-- ${ATTRIBUTION}. Licensed ODbL (https://opendatacommons.org/licenses/odbl/1-0/).`);
  out.push('-- Source: AccraMobile3 (2017) / GUMAP via OpenStreetMap Overpass.');
  out.push(`-- Generated: ${new Date(NOW).toISOString()} | rows: ${all.length}`);
  out.push('-- SCAFFOLD ONLY. Writes osm_mirror.* exclusively — never core.*.');
  out.push('-- Apply db/migrations/0004_import_osm_mirror.sql first.');
  out.push('');
  out.push('BEGIN;');
  out.push('');

  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    out.push(`INSERT INTO osm_mirror.osm_features`);
    out.push(`  ${COLS}`);
    out.push('VALUES');
    const tuples = batch.map((r) => {
      const vals = [
        sqlText(r.osm_ref),
        sqlText(r.kind),
        sqlJsonb(r.tags),
        r.geom, // already an expression or NULL
        sqlText(r.content_hash),
        sqlTs(fetchedAtIso),
        sqlTs(r.last_edit),
        sqlInt(r.freshness_score),
        sqlTextArray(r.route_refs),
        q(LICENSE),
        q(ATTRIBUTION),
        sqlText(r.source_url),
      ];
      return `  (${vals.join(', ')})`;
    });
    out.push(tuples.join(',\n'));
    out.push('ON CONFLICT (osm_ref) DO UPDATE SET');
    out.push(`  ${UPDATE}`);
    out.push('WHERE osm_mirror.osm_features.content_hash IS DISTINCT FROM EXCLUDED.content_hash;');
    out.push('');
  }

  out.push('COMMIT;');
  out.push('');
  writeFileSync(OUT, out.join('\n'));

  // --- summary --------------------------------------------------------------
  const byKind = {};
  let withGeom = 0;
  let withRefs = 0;
  const fresh = { fresh: 0, aging: 0, stale: 0, unknown: 0 };
  for (const r of all) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    if (r.geom !== 'NULL') withGeom += 1;
    if (r.route_refs.length) withRefs += 1;
    const f = r.freshness_score;
    if (f == null) fresh.unknown += 1;
    else if (f >= 78) fresh.fresh += 1; // ~<2y in a 9y window
    else if (f >= 45) fresh.aging += 1; // ~2-5y
    else fresh.stale += 1;
  }
  const kb = (statSync(OUT).size / 1024).toFixed(0);
  console.log('osm_mirror import SQL generated:');
  console.log(`  file: ${OUT} (${kb} KB)`);
  console.log(`  rows: ${all.length}  ->  ${Object.entries(byKind).map(([k, v]) => `${k}:${v}`).join(', ')}`);
  console.log(`  with geometry: ${withGeom}  |  stops with route_refs: ${withRefs}`);
  console.log(`  freshness (approx): fresh ${fresh.fresh}, aging ${fresh.aging}, stale ${fresh.stale}, unknown ${fresh.unknown}`);
  console.log(`  every row stamped: license='${LICENSE}', attribution='${ATTRIBUTION}'`);
  console.log('  next: apply db/migrations/0004 then run this SQL (Supabase SQL editor / psql).');
}

main();
