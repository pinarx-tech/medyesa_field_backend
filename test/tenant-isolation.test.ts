import { PrismaClient, VisitVerificationStatus } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearerForUser,
  createTestContext,
  resetDatabase,
  seedCompanyWithUsers,
} from './helpers.js';

describe('Tenant isolation (Tests 9–12)', () => {
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

  it('9–12. Company A HC/MR cannot read/update/delete Company B entities (404, never 403), while Company A own data returns 200', async () => {
    const tenantA = await seedCompanyWithUsers(prisma, {
      code: 'compa',
      name: 'Company A',
    });
    const tenantB = await seedCompanyWithUsers(prisma, {
      code: 'compb',
      name: 'Company B',
    });

    const hcAToken = await bearerForUser(tenantA.hc);
    const mrAToken = await bearerForUser(tenantA.mr);

    // Seed full entity graph inside Company A and Company B
    const terA = await prisma.territory.create({
      data: { companyId: tenantA.company.id, code: 'TER_A', name: 'Zone A' },
    });
    const docA = await prisma.doctor.create({
      data: {
        companyId: tenantA.company.id,
        name: 'Dr. Alpha',
        specialty: 'Cardiology',
      },
    });

    const terB = await prisma.territory.create({
      data: { companyId: tenantB.company.id, code: 'TER_B', name: 'Zone B' },
    });
    const docB = await prisma.doctor.create({
      data: {
        companyId: tenantB.company.id,
        name: 'Dr. Beta',
        specialty: 'Neurology',
      },
    });
    await prisma.territoryDoctor.create({
      data: {
        companyId: tenantB.company.id,
        territoryId: terB.id,
        doctorId: docB.id,
        assignedByHeadControllerId: tenantB.hc.id,
      },
    });
    const workDayB = await prisma.workDay.create({
      data: {
        companyId: tenantB.company.id,
        mrId: tenantB.mr.id,
        startedAt: new Date(),
      },
    });
    const visitB = await prisma.visit.create({
      data: {
        companyId: tenantB.company.id,
        mrId: tenantB.mr.id,
        doctorId: docB.id,
        workDayId: workDayB.id,
        status: 'completed',
        checkInVerificationStatus: VisitVerificationStatus.unverified,
        capturedAtClient: new Date(),
      },
    });
    await prisma.activityLog.create({
      data: {
        companyId: tenantB.company.id,
        actorId: tenantB.mr.id,
        actorRole: tenantB.mr.role,
        actorDisplayName: tenantB.mr.displayName,
        actionType: 'visit_completed',
        subjectType: 'visit',
        subjectId: visitB.id,
      },
    });

    // Company A HC cross-tenant mutations/reads must return 404 (no existence leak)
    const crossChecks = [
      {
        method: 'PATCH' as const,
        url: `/v1/hc/doctors/${docB.id}`,
        payload: { name: 'Hijacked' },
      },
      {
        method: 'POST' as const,
        url: `/v1/hc/doctors/${docB.id}/archive`,
      },
      {
        method: 'PATCH' as const,
        url: `/v1/hc/territories/${terB.id}`,
        payload: { name: 'Hijacked Zone' },
      },
      {
        method: 'POST' as const,
        url: `/v1/hc/territories/${terB.id}/archive`,
      },
      {
        method: 'POST' as const,
        url: `/v1/hc/territories/${terB.id}/doctors`,
        payload: { doctorId: docA.id },
      },
      {
        method: 'DELETE' as const,
        url: `/v1/hc/territories/${terB.id}/doctors/${docB.id}`,
      },
      {
        method: 'POST' as const,
        url: `/v1/hc/mrs/${tenantB.mr.id}/territory`,
        payload: { territoryId: terA.id },
      },
      {
        method: 'GET' as const,
        url: `/v1/hc/mrs/${tenantB.mr.id}/activity`,
      },
    ];

    for (const check of crossChecks) {
      const res = await app.inject({
        method: check.method,
        url: check.url,
        headers: { authorization: hcAToken },
        ...(check.payload ? { payload: check.payload } : {}),
      });
      expect(res.statusCode, `${check.method} ${check.url}`).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }

    // Company A HC lists must contain zero Company B rows
    const [docsRes, tersRes, mrsRes, actRes] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/v1/hc/doctors',
        headers: { authorization: hcAToken },
      }),
      app.inject({
        method: 'GET',
        url: '/v1/hc/territories',
        headers: { authorization: hcAToken },
      }),
      app.inject({
        method: 'GET',
        url: '/v1/hc/mrs',
        headers: { authorization: hcAToken },
      }),
      app.inject({
        method: 'GET',
        url: '/v1/hc/activity',
        headers: { authorization: hcAToken },
      }),
    ]);

    expect(docsRes.statusCode).toBe(200);
    expect(docsRes.json().doctors.map((d: { id: string }) => d.id)).toEqual([
      docA.id,
    ]);
    expect(tersRes.json().territories.map((t: { id: string }) => t.id)).toEqual(
      [terA.id],
    );
    expect(mrsRes.json().mrs.map((m: { id: string }) => m.id)).toEqual([
      tenantA.mr.id,
    ]);
    expect(actRes.json().events).toHaveLength(0);

    // Company A HC can update own Company A doctor -> 200
    const ownUpdate = await app.inject({
      method: 'PATCH',
      url: `/v1/hc/doctors/${docA.id}`,
      headers: { authorization: hcAToken },
      payload: { name: 'Dr. Alpha Updated' },
    });
    expect(ownUpdate.statusCode).toBe(200);

    // Company A MR cannot touch or view Company B MR's visit -> 404
    const mrCrossNote = await app.inject({
      method: 'PATCH',
      url: `/v1/mr/visits/${visitB.id}/note`,
      headers: { authorization: mrAToken },
      payload: { noteText: 'Unauthorized edit' },
    });
    expect(mrCrossNote.statusCode).toBe(404);

    const mrAToday = await app.inject({
      method: 'GET',
      url: '/v1/mr/today',
      headers: { authorization: mrAToken },
    });
    expect(mrAToday.statusCode).toBe(200);
    expect(mrAToday.json().visits).toHaveLength(0);
  });
});
