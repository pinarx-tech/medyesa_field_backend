import { PrismaClient, VisitVerificationStatus } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearerForUser,
  createTestContext,
  resetDatabase,
  seedCompanyWithUsers,
} from './helpers.js';

describe('Verification integrity (Test 24)', () => {
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

  it('24. visit create with verificationStatus=\'verified\' and distanceMeters > geofenceRadiusMeters returns 422', async () => {
    const { company, mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });
    const doctor = await prisma.doctor.create({
      data: {
        companyId: company.id,
        name: 'Dr. Strict Geofence',
        specialty: 'Cardiology',
        geofenceRadiusMeters: 100,
      },
    });

    const mrBearer = await bearerForUser(mr);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/mr/visits',
      headers: { authorization: mrBearer },
      payload: {
        clientId: 'spoofed-verified-visit',
        doctorId: doctor.id,
        status: 'completed',
        checkInDistanceMeters: 250,
        checkInVerificationStatus: VisitVerificationStatus.verified,
        capturedAtClient: '2026-11-25T06:00:00.000Z',
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('business_rule_violation');

    // Outside radius without mandatory reason is accepted per §7.5
    const outsideOk = await app.inject({
      method: 'POST',
      url: '/v1/mr/visits',
      headers: { authorization: mrBearer },
      payload: {
        clientId: 'honest-outside-visit',
        doctorId: doctor.id,
        status: 'completed',
        checkInDistanceMeters: 250,
        checkInVerificationStatus: VisitVerificationStatus.outsideRadius,
        capturedAtClient: '2026-11-25T06:05:00.000Z',
      },
    });
    expect(outsideOk.statusCode).toBe(201);
  });
});
