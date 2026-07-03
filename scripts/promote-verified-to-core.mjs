// ============================================================================
// PHASE 4.1 (+ new-stops) — Promote field data into the PROPRIETARY core schema.
// ============================================================================
// Reads a verification export and emits idempotent SQL + a local core dataset.
// Handles THREE export shapes (backward-compatible):
//   * new admin export   -> { verified_stops:[], new_stops:[], route_changes:[] }
//   * old admin export   -> { verifications: { "node/..": {...} } }
//   * treasure-map HTML  -> { captures: { "rel|node": {...}, "shout|rel": "..." } }
//
// Firewall rules (strict):
//   * core rows get FRESH UUIDs; an OSM node id is NEVER a core key.
//   * core.informal_stops.osm_ref stays NULL; the OSM link lives only in
//     core.provenance.osm_ref ("located against", not "copied from").
//   * VERIFIED stops may fall back to OSM name/geom when field data is missing —
//     those fields are tagged license='ODbL' in provenance (excluded from B2B).
//   * NEW stops are 100% proprietary: osm_ref NULL everywhere, YOUR GPS only.
//     If a new stop has no name or no GPS it is skipped (can't satisfy NOT NULL).
//   * route_changes go to core.route_changes (curation queue), NOT the pack.
//
//   node scripts/promote-verified-to-core.mjs --input <verification.json> [--osm public/admin/osm-data.json]

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_JSON = join(ROOT, 'data', 'core_verified.json');
const OUT_SQL = join(ROOT, 'data', 'promote_to_core.sql');

