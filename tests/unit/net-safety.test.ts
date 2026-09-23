import { describe, expect, it } from 'vitest';
import {
  assertResolvedAddressesArePublic,
  assertSafePublicUrl,
  classifyHost,
  classifyIPv4,
  classifyIPv6,
  isSameSite,
  normaliseUrl,
  parseIPv4,
} from '@/lib/net-safety';

/**
 * SSRF is the highest-risk surface in this application, because fetching
 * arbitrary user-supplied URLs is the product's job. The regression cases at
 * the top of this file are the ones an earlier version got wrong.
 */

describe('parseIPv4', () => {
  it('parses dotted quads', () => {
    expect(parseIPv4('127.0.0.1')).toBe(0x7f000001);
    expect(parseIPv4('8.8.8.8')).toBe(0x08080808);
    expect(parseIPv4('255.255.255.255')).toBe(0xffffffff);
  });

  it('parses the short forms inet_aton accepts', () => {
    // These are what the network stack actually resolves them to, so the guard
    // has to see them the same way.
    expect(parseIPv4('127.1')).toBe(0x7f000001);
    expect(parseIPv4('127.0.1')).toBe(0x7f000001);
    expect(parseIPv4('2130706433')).toBe(0x7f000001);
  });

  it('parses hex and octal parts', () => {
    expect(parseIPv4('0x7f000001')).toBe(0x7f000001);
    expect(parseIPv4('0x7f.0x0.0x0.0x1')).toBe(0x7f000001);
    expect(parseIPv4('017700000001')).toBe(0x7f000001);
    expect(parseIPv4('0177.0.0.01')).toBe(0x7f000001);
  });

  it('rejects things that are not IPv4', () => {
    for (const host of [
      'example.com',
      '',
      '1.2.3.4.5',
      '256.1.1.1',
      '1.2.3.999',
      'abc',
      '1.2.3.-1',
    ]) {
      expect(parseIPv4(host), host).toBeNull();
    }
  });
});

describe('classifyIPv4', () => {
  it('flags loopback, private, link-local and CGNAT', () => {
    const privateAddresses = [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
    ];
    for (const address of privateAddresses) {
      expect(classifyIPv4(parseIPv4(address)!), address).toBe('private');
    }
  });

  it('allows genuinely public addresses, including ones adjacent to private ranges', () => {
    for (const address of [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1',
      '172.32.0.1',
      '11.0.0.1',
      '99.64.0.1',
    ]) {
      expect(classifyIPv4(parseIPv4(address)!), address).toBe('public');
    }
  });
});

describe('classifyIPv6', () => {
  it('flags loopback, unique-local, link-local and multicast', () => {
    for (const host of ['::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', 'ff02::1']) {
      expect(classifyIPv6(host), host).toBe('private');
    }
  });

  it('flags IPv4-mapped loopback in both notations', () => {
    // ::ffff:127.0.0.1 reaches loopback; classifying it as IPv6-public would
    // be a bypass.
    expect(classifyIPv6('::ffff:127.0.0.1')).toBe('private');
    expect(classifyIPv6('::ffff:7f00:1')).toBe('private');
    expect(classifyIPv6('[::ffff:169.254.169.254]')).toBe('private');
  });

  it('allows a public IPv6 address', () => {
    expect(classifyIPv6('2606:4700:4700::1111')).toBe('public');
  });

  it('reports a non-IPv6 string as not-an-ip', () => {
    expect(classifyIPv6('example.com')).toBe('not-an-ip');
  });
});

describe('classifyHost', () => {
  it('blocks internal hostnames whatever they resolve to', () => {
    for (const host of [
      'localhost',
      'app.localhost',
      'printer.local',
      'db.internal',
      'svc.home.arpa',
      'server.lan',
      'metadata.google.internal',
    ]) {
      expect(classifyHost(host), host).toBe('private');
    }
  });

  it('leaves ordinary hostnames for the DNS check', () => {
    expect(classifyHost('example.com')).toBe('not-an-ip');
  });
});

