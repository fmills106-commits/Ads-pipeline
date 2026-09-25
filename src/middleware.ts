import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content-Security-Policy, with a per-request nonce.
 *
 * This could not live in `next.config.ts` alongside the other security
 * headers: Next.js injects inline bootstrap scripts into every page, so a
 * policy strict enough to be worth having needs a fresh nonce per response,
 * and only middleware runs per request.
 *
 * The shape of the policy is the point. `script-src` is the directive that
 * turns a stored-content bug into account takeover, and this application
 * stores arbitrary text scraped from strangers' websites, so it gets the
 * strict treatment: a nonce plus `strict-dynamic`, and no host allow-list to
 * be bypassed. `style-src` keeps `'unsafe-inline'` because React sets style
 * attributes and Next injects a stylesheet inline during development —
 * inline CSS is a far smaller problem than inline script, and pretending
 * otherwise by shipping a policy that breaks the app would be worse.
 *
 * `connect-src 'self'` matters more than it looks: it means a successful
 * injection still cannot post what it read to an attacker's server.
 */

/** Everything that is not a page needing a policy. */
const SKIP = /^\/(?:_next\/static|_next\/image|favicon\.ico|robots\.txt|sitemap\.xml)/;

function buildPolicy(nonce: string, isDev: boolean): string {
  const directives = [
    "default-src 'self'",
    // `strict-dynamic` lets the nonced bootstrap load the chunks it needs
    // without naming them, which is what makes a nonce workable in Next.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${isDev ? "'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // Product images come from the merchant's own site, which is any host.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // No third-party telemetry, and nowhere for exfiltrated data to go.
    `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ];

  if (!isDev) directives.push('upgrade-insecure-requests');

  return directives
    .map((directive) => directive.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('; ');
}

export function middleware(request: NextRequest): NextResponse {
  if (SKIP.test(request.nextUrl.pathname)) return NextResponse.next();

  // 128 bits of randomness, base64. `crypto` is the Web Crypto global, which
  // exists in the middleware runtime; `node:crypto` does not.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));

  const policy = buildPolicy(nonce, process.env.NODE_ENV !== 'production');

  // Next.js reads the nonce off the *request* to stamp its own inline
  // scripts, so it has to be set here and not only on the response.
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', policy);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  // Matched broadly and narrowed in code, so the skip list stays readable and
  // testable rather than being encoded in a matcher regex.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
