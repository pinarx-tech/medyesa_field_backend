import { PrismaClient, Role, VisitVerificationStatus } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearerForUser,
  createTestContext,
  resetDatabase,
  seedCompanyWithUsers,
  seedPlatformAdmin,
} from './helpers.js';

describe('Phase 10 Security & Isolation Audit', () => {
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

  it('prevents HC and MR from Company A from accessing or mutating Company B resources and enforces role boundaries', async () => {
    await seedPlatformAdmin(prisma);
    const tenantA = await seedCompanyWithUsers(prisma, {
      code: 'pilota',
      name: 'Pilot Pharma A',
    });
    const tenantB = await seedCompanyWithUsers(prisma, {
      code: 'pilotb',
      name: 'Pilot Pharma B',
    });

    const clinicB = await prisma.clinic.create({
      data: {
        companyId: tenantB.company.id,
        name: 'Confidential Clinic B',
        normalizedName: 'confidentialclinicb',
        formattedAddress: 'MG Road, Bengaluru',
        latitude: 12.97,
        longitude: 77.59,
      },
    });
    const terB = await prisma.territory.create({
      data: {
        companyId: tenantB.company.id,
        code: 'ZONE_B',
        name: 'Zone B',
      },
    });
    const docB = await prisma.doctor.create({
      data: {
        companyId: tenantB.company.id,
        clinicId: clinicB.id,
        name: 'Dr. B Confidential',
        specialty: 'Oncology',
      },
    });
    const visitB = await prisma.visit.create({
      data: {
        companyId: tenantB.company.id,
        mrId: tenantB.mr.id,
        doctorId: docB.id,
        status: 'completed',
        checkInVerificationStatus: VisitVerificationStatus.verified,
        capturedAtClient: new Date(),
      },
    });

    const hcAToken = await bearerForUser(tenantA.hc);
    const mrAToken = await bearerForUser(tenantA.mr);

    // Company A HC cannot read or mutate Company B records (404).
    for (const req of [
      { method: 'GET' as const, url: `/v1/hc/doctors/${docB.id}` },
      { method: 'GET' as const, url: `/v1/hc/territories/${terB.id}` },
      { method: 'GET' as const, url: `/v1/hc/mrs/${tenantB.mr.id}/monitoring` },
      {
        method: 'PATCH' as const,
        url: `/v1/hc/clinics/${clinicB.id}`,
        payload: { name: 'Tampered' },
      },
      { method: 'POST' as const, url: `/v1/hc/mrs/${tenantB.mr.id}/deactivate` },
    ]) {
      const res = await app.inject({
        ...req,
        headers: { authorization: hcAToken },
      });
      expect(res.statusCode).toBe(404);
    }

    // MR from Company A cannot call HC or Platform Admin endpoints (403).
    const mrToHc = await app.inject({
      method: 'GET',
      url: '/v1/hc/dashboard',
      headers: { authorization: mrAToken },
    });
    expect(mrToHc.statusCode).toBe(403);

    const mrToAdmin = await app.inject({
      method: 'GET',
      url: '/v1/admin/companies',
      headers: { authorization: mrAToken },
    });
    expect(mrToAdmin.statusCode).toBe(403);

    // MR from Company A cannot upsert notes on Company B's visit.
    const mrNoteOnB = await app.inject({
      method: 'PUT',
      url: `/v1/mr/visits/${visitB.id}/note`,
      headers: { authorization: mrAToken },
      payload: { noteText: 'Unauthorized note' },
    });
    expect(mrNoteOnB.statusCode).toBe(404);

    // Deactivated user account blocks existing access tokens immediately with 403 account_inactive.
    await prisma.user.update({
      where: { id: tenantA.hc.id },
      data: { accountStatus: 'deactivated' },
    });
    const blockedHc = await app.inject({
      method: 'GET',
      url: '/v1/hc/dashboard',
      headers: { authorization: hcAToken },
    });
    expect(blockedHc.statusCode).toBe(403);
    expect(blockedHc.json().error.code).toBe('account_inactive');
  });

  it('forgot-password returns clean 501 copy without Chunk/STUB leaks and user listing never leaks password hashes', async () => {
    const { token: paToken } = await seedPlatformAdmin(prisma);
    const { mr } = await seedCompanyWithUsers(prisma, {
      code: 'sec',
      name: 'Sec Co',
    });

    const forgotRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email: mr.email },
    });
    expect(forgotRes.statusCode).toBe(501);
    expect(forgotRes.body).not.toContain('Chunk');
    expect(forgotRes.body).not.toContain('STUB');

    const usersRes = await app.inject({
      method: 'GET',
      url: '/v1/admin/users',
      headers: { authorization: `Bearer ${paToken}` },
    });
    expect(usersRes.statusCode).toBe(200);
    expect(usersRes.body).not.toContain('passwordHash');
    expect(
      usersRes.json().users.every((u: { role: Role }) => u.role !== undefined),
    ).toBe(true);
  });

  it('rejects disallowed browser origins on CORS preflight while permitting configured origin', async () => {
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'GET',
      },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://localhost:3000',
    );

    const disallowed = await app.inject({
      method: 'OPTIONS',
      url: '/v1/admin/companies',
      headers: {
        origin: 'https://untrusted.example.com',
        'access-control-request-method': 'DELETE',
      },
    });
    expect(disallowed.headers['access-control-allow-origin']).toBeUndefined();
  });
});