describe('assertSafePublicUrl', () => {
  it('accepts ordinary public shop URLs', () => {
    expect(assertSafePublicUrl('https://example.com').hostname).toBe('example.com');
    expect(assertSafePublicUrl('  http://shop.example.co.uk/products/1  ').pathname).toBe(
      '/products/1',
    );
  });

  describe('regression: alternative IPv4 encodings of 127.0.0.1', () => {
    // Every one of these was ACCEPTED before the Phase 2 hardening.
    const bypasses = [
      'http://2130706433/',
      'http://0x7f000001/',
      'http://127.1/',
      'http://017700000001/',
      'http://0x7f.1/',
      'http://[::ffff:127.0.0.1]/',
    ];
    for (const url of bypasses) {
      it(url, () => {
        expect(() => assertSafePublicUrl(url)).toThrow(/public host/);
      });
    }
  });

  it('blocks the cloud metadata endpoint in every spelling', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://2852039166/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      expect(() => assertSafePublicUrl(url), url).toThrow();
    }
  });

  it('rejects non-HTTP schemes', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com',
      'gopher://example.com',
      'data:text/html,x',
    ]) {
      expect(() => assertSafePublicUrl(url), url).toThrow();
    }
  });

  it('rejects embedded credentials', () => {
    expect(() => assertSafePublicUrl('https://user:pass@example.com')).toThrow(/credentials/);
  });

  it('rejects non-standard ports, which are usually internal services', () => {
    expect(() => assertSafePublicUrl('http://example.com:8080/')).toThrow(/port 8080/);
    expect(() => assertSafePublicUrl('http://example.com:22/')).toThrow(/port 22/);
    expect(() => assertSafePublicUrl('https://example.com:443/')).not.toThrow();
    expect(() => assertSafePublicUrl('http://example.com:80/')).not.toThrow();
  });

  it('rejects an over-long URL', () => {
    expect(() => assertSafePublicUrl(`https://example.com/${'a'.repeat(3000)}`)).toThrow(
      /too long/,
    );
  });

  it('rejects unparseable input', () => {
    for (const url of ['', '   ', 'not a url', 'http://', '///']) {
      expect(() => assertSafePublicUrl(url), JSON.stringify(url)).toThrow();
    }
  });
});

describe('assertResolvedAddressesArePublic', () => {
  it('passes when every resolved address is public', () => {
    expect(() =>
      assertResolvedAddressesArePublic('example.com', ['93.184.216.34', '2606:2800:220:1::1']),
    ).not.toThrow();
  });

  it('refuses when any address is private — DNS rebinding defence', () => {
    // A public hostname with one private A record is the classic rebind.
    expect(() =>
      assertResolvedAddressesArePublic('evil.example.com', ['93.184.216.34', '127.0.0.1']),
    ).toThrow(/non-public address/);
  });

  it('refuses a hostname pointed at cloud metadata', () => {
    expect(() => assertResolvedAddressesArePublic('evil.example.com', ['169.254.169.254'])).toThrow(
      /non-public address/,
    );
  });

  it('refuses when nothing resolved', () => {
    expect(() => assertResolvedAddressesArePublic('nope.example.com', [])).toThrow(/resolve/);
  });
});

describe('normaliseUrl', () => {
  it('drops the fragment and lowercases the host', () => {
    expect(normaliseUrl('https://Example.COM/Path#section')).toBe('https://example.com/Path');
  });

  it('removes default ports', () => {
    expect(normaliseUrl('https://example.com:443/a')).toBe('https://example.com/a');
    expect(normaliseUrl('http://example.com:80/a')).toBe('http://example.com/a');
  });

  it('strips tracking parameters but keeps real ones', () => {
    expect(normaliseUrl('https://example.com/p?utm_source=x&id=7&fbclid=y')).toBe(
      'https://example.com/p?id=7',
    );
  });

  it('sorts query parameters so order does not create duplicates', () => {
    expect(normaliseUrl('https://example.com/p?b=2&a=1')).toBe(
      normaliseUrl('https://example.com/p?a=1&b=2'),
    );
  });

  it('collapses index.html and trailing slashes', () => {
    expect(normaliseUrl('https://example.com/dir/index.html')).toBe('https://example.com/dir');
    expect(normaliseUrl('https://example.com/dir/')).toBe('https://example.com/dir');
    expect(normaliseUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('resolves relative URLs against a base', () => {
    expect(normaliseUrl('/products/1', 'https://example.com/collections')).toBe(
      'https://example.com/products/1',
    );
    expect(normaliseUrl('../up', 'https://example.com/a/b/c')).toBe('https://example.com/a/up');
  });
});

describe('isSameSite', () => {
  it('ignores a www prefix', () => {
    expect(isSameSite('https://example.com/a', 'https://www.example.com/b')).toBe(true);
  });

  it('separates different hosts and subdomains', () => {
    expect(isSameSite('https://example.com', 'https://evil.com')).toBe(false);
    expect(isSameSite('https://example.com', 'https://shop.example.com')).toBe(false);
  });

  it('returns false rather than throwing on junk', () => {
    expect(isSameSite('not a url', 'https://example.com')).toBe(false);
  });
});
