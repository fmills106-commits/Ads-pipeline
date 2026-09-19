import { describe, expect, it } from 'vitest';
import { assertSafePublicUrl } from '@/server/business/service';

/**
 * SSRF defence at the point a user supplies a URL.
 *
 * This is the first of two gates. The second — re-checking the *resolved* IP
 * immediately before connecting — lands with the crawler in Phase 2, because
 * DNS can point a perfectly public hostname at 169.254.169.254.
 */
describe('assertSafePublicUrl', () => {
  it('accepts ordinary public URLs', () => {
    expect(assertSafePublicUrl('https://example.com').hostname).toBe('example.com');
    expect(assertSafePublicUrl('http://shop.example.co.uk/products/1').protocol).toBe('http:');
    expect(assertSafePublicUrl('  https://example.com/path?a=1  ').pathname).toBe('/path');
  });

  it('rejects non-HTTP schemes', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com',
      'gopher://example.com',
      'javascript:alert(1)',
      'data:text/html,<script>',
    ]) {
      expect(() => assertSafePublicUrl(url), url).toThrow();
    }
  });

  it('rejects embedded credentials', () => {
    expect(() => assertSafePublicUrl('https://user:pass@example.com')).toThrow(/credentials/);
  });

  it('rejects loopback and localhost', () => {
    for (const url of [
      'http://localhost:3000',
      'http://app.localhost',
      'http://127.0.0.1',
      'http://127.0.0.53:8080',
      'http://[::1]:5432',
      'http://0.0.0.0',
    ]) {
      expect(() => assertSafePublicUrl(url), url).toThrow(/public host/);
    }
  });

  it('rejects RFC1918 private ranges', () => {
    for (const url of [
      'http://10.0.0.1',
      'http://172.16.0.1',
      'http://172.31.255.255',
      'http://192.168.1.1',
    ]) {
      expect(() => assertSafePublicUrl(url), url).toThrow(/public host/);
    }
  });

  it('rejects the cloud metadata endpoint', () => {
    // The single most valuable SSRF target in any cloud deployment.
    expect(() => assertSafePublicUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
      /public host/,
    );
  });

  it('rejects carrier-grade NAT, multicast and internal TLDs', () => {
    for (const url of [
      'http://100.64.0.1',
      'http://224.0.0.1',
      'http://db.internal',
      'http://printer.local',
      'http://svc.home.arpa',
    ]) {
      expect(() => assertSafePublicUrl(url), url).toThrow(/public host/);
    }
  });

  it('rejects IPv6 unique-local and link-local addresses', () => {
    for (const url of ['http://[fd00::1]', 'http://[fc00::1]', 'http://[fe80::1]']) {
      expect(() => assertSafePublicUrl(url), url).toThrow(/public host/);
    }
  });

  it('allows public ranges adjacent to private ones', () => {
    // 172.15/172.32 and 11.x are public; a too-broad regex would block them.
    expect(() => assertSafePublicUrl('http://172.15.0.1')).not.toThrow();
    expect(() => assertSafePublicUrl('http://172.32.0.1')).not.toThrow();
    expect(() => assertSafePublicUrl('http://11.0.0.1')).not.toThrow();
    expect(() => assertSafePublicUrl('http://8.8.8.8')).not.toThrow();
  });

  it('rejects unparseable input', () => {
    for (const url of ['', 'not a url', 'http://', '///']) {
      expect(() => assertSafePublicUrl(url), JSON.stringify(url)).toThrow();
    }
  });
});
