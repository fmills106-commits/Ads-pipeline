import type { NextConfig } from 'next';

/**
 * Security headers applied to every response.
 *
 * The Content-Security-Policy is deliberately not here: it needs a
 * per-request nonce, so it is set in `src/middleware.ts`. Everything in this
 * list is static and belongs at the edge.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  /**
   * Two years, with subdomains, and preload-eligible.
   *
   * Only meaningful over HTTPS, and harmless over plain HTTP because browsers
   * ignore it there — so it does not need to be conditional on the
   * environment. It does mean a domain committed here cannot be served over
   * HTTP later without waiting the max-age out.
   */
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: false,
  /*
   * `output: 'standalone'` is deliberately NOT set.
   *
   * It would shrink the container image, but it also makes `next start`
   * unsupported — Next.js warns and expects `node .next/standalone/server.js`
   * with static assets copied alongside by hand. That trades a smaller image
   * for a build whose documented start command no longer works, on a path
   * (containers) that is the fallback rather than the default. Not worth it.
   */
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
