import { PrismaClient } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_PASSWORD,
  createTestContext,
  resetDatabase,
  seedPlatformAdmin,
} from './helpers.js';

describe('Admin provisioning & seat limits (Tests 19–20)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ prisma, app } = await createTestContext());
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('19. admin create company (platformAdmin only)', async () => {
    const { token: paToken } = await seedPlatformAdmin(prisma);
    const paBearer = `Bearer ${paToken}`;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/companies',
      headers: { authorization: paBearer },
      payload: {
        name: 'Novartis Healthcare',
        code: 'novartis',
        licensedMrSeats: 15,
        licensedHcSeats: 3,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.company.id).toBeTypeOf('number');
    expect(body.company.code).toBe('novartis');
    expect(body.company.licensedMrSeats).toBe(15);
  });

  it('20. admin create user respects MR seat limit (422)', async () => {
    const { token: paToken } = await seedPlatformAdmin(prisma);
    const paBearer = `Bearer ${paToken}`;

    // Create company with 2 MR seats
    const createCoRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/companies',
      headers: { authorization: paBearer },
      payload: {
        name: 'Small Pharma',
        code: 'small',
        licensedMrSeats: 2,
        licensedHcSeats: 1,
      },
    });
    expect(createCoRes.statusCode).toBe(201);
    const companyId = createCoRes.json().company.id as number;

    // 1st MR succeeds
    const mr1 = await app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: { authorization: paBearer },
      payload: {
        companyId,
        employeeId: 'MR_001',
        email: 'mr1@small.test',
        displayName: 'MR One',
        role: 'mr',
        initialPassword: TEST_PASSWORD,
      },
    });
    expect(mr1.statusCode).toBe(201);

    // 2nd MR succeeds
    const mr2 = await app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: { authorization: paBearer },
      payload: {
        companyId,
        employeeId: 'MR_002',
        email: 'mr2@small.test',
        displayName: 'MR Two',
        role: 'mr',
        initialPassword: TEST_PASSWORD,
      },
    });
    expect(mr2.statusCode).toBe(201);

    // 3rd MR exceeds seat limit of 2 -> 422
    const mr3 = await app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: { authorization: paBearer },
      payload: {
        companyId,
        employeeId: 'MR_003',
        email: 'mr3@small.test',
        displayName: 'MR Three',
        role: 'mr',
        initialPassword: TEST_PASSWORD,
      },
    });
    expect(mr3.statusCode).toBe(422);
    expect(mr3.json().error.code).toBe('business_rule_violation');
  });
});
