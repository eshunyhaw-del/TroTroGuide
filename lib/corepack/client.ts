// Client-side consumption of the Accra Core Pack: fetch and cache it in IndexedDB on first run,
// then load it (and a MiniSearch index) from IndexedDB so search and directions work offline.
// The manifest is checked in the background and the pack swapped when a newer one exists.
// Nothing here sends GPS anywhere; on-board guidance lives in ../onboard/mapmatch.ts.

import MiniSearch, { type SearchResult } from 'minisearch';
import { idbGet, idbPut } from './idb';
import { fold } from '@/lib/geo/text';
import { haversineM } from '@/lib/geo/haversine';
import { decode } from '@/lib/geo/polyline';
import type { CorePack, CorePackManifest, PackLandmark, PackRoute, PackStop, RecordStatus } from './types';

const DB_NAME = 'trotro';
const STORE = 'corepack';
const PACK_KEY = 'accra';

// How far we'll ask a rider to walk to a boarding stop. The product rule is "nearest walkable stop,
// but never more than a 30-minute walk".
export const WALK_PACE_M_PER_MIN = 80;
export const MAX_WALK_MIN = 30;
export const MAX_WALK_M = WALK_PACE_M_PER_MIN * MAX_WALK_MIN; // 2400

type PackRouteStop = PackRoute['stops'][number];

interface SearchDoc {
  id: string;
  type: 'stop' | 'neighborhood' | 'landmark';
  name: string;
  aliases: string; // space-joined (+ synonym expansions)
  display: string;
  lat: number;
  lng: number;
  routeIds: string[];
  status?: RecordStatus;
}

let _pack: CorePack | null = null;
let _mini: MiniSearch<SearchDoc> | null = null;

function buildIndex(pack: CorePack): MiniSearch<SearchDoc> {
  const syn = new Map(pack.synonyms.map((s) => [fold(s.token), s.canonical]));
  const expandAliases = (names: string[]): string => {
    const extra: string[] = [];
    for (const n of names) {
      const f = fold(n);
      const c = syn.get(f);
      if (c) extra.push(c);
    }
    return [...names, ...extra].join(' ');
  };

  const docs: SearchDoc[] = [
    // Only NAMED stops are searchable. The beta pack also carries unnamed route-member stops
    // (needed for boarding/map geometry); they'd pollute search.
    ...pack.stops
      .filter((s) => s.name && s.name.trim())
      .map((s) => ({
        id: s.id, type: 'stop' as const, name: s.name,
        aliases: expandAliases(s.aliases), display: s.name,
        lat: s.lat, lng: s.lng, routeIds: s.routeIds, status: s.status,
      })),
    ...pack.neighborhoods.map((n) => ({
      id: n.id, type: 'neighborhood' as const, name: n.name,
      aliases: expandAliases(n.localNames), display: n.name,
      lat: n.lat, lng: n.lng, routeIds: [] as string[], status: undefined as RecordStatus | undefined,
    })),
    ...pack.landmarks.map((l) => ({
      id: l.id, type: 'landmark' as const, name: l.name,
      aliases: expandAliases(l.local ? [l.local] : []), display: l.name,
      lat: l.lat, lng: l.lng, routeIds: [] as string[], status: undefined as RecordStatus | undefined,
    })),
  ];

  const mini = new MiniSearch<SearchDoc>({
    fields: ['name', 'aliases'],
    storeFields: ['type', 'display', 'lat', 'lng', 'routeIds', 'status'],
    processTerm: (t) => fold(t) || null, // same folding as the server's unaccent
    searchOptions: { prefix: true, fuzzy: 0.2, boost: { name: 2 }, combineWith: 'OR' },
  });
  mini.addAll(docs);
  return mini;
}

/** Load from IndexedDB if present, else fetch + persist. Returns the pack. */
export async function ensurePack(opts: { allowMeteredDownload?: boolean } = {}): Promise<CorePack | null> {
  if (_pack) return _pack;

  const cached = await idbGet<CorePack>(DB_NAME, STORE, PACK_KEY);
  if (cached) {
    _pack = cached;
    _mini = buildIndex(cached);
    void checkForUpdate(opts).catch(() => {}); // background, best-effort
    return cached;
  }

  if (!opts.allowMeteredDownload && isMetered()) return null; // caller prompts user
  const fresh = await download();
  if (fresh) {
    _pack = fresh;
    _mini = buildIndex(fresh);
    await idbPut(DB_NAME, STORE, PACK_KEY, fresh);
  }
  return _pack;
}

