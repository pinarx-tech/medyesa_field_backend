import { PrismaClient } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext } from './helpers.js';

describe('Health & Metadata endpoints (Tests 1–3)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ prisma, app } = await createTestContext());
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('1. health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(res.json().timestamp).toBeTypeOf('string');
  });

  it('2. health/db returns latency and ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/db' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(res.json().dbLatencyMs).toBeTypeOf('number');
    expect(res.json().dbLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('3. version returns version + gitSha + deployedAt', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/version' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBeTypeOf('string');
    expect(body.gitSha).toBeTypeOf('string');
    expect(body.deployedAt).toBeTypeOf('string');
  });
});
