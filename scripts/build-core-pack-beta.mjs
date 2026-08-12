// ============================================================================
// BETA STATUS MODEL — build TWO CorePacks (firewall-safe, Option 1).
// ============================================================================
// The proprietary `core` schema is NEVER touched by OSM. Instead we MERGE at
// build time:
//
//   BETA pack   (public app)  = OSM beta data (status:'beta', ODbL-attributed)
//                               + verified core data (status:'verified')
//               -> public/core-pack/v<ts>/accra-core.json (+ manifest.json)
//
//   VERIFIED pack (future B2B) = ONLY verified core data, OSM-free, proprietary
//               -> data/core-pack-verified.json  (NOT served, the sellable asset)
//
// Sources:
//   public/admin/osm-data.json   ODbL scaffold parsed by build-admin-data.mjs
//   data/core_verified.json      proprietary fieldwork (from promote) — optional
//   data/routes.json             verified route backbone — optional
//
// Why this keeps the sale clean: the verified pack is assembled from `core` ONLY,
// which was independently field-collected. OSM lives in the beta pack alone, a
// transient public artifact carrying its ODbL attribution. See ATTRIBUTION.txt.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OSM = join(ROOT, 'public', 'admin', 'osm-data.json');
const VERIFIED_CORE = join(ROOT, 'data', 'core_verified.json');
const ROUTES_DEF = join(ROOT, 'data', 'routes.json');
const ROUTE_OVERRIDES = join(ROOT, 'data', 'route-overrides.json'); // field-verified corrections to OSM route metadata, keyed by relRef
const PACK_DIR = join(ROOT, 'public', 'core-pack');
const VERIFIED_OUT = join(ROOT, 'data', 'core-pack-verified.json');

const ATTRIBUTION = '© OpenStreetMap contributors';
const LICENSE = 'ODbL-1.0';
const DEDUP_M = 60; // a verified stop within this radius (same folded name) supersedes its beta twin
const STOP_DEDUP_M = 250; // OSM beta stops with the same folded name within this radius are the same physical stop

// --- polyline6 + geo helpers (same algorithms as the other pack scripts) ----
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
// Distance (m) from point P to segment A→B, via a local equirectangular
// projection centred on P (accurate to <1% at city scale / segment lengths).
function distPointToSegM(plat, plng, alat, alng, blat, blng) {
  const mLat = 111320, mLng = 111320 * Math.cos((plat * Math.PI) / 180);
  const ax = (alng - plng) * mLng, ay = (alat - plat) * mLat;
  const bx = (blng - plng) * mLng, by = (blat - plat) * mLat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? -(ax * dx + ay * dy) / len2 : 0; // P is the origin (0,0)
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(cx, cy);
}
const LANDMARK_NEAR_M = 150; // ship a landmark only if it's within this of some trotro line
const LANDMARK_DEDUP_M = 120; // same-name landmarks (node + way of one feature) collapse to one
const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const r5 = (v) => Math.round(v * 1e5) / 1e5; // ~1.1 m — plenty for walking/boarding, trims pack bytes
// Build a route-stop, omitting null board/alight keys (×12k members = big saving).
const rstop = (stopId, seq, distM, board, alight, status) => {
  const o = { stopId, seq, distM };
  if (board) o.board = board;
  if (alight) o.alight = alight;
  if (status) o.status = status;
  return o;
};