async function download(): Promise<CorePack | null> {
  try {
    const m = (await (await fetch('/core-pack/manifest.json', { cache: 'no-cache' })).json()) as CorePackManifest;
    return (await (await fetch(m.url, { cache: 'force-cache' })).json()) as CorePack;
  } catch {
    return null;
  }
}

/** Background: swap to a newer pack version if one is published. */
export async function checkForUpdate(opts: { allowMeteredDownload?: boolean } = {}): Promise<boolean> {
  if (!opts.allowMeteredDownload && isMetered()) return false;
  try {
    const m = (await (await fetch('/core-pack/manifest.json', { cache: 'no-cache' })).json()) as CorePackManifest;
    if (_pack && m.version <= _pack.version) return false;
    const fresh = await download();
    if (!fresh) return false;
    _pack = fresh;
    _mini = buildIndex(fresh);
    await idbPut(DB_NAME, STORE, PACK_KEY, fresh);
    return true;
  } catch {
    return false;
  }
}

function isMetered(): boolean {
  // navigator.connection is non-standard but widely available on Android Chrome.
  const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!conn) return false;
  return Boolean(conn.saveData) || ['slow-2g', '2g'].includes(conn.effectiveType ?? '');
}

/** Public wrapper so UI can decide whether to show a metered-download prompt. */
export function isConnectionMetered(): boolean {
  return isMetered();
}

/** Cheap (~100 B) manifest fetch so the consent prompt can show the pack size. */
export async function peekManifest(): Promise<CorePackManifest | null> {
  try {
    return (await (await fetch('/core-pack/manifest.json', { cache: 'no-cache' })).json()) as CorePackManifest;
  } catch {
    return null;
  }
}

export interface SearchHit {
  id: string;
  type: 'stop' | 'neighborhood' | 'landmark';
  display: string;
  lat: number;
  lng: number;
  routeIds: string[];
  status?: RecordStatus;
  score: number;
}

/** OFFLINE search, instant, no network. */
export function search(q: string, limit = 12): SearchHit[] {
  if (!_mini) return [];
  // MiniSearch returns its built-in fields plus our storeFields; intersect with SearchDoc so the
  // stored fields are typed (no `as any`).
  const hits = _mini.search(q) as Array<SearchResult & SearchDoc>;
  return hits.slice(0, limit).map((r) => ({
    id: r.id,
    type: r.type,
    display: r.display,
    lat: r.lat,
    lng: r.lng,
    routeIds: r.routeIds,
    status: r.status,
    score: r.score,
  }));
}

export interface BoardingOption {
  board_stop_id: string;
  board_stop_name: string;
  walk_m: number;
  route_id: string;
  route_name: string;
  route_ref?: string;
  mate_shout: string;
  board_phrase: string;
  alight_stop_id: string;
  alight_stop_name: string;
  alight_phrase: string;
  // The exact seq positions the engine chose on the route.
  board_seq: number;
  alight_seq: number;
  stops_between: number;
  leg_m: number; // metres ridden from board to alight (for time estimate)
  status?: RecordStatus;
}

/** Pre-formatted "tell the mate" instruction for an alight stop. */
function alightPhrase(name: string | undefined): string {
  return name?.trim()
    ? `Tell the mate: "${name}, bus stop!"`
    : 'Tell the mate where you want to get down.';
}

