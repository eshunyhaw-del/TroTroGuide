// Rate limiting for the public B2C read endpoints (Upstash token bucket).

import { Ratelimit, type Duration } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { log } from './log';

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = url && token ? new Redis({ url, token }) : null;
if (!redis) {
  log.warn('Upstash not configured (UPSTASH_REDIS_REST_*); rate limiting disabled.');
}

function bucket(name: string, refillTokens: number, interval: Duration, capacity: number): Ratelimit | null {
  if (!redis) return null;
  return new Ratelimit({
    redis,
    // refillTokens per `interval`, up to `capacity` tokens (the burst allowance).
    limiter: Ratelimit.tokenBucket(refillTokens, interval, capacity),
    prefix: `rl:${name}`,
    analytics: false, // save Upstash commands on the free tier
    ephemeralCache: new Map<string, number>(), // in-instance dedupe -> fewer Redis round-trips
  });
}

// ~1 req/s sustained, burst 30 (search is the typeahead-ish endpoint).
export const searchLimiter = bucket('search', 10, '10 s', 30);
// ~0.5 req/s sustained, burst 15 (boarding-point is fired less often).
export const boardingLimiter = bucket('boarding', 5, '10 s', 15);
// Writes: fired once at end-of-trip, so keep it tight, ~1/12s sustained, burst 10.
export const contributeLimiter = bucket('contribute', 5, '60 s', 10);
// Street imagery: fired as the rider crosses landmarks (movement-gated + cached client-side), so a
// modest sustained rate with a small burst for the app-open prefetch.
export const streetviewLimiter = bucket('streetview', 5, '10 s', 15);

/** Best-effort client IP for the bucket key (Cloudflare -> XFF -> real-ip). */
export function clientIp(req: Request): string {
  const h = req.headers;
  return (
    h.get('cf-connecting-ip') ||
    (h.get('x-forwarded-for') ?? '').split(',')[0].trim() ||
    h.get('x-real-ip') ||
    'anon'
  );
}

export interface LimitResult {
  success: boolean;
  remaining: number;
  reset: number; // epoch ms when a token frees up
}

export async function check(limiter: Ratelimit | null, key: string): Promise<LimitResult> {
  if (!limiter) return { success: true, remaining: 0, reset: 0 }; // disabled (dev)
  const r = await limiter.limit(key);
  return { success: r.success, remaining: r.remaining, reset: r.reset };
}

/** Seconds to advise in a Retry-After header (always >= 1). */
export function retryAfterSeconds(reset: number): number {
  return Math.max(1, Math.ceil((reset - Date.now()) / 1000));
}
