import { NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/log';
import { check, clientIp, contributeLimiter, retryAfterSeconds } from '@/lib/ratelimit';
import { forwardMapRequest, sheetsConfigured } from '@/lib/sheets';

export const runtime = 'nodejs';

// Cap the request body: a legit ride trace is a few dozen KB; anything past this is abuse, and we
// reject it BEFORE parsing so a giant payload can't spike memory.
const MAX_BODY_BYTES = 256 * 1024; // 256 KB

// Phase-1 ingestion stub for field captures (route contributions + ride traces).
export async function POST(req: NextRequest) {
  // This is the one write endpoint; throttle it like the read endpoints so it can't be used to
  // flood the origin / logs.
  const rl = await check(contributeLimiter, clientIp(req));
  if (!rl.success) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(rl.reset)) } },
    );
  }

  // Reject oversized bodies twice: by the declared Content-Length (cheap), then by the actual bytes
  // read (in case the header is absent or lies).
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  let body: { kind?: unknown; trace?: unknown; issues?: unknown; destination?: unknown; detail?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }

  const kind = typeof body.kind === 'string' ? body.kind : 'unknown';
  const points = Array.isArray(body.trace) ? body.trace.length : 0;
  const issues = Array.isArray(body.issues) ? body.issues.length : 0;
  log.info({ where: 'contribute', kind, points, issues }, 'capture_received');

  // ONLY "missing route" reports go to the ops sheet — and only the text the user typed.
  if (kind === 'map-request') {
    const destination = (typeof body.destination === 'string' ? body.destination : '').trim();
    const detail = (typeof body.detail === 'string' ? body.detail : '').trim();
    if (destination) {
      const ok = await forwardMapRequest(destination.slice(0, 300), detail.slice(0, 1000));
      // If a sheet is configured but the append didn't confirm, tell the client it failed so it
      // keeps the report queued and retries later (no data loss).
      if (!ok && sheetsConfigured()) {
        return NextResponse.json({ error: 'forward_failed' }, { status: 502 });
      }
    }
  }

  return NextResponse.json({ ok: true });
}