/** OFFLINE single-leg boarding lookup (mirrors the server boarding_point RPC). */
export function boardingPointOffline(
  userLat: number,
  userLng: number,
  destId: string,
  destType: 'stop' | 'neighborhood' | 'landmark',
  radiusM = MAX_WALK_M, // must stay >= planTripOffline's seed radius
): { options: BoardingOption[]; noDirectRoute: boolean } {
  if (!_pack) return { options: [], noDirectRoute: true };

  const dest =
    destType === 'stop'
      ? _pack.stops.find((s) => s.id === destId)
      : destType === 'neighborhood'
        ? _pack.neighborhoods.find((n) => n.id === destId)
        : _pack.landmarks.find((l) => l.id === destId);
  if (!dest) return { options: [], noDirectRoute: true };

  const stopById = new Map(_pack.stops.map((s) => [s.id, s]));
  const options: BoardingOption[] = [];

  for (const route of _pack.routes) {
    let board: { rs: PackRouteStop; lat: number; lng: number; name: string; walk: number } | null = null;
    let alight: { rs: PackRouteStop; name: string; d: number } | null = null;

    for (const rs of route.stops) {
      const s = stopById.get(rs.stopId);
      if (!s) continue;
      const dUser = haversineM(userLat, userLng, s.lat, s.lng);
      if (dUser <= radiusM && (!board || dUser < board.walk)) {
        board = { rs, lat: s.lat, lng: s.lng, name: s.name, walk: dUser };
      }
      const dDest = haversineM(dest.lat, dest.lng, s.lat, s.lng);
      if (dDest <= 500 && (!alight || dDest < alight.d)) {
        alight = { rs, name: s.name, d: dDest };
      }
    }

    if (board && alight && alight.rs.seq > board.rs.seq) {
      options.push({
        board_stop_id: board.rs.stopId,
        board_stop_name: board.name,
        walk_m: Math.round(board.walk),
        route_id: route.id,
        route_name: route.name,
        route_ref: route.ref,
        mate_shout: route.mateShout,
        board_phrase: board.rs.board ?? `The mate will be shouting: ${route.mateShout}`,
        alight_stop_id: alight.rs.stopId,
        alight_stop_name: alight.name,
        alight_phrase: alight.rs.alight ?? alightPhrase(alight.name),
        board_seq: board.rs.seq,
        alight_seq: alight.rs.seq,
        stops_between: alight.rs.seq - board.rs.seq,
        leg_m: Math.max(0, alight.rs.distM - board.rs.distM),
        status: route.status,
      });
    }
  }

  options.sort((a, b) => a.walk_m - b.walk_m || a.stops_between - b.stops_between);
  return { options: options.slice(0, 5), noDirectRoute: options.length === 0 };
}

export interface TripOption {
  legs: BoardingOption[];
  transfers: number; // legs.length - 1
  totalWalkM: number;
  totalLegM: number; // summed ride distance across all legs
}

/**
 * Multi-leg trip search for journeys with no single direct route, the real Accra pattern of "car
 * to Lapaz, then another car to your final stop".
 */
