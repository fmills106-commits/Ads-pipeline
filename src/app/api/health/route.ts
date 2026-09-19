import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';

/**
 * Liveness plus database reachability. Unauthenticated on purpose so a load
 * balancer can call it; it reveals nothing beyond up/down and mock mode.
 */
export async function GET(): Promise<NextResponse> {
  const env = getEnv();
  let database: 'up' | 'down' = 'down';

  try {
    await prisma.$queryRaw`SELECT 1`;
    database = 'up';
  } catch {
    database = 'down';
  }

  return NextResponse.json(
    {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      zeroCostMode: env.ZERO_COST_MODE,
      timestamp: new Date().toISOString(),
    },
    { status: database === 'up' ? 200 : 503 },
  );
}
