// Cloudflare Worker — Phase 0 edge layer (FREE TIER ONLY).

import { latLngToCell, isValidCell, getResolution } from 'h3-js';

interface Env {
  ORIGIN_HOST: string;       // e.g. "trotro-guide.vercel.app"
  SNAPSHOT?: KVNamespace;    // optional: KV holding a degraded-mode snapshot
  DEBUG_HEADERS?: string; // "true" in dev -> emit X-Tk-* verification headers
}

const H3_RES = 9;
const ORIGIN_TIMEOUT_MS = 5_000;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    try {
      if (url.pathname === '/api/search' && req.method === 'GET') {
        return await handleSearch(req, env, ctx, url);
      }
      if (url.pathname === '/api/boarding-point' && req.method === 'POST') {
        return await handleBoarding(req, env, ctx);
      }
      if (url.pathname.startsWith('/core-pack/') || url.pathname.startsWith('/tiles/')) {
        return await handleStatic(req, env, url);
      }
    } catch {
      // Top-level guard: never let an edge bug take down the whole zone.
      return passthrough(req, env).catch(() => degraded());
    }

    return passthrough(req, env).catch(() => degraded());
  },
};

// /api/search
async function handleSearch(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const q = normalizeQuery(url.searchParams.get('q') ?? '');
  const cacheKey = new Request(`https://cache.trotro/api/search?q=${encodeURIComponent(q)}`, { method: 'GET' });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return withHeader(hit, 'X-Edge-Cache', 'HIT');

  let origin: Response;
  try {
    origin = await fetchOrigin(req, env, { q });
  } catch {
    return degraded(); // origin unreachable
  }
  if (origin.status >= 500) {
    // Origin up but failing (e.g. Supabase unconfigured) -> serve stale if we have it, otherwise
    // tell the client to use its offline pack.
    const stale = await cache.match(cacheKey);
    return stale ? withHeader(stale, 'X-Edge-Cache', 'STALE') : degraded();
  }
  if (origin.ok) ctx.waitUntil(cache.put(cacheKey, origin.clone()));
  return withHeader(origin, 'X-Edge-Cache', 'MISS');
}

// /api/boarding-point
async function handleBoarding(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await req
    .json<{ cell?: unknown; lat?: unknown; lng?: unknown; destinationId?: unknown; destinationType?: unknown }>()
    .catch(() => null);
  if (!body) return json({ error: 'bad_json' }, 400);

  // Resolve a coarse H3 cell. Prefer the client-sent cell; defensively quantize any stray lat/lng
  // and DISCARD the raw fix so it can never be cached/logged.
  let cell = typeof body.cell === 'string' ? body.cell : undefined;
  if ((!cell || !isR9(cell)) && typeof body.lat === 'number' && typeof body.lng === 'number') {
    cell = latLngToCell(body.lat, body.lng, H3_RES);
  }
  if (!cell || !isR9(cell)) return json({ error: 'valid H3 res-9 cell required' }, 400);

  const destId = typeof body.destinationId === 'string' ? body.destinationId : '';
  const destType = typeof body.destinationType === 'string' ? body.destinationType : '';
  if (!destId || !['stop', 'neighborhood', 'landmark'].includes(destType)) {
    return json({ error: 'destination required' }, 400);
  }

  // Sanitized body forwarded to origin: ONLY the coarse cell (no raw GPS).
  const sanitized = { cell, destinationId: destId, destinationType: destType };

  // Coarse cache variant: (cell, dest).
  const cacheKeyUrl = `https://cache.trotro/api/boarding-point?cell=${cell}&d=${destType}:${destId}`;
  const cacheKey = new Request(cacheKeyUrl, { method: 'GET' });

  // Verification aids (no raw GPS — only the coarse cell + derived key). GATED: emitted ONLY when
  // DEBUG_HEADERS=true (dev).
  const dbg: Record<string, string> =
    env.DEBUG_HEADERS === 'true' ? { 'X-Tk-Cell': cell, 'X-Tk-Cache-Key': cacheKeyUrl } : {};

  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return withHeaders(hit, { ...dbg, 'X-Edge-Cache': 'HIT' });

  let origin: Response;
  try {
    origin = await fetchOrigin(req, env, { body: sanitized });
  } catch {
    return withHeaders(degraded(), dbg); // origin unreachable -> use offline pack
  }
  if (origin.status >= 500) {
    // Origin up but failing (e.g. Supabase unconfigured) -> stale or offline pack.
    const stale = await cache.match(cacheKey);
    return withHeaders(stale ?? degraded(), { ...dbg, 'X-Edge-Cache': stale ? 'STALE' : 'MISS' });
  }
  if (origin.ok) ctx.waitUntil(cache.put(cacheKey, origin.clone()));
  return withHeaders(origin, { ...dbg, 'X-Edge-Cache': 'MISS' });
}

