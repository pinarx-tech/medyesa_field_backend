import { PrismaClient, VisitVerificationStatus } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearerForUser,
  createTestContext,
  resetDatabase,
  seedCompanyWithUsers,
} from './helpers.js';

describe('Part 3 — HC Activity History (6 Operational Categories & 4-Way Filters)', () => {
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

  it('returns all 6 operational event categories, supports filters, and excludes non-business debug actions', async () => {
    const tenantA = await seedCompanyWithUsers(prisma, {
      code: 'compa',
      name: 'Company A',
    });
    const ter = await prisma.territory.create({
      data: { companyId: tenantA.company.id, code: 'SOUTH', name: 'South Zone' },
    });
    const [docVisited, docPending] = await Promise.all([
      prisma.doctor.create({
        data: { companyId: tenantA.company.id, name: 'Dr. Visited', specialty: 'Cardio' },
      }),
      prisma.doctor.create({
        data: { companyId: tenantA.company.id, name: 'Dr. Pending', specialty: 'Diab' },
      }),
    ]);

    await prisma.mrTerritoryAssignment.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        territoryId: ter.id,
        assignedByHeadControllerId: tenantA.hc.id,
      },
    });
    for (const d of [docVisited, docPending]) {
      await prisma.territoryDoctor.create({
        data: {
          companyId: tenantA.company.id,
          territoryId: ter.id,
          doctorId: d.id,
          assignedByHeadControllerId: tenantA.hc.id,
        },
      });
    }

    const t0 = new Date('2026-11-26T04:00:00.000Z');
    await prisma.activityLog.create({
      data: {
        companyId: tenantA.company.id,
        actorId: tenantA.mr.id,
        actorRole: tenantA.mr.role,
        actorDisplayName: tenantA.mr.displayName,
        actionType: 'mr_login',
        occurredAt: t0,
      },
    });
    await prisma.activityLog.create({
      data: {
        companyId: tenantA.company.id,
        actorId: tenantA.mr.id,
        actorRole: tenantA.mr.role,
        actorDisplayName: tenantA.mr.displayName,
        actionType: 'debug_token_refresh',
        occurredAt: t0,
      },
    });

    const wd = await prisma.workDay.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        startedAt: new Date('2026-11-26T04:10:00.000Z'),
        endedAt: new Date('2026-11-26T12:00:00.000Z'),
      },
    });

    const v1 = await prisma.visit.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        doctorId: docVisited.id,
        workDayId: wd.id,
        territoryIdAtVisit: ter.id,
        status: 'completed',
        checkInVerificationStatus: VisitVerificationStatus.outsideRadius,
        capturedAtClient: new Date('2026-11-26T05:00:00.000Z'),
      },
    });
    await prisma.visit.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        doctorId: docVisited.id,
        workDayId: wd.id,
        territoryIdAtVisit: ter.id,
        status: 'completed',
        correctsVisitId: v1.id,
        checkInVerificationStatus: VisitVerificationStatus.verified,
        capturedAtClient: new Date('2026-11-26T05:15:00.000Z'),
      },
    });

    const hcBearer = await bearerForUser(tenantA.hc);
    const allRes = await app.inject({
      method: 'GET',
      url: '/v1/hc/activity?date=2026-11-26&tzOffsetMinutes=330',
      headers: { authorization: hcBearer },
    });
    expect(allRes.statusCode).toBe(200);
    const categories = (allRes.json().events as Array<{ category: string }>).map(
      (e) => e.category,
    );

    expect(categories).toContain('employee_login');
    expect(categories).toContain('start_day');
    expect(categories).toContain('visit_completed');
    expect(categories).toContain('visit_corrected');
    expect(categories).toContain('end_day');
    expect(categories).toContain('pending_visit');
    expect(categories).toHaveLength(6);

    const filteredRes = await app.inject({
      method: 'GET',
      url: `/v1/hc/activity?date=2026-11-26&tzOffsetMinutes=330&mrId=${tenantA.mr.id}&territoryId=${ter.id}&category=visit_corrected`,
      headers: { authorization: hcBearer },
    });
    expect(filteredRes.statusCode).toBe(200);
    expect(filteredRes.json().events).toHaveLength(1);
    expect(filteredRes.json().events[0].doctorName).toBe('Dr. Visited');
    expect(filteredRes.json().events[0].statusLabel).toBe('Corrected');
  });
});
