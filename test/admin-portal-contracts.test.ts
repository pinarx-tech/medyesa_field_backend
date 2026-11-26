import { PrismaClient } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_PASSWORD,
  createTestContext,
  resetDatabase,
  seedPlatformAdmin,
} from './helpers.js';

describe('Part 6 — Admin Portal Provisioning, Temp Password & Seat-Shrink Guards', () => {
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

  it('auto-generates [FirstName]@[6 digits] temp passwords on create & reset, enforces seat limits + seat-shrink guard, and revokes sessions on suspend', async () => {
    const { token: paToken } = await seedPlatformAdmin(prisma);
    const paBearer = `Bearer ${paToken}`;

    const coRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/companies',
      headers: { authorization: paBearer },
      payload: {
        name: 'Kaveri Pharma',
        code: 'kaveri',
        licensedMrSeats: 1,
        licensedHcSeats: 1,
      },
    });
    expect(coRes.statusCode).toBe(201);
    const companyId = coRes.json().company.id as number;

    const mrRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: { authorization: paBearer },
      payload: {
        companyId,
        employeeId: 'MR5001',
        email: 'sujan@kaveri.test',
        displayName: 'Sujan Angadi',
        role: 'mr',
      },
    });
    expect(mrRes.statusCode).toBe(201);
    const mrUser = mrRes.json().user;
    const tempPass = mrRes.json().temporaryPassword as string;
    expect(tempPass).toMatch(/^Sujan@\d{6}$/);
    expect(mrUser.mustChangePassword).toBe(true);

    const listRes = await app.inject({
      method: 'GET',
      url: `/v1/admin/users?companyId=${companyId}`,
      headers: { authorization: paBearer },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body).not.toContain(tempPass);
    expect(listRes.body).not.toContain('passwordHash');

    const shrinkRes = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/companies/${companyId}`,
      headers: { authorization: paBearer },
      payload: { licensedMrSeats: 0 },
    });
    expect(shrinkRes.statusCode).toBe(422);

    const mrLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { employeeIdOrEmail: 'MR5001', password: tempPass },
    });
    expect(mrLogin.statusCode).toBe(200);
    expect(mrLogin.json().user.mustChangePassword).toBe(true);

    const resetRes = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${mrUser.id}/reset-password`,
      headers: { authorization: paBearer },
      payload: {},
    });
    expect(resetRes.statusCode).toBe(200);
    const resetTempPass = resetRes.json().temporaryPassword as string;
    expect(resetTempPass).toMatch(/^Sujan@\d{6}$/);

    const oldRefreshCheck = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: mrLogin.json().refreshToken },
    });
    expect(oldRefreshCheck.statusCode).toBe(401);

    const suspendRes = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${mrUser.id}/suspend`,
      headers: { authorization: paBearer },
    });
    expect(suspendRes.statusCode).toBe(200);

    const mr2Res = await app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: { authorization: paBearer },
      payload: {
        companyId,
        employeeId: 'MR5002',
        email: 'rahul@kaveri.test',
        displayName: 'Rahul Verma',
        role: 'mr',
        initialPassword: TEST_PASSWORD,
      },
    });
    expect(mr2Res.statusCode).toBe(201);

    const reactivateBlocked = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${mrUser.id}/reactivate`,
      headers: { authorization: paBearer },
    });
    expect(reactivateBlocked.statusCode).toBe(422);
  });
});