// static (versioned, immutable)
async function handleStatic(req: Request, env: Env, url: URL): Promise<Response> {
  const isManifest = url.pathname.endsWith('/manifest.json');
  const cache = caches.default;

  if (!isManifest) {
    const hit = await cache.match(req);
    if (hit) return hit;
  }
  let origin: Response;
  try {
    origin = await fetchOrigin(req, env, {});
  } catch {
    return new Response(null, { status: 504 }); // client uses already-cached pack/tiles
  }
  const res = new Response(origin.body, origin);
  res.headers.set(
    'Cache-Control',
    isManifest ? 'public, max-age=60, stale-while-revalidate=600' : 'public, max-age=31536000, immutable',
  );
  if (!isManifest && origin.ok) await cache.put(req, res.clone());
  return res;
}

// helpers
function isR9(cell: string): boolean {
  try {
    return isValidCell(cell) && getResolution(cell) === H3_RES;
  } catch {
    return false;
  }
}

function normalizeQuery(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

/** Fetch the real origin with a hard timeout. Rewrites host to ORIGIN_HOST. */
async function fetchOrigin(req: Request, env: Env, opts: { q?: string; body?: unknown }): Promise<Response> {
  const inUrl = new URL(req.url);
  inUrl.host = env.ORIGIN_HOST;
  // Local dev (localhost / 127.0.0.1) speaks http; everything else https.
  inUrl.protocol = isLocalOrigin(env.ORIGIN_HOST) ? 'http:' : 'https:';
  if (opts.q !== undefined) inUrl.search = `?q=${encodeURIComponent(opts.q)}`;

  const headers = stripHopHeaders(req.headers);
  const init: RequestInit = { method: req.method, headers };
  if (opts.body !== undefined) {
    init.method = 'POST';
    init.body = JSON.stringify(opts.body);
    headers.set('content-type', 'application/json');
  }

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ORIGIN_TIMEOUT_MS);
  try {
    return await fetch(inUrl.toString(), { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

function passthrough(req: Request, env: Env): Promise<Response> {
  return fetchOrigin(req, env, {});
}

/** Fail-open: tell the client to use its offline Core Pack instead of erroring. */
function degraded(): Response {
  return json(
    { degraded: true, usePack: true, message: 'Origin unavailable — use the offline pack.' },
    200,
    { 'X-Degraded': 'fail-open' },
  );
}

function json(obj: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  });
}

function withHeader(res: Response, k: string, v: string): Response {
  const r = new Response(res.body, res);
  r.headers.set(k, v);
  return r;
}

function withHeaders(res: Response, kv: Record<string, string>): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(kv)) r.headers.set(k, v);
  return r;
}

function isLocalOrigin(host: string): boolean {
  return host.startsWith('localhost') || host.startsWith('127.') || host.startsWith('0.0.0.0');
}

function stripHopHeaders(h: Headers): Headers {
  const out = new Headers(h);
  ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'].forEach((x) => out.delete(x));
  return out;
}
