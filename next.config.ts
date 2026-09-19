import type { NextConfig } from 'next';

/**
 * Security headers applied to every response.
 *
 * Note: a Content-Security-Policy is intentionally NOT set here yet. It needs a
 * per-request nonce (Next.js injects inline bootstrap scripts), which belongs in
 * middleware alongside the rest of the request pipeline. Tracked for Phase 2.
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
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
