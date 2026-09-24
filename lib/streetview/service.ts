// Resolve the best street-level image for a query point. SERVER ONLY.

import type { ImageQuery, ImageResult } from './types';
import { activeProvider } from './provider';
import { bestCandidate } from './rank';

export async function resolveStreetImage(query: ImageQuery, now: number): Promise<ImageResult> {
  const provider = activeProvider();
  if (!provider) return { status: 'not_configured' };

  let candidates;
  try {
    candidates = await provider.findCandidates(query);
  } catch {
    // Provider/network failure. Navigation must continue regardless, the route maps this to a
    // non-fatal 'error' state the card renders quietly.
    return { status: 'error' };
  }

  if (candidates.length === 0) return { status: 'empty' };

  const best = bestCandidate(candidates, query, now);
  if (!best) return { status: 'empty' };

  return {
    status: 'ok',
    image: {
      id: best.id,
      thumbUrl: best.thumbUrl,
      fullUrl: best.fullUrl ?? null,
      bearing: best.bearing,
      capturedAt: best.capturedAt,
      provider: provider.name,
      attribution: provider.attributionFor(best),
      attributionUrl: provider.attributionUrlFor(best),
    },
  };
}