// ---------------------------------------------------------------------------
// BETA portion — from OSM (ODbL). Every record tagged status:'beta'.
// ---------------------------------------------------------------------------
function buildOsmBeta() {
  if (!existsSync(OSM)) {
    console.warn(`  ⚠ ${OSM} missing — run "npm run build:admin" first. Beta pack will have no OSM data.`);
    return { stops: new Map(), routes: [] };
  }
  const osm = JSON.parse(readFileSync(OSM, 'utf8'));
  // Field-verified corrections to OSM route metadata (mate shout / display name),
  // keyed by OSM relation ref. Lets a wrong route field be fixed without editing
  // the OSM mirror; an absent file means no overrides (identical to plain OSM).
  const overrides = existsSync(ROUTE_OVERRIDES)
    ? JSON.parse(readFileSync(ROUTE_OVERRIDES, 'utf8')).routes || {}
    : {};
  let overridden = 0;
  const sid = (ref) => `osm-${String(ref).split('/')[1]}`;

  const stops = new Map(); // id -> PackStop
  const routeIdsByStop = new Map();
  const addStop = (ref, name, lat, lng) => {
    const id = sid(ref);
    // aliases stay [] — the name itself is indexed, so [name] would just duplicate bytes.
    if (!stops.has(id)) stops.set(id, { id, name: name || '', aliases: [], lat: r5(lat), lng: r5(lng), routeIds: [], status: 'beta' });
    return id;
  };

  const routes = [];
  const routeLines = []; // [[lat,lng],...][] — geometry for the near-line landmark filter
  for (const r of osm.routes) {
    if (!r.trotro) continue;
    // join ordered members -> coords (skip members without coords / consecutive dupes)
    const seq = [];
    for (const ref of r.stops) {
      const s = osm.stopIndex[ref];
      if (!s || s.lat == null || s.lng == null) continue;
      if (seq.length && seq[seq.length - 1].ref === ref) continue;
      seq.push({ ref, name: s.name, lat: s.lat, lng: s.lng });
    }
    if (seq.length < 2) continue;

    const rid = `osm-r-${String(r.relRef).split('/')[1]}`;
    const coords = seq.map((e) => [e.lat, e.lng]);
    const ov = overrides[r.relRef] || {};
    if (ov.shout != null || ov.name != null) overridden += 1;
    // Mate shout = the OSM destination tag + "!", UNLESS a field override supplies
    // the real shout (e.g. the local "Dodowa!" instead of the far terminus "Ministries!").
    const shoutSrc = ov.shout != null ? ov.shout : r.to;
    const mateShout = shoutSrc ? `${shoutSrc}!` : '';
    let cum = 0;
    const stopList = seq.map((e, i) => {
      if (i > 0) cum += haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
      const stopId = addStop(e.ref, e.name, e.lat, e.lng);
      if (!routeIdsByStop.has(stopId)) routeIdsByStop.set(stopId, new Set());
      routeIdsByStop.get(stopId).add(rid);
      const nm = e.name || 'this stop';
      return rstop(
        stopId, i + 1, Math.round(cum),
        i === 0 ? `Board at ${nm}${mateShout ? `; the mate shouts "${mateShout}"` : ''}` : null,
        i === seq.length - 1 ? `Tell the mate: "${nm}!"` : null,
      );
    });
    routes.push({ id: rid, name: ov.name || r.name || `Route ${r.ref || ''}`.trim(), ref: r.ref || '', mateShout, polyline: encode(coords, 6), stops: stopList, status: 'beta' });
    routeLines.push(coords);
  }

  // Standalone named stops (searchable even if not on an included route).
  for (const s of osm.stops) {
    if (!s.name || s.lat == null || s.lng == null) continue;
    addStop(s.ref, s.name, s.lat, s.lng);
  }
  for (const [id, set] of routeIdsByStop) { const ps = stops.get(id); if (ps) ps.routeIds = [...set]; }

  const merged = dedupeNearbyStops(stops, routes);

  return { stops, routes, dedupCount: merged, routeLines, overridden };
}

