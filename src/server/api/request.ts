/**
 * Extracts the client IP for audit and rate-limiting purposes.
 *
 * Proxy headers are attacker-controlled unless the deployment terminates them,
 * so the value recorded here is evidence, not identity — it is written to the
 * audit log and never used for an authorisation decision.
 */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    // Left-most entry is the original client when the chain is trusted.
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return request.headers.get('x-real-ip')?.slice(0, 64) ?? null;
}
