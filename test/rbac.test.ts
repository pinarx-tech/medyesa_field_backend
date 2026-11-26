import { AccountStatus, PrismaClient, Role, VisitVerificationStatus } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_PASSWORD,
  bearerForUser,
  createTestContext,
  resetDatabase,
  seedCompanyWithUsers,
} from './helpers.js';
import { hashPassword } from '../src/lib/password.js';

describe('RBAC enforcement (Tests 21–23)', () => {
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

  it('21. hc cannot access /v1/admin/* (403 forbidden)', async () => {
    const { hc } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });
    const hcToken = await bearerForUser(hc);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/companies',
      headers: { authorization: hcToken },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('22. mr cannot access /v1/hc/* (403 forbidden)', async () => {
    const { mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });
    const mrToken = await bearerForUser(mr);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/hc/dashboard',
      headers: { authorization: mrToken },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it("23. mr cannot read another MR's visits (404 not_found)", async () => {
    const { company, mr: mr1 } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    const mr2 = await prisma.user.create({
      data: {
        companyId: company.id,
        employeeId: 'MR_TWO',
        email: 'mr2@medyesa.test',
        displayName: 'Second MR',
        passwordHash: await hashPassword(TEST_PASSWORD),
        role: Role.mr,
        accountStatus: AccountStatus.active,
      },
    });

    const doctor = await prisma.doctor.create({
      data: {
        companyId: company.id,
        name: 'Dr. Shared',
        specialty: 'Cardiology',
      },
    });

    const mr1Visit = await prisma.visit.create({
      data: {
        companyId: company.id,
        mrId: mr1.id,
        doctorId: doctor.id,
        status: 'completed',
        checkInVerificationStatus: VisitVerificationStatus.unverified,
        capturedAtClient: new Date(),
      },
    });

    const mr2Token = await bearerForUser(mr2);

    const todayRes = await app.inject({
      method: 'GET',
      url: '/v1/mr/today',
      headers: { authorization: mr2Token },
    });
    expect(todayRes.statusCode).toBe(200);
    expect(todayRes.json().visits).toHaveLength(0);

    const noteRes = await app.inject({
      method: 'PATCH',
      url: `/v1/mr/visits/${mr1Visit.id}/note`,
      headers: { authorization: mr2Token },
      payload: { noteText: 'Cannot touch MR1 visit' },
    });
    expect(noteRes.statusCode).toBe(404);
    expect(noteRes.json().error.code).toBe('not_found');
  });
});
