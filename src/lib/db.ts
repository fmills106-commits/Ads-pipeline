import { PrismaClient } from '@prisma/client';
import { getEnv } from './env';

/**
 * The Prisma client singleton.
 *
 * Next.js reloads modules in development, so the instance is stashed on
 * `globalThis` to avoid exhausting the connection pool across hot reloads.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const env = getEnv();
  return new PrismaClient({
    log:
      env.LOG_LEVEL === 'trace' || env.LOG_LEVEL === 'debug'
        ? ['query', 'warn', 'error']
        : ['warn', 'error'],
    datasources: { db: { url: env.DATABASE_URL } },
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (getEnv().NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/** The subset of the client usable inside `prisma.$transaction(...)`. */
export type PrismaTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** Accepts either the root client or a transaction handle. */
export type Db = PrismaClient | PrismaTransaction;