export function planTripOffline(
  userLat: number,
  userLng: number,
  destId: string,
  destType: 'stop' | 'neighborhood' | 'landmark',
  opts: { radiusM?: number; destRadiusM?: number; maxLegs?: number } = {},
): { options: TripOption[]; noRoute: boolean } {
  if (!_pack) return { options: [], noRoute: true };
  const radiusM = opts.radiusM ?? MAX_WALK_M;
  const destRadiusM = opts.destRadiusM ?? 500;
  const maxLegs = Math.max(2, opts.maxLegs ?? 3);

  const dest =
    destType === 'stop'
      ? _pack.stops.find((s) => s.id === destId)
      : destType === 'neighborhood'
        ? _pack.neighborhoods.find((n) => n.id === destId)
        : _pack.landmarks.find((l) => l.id === destId);
  if (!dest) return { options: [], noRoute: true };

  const stopById = new Map(_pack.stops.map((s) => [s.id, s]));
  const routeById = new Map(_pack.routes.map((r) => [r.id, r]));

  // Unnamed route-member stops are fine for boarding/alighting at the ends of a single ride (the
  // user can see the place on the map), but they make terrible mid-trip waypoints, "transfer at
  // ''" / "get down at ''" tells the rider nothing.
  const isNamed = (stopId: string) => Boolean(stopById.get(stopId)?.name?.trim());

  // stopId -> every (route, seq) it appears in, this IS the transfer graph, since a stop shared by
  // two routes is exactly a valid transfer point.
  const stopRouteIndex = new Map<string, { routeId: string; rs: PackRouteStop }[]>();
  for (const route of _pack.routes) {
    for (const rs of route.stops) {
      if (!isNamed(rs.stopId)) continue;
      const arr = stopRouteIndex.get(rs.stopId) ?? [];
      arr.push({ routeId: route.id, rs });
      stopRouteIndex.set(rs.stopId, arr);
    }
  }

  // Candidate alight stops near the destination, across the whole pack.
  const destCandidates = new Set<string>();
  for (const s of _pack.stops) {
    if (haversineM(dest.lat, dest.lng, s.lat, s.lng) <= destRadiusM) destCandidates.add(s.id);
  }
  if (destCandidates.size === 0) return { options: [], noRoute: true };

  function makeLeg(routeId: string, boardRs: PackRouteStop, alightRs: PackRouteStop, walkM: number): BoardingOption | null {
    const route = routeById.get(routeId);
    const boardStop = stopById.get(boardRs.stopId);
    const alightStop = stopById.get(alightRs.stopId);
    if (!route || !boardStop || !alightStop) return null;
    return {
      board_stop_id: boardRs.stopId,
      board_stop_name: boardStop.name,
      walk_m: Math.round(walkM),
      route_id: route.id,
      route_name: route.name,
      route_ref: route.ref,
      mate_shout: route.mateShout,
      board_phrase: boardRs.board ?? `The mate will be shouting: ${route.mateShout}`,
      alight_stop_id: alightRs.stopId,
      alight_stop_name: alightStop.name,
      alight_phrase: alightRs.alight ?? alightPhrase(alightStop.name),
      board_seq: boardRs.seq,
      alight_seq: alightRs.seq,
      stops_between: alightRs.seq - boardRs.seq,
      leg_m: Math.max(0, alightRs.distM - boardRs.distM),
      status: route.status,
    };
  }

  // Cap per transfer depth, not overall: each depth is searched fully before the next, so deeper
  // junk paths can't crowd out a real fewest-transfers trip.
  const PER_DEPTH_CAP = 400;

  function searchAtDepth(targetTransfers: number): TripOption[] {
    const found: TripOption[] = [];

    function dfs(
      routeId: string,
      boardRs: PackRouteStop,
      walkM: number,
      legsSoFar: BoardingOption[],
      usedRoutes: Set<string>,
      depth: number,
    ) {
      if (found.length >= PER_DEPTH_CAP) return;
      const route = routeById.get(routeId);
      if (!route) return;
      const ordered = [...route.stops].sort((a, b) => a.seq - b.seq);

      for (const rs of ordered) {
        if (rs.seq <= boardRs.seq) continue;

        if (depth === targetTransfers && destCandidates.has(rs.stopId)) {
          const leg = makeLeg(routeId, boardRs, rs, walkM);
          if (leg) {
            const allLegs = [...legsSoFar, leg];
            found.push({
              legs: allLegs,
              transfers: allLegs.length - 1,
              totalWalkM: allLegs[0].walk_m,
              totalLegM: allLegs.reduce((s, l) => s + l.leg_m, 0),
            });
          }
        }

        if (depth < targetTransfers) {
          const here = stopRouteIndex.get(rs.stopId) ?? [];
          for (const c of here) {
            if (c.routeId === routeId || usedRoutes.has(c.routeId)) continue;
            const leg = makeLeg(routeId, boardRs, rs, walkM);
            if (!leg) continue;
            const nextUsed = new Set(usedRoutes);
            nextUsed.add(c.routeId);
            dfs(c.routeId, c.rs, 0, [...legsSoFar, leg], nextUsed, depth + 1);
          }
        }
      }
    }

    // Seed: EVERY boardable stop within the walk radius per route, not just the single nearest.
    for (const route of _pack!.routes) {
      const seeds: { rs: PackRouteStop; walk: number }[] = [];
      for (const rs of route.stops) {
        const s = stopById.get(rs.stopId);
        if (!s) continue;
        const d = haversineM(userLat, userLng, s.lat, s.lng);
        if (d <= radiusM) seeds.push({ rs, walk: d });
      }
      // Nearest first so the cheapest first-leg walks are explored before the cap.
      seeds.sort((a, b) => a.walk - b.walk);
      for (const seed of seeds) {
        dfs(route.id, seed.rs, seed.walk, [], new Set([route.id]), 0);
        if (found.length >= PER_DEPTH_CAP) break;
      }
      if (found.length >= PER_DEPTH_CAP) break;
    }
    return found;
  }

  // Try 1 transfer first; only escalate to 2 transfers if NOTHING works with fewer, this is what
  // guarantees "fewest transfers" instead of just sorting a possibly-incomplete sample after the
  // fact.
  let results: TripOption[] = [];
  for (let transfers = 1; transfers < maxLegs; transfers++) {
    results = searchAtDepth(transfers);
    if (results.length > 0) break;
  }

  // Dedupe identical route sequences, then rank by WALK distance first (the thing the rider
  // actually feels and what they asked to minimize), riding distance only as a tiebreaker, summing
  // the two punished a 0m-walk option with a long ride below a long-walk option with a short ride.
  const seen = new Set<string>();
  const multiLeg = results
    .sort((a, b) => a.totalWalkM - b.totalWalkM || a.totalLegM - b.totalLegM)
    .filter((o) => {
      const key = o.legs.map((l) => l.route_id).join('>');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);

  return { options: multiLeg, noRoute: multiLeg.length === 0 };
}

export function getRoute(routeId: string): PackRoute | undefined {
  return _pack?.routes.find((r) => r.id === routeId);
}

/** Resolve a stop id to its display name (for on-board guidance cues). */
export function getStopName(id: string): string {
  return _pack?.stops.find((s) => s.id === id)?.name ?? id;
}

/** Resolve a stop id to its full record (coords/landmark) for the map view. */
export function getStop(id: string): PackStop | undefined {
  return _pack?.stops.find((s) => s.id === id);
}

/** All landmarks in the pack (the map shows the ones near the drawn route). */
export function getLandmarks(): PackLandmark[] {
  return _pack?.landmarks ?? [];
}

// Distance (m) from point P to segment A→B via a local equirectangular projection centred on P,
// plus the fraction t along AB of the closest point.
function segProjM(
  plat: number, plng: number,
  alat: number, alng: number,
  blat: number, blng: number,
): { offsetM: number; t: number } {
  const mLat = 111320, mLng = 111320 * Math.cos((plat * Math.PI) / 180);
  const ax = (alng - plng) * mLng, ay = (alat - plat) * mLat;
  const bx = (blng - plng) * mLng, by = (blat - plat) * mLat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? -(ax * dx + ay * dy) / len2 : 0; // P is the origin (0,0)
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return { offsetM: Math.hypot(cx, cy), t };
}

// Project P onto the whole polyline: how far ALONG the route its closest point is (metres) and how
// far OFF the line P sits.
function projectToLine(
  line: [number, number][], cum: number[], plat: number, plng: number,
): { alongM: number; offsetM: number } {
  let best = { alongM: 0, offsetM: Infinity };
  for (let i = 0; i < line.length - 1; i++) {
    const { offsetM, t } = segProjM(plat, plng, line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]);
    if (offsetM < best.offsetM) best = { alongM: cum[i] + t * (cum[i + 1] - cum[i]), offsetM };
  }
  return best;
}