// ---------------------------------------------------------------------------
// LANDMARKS (beta only) — keep OSM POIs that sit within LANDMARK_NEAR_M of some
// trotro line, so the pack carries useful "get down at the Shell" cues without
// shipping every POI in Accra. ODbL scaffold → beta pack ONLY (never verified).
// ---------------------------------------------------------------------------
function buildBetaLandmarks(osm, routeLines) {
  const src = Array.isArray(osm.landmarks) ? osm.landmarks : [];
  if (!src.length || !routeLines.length) return [];

  // Per-line bbox (pad ~0.002° ≈ 220m > NEAR_M) so we skip lines a landmark
  // can't possibly be near before touching their segments.
  const PAD = 0.002;
  const lineBoxes = routeLines.map((line) => {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const [la, ln] of line) { if (la < minLat) minLat = la; if (la > maxLat) maxLat = la; if (ln < minLng) minLng = ln; if (ln > maxLng) maxLng = ln; }
    return { minLat: minLat - PAD, maxLat: maxLat + PAD, minLng: minLng - PAD, maxLng: maxLng + PAD };
  });

  const nearAnyLine = (lat, lng) => {
    for (let li = 0; li < routeLines.length; li++) {
      const b = lineBoxes[li];
      if (lat < b.minLat || lat > b.maxLat || lng < b.minLng || lng > b.maxLng) continue;
      const line = routeLines[li];
      for (let i = 0; i < line.length - 1; i++) {
        if (distPointToSegM(lat, lng, line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]) <= LANDMARK_NEAR_M) return true;
      }
    }
    return false;
  };

  const kept = [];
  const seen = []; // {folded, lat, lng} for same-name dedupe
  for (const l of src) {
    if (l.lat == null || l.lng == null || !l.name) continue;
    if (!nearAnyLine(l.lat, l.lng)) continue;
    const f = fold(l.name);
    if (seen.some((s) => s.folded === f && haversineM(s.lat, s.lng, l.lat, l.lng) <= LANDMARK_DEDUP_M)) continue;
    seen.push({ folded: f, lat: l.lat, lng: l.lng });
    const osmId = String(l.ref).split('/')[1] ?? slug(l.name);
    const lm = { id: `osm-l-${osmId}`, name: l.name, lat: r5(l.lat), lng: r5(l.lng) };
    if (l.local) lm.local = l.local;
    if (l.type) lm.type = l.type;
    kept.push(lm);
  }
  return kept;
}

// Same-name OSM stop nodes within STOP_DEDUP_M are the same physical stop —
// OSM tags them as separate nodes per route relation with no clustering, which
// breaks "shared stop = transfer point" detection in planTripOffline(). Merge
// each cluster into one canonical stop (most-connected member wins the id) and
// rewrite every route.stops[].stopId reference accordingly. Same-name stops
// further apart than the radius are left alone — they're genuinely different
// places (e.g. two unrelated "Atomic First" stops 6.7km apart).
function dedupeNearbyStops(stops, routes) {
  const byName = new Map();
  for (const s of stops.values()) {
    if (!s.name || !s.name.trim()) continue;
    const key = fold(s.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(s);
  }

  const remap = new Map(); // superseded stop id -> canonical stop id
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const parent = new Map(group.map((s) => [s.id, s.id]));
    const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (haversineM(group[i].lat, group[i].lng, group[j].lat, group[j].lng) <= STOP_DEDUP_M) union(group[i].id, group[j].id);
      }
    }
    const clusters = new Map();
    for (const s of group) {
      const root = find(s.id);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(s);
    }
    for (const members of clusters.values()) {
      if (members.length < 2) continue;
      members.sort((a, b) => b.routeIds.length - a.routeIds.length || a.id.localeCompare(b.id));
      const canon = members[0];
      const routeIds = new Set(canon.routeIds);
      for (const m of members.slice(1)) {
        for (const rid of m.routeIds) routeIds.add(rid);
        remap.set(m.id, canon.id);
        stops.delete(m.id);
      }
      canon.routeIds = [...routeIds];
    }
  }

  if (remap.size) {
    for (const route of routes) {
      for (const rs of route.stops) {
        const canon = remap.get(rs.stopId);
        if (canon) rs.stopId = canon;
      }
    }
  }
  return remap.size;
}

