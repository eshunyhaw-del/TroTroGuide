import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _anon: SupabaseClient | null = null;

/**
 * Anonymous client for READS (search, boarding-point). RLS allows public SELECT
 * of approved truth and EXECUTE on the two read RPCs. No service-role secret on
 * the read path.
 *
 * Created LAZILY on first use so that merely importing this module never throws.
 * That lets `next build` collect page data without DB creds, and a missing config
 * surfaces as a clean request-time 500 — which the edge Worker turns into a
 * degraded "use the offline pack" response instead of a hard failure.
 */
export function supabaseAnon(): SupabaseClient {
  if (_anon) return _anon;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }
  _anon = createClient(url, anonKey, { auth: { persistSession: false } });
  return _anon;
}

/**
 * Service-role client for the contribution PIPELINE only (validate/approve/apply
 * /export/revert). NEVER import this into a client component or expose the key.
 */
export function supabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL');
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY (server-only)');
  return createClient(url, key, { auth: { persistSession: false } });
}
