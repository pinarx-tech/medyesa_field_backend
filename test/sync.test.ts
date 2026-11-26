import { PrismaClient, VisitVerificationStatus } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearerForUser,
  createTestContext,
  resetDatabase,
  seedCompanyWithUsers,
} from './helpers.js';

describe('Sync & Idempotency conflict handling (Test 25)', () => {
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

  it("25. sync batch with reused clientId and different payload returns failed with code 'conflict' (not a 500)", async () => {
    const { company, mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    const doctor1 = await prisma.doctor.create({
      data: {
        companyId: company.id,
        name: 'Dr. First Clinic',
        specialty: 'General Medicine',
      },
    });

    const doctor2 = await prisma.doctor.create({
      data: {
        companyId: company.id,
        name: 'Dr. Second Clinic',
        specialty: 'Pediatrics',
      },
    });

    const mrBearer = await bearerForUser(mr);
    const reusedClientId = 'client-op-uuid-12345';

    // 1. Initial sync operation: creates visit with doctor1
    const firstSync = await app.inject({
      method: 'POST',
      url: '/v1/mr/sync/batch',
      headers: { authorization: mrBearer },
      payload: {
        operations: [
          {
            clientId: reusedClientId,
            entityId: 'visit-entity-local-1',
            entityType: 'visit',
            operation: 'create',
            capturedAtClient: '2026-11-25T08:00:00.000Z',
            payload: {
              doctorId: doctor1.id,
              status: 'completed',
              checkInVerificationStatus: VisitVerificationStatus.unverified,
              capturedAtClient: '2026-11-25T08:00:00.000Z',
            },
          },
        ],
      },
    });

    expect(firstSync.statusCode).toBe(200);
    const firstResults = firstSync.json().results;
    expect(firstResults).toHaveLength(1);
    expect(firstResults[0].clientId).toBe(reusedClientId);
    expect(firstResults[0].status).toBe('synced');

    // 2. Second sync operation with SAME clientId but DIFFERENT payload (doctor2)
    // Server must return 200 with per-op failure status='failed' and code='conflict', NEVER a 500
    const secondSync = await app.inject({
      method: 'POST',
      url: '/v1/mr/sync/batch',
      headers: { authorization: mrBearer },
      payload: {
        operations: [
          {
            clientId: reusedClientId,
            entityId: 'visit-entity-local-1',
            entityType: 'visit',
            operation: 'create',
            capturedAtClient: '2026-11-25T08:00:00.000Z',
            payload: {
              doctorId: doctor2.id, // Different doctor! Conflicting payload!
              status: 'completed',
              checkInVerificationStatus: VisitVerificationStatus.unverified,
              capturedAtClient: '2026-11-25T08:00:00.000Z',
            },
          },
        ],
      },
    });

    expect(secondSync.statusCode).toBe(200);
    const secondResults = secondSync.json().results;
    expect(secondResults).toHaveLength(1);
    expect(secondResults[0].clientId).toBe(reusedClientId);
    expect(secondResults[0].status).toBe('failed');
    expect(secondResults[0].error.code).toBe('conflict');
  });
});