// ---------------------------------------------------------------------------
// VERIFIED portion — from core_verified.json (+ routes.json). Proprietary.
// Route assembly mirrors build-core-pack-from-verified.mjs.
// ---------------------------------------------------------------------------
function buildVerified() {
  if (!existsSync(VERIFIED_CORE)) return { stops: new Map(), routes: [] };
  const core = JSON.parse(readFileSync(VERIFIED_CORE, 'utf8'));
  const coreStops = core.stops || [];
  if (!coreStops.length) return { stops: new Map(), routes: [] };

  const byOsmRef = new Map(coreStops.filter((s) => s.osmRef).map((s) => [s.osmRef, s]));
  const routeIdsByStop = new Map(coreStops.map((s) => [s.id, new Set()]));
  const routeDefs = existsSync(ROUTES_DEF) ? JSON.parse(readFileSync(ROUTES_DEF, 'utf8')) : [];

  const meta = new Map();
  const entries = new Map();
  const add = (ref, stop, pos, isNew) => { if (!entries.has(ref)) entries.set(ref, []); entries.get(ref).push({ stop, pos, isNew }); };
  routeDefs.forEach((def, idx) => {
    const ref = def.ref != null ? String(def.ref) : `idx${idx}`;
    meta.set(ref, { name: def.name || `Route ${def.ref ?? idx}`, mateShout: def.mateShout || '' });
    (def.stops || []).forEach((osmRef, i) => { const s = byOsmRef.get(osmRef); if (s) add(ref, s, i + 1, false); });
  });
  for (const s of coreStops) {
    if (!s.isNew || !s.routeRef) continue;
    if (!meta.has(s.routeRef)) meta.set(s.routeRef, { name: `Route ${s.routeRef}`, mateShout: s.mateShout || '' });
    add(s.routeRef, s, s.sequence ?? 9999, true);
  }

  const routes = [];
  for (const [ref, list] of entries) {
    list.sort((a, b) => a.pos - b.pos);
    const seq = [];
    for (const e of list) if (!seq.length || seq[seq.length - 1].stop.id !== e.stop.id) seq.push(e);
    if (seq.length < 2) continue;
    const coords = seq.map((e) => [e.stop.lat, e.stop.lng]);
    const m = meta.get(ref);
    const mateShout = m.mateShout || seq.map((e) => e.stop.mateShout).find(Boolean) || '';
    let cum = 0;
    const stops = seq.map((e, i) => {
      if (i > 0) cum += haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
      return rstop(
        e.stop.id, i + 1, Math.round(cum),
        i === 0 ? `Board at ${e.stop.name}; the mate shouts "${mateShout}"` : null,
        i === seq.length - 1 ? `Tell the mate: "${e.stop.name}, bus stop!"` : null,
        'verified',
      );
    });
    const id = ref.startsWith('idx') ? slug(m.name) || ref : `r-${ref}`;
    for (const e of seq) routeIdsByStop.get(e.stop.id)?.add(id);
    routes.push({ id, name: m.name, ref: ref.startsWith('idx') ? '' : ref, mateShout, polyline: encode(coords, 6), stops, status: 'verified' });
  }

  const stops = new Map();
  for (const s of coreStops) {
    stops.set(s.id, {
      id: s.id, name: s.name, aliases: s.aliases || [], lat: r5(s.lat), lng: r5(s.lng),
      routeIds: [...(routeIdsByStop.get(s.id) || [])], status: 'verified',
    });
  }
  return { stops, routes };
}

function bboxOf(stops) {
  const lats = [...stops.values()].map((s) => s.lat);
  const lngs = [...stops.values()].map((s) => s.lng);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}
