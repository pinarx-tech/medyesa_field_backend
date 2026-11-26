import { PrismaClient } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext } from './helpers.js';

describe('Rate limiting', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = '100';
    ({ prisma, app } = await createTestContext({ disableRateLimit: false }));
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('Rate limit enforcement: 101st request within a minute returns 429 rate_limited', async () => {
    for (let i = 1; i <= 100; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        remoteAddress: '198.51.100.42',
      });
      expect(res.statusCode, `Request #${i}`).toBe(200);
    }

    const blocked = await app.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: '198.51.100.42',
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('rate_limited');
  });
});
