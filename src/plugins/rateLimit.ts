import rateLimit from '@fastify/rate-limit';
import { FastifyInstance } from 'fastify';
import { getEnv } from '../env.js';

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  const env = getEnv();
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    errorResponseBuilder: (req, context) => ({
      statusCode: 429,
      error: {
        code: 'rate_limited',
        message: `Rate limit exceeded. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
        requestId: req.id,
      },
    }),
  });
}
