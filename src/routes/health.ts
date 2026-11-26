import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { getEnv } from '../env.js';

const DEPLOYED_AT = new Date().toISOString();

export async function registerHealthRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  app.get('/health/db', async () => {
    const start = performance.now();
    await prisma.$queryRaw`SELECT 1`;
    const dbLatencyMs = Math.round(performance.now() - start);
    return { status: 'ok', dbLatencyMs };
  });

  app.get('/v1/version', async () => {
    const env = getEnv();
    return {
      version: env.APP_VERSION,
      gitSha: env.RENDER_GIT_COMMIT,
      deployedAt: DEPLOYED_AT,
    };
  });
}
