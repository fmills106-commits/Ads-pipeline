import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { getEnv } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { FREE_USAGE, type ProviderResult, type StorageProvider, type StoredObject } from '../types';

/**
 * Local filesystem storage. Free, and the default.
 *
 * Creative images, scraped page snapshots and uploaded brand assets all live
 * under `STORAGE_LOCAL_PATH`. An S3-compatible provider is an optional upgrade
 * for multi-instance deployments; nothing requires it, and MinIO covers that
 * case for free too.
 */

const DESCRIPTOR = {
  key: 'storage.local',
  capability: 'STORAGE' as const,
  tier: 'LOCAL_FREE' as const,
  label: 'Local disk (free)',
  description: 'Stores creatives and assets on this machine. Costs nothing.',
  priority: 0,
  isConfigured: () => true,
};

/** Storage keys come from untrusted places, so traversal is blocked explicitly. */
function safeJoin(root: string, key: string): string {
  if (key.length === 0) throw new AppError('VALIDATION_ERROR', 'Storage key must not be empty');
  if (key.includes('\0'))
    throw new AppError('VALIDATION_ERROR', 'Storage key contains a null byte');

  const absoluteRoot = resolve(root);
  const target = resolve(join(absoluteRoot, key));

  if (target !== absoluteRoot && !target.startsWith(absoluteRoot + sep)) {
    throw new AppError('VALIDATION_ERROR', 'Storage key escapes the storage root', {
      details: { key },
      publicMessage: 'That file path is not allowed.',
    });
  }
  return target;
}

class LocalStorageProvider implements StorageProvider {
  readonly descriptor = DESCRIPTOR;

  private get root(): string {
    return resolve(getEnv().STORAGE_LOCAL_PATH);
  }

  async put(key: string, bytes: Buffer, mimeType: string): Promise<ProviderResult<StoredObject>> {
    const path = safeJoin(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);

    return {
      value: { key, bytes: bytes.length, mimeType },
      usage: FREE_USAGE(bytes.length, 'bytes'),
    };
  }

  async get(key: string): Promise<ProviderResult<Buffer>> {
    const path = safeJoin(this.root, key);
    try {
      const bytes = await readFile(path);
      return { value: bytes, usage: FREE_USAGE(bytes.length, 'bytes') };
    } catch (cause) {
      throw new AppError('NOT_FOUND', `Stored object "${key}" not found`, { cause });
    }
  }

  async delete(key: string): Promise<ProviderResult<void>> {
    await rm(safeJoin(this.root, key), { force: true });
    return { value: undefined, usage: FREE_USAGE(1, 'objects') };
  }

  urlFor(key: string): string {
    // Served by the application rather than exposed directly, so tenant checks
    // apply to asset reads the same as to any other resource.
    return `/api/assets/${encodeURIComponent(key)}`;
  }
}

export const createLocalStorageProvider = (): StorageProvider => new LocalStorageProvider();
export const localStorageDescriptor = DESCRIPTOR;

/** Content-addressed key, so identical bytes are stored once. */
export function storageKeyFor(businessId: string, bytes: Buffer, extension: string): string {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  return `${businessId}/${digest}.${extension.replace(/^\./, '')}`;
}