function parseArgs(argv) {
  const a = { input: null, osm: join(ROOT, 'public', 'admin', 'osm-data.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') a.input = argv[++i];
    else if (argv[i] === '--osm') a.osm = argv[++i];
  }
  if (!a.input) {
    console.error('Usage: node scripts/promote-verified-to-core.mjs --input <verification.json> [--osm <osm-data.json>]');
    process.exit(1);
  }
  return a;
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const sqlText = (s) => (s == null || s === '' ? 'NULL' : q(s));
const sqlInt = (n) => (n == null ? 'NULL' : String(Math.trunc(n)));
const sqlArray = (arr) => (arr && arr.length ? 'ARRAY[' + arr.map((x) => q(x)).join(',') + ']::text[]' : "'{}'::text[]");
const sqlGeog = (lng, lat) => `ST_GeogFromText('SRID=4326;POINT(${lng} ${lat})')`;

// --- normalize any export shape -> { verified, newStops, routeChanges } ---
function normalize(input) {
  if (input.verified_stops || input.new_stops || input.route_changes) {
    return {
      format: 'admin-v2',
      verified: (input.verified_stops || []).map((v) => ({
        osmRef: v.osm_ref, exists: v.exists !== false, mateShout: v.mate_shout || '',
        localName: v.local_name || '', osmName: v.name || null,
        myLat: v.my_lat ?? null, myLng: v.my_lng ?? null, notes: v.notes || '',
      })),
      newStops: (input.new_stops || []).map((s) => ({
        stopId: s.stop_id, name: s.name || '', localName: s.local_name || '', mateShout: s.mate_shout || '',
        boardAlight: s.board_alight || 'both', myLat: s.my_lat ?? null, myLng: s.my_lng ?? null,
        routeRef: String(s.route_ref ?? ''), sequence: s.sequence ?? null, notes: s.notes || '',
      })),
      routeChanges: (input.route_changes || []).map((c) => ({
        routeRef: String(c.route_ref ?? ''), changeTypes: c.change_types || (c.change_type ? [c.change_type] : []),
        description: c.description || '', newTerminal: c.new_terminal || '', oldTerminal: c.old_terminal || '',
        stopsAdded: c.stops_added ?? null, stopsRemoved: c.stops_removed ?? null,
      })),
    };
  }
  if (input.verifications) {
    return {
      format: 'admin-v1',
      verified: Object.entries(input.verifications).map(([osmRef, v]) => ({
        osmRef, exists: v.exists !== false, mateShout: v.mateShout || '', localName: v.localName || '',
        osmName: v.osmName || null, myLat: v.myLat ?? null, myLng: v.myLng ?? null, notes: v.notes || '',
      })),
      newStops: [], routeChanges: [],
    };
  }
  if (input.captures) {
    const shoutByRoute = {};
    for (const [k, val] of Object.entries(input.captures)) if (k.startsWith('shout|')) shoutByRoute[k.slice(6)] = val;
    const verified = [];
    for (const [k, v] of Object.entries(input.captures)) {
      if (k.startsWith('shout|')) continue;
      const [routeRef, stopRef] = k.split('|');
      if (!stopRef) continue;
      verified.push({ osmRef: stopRef, exists: v.exists !== false, mateShout: shoutByRoute[routeRef] || '', localName: '', osmName: null, myLat: null, myLng: null, notes: v.note || '' });
    }
    return { format: 'treasure-map', verified, newStops: [], routeChanges: [] };
  }
  throw new Error('Unrecognized verification format');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = JSON.parse(readFileSync(args.input, 'utf8'));
  const { format, verified, newStops, routeChanges } = normalize(input);

  let osmIndex = {};
  if (existsSync(args.osm)) osmIndex = JSON.parse(readFileSync(args.osm, 'utf8')).stopIndex || {};

  // stable ids across runs
  const prior = existsSync(CORE_JSON) ? JSON.parse(readFileSync(CORE_JSON, 'utf8')) : { stops: [] };
  const idByKey = new Map((prior.stops || []).map((s) => [s.srcKey, s.id]));

  const stops = [];
  const warn = { osmName: 0, osmGeom: 0 };
  let skippedGone = 0, skippedNoData = 0, skippedNewNoData = 0;

  // --- verified existing OSM stops ---
  for (const r of verified) {
    if (!r.exists) { skippedGone += 1; continue; }
    const osm = osmIndex[r.osmRef] || {};
    const fallbackName = r.osmName || osm.name || '';
    const nameSource = r.localName ? 'field' : fallbackName ? 'osm' : null;
    const name = r.localName || fallbackName;
    const hasGps = r.myLat != null && r.myLng != null;
    const geomSource = hasGps ? 'field' : osm.lat != null ? 'osm' : null;
    const lat = hasGps ? r.myLat : osm.lat;
    const lng = hasGps ? r.myLng : osm.lng;
    if (!nameSource || !geomSource) { skippedNoData += 1; continue; }
    if (nameSource === 'osm') warn.osmName += 1;
    if (geomSource === 'osm') warn.osmGeom += 1;
    stops.push({
      id: idByKey.get(r.osmRef) || randomUUID(), srcKey: r.osmRef, osmRef: r.osmRef, isNew: false,
      name, nameSource, aliases: [...new Set([r.localName, fallbackName].filter((x) => x && x !== name))],
      lat: +Number(lat).toFixed(6), lng: +Number(lng).toFixed(6), geomSource,
      mateShout: r.mateShout, boardAlight: null, routeRef: null, sequence: null, notes: r.notes,
      confidence: nameSource === 'field' && geomSource === 'field' ? 0.9 : 0.6,
    });
  }

  // --- NEW stops (purely proprietary, osm_ref NULL) ---
  for (const s of newStops) {
    const hasGps = s.myLat != null && s.myLng != null;
    if (!s.name || !hasGps) { skippedNewNoData += 1; continue; } // new stops MUST have name + YOUR GPS
    const key = 'new:' + s.stopId;
    stops.push({
      id: idByKey.get(key) || randomUUID(), srcKey: key, osmRef: null, isNew: true,
      name: s.name, nameSource: 'field', aliases: [...new Set([s.localName].filter((x) => x && x !== s.name))],
      lat: +Number(s.myLat).toFixed(6), lng: +Number(s.myLng).toFixed(6), geomSource: 'field',
      mateShout: s.mateShout, boardAlight: s.boardAlight, routeRef: s.routeRef, sequence: s.sequence, notes: s.notes,
      confidence: 0.9,
    });
  }

  // --- core_verified.json (consumed by build-core-pack-from-verified) ---
  writeFileSync(CORE_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), sourceFormat: format, stops, routeChanges }, null, 2));

  // --- promote_to_core.sql ---
  const ids = stops.map((s) => q(s.id));
  const out = [];
  out.push('-- Trotro Guide — promote field data -> PROPRIETARY core.');
  out.push(`-- Generated ${new Date().toISOString()} from ${format}. Stops: ${stops.length} (new: ${stops.filter((s) => s.isNew).length}). Route changes: ${routeChanges.length}.`);
  out.push('-- core.informal_stops.osm_ref is always NULL; OSM linkage lives in core.provenance only.');
  out.push('BEGIN;');
  out.push('');
  out.push('-- stops (verified OSM + brand-new; fresh UUID PKs; geom from YOUR GPS where available)');
  for (const s of stops) {
    out.push(
      `INSERT INTO core.informal_stops (id, name, aliases, geom, confidence) VALUES (` +
        `${q(s.id)}, ${q(s.name)}, ${sqlArray(s.aliases)}, ${sqlGeog(s.lng, s.lat)}, ${s.confidence})` +
        ` ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, aliases=EXCLUDED.aliases, geom=EXCLUDED.geom, confidence=EXCLUDED.confidence;`,
    );
  }
  out.push('');
  out.push('-- provenance (idempotent rebuild for these stops)');
  if (ids.length) out.push(`DELETE FROM core.provenance WHERE entity_type='stop' AND entity_id IN (${ids.join(', ')});`);
  for (const s of stops) {
    const note = s.isNew
      ? `NEW stop (route ${s.routeRef || '?'} seq ${s.sequence ?? '?'}, ${s.boardAlight || 'both'})${s.mateShout ? ` shout: ${s.mateShout}` : ''}${s.notes ? ` — ${s.notes}` : ''}`
      : s.notes;
    out.push(
      `INSERT INTO core.provenance (entity_type, entity_id, field, source, license, osm_ref, note) VALUES (` +
        `'stop', ${q(s.id)}, NULL, 'fieldwork', 'proprietary', ${sqlText(s.osmRef)}, ${sqlText(note)});`,
    );
    if (s.nameSource === 'osm')
      out.push(`INSERT INTO core.provenance (entity_type, entity_id, field, source, license, osm_ref, note) VALUES ('stop', ${q(s.id)}, 'name', 'osm', 'ODbL', ${sqlText(s.osmRef)}, 'name from OSM fallback — verify in field');`);
    if (s.geomSource === 'osm')
      out.push(`INSERT INTO core.provenance (entity_type, entity_id, field, source, license, osm_ref, note) VALUES ('stop', ${q(s.id)}, 'geom', 'osm', 'ODbL', ${sqlText(s.osmRef)}, 'geom from OSM fallback — capture your own GPS');`);
  }

  // --- route changes (curation queue; never auto-applied) ---
  if (routeChanges.length) {
    const refs = [...new Set(routeChanges.map((c) => c.routeRef).filter(Boolean))].map(q);
    out.push('');
    out.push('-- route changes for review (replaces prior UNVERIFIED reports for these routes)');
    if (refs.length) out.push(`DELETE FROM core.route_changes WHERE verified = false AND route_ref IN (${refs.join(', ')});`);
    for (const c of routeChanges) {
      const types = c.changeTypes.length ? c.changeTypes : ['unspecified'];
      for (const t of types) {
        out.push(
          `INSERT INTO core.route_changes (route_ref, change_type, description, new_terminal, old_terminal, stops_added, stops_removed, reported_at) VALUES (` +
            `${sqlText(c.routeRef)}, ${q(t)}, ${sqlText(c.description)}, ${sqlText(c.newTerminal)}, ${sqlText(c.oldTerminal)}, ${sqlInt(c.stopsAdded)}, ${sqlInt(c.stopsRemoved)}, now());`,
        );
      }
    }
  }

  out.push('');
  out.push('COMMIT;');
  out.push('');
  writeFileSync(OUT_SQL, out.join('\n'));

  // --- summary ---
  const nNew = stops.filter((s) => s.isNew).length;
  console.log(`Promote (${format}):`);
  console.log(`  promoted: ${stops.length} stop(s) (${stops.length - nNew} verified OSM, ${nNew} NEW)`);
  console.log(`  route changes queued: ${routeChanges.length}`);
  console.log(`  skipped: ${skippedGone} gone, ${skippedNoData} verified w/o name·coords, ${skippedNewNoData} new w/o name·GPS`);
  console.log(`  files: ${OUT_SQL} (${(statSync(OUT_SQL).size / 1024).toFixed(1)} KB), ${CORE_JSON}`);
  if (warn.osmName || warn.osmGeom) console.warn(`  ⚠ OSM fallback (ODbL, not sellable until field-verified): ${warn.osmName} name(s), ${warn.osmGeom} geom(s).`);
  else console.log('  ✓ 100% proprietary: every promoted field used your own name + GPS.');
  console.log('  next: node scripts/build-core-pack-from-verified.mjs [--routes data/routes.json]');
}

main();
