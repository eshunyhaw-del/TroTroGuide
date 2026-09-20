import { NextRequest, NextResponse } from 'next/server';
import { resolveStreetImage } from '@/lib/streetview/service';
import { log } from '@/lib/log';
import { check, clientIp, retryAfterSeconds, streetviewLimiter } from '@/lib/ratelimit';

export const runtime = 'nodejs';
// Reaches out to graph.mapillary.com (EU-served); no DB. Keep it near the other public read
// functions.
export const preferredRegion = ['dub1'];

// GET /api/streetview?lat=..&lng=..&bearing=..&radius=..
export async function GET(req: NextRequest) {
  const rl = await check(streetviewLimiter, clientIp(req));
  if (!rl.success) {
    // Soft fail — the imagery card just shows "no image", navigation is untouched.
    return NextResponse.json(
      { status: 'error' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(rl.reset)) } },
    );
  }

  const sp = req.nextUrl.searchParams;
  const lat = Number(sp.get('lat'));
  const lng = Number(sp.get('lng'));
  const bearingRaw = sp.get('bearing');
  const radiusRaw = Number(sp.get('radius'));

  // Reject anything that isn't a finite coordinate in a sane range. Bad input is a client bug, not
  // a reason to call the provider.
  if (
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    lat < -90 || lat > 90 || lng < -180 || lng > 180
  ) {
    return NextResponse.json({ status: 'error' }, { status: 400 });
  }

  const bearing =
    bearingRaw != null && Number.isFinite(Number(bearingRaw))
      ? ((Number(bearingRaw) % 360) + 360) % 360
      : null;
  // Clamp radius to a useful window: too small misses sparse Accra coverage, too big pulls in
  // off-road imagery the ranking would have to discard anyway.
  const radiusM = Number.isFinite(radiusRaw) ? Math.min(200, Math.max(30, radiusRaw)) : 120;

  try {
    const result = await resolveStreetImage({ lat, lng, bearing, radiusM }, Date.now());
    const res = NextResponse.json(result);
    // 'ok'/'empty' for a public landmark point are stable — cache hard at the edge so repeat riders
    // past the same landmark cost the provider nothing.
    if (result.status === 'ok' || result.status === 'empty') {
      res.headers.set('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    } else {
      res.headers.set('Cache-Control', 'no-store');
    }
    return res;
  } catch (err) {
    log.error({ where: 'streetview', msg: (err as Error).message }, 'streetview_failed');
    // Never break navigation on an imagery failure.
    return NextResponse.json({ status: 'error' }, { status: 200 });
  }
}