export interface RouteLandmark {
  landmark: PackLandmark;
  alongM: number; // metres travelled along the route to the landmark's nearest point
  offsetM: number; // metres the landmark sits off the line
}

/** Landmarks that sit near a route's line, in travel order. */
export function getLandmarksNearRoute(
  routeId: string,
  opts: { maxOffsetM?: number; boardStopId?: string; alightStopId?: string } = {},
): RouteLandmark[] {
  const pack = _pack;
  if (!pack || !pack.landmarks.length) return [];
  const route = pack.routes.find((r) => r.id === routeId);
  if (!route) return [];
  const line = decode(route.polyline, 6);
  if (line.length < 2) return [];

  const cum: number[] = [0];
  for (let i = 1; i < line.length; i++) {
    cum[i] = cum[i - 1] + haversineM(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
  }

  const maxOffset = opts.maxOffsetM ?? 130;
  const alongOf = (stopId?: string): number | null => {
    if (!stopId) return null;
    const s = pack.stops.find((x) => x.id === stopId);
    return s ? projectToLine(line, cum, s.lat, s.lng).alongM : null;
  };
  const bA = alongOf(opts.boardStopId);
  const aA = alongOf(opts.alightStopId);
  let lo = -Infinity, hi = Infinity;
  if (bA != null && aA != null) { lo = Math.min(bA, aA) - 150; hi = Math.max(bA, aA) + 150; }

  const out: RouteLandmark[] = [];
  for (const l of pack.landmarks) {
    const { alongM, offsetM } = projectToLine(line, cum, l.lat, l.lng);
    if (offsetM > maxOffset || alongM < lo || alongM > hi) continue;
    out.push({ landmark: l, alongM, offsetM });
  }
  out.sort((a, b) => a.alongM - b.alongM);
  return out;
}

export interface NearestStopResult {
  stop: PackStop;
  distanceM: number;
}

/**
 * Closest stop in the whole pack to (userLat,userLng), independent of any destination search, so
 * the rider can just be told "walk here" before they've even picked where they're going.
 */
export function nearestStopOffline(userLat: number, userLng: number): NearestStopResult | null {
  if (!_pack || _pack.stops.length === 0) return null;
  let best: NearestStopResult | null = null;
  for (const stop of _pack.stops) {
    const distanceM = haversineM(userLat, userLng, stop.lat, stop.lng);
    if (!best || distanceM < best.distanceM) best = { stop, distanceM };
  }
  return best;
}

/**
 * Closest named neighborhood to (userLat,userLng), used to label "near you" without a network
 * reverse-geocode call (keeps the no-GPS-leaves-the-device promise above; the pack already carries
 * neighborhood centroids).
 */
export function nearestNeighborhoodOffline(userLat: number, userLng: number): string | null {
  if (!_pack || _pack.neighborhoods.length === 0) return null;
  let bestName: string | null = null;
  let bestD = Infinity;
  for (const n of _pack.neighborhoods) {
    const d = haversineM(userLat, userLng, n.lat, n.lng);
    if (d < bestD) {
      bestD = d;
      bestName = n.name;
    }
  }
  return bestName;
}

/** True when the loaded pack is the placeholder/demo fixture (not real data). */
export function isDemoPack(): boolean {
  return Boolean(_pack?.demo);
}

/** Headline counts for the homepage ("N+ routes · N+ stops"). */
export function getPackStats(): { routes: number; stops: number } {
  return { routes: _pack?.routes.length ?? 0, stops: _pack?.stops.length ?? 0 };
}

/** ODbL attribution to display when the loaded pack contains OSM (beta) data. */
export function getAttribution(): { attribution: string; license: string } | null {
  if (!_pack?.attribution) return null;
  return { attribution: _pack.attribution, license: _pack.license ?? 'ODbL-1.0' };
}

/**
 * Last-resort boarding lookup: for each route that REACHES the destination, board at that route's
 * FIRST stop ("assume you walk to the terminal").
 */
export function boardingFromTerminalOffline(
  userLat: number,
  userLng: number,
  destId: string,
  destType: 'stop' | 'neighborhood' | 'landmark',
  destRadiusM = 700,
): { options: BoardingOption[]; noDirectRoute: boolean } {
  if (!_pack) return { options: [], noDirectRoute: true };

  const dest =
    destType === 'stop'
      ? _pack.stops.find((s) => s.id === destId)
      : destType === 'neighborhood'
        ? _pack.neighborhoods.find((n) => n.id === destId)
        : _pack.landmarks.find((l) => l.id === destId);
  if (!dest) return { options: [], noDirectRoute: true };

  const stopById = new Map(_pack.stops.map((s) => [s.id, s]));
  const options: BoardingOption[] = [];

  for (const route of _pack.routes) {
    const ordered = [...route.stops].sort((a, b) => a.seq - b.seq);
    const terminal = ordered.find((rs) => stopById.has(rs.stopId));
    if (!terminal) continue;
    const tStop = stopById.get(terminal.stopId)!;

    let alight: { rs: PackRouteStop; name: string; d: number } | null = null;
    for (const rs of ordered) {
      if (rs.seq <= terminal.seq) continue;
      const s = stopById.get(rs.stopId);
      if (!s) continue;
      const dDest = haversineM(dest.lat, dest.lng, s.lat, s.lng);
      if (dDest <= destRadiusM && (!alight || dDest < alight.d)) {
        alight = { rs, name: s.name, d: dDest };
      }
    }
    if (!alight) continue;

    options.push({
      board_stop_id: terminal.stopId,
      board_stop_name: tStop.name,
      walk_m: Math.round(haversineM(userLat, userLng, tStop.lat, tStop.lng)),
      route_id: route.id,
      route_name: route.name,
      route_ref: route.ref,
      mate_shout: route.mateShout,
      board_phrase: terminal.board ?? `Board at ${tStop.name}; the mate shouts: ${route.mateShout}`,
      alight_stop_id: alight.rs.stopId,
      alight_stop_name: alight.name,
      alight_phrase: alight.rs.alight ?? alightPhrase(alight.name),
      board_seq: terminal.seq,
      alight_seq: alight.rs.seq,
      stops_between: alight.rs.seq - terminal.seq,
      leg_m: Math.max(0, alight.rs.distM - terminal.distM),
      status: route.status,
    });
  }

  options.sort((a, b) => b.stops_between - a.stops_between);
  return { options: options.slice(0, 5), noDirectRoute: options.length === 0 };
}
