// ============================================================================
// PHASE 4.2 (+ new-stops) — Build the shippable CorePack from VERIFIED data.
// ============================================================================
// Reads data/core_verified.json (from promote — verified OSM stops AND brand-new
// fieldwork stops) and an OPTIONAL route-definition file, and writes a versioned
// CorePack to public/core-pack/. Never reads osm_mirror / data/osm_raw.
//
// Routes are assembled from the CURRENT stop sequence:
//   * data/routes.json (optional): per route { name, ref, mateShout,
//       stops:[osm_refs in order] } — the verified OSM backbone.
//   * NEW stops auto-insert into their route by `route_ref` + `sequence`.
// The polyline is synthesized from YOUR stop coordinates and per-stop cumulative
// distM is computed from it, so the on-board invariant holds by construction.
//
// Route changes (core_verified.routeChanges) are written to
// data/route-changes-review.json for YOUR curation — NEVER shipped in the pack.
//
//   node scripts/build-core-pack-from-verified.mjs [--core data/core_verified.json] [--routes data/routes.json]

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REVIEW = join(ROOT, 'data', 'route-changes-review.json');

function parseArgs(argv) {
  const a = { core: join(ROOT, 'data', 'core_verified.json'), routes: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--core') a.core = argv[++i];
    else if (argv[i] === '--routes') a.routes = argv[++i];
  }
  return a;
}

