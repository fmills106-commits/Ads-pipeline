import { NextResponse } from 'next/server';
import { notFound } from '@/lib/errors';
import { route } from '@/server/api/handler';
import { loadEnabledPaidProviders, runProvider } from '@/server/providers';
import type { StorageProvider } from '@/server/providers/types';
import { requireBusinessContext } from '@/server/tenancy/context';

/**
 * Serves a stored object.
 *
 * `StorageProvider.urlFor()` has pointed at this path since Phase 1, and until
 * now nothing answered it — harmless only because nothing has been stored yet.
 * Phase 4 starts writing creatives here, and a public deployment should not
 * grow that route under time pressure, so it lands with the hardening.
 *
 * Why the application serves bytes instead of handing out a bucket URL: the
 * first segment of every key is the owning business (see `storageKeyFor`), and
 * routing reads through here means an asset is subject to the same membership
 * check as every other tenant-scoped resource. A signed bucket URL, once
 * leaked, is valid for anyone who has it.
 */

/** Content types we are willing to serve back. Anything else is a download. */
const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
};

export const GET = route({}, async ({ params, user }) => {
  const segments = params['key'];
  const parts = Array.isArray(segments) ? segments : segments ? [segments] : [];
  const key = parts.map((part) => decodeURIComponent(part)).join('/');

  // `..` in a key would escape the storage root. The provider's `safeJoin`
  // refuses it too; rejecting here means the attempt never reaches the disk.
  if (key === '' || key.includes('..') || key.startsWith('/')) {
    throw notFound('Asset not found');
  }

  const businessId = parts[0];
  if (!businessId) throw notFound('Asset not found');

  /*
   * The membership check. `requireBusinessContext` raises TENANT_MISMATCH for
   * a business in someone else's workspace, which maps to 404 — so a caller
   * cannot tell an asset they may not read from one that does not exist.
   */
  const context = await requireBusinessContext(user, businessId);

  const enabledPaid = await loadEnabledPaidProviders(context.workspace.id);
  const outcome = await runProvider<StorageProvider, Buffer>({
    capability: 'STORAGE',
    kind: 'STORAGE',
    workspaceId: context.workspace.id,
    businessId: context.businessId,
    subjectType: 'Asset',
    subjectId: key,
    enabledPaid,
    execute: (provider) => provider.get(key),
  });

  const extension = key.split('.').pop()?.toLowerCase() ?? '';
  const contentType = CONTENT_TYPES[extension] ?? 'application/octet-stream';

  return new NextResponse(new Uint8Array(outcome.value), {
    headers: {
      'content-type': contentType,
      'content-length': String(outcome.value.length),
      /*
       * Keys are content-addressed — the digest is in the filename — so the
       * bytes behind one key never change and can be cached hard. `private`
       * keeps it out of shared caches, because the response was authorised
       * for this user and a shared cache would serve it to the next one.
       */
      'cache-control': 'private, max-age=31536000, immutable',
      // Stored bytes came from a third-party website. Never let a browser
      // decide for itself that an object is HTML and run it.
      'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename="${encodeURIComponent(key.split('/').pop() ?? 'asset')}"`,
    },
  });
});
