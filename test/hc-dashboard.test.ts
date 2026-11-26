import {
  AccountStatus,
  PrismaClient,
  Role,
  SyncStatus,
  VisitVerificationStatus,
} from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password.js';
import {
  TEST_PASSWORD,
  bearerForUser,
  createTestContext,
  resetDatabase,
  seedCompanyWithUsers,
} from './helpers.js';

describe('Part 1 — HC Dashboard 6 Metrics & Isolation', () => {
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

  it('computes all 6 metrics accurately, excludes superseded visits from double-counting, separates pending visits from sync failures, and excludes Company B', async () => {
    const tenantA = await seedCompanyWithUsers(prisma, {
      code: 'compa',
      name: 'Company A',
    });
    const tenantB = await seedCompanyWithUsers(prisma, {
      code: 'compb',
      name: 'Company B',
    });

    // Add second active MR in Company A (who has NOT started today)
    await prisma.user.create({
      data: {
        companyId: tenantA.company.id,
        employeeId: 'MR_COMPA_2',
        email: 'mr2@compa.test',
        displayName: 'Not Started MR',
        passwordHash: await hashPassword(TEST_PASSWORD),
        role: Role.mr,
        accountStatus: AccountStatus.active,
      },
    });

    // Assign territory with 3 active doctors to tenantA.mr
    const terA = await prisma.territory.create({
      data: { companyId: tenantA.company.id, code: 'ZONEA', name: 'Zone A' },
    });
    await prisma.mrTerritoryAssignment.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        territoryId: terA.id,
        assignedByHeadControllerId: tenantA.hc.id,
      },
    });

    const [doc1, doc2, doc3] = await Promise.all([
      prisma.doctor.create({
        data: { companyId: tenantA.company.id, name: 'Dr. One', specialty: 'Cardio' },
      }),
      prisma.doctor.create({
        data: { companyId: tenantA.company.id, name: 'Dr. Two', specialty: 'Diab' },
      }),
      prisma.doctor.create({
        data: { companyId: tenantA.company.id, name: 'Dr. Three', specialty: 'Neuro' },
      }),
    ]);

    for (const d of [doc1, doc2, doc3]) {
      await prisma.territoryDoctor.create({
        data: {
          companyId: tenantA.company.id,
          territoryId: terA.id,
          doctorId: d.id,
          assignedByHeadControllerId: tenantA.hc.id,
        },
      });
    }

    const now = new Date('2026-11-26T05:00:00.000Z'); // 10:30 AM IST on 2026-11-26
    const wdA = await prisma.workDay.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        startedAt: now,
      },
    });

    // Original visit to doc1 + correcting re-record visit -> must count as 1 completed visit, NOT 2!
    const origVisit = await prisma.visit.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        doctorId: doc1.id,
        workDayId: wdA.id,
        status: 'completed',
        checkInVerificationStatus: VisitVerificationStatus.outsideRadius,
        capturedAtClient: now,
      },
    });
    await prisma.visit.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        doctorId: doc1.id,
        workDayId: wdA.id,
        status: 'completed',
        correctsVisitId: origVisit.id,
        checkInVerificationStatus: VisitVerificationStatus.verified,
        capturedAtClient: new Date('2026-11-26T05:10:00.000Z'),
      },
    });

    // 1 failed SyncOperation for tenantA.mr (strictly distinct from pending visits)
    await prisma.syncOperation.create({
      data: {
        id: `${tenantA.company.id}:fail-op-1`,
        companyId: tenantA.company.id,
        actorId: tenantA.mr.id,
        entityType: 'visit',
        entityId: 'local-fail-1',
        operation: 'create',
        payload: {},
        status: SyncStatus.failed,
        lastError: 'Distance exceeds geofence radius.',
      },
    });

    // Seed noise in Company B that MUST NEVER appear in Company A dashboard
    await prisma.workDay.create({
      data: { companyId: tenantB.company.id, mrId: tenantB.mr.id, startedAt: now },
    });
    await prisma.syncOperation.create({
      data: {
        id: `${tenantB.company.id}:fail-b`,
        companyId: tenantB.company.id,
        actorId: tenantB.mr.id,
        entityType: 'visit',
        entityId: 'local-b',
        operation: 'create',
        payload: {},
        status: SyncStatus.failed,
      },
    });

    const hcABearer = await bearerForUser(tenantA.hc);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/hc/dashboard?date=2026-11-26&tzOffsetMinutes=330',
      headers: { authorization: hcABearer },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.company.code).toBe('compa');
    expect(body.metrics).toEqual({
      totalAssignedMrs: 2,
      mrsCurrentlyWorking: 1,
      mrsNotStarted: 1,
      mrsEndedToday: 0,
      visitsCompletedToday: 1,
      visitsPendingToday: 2,
      syncFailuresCount: 1,
    });
    expect(body.mrSummaries).toHaveLength(2);
    // MR with sync failure sorted first by operational urgency
    expect(body.mrSummaries[0].mrId).toBe(tenantA.mr.id);
    expect(body.mrSummaries[0].syncFailuresCount).toBe(1);
    expect(body.mrSummaries[0].visitsPendingToday).toBe(2);
  });

  it('returns clean zeros and empty MR list for a brand-new company with a new HC', async () => {
    const company = await prisma.company.create({
      data: { name: 'Fresh Pharma', code: 'fresh' },
    });
    const freshHc = await prisma.user.create({
      data: {
        companyId: company.id,
        employeeId: 'HC_FRESH',
        email: 'hc@fresh.test',
        displayName: 'Fresh HC',
        passwordHash: await hashPassword(TEST_PASSWORD),
        role: Role.headController,
        accountStatus: AccountStatus.active,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/hc/dashboard?date=2026-11-26&tzOffsetMinutes=330',
      headers: { authorization: await bearerForUser(freshHc) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metrics).toEqual({
      totalAssignedMrs: 0,
      mrsCurrentlyWorking: 0,
      mrsNotStarted: 0,
      mrsEndedToday: 0,
      visitsCompletedToday: 0,
      visitsPendingToday: 0,
      syncFailuresCount: 0,
    });
    expect(body.mrSummaries).toEqual([]);
  });
});
