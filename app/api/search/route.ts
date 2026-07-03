import { NextRequest, NextResponse } from 'next/server';
import { supabaseAnon } from '@/lib/supabase';
import { log } from '@/lib/log';
import { check, clientIp, retryAfterSeconds, searchLimiter } from '@/lib/ratelimit';

export const runtime = 'nodejs';
// CORRECTION #3 (co-location): pin the function next to Supabase (eu-west-1 = 'dub1')
// so DB-touching requests don't cross regions. When the DB moves to af-south-1,
// change this to 'cpt1' — one line, no rewrite.
export const preferredRegion = ['dub1'];

// GET /api/search?q=circle
// Text-only (no location, no PII) -> safe to edge-cache aggressively. Note the
// Cloudflare Worker serves cache HITs without reaching here, so the limiter only
// runs on cache misses (origin hits).
export async function GET(req: NextRequest) {
  const rl = await check(searchLimiter, clientIp(req));
  if (!rl.success) {
    // Soft fail: tell the client to use its offline pack rather than blocking nav.
    return NextResponse.json(
      { error: 'rate_limited', usePack: true },
      { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(rl.reset)) } },
    );
  }

  const q = (req.nextUrl.searchParams.get('q') ?? '').slice(0, 64);
  if (q.trim().length < 1) {
    return NextResponse.json({ results: [] });
  }

  const { data, error } = await supabaseAnon()
    .schema('core')
    .rpc('search_places', { p_q: q, p_limit: 12 });

  if (error) {
    log.error({ where: 'search', code: error.code }, 'search_failed');
    return NextResponse.json({ error: 'search_failed' }, { status: 500 });
  }

  const res = NextResponse.json({ results: data ?? [] });
  // 5 min fresh at the edge, serve-stale for a day while revalidating.
  res.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
  return res;
}
