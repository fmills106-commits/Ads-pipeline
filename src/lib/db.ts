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

/**
 * Runs `work` in a transaction, or joins the one already in progress.
 *
 * Every service here takes a `Db` so a caller can pass a transaction handle,
 * which means a function that wants atomicity cannot simply call
 * `$transaction` — Postgres has no nested transactions, and the handle does
 * not offer the method. Without this, such a function has to choose between
 * being atomic and being composable.
 *
 * Joining an outer transaction is the right semantics rather than a
 * concession: the caller has already said where the boundary is, and a
 * rollback out there should undo this work too.
 */
export async function inTransaction<T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  if ('$transaction' in db) return db.$transaction((tx) => work(tx));
  return work(db);
}