function synonymsOf(stops) {
  const out = [], seen = new Set();
  for (const s of stops.values()) {
    const canonical = fold(s.name);
    for (const al of s.aliases || []) {
      const token = fold(al);
      if (token && token !== canonical && !seen.has(token)) { seen.add(token); out.push({ token, canonical }); }
    }
  }
  return out;
}
function writePack(pack) {
  const body = JSON.stringify(pack);
  const bytes = Buffer.byteLength(body, 'utf8');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const dir = join(PACK_DIR, `v${pack.version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'accra-core.json'), body);
  writeFileSync(join(PACK_DIR, 'manifest.json'), JSON.stringify({ version: pack.version, url: `/core-pack/v${pack.version}/accra-core.json`, bytes, sha256 }));
  return bytes;
}

function main() {
  const beta = buildOsmBeta();
  const verified = buildVerified();

  // Landmarks are ODbL scaffold → beta pack only. Re-read the OSM source (cheap)
  // and keep the ones sitting on a trotro corridor.
  const betaLandmarks = existsSync(OSM)
    ? buildBetaLandmarks(JSON.parse(readFileSync(OSM, 'utf8')), beta.routeLines ?? [])
    : [];

  // --- MERGE: verified supersedes a nearby beta twin (same folded name) ------
  const merged = new Map(beta.stops);
  const verifiedStopList = [...verified.stops.values()];
  let superseded = 0;
  for (const v of verifiedStopList) {
    const vf = fold(v.name);
    for (const [id, b] of merged) {
      if (b.status !== 'beta') continue;
      if (fold(b.name) === vf && haversineM(v.lat, v.lng, b.lat, b.lng) <= DEDUP_M) { merged.delete(id); superseded += 1; }
    }
    merged.set(v.id, v);
  }
  const mergedRoutes = [...beta.routes, ...verified.routes];

  // --- BETA pack (public) ----------------------------------------------------
  const version = Date.now();
  const betaPack = {
    version,
    attribution: ATTRIBUTION,
    license: LICENSE,
    bbox: merged.size ? bboxOf(merged) : [-0.7, 5.4, 0.3, 6.1],
    stops: [...merged.values()],
    routes: mergedRoutes,
    landmarks: betaLandmarks,
    neighborhoods: [],
    synonyms: synonymsOf(merged),
  };
  const betaBytes = writePack(betaPack);

  // --- VERIFIED pack (sellable, NOT served) — assert OSM-free ----------------
  const vStops = [...verified.stops.values()];
  const leak = vStops.find((s) => s.status !== 'verified' || /^osm-/.test(s.id)) || verified.routes.find((r) => r.status !== 'verified' || /^osm-/.test(r.id));
  if (leak) { console.error('FIREWALL ASSERTION FAILED: OSM/non-verified data in the verified pack:', leak.id); process.exit(1); }
  const verifiedPack = {
    version,
    bbox: vStops.length ? bboxOf(verified.stops) : [-0.7, 5.4, 0.3, 6.1],
    stops: vStops,
    routes: verified.routes,
    landmarks: [],
    neighborhoods: [],
    synonyms: synonymsOf(verified.stops),
  };
  const verifiedBody = JSON.stringify(verifiedPack);
  writeFileSync(VERIFIED_OUT, verifiedBody);

  // --- report ----------------------------------------------------------------
  const betaStops = betaPack.stops.filter((s) => s.status === 'beta').length;
  const named = betaPack.stops.filter((s) => s.name && s.name.trim()).length;
  console.log('Two CorePacks built:');
  console.log(`  BETA   (public)  v${version}: ${betaPack.stops.length} stops (${betaStops} beta, ${named} named), ${betaPack.routes.length} routes, ${betaLandmarks.length} landmarks (near-line ≤${LANDMARK_NEAR_M}m), ${(betaBytes / 1024).toFixed(0)} KB`);
  console.log(`         + ODbL attribution embedded · ${superseded} beta stop(s) superseded by verified · ${beta.dedupCount ?? 0} duplicate OSM stop(s) merged (≤${STOP_DEDUP_M}m, same name)`);
  if (beta.overridden) console.log(`         + ${beta.overridden} OSM route(s) corrected by data/route-overrides.json`);
  console.log(`         -> public/core-pack/manifest.json`);
  console.log(`  VERIFIED (B2B)   v${version}: ${verifiedPack.stops.length} stops, ${verifiedPack.routes.length} routes, ${(Buffer.byteLength(verifiedBody) / 1024).toFixed(1)} KB (OSM-free ✓)`);
  console.log(`         -> ${VERIFIED_OUT} (NOT served)`);
  if (betaBytes > 1_500_000) console.warn(`  ⚠ beta pack ${(betaBytes / 1024 / 1024).toFixed(2)} MB — large for metered data; consider pruning very-stale stops.`);
  if (!vStops.length) console.log('  (no verified data yet — verified pack is empty; beta = OSM only.)');
}

main();
