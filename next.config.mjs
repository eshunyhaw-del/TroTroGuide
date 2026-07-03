/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Preact alias for the prod client bundle was reverted: preact/compat@10.23.2
  // doesn't implement React's `use()` hook, which Next 14.2.35's App Router
  // client runtime calls internally — crashed the whole tree with "c.use is
  // not a function" on first render (stuck on "Loading…" forever). Falling
  // back to plain React per the original instruction; bundle is bigger but
  // works.

  async headers() {
    return [
      {
        source: '/core-pack/v:version/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/core-pack/manifest.json',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=60, stale-while-revalidate=600' }],
      },
      {
        // Baseline security headers on every response. A full Content-Security-
        // Policy is deliberately deferred (MapLibre workers, Carto tiles, the
        // Paystack link and inline styles need careful allow-listing) and tracked
        // separately. Note: `geolocation=(self)` MUST stay — the app uses GPS.
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()' },
        ],
      },
    ];
  },
};
export default nextConfig;
