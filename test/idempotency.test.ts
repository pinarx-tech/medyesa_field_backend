import { PrismaClient, VisitVerificationStatus } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearerForUser,
  createTestContext,
  resetDatabase,
  seedCompanyWithUsers,
} from './helpers.js';

describe('Idempotency invariants', () => {
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

  it('Idempotency: POST /v1/mr/visits with the same clientId twice returns the same serverId and stores one row', async () => {
    const { company, mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });
    const doctor = await prisma.doctor.create({
      data: {
        companyId: company.id,
        name: 'Dr. Idempotent',
        specialty: 'Cardiology',
      },
    });

    const mrBearer = await bearerForUser(mr);
    const payload = {
      clientId: 'client-visit-001',
      doctorId: doctor.id,
      status: 'completed',
      checkInDistanceMeters: 35,
      checkInVerificationStatus: VisitVerificationStatus.verified,
      capturedAtClient: '2026-11-25T05:00:00.000Z',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/mr/visits',
      headers: { authorization: mrBearer },
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/mr/visits',
      headers: { authorization: mrBearer },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().serverId).toBe(first.json().serverId);
    expect(second.json().deduplicated).toBe(true);

    const count = await prisma.visit.count({ where: { companyId: company.id } });
    expect(count).toBe(1);
  });

  it('Idempotency: POST /v1/mr/sync/batch retried is fully idempotent', async () => {
    const { company, mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });
    const doctor = await prisma.doctor.create({
      data: {
        companyId: company.id,
        name: 'Dr. Batch',
        specialty: 'Diabetology',
      },
    });

    const mrBearer = await bearerForUser(mr);
    const batchPayload = {
      operations: [
        {
          clientId: 'batch-wd-start-1',
          entityType: 'workDay',
          entityId: 'wd-local-1',
          operation: 'start',
          payload: { startedAt: '2026-11-25T04:00:00.000Z' },
          capturedAtClient: '2026-11-25T04:00:00.000Z',
        },
        {
          clientId: 'batch-visit-1',
          entityType: 'visit',
          entityId: 'visit-local-1',
          operation: 'create',
          payload: {
            doctorId: doctor.id,
            status: 'completed',
            checkInDistanceMeters: 42,
            checkInVerificationStatus: VisitVerificationStatus.verified,
          },
          capturedAtClient: '2026-11-25T05:15:00.000Z',
        },
      ],
    };

    const run1 = await app.inject({
      method: 'POST',
      url: '/v1/mr/sync/batch',
      headers: { authorization: mrBearer },
      payload: batchPayload,
    });
    expect(run1.statusCode).toBe(200);
    expect(run1.json().results[0].status).toBe('synced');
    expect(run1.json().results[1].status).toBe('synced');

    const run2 = await app.inject({
      method: 'POST',
      url: '/v1/mr/sync/batch',
      headers: { authorization: mrBearer },
      payload: batchPayload,
    });
    expect(run2.statusCode).toBe(200);
    expect(run2.json().results[0].serverId).toBe(run1.json().results[0].serverId);
    expect(run2.json().results[1].serverId).toBe(run1.json().results[1].serverId);
    expect(run2.json().results[1].deduplicated).toBe(true);

    expect(await prisma.workDay.count({ where: { companyId: company.id } })).toBe(1);
    expect(await prisma.visit.count({ where: { companyId: company.id } })).toBe(1);
  });
});
