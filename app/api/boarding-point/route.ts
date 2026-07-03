import { NextRequest, NextResponse } from 'next/server';
import { supabaseAnon } from '@/lib/supabase';
import { cellCenter, isValidR9 } from '@/lib/geo/h3';
import { log } from '@/lib/log';
import { boardingLimiter, check, clientIp, retryAfterSeconds } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const preferredRegion = ['dub1']; // see /api/search for the af-south-1 note

// POST /api/boarding-point
// Body: { cell: "<H3 res-9 id>", destinationId: "<uuid>", destinationType: "stop"|"neighborhood"|"landmark" }
//
// CORRECTION #1: this is a personalized endpoint, so it is POST (not a GET with
// coordinates) and the body carries an H3 CELL, never raw lat/lng. The server
// resolves the cell to its CENTRE — coarse (~174 m) — and uses that for the
// PostGIS lookup, so nothing finer than a cell ever reaches the DB, the logs, or
// a cache key. The result is deterministic per (cell, destination), which is
// what lets the Cloudflare Worker build a coarse, privacy-safe cache variant.
export async function POST(req: NextRequest) {
  const rl = await check(boardingLimiter, clientIp(req));
  if (!rl.success) {
    return NextResponse.json(
      { error: 'rate_limited', usePack: true },
      { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(rl.reset)) } },
    );
  }

  let body: { cell?: string; destinationId?: string; destinationType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }

  const { cell, destinationId, destinationType } = body;

  if (!cell || !isValidR9(cell)) {
    return NextResponse.json(
      { error: 'cell must be a valid H3 res-9 index. Quantize on the client; never send raw GPS.' },
      { status: 400 },
    );
  }
  if (!destinationId || !['stop', 'neighborhood', 'landmark'].includes(destinationType ?? '')) {
    return NextResponse.json({ error: 'destinationId and destinationType are required' }, { status: 400 });
  }

  const [lat, lng] = cellCenter(cell); // CELL CENTRE, not user GPS

  const { data, error } = await supabaseAnon().schema('core').rpc('boarding_point', {
    p_lat: lat,
    p_lng: lng,
    p_dest_id: destinationId,
    p_dest_type: destinationType,
    p_radius_m: 600,
  });

  if (error) {
    // Safe to log the coarse cell + destination; NEVER lat/lng.
    log.error({ where: 'boarding', cell, destinationType, code: error.code }, 'boarding_lookup_failed');
    return NextResponse.json({ error: 'boarding_lookup_failed' }, { status: 500 });
  }

  const options = data ?? [];
  const res = NextResponse.json({
    cell,
    destinationId,
    destinationType,
    options,
    noDirectRoute: options.length === 0,
    transfersAvailable: false, // multi-leg arrives in Phase 2
  });
  // POST is not edge-cached by default; the Worker honours this TTL on its
  // synthetic (cell+dest) cache key.
  res.headers.set('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
  return res;
}

// NOTE: we deliberately never log lat/lng. Only the coarse `cell` is ever logged.