function encodeSigned(num) {
  let sgn = num < 0 ? ~(num << 1) : num << 1;
  let out = '';
  while (sgn >= 0x20) { out += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63); sgn >>= 5; }
  out += String.fromCharCode(sgn + 63);
  return out;
}
function encode(coords, precision = 6) {
  const factor = 10 ** precision;
  const r = (v) => Math.round(v * factor);
  let prevLat = 0, prevLng = 0, out = '';
  for (const [lat, lng] of coords) { const a = r(lat), b = r(lng); out += encodeSigned(a - prevLat) + encodeSigned(b - prevLng); prevLat = a; prevLng = b; }
  return out;
}
function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000, t = (d) => (d * Math.PI) / 180;
  const dLat = t(bLat - aLat), dLng = t(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(t(aLat)) * Math.cos(t(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.core)) { console.error(`No ${args.core}. Run scripts/promote-verified-to-core.mjs first.`); process.exit(1); }
  const core = JSON.parse(readFileSync(args.core, 'utf8'));
  const coreStops = core.stops || [];
  if (!coreStops.length) { console.error('No verified stops to build from.'); process.exit(1); }

  const byOsmRef = new Map(coreStops.filter((s) => s.osmRef).map((s) => [s.osmRef, s]));
  const routeIdsByStop = new Map(coreStops.map((s) => [s.id, new Set()]));

  // --- assemble routes from the CURRENT stop sequence ---
  const routeDefs = args.routes && existsSync(args.routes) ? JSON.parse(readFileSync(args.routes, 'utf8')) : [];
  const meta = new Map();    // ref -> {name, mateShout}
  const entries = new Map(); // ref -> [{stop, pos, isNew}]
  let missingRefs = 0;
  const add = (ref, stop, pos, isNew) => { if (!entries.has(ref)) entries.set(ref, []); entries.get(ref).push({ stop, pos, isNew }); };

  routeDefs.forEach((def, idx) => {
    const ref = def.ref != null ? String(def.ref) : `idx${idx}`;
    meta.set(ref, { name: def.name || `Route ${def.ref ?? idx}`, mateShout: def.mateShout || '' });
    (def.stops || []).forEach((osmRef, i) => { const s = byOsmRef.get(osmRef); if (s) add(ref, s, i + 1, false); else missingRefs += 1; });
  });
  for (const s of coreStops) {
    if (!s.isNew || !s.routeRef) continue;
    if (!meta.has(s.routeRef)) meta.set(s.routeRef, { name: `Route ${s.routeRef}`, mateShout: s.mateShout || '' });
    add(s.routeRef, s, s.sequence ?? 9999, true);
  }

  const routes = [];
  for (const [ref, list] of entries) {
    list.sort((a, b) => a.pos - b.pos);
    // drop consecutive duplicate stop ids (avoid zero-length segments)
    const seq = [];
    for (const e of list) if (!seq.length || seq[seq.length - 1].stop.id !== e.stop.id) seq.push(e);
    if (seq.length < 2) continue;
    const coords = seq.map((e) => [e.stop.lat, e.stop.lng]);
    const m = meta.get(ref);
    const mateShout = m.mateShout || seq.map((e) => e.stop.mateShout).find(Boolean) || '';
    let cum = 0;
    const stops = seq.map((e, i) => {
      if (i > 0) cum += haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
      return {
        stopId: e.stop.id, seq: i + 1, distM: Math.round(cum),
        board: i === 0 ? `Board at ${e.stop.name}; the mate shouts "${mateShout}"` : null,
        alight: i === seq.length - 1 ? `Tell the mate: "${e.stop.name}, bus stop!"` : null,
      };
    });
    const id = ref.startsWith('idx') ? slug(m.name) || ref : `r-${ref}`;
    for (const e of seq) routeIdsByStop.get(e.stop.id)?.add(id);
    routes.push({ id, name: m.name, mateShout, polyline: encode(coords, 6), stops });
  }

  // --- stops + synonyms ---
  const stops = coreStops.map((s) => ({
    id: s.id, name: s.name, aliases: s.aliases || [], lat: s.lat, lng: s.lng,
    routeIds: [...(routeIdsByStop.get(s.id) || [])], landmark: null,
  }));
  const synonyms = [];
  const seen = new Set();
  for (const s of coreStops) {
    const canonical = fold(s.name);
    for (const al of s.aliases || []) {
      const token = fold(al);
      if (token && token !== canonical && !seen.has(token)) { seen.add(token); synonyms.push({ token, canonical }); }
    }
  }

  const lats = stops.map((s) => s.lat), lngs = stops.map((s) => s.lng);
  const bbox = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];

  const version = Date.now();
  const pack = { version, bbox, stops, routes, landmarks: [], neighborhoods: [], synonyms };
  const body = JSON.stringify(pack);
  const bytes = Buffer.byteLength(body, 'utf8');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const dir = join(ROOT, 'public', 'core-pack', `v${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'accra-core.json'), body);
  writeFileSync(join(ROOT, 'public', 'core-pack', 'manifest.json'), JSON.stringify({ version, url: `/core-pack/v${version}/accra-core.json`, bytes, sha256 }));

  // --- route changes -> review file (NOT shipped) ---
  const routeChanges = core.routeChanges || [];
  if (routeChanges.length) {
    writeFileSync(REVIEW, JSON.stringify({ note: 'Operator-reported route changes. Review, then update data/routes.json / re-verify before they reach the pack. NOT shipped to users.', generatedAt: new Date().toISOString(), routeChanges }, null, 2));
  }

  const nNew = coreStops.filter((s) => s.isNew).length;
  console.log(`Verified CorePack v${version}:`);
  console.log(`  ${stops.length} stop(s) (${nNew} new), ${routes.length} route(s), ${synonyms.length} synonym(s), ${(bytes / 1024).toFixed(1)} KB`);
  if (missingRefs) console.warn(`  ⚠ ${missingRefs} route stop ref(s) not among verified stops — verify those first.`);
  if (routeChanges.length) console.log(`  ⚑ ${routeChanges.length} route change(s) → ${REVIEW} (review before applying)`);
  if (!routes.length) console.warn('  ⚠ no routes — search works, boarding shows "not mapped yet".');
  if (bytes > 1_200_000) console.warn('  ⚠ pack > 1.2 MB — prune before shipping on metered data.');
  console.log('  wrote public/core-pack/manifest.json. Deploy with: vercel --prod');
}

main();
