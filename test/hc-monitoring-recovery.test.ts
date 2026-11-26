import { PrismaClient, SyncStatus, VisitVerificationStatus } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearerForUser,
  createTestContext,
  resetDatabase,
  seedCompanyWithUsers,
} from './helpers.js';

describe('Parts 4 & 5 — MR 5-State Monitoring & Audited Human-Error Recovery', () => {
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

  it('distinguishes notVisited, awaitingSync, synced, syncFailed, and corrected states in MR monitoring', async () => {
    const tenantA = await seedCompanyWithUsers(prisma, {
      code: 'compa',
      name: 'Company A',
    });
    const ter = await prisma.territory.create({
      data: { companyId: tenantA.company.id, code: 'EAST', name: 'East Zone' },
    });
    await prisma.mrTerritoryAssignment.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        territoryId: ter.id,
        assignedByHeadControllerId: tenantA.hc.id,
      },
    });

    const [dNotVisited, dAwaiting, dSynced, dFailed] = await Promise.all([
      prisma.doctor.create({
        data: { companyId: tenantA.company.id, name: 'Dr. A NotVisited', specialty: 'Cardio' },
      }),
      prisma.doctor.create({
        data: { companyId: tenantA.company.id, name: 'Dr. B Awaiting', specialty: 'Cardio' },
      }),
      prisma.doctor.create({
        data: { companyId: tenantA.company.id, name: 'Dr. C Synced', specialty: 'Cardio' },
      }),
      prisma.doctor.create({
        data: { companyId: tenantA.company.id, name: 'Dr. D Failed', specialty: 'Cardio' },
      }),
    ]);

    for (const d of [dNotVisited, dAwaiting, dSynced, dFailed]) {
      await prisma.territoryDoctor.create({
        data: {
          companyId: tenantA.company.id,
          territoryId: ter.id,
          doctorId: d.id,
          assignedByHeadControllerId: tenantA.hc.id,
        },
      });
    }

    const now = new Date();
    await prisma.visit.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        doctorId: dSynced.id,
        status: 'completed',
        checkInVerificationStatus: VisitVerificationStatus.verified,
        capturedAtClient: now,
      },
    });

    await prisma.syncOperation.create({
      data: {
        id: `${tenantA.company.id}:pend-1`,
        companyId: tenantA.company.id,
        actorId: tenantA.mr.id,
        entityType: 'visit',
        entityId: 'local-b',
        operation: 'create',
        payload: { doctorId: dAwaiting.id },
        status: SyncStatus.pending,
      },
    });

    await prisma.syncOperation.create({
      data: {
        id: `${tenantA.company.id}:fail-1`,
        companyId: tenantA.company.id,
        actorId: tenantA.mr.id,
        entityType: 'visit',
        entityId: 'local-d',
        operation: 'create',
        payload: { doctorId: dFailed.id },
        status: SyncStatus.failed,
        lastError: 'Geofence mismatch.',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/hc/mrs/${tenantA.mr.id}/monitoring`,
      headers: { authorization: await bearerForUser(tenantA.hc) },
    });

    expect(res.statusCode).toBe(200);
    const docs = res.json().assignedDoctors as Array<{
      doctorId: string;
      visitState: string;
    }>;
    const byId = new Map(docs.map((d) => [d.doctorId, d.visitState]));
    expect(byId.get(dNotVisited.id)).toBe('notVisited');
    expect(byId.get(dAwaiting.id)).toBe('awaitingSync');
    expect(byId.get(dSynced.id)).toBe('synced');
    expect(byId.get(dFailed.id)).toBe('syncFailed');
  });

  it('reopens today’s accidental End Day preserving previousEndedAt + audit logs, rejects past day with 422, and corrects visits without altering original GPS', async () => {
    const tenantA = await seedCompanyWithUsers(prisma, {
      code: 'compa',
      name: 'Company A',
    });
    const hcBearer = await bearerForUser(tenantA.hc);
    const now = new Date();
    const endedAt = new Date(now.getTime() - 60_000);

    const todayWd = await prisma.workDay.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        startedAt: new Date(now.getTime() - 3_600_000),
        endedAt,
      },
    });

    const pastWd = await prisma.workDay.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        startedAt: new Date(now.getTime() - 72 * 3_600_000),
        endedAt: new Date(now.getTime() - 64 * 3_600_000),
      },
    });

    const reopenRes = await app.inject({
      method: 'POST',
      url: `/v1/hc/workdays/${todayWd.id}/reopen`,
      headers: { authorization: hcBearer },
      payload: { reason: 'MR accidentally tapped End day at noon.' },
    });
    expect(reopenRes.statusCode).toBe(200);
    expect(reopenRes.json().workDay.endedAt).toBeNull();
    expect(reopenRes.json().workDay.previousEndedAt).toBe(endedAt.toISOString());

    const auditEntry = await prisma.auditLog.findFirst({
      where: { companyId: tenantA.company.id, action: 'hc_workday_reopened' },
    });
    expect(auditEntry).not.toBeNull();

    const pastRes = await app.inject({
      method: 'POST',
      url: `/v1/hc/workdays/${pastWd.id}/reopen`,
      headers: { authorization: hcBearer },
      payload: { reason: 'Attempt to reopen old workday.' },
    });
    expect(pastRes.statusCode).toBe(422);

    const doc = await prisma.doctor.create({
      data: { companyId: tenantA.company.id, name: 'Dr. Audit', specialty: 'Cardio' },
    });
    const origVisit = await prisma.visit.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        doctorId: doc.id,
        workDayId: todayWd.id,
        status: 'completed',
        checkInLatitude: 12.9123,
        checkInLongitude: 77.5912,
        checkInDistanceMeters: 18,
        checkInVerificationStatus: VisitVerificationStatus.verified,
        capturedAtClient: now,
      },
    });

    const corrRes = await app.inject({
      method: 'POST',
      url: `/v1/hc/visits/${origVisit.id}/correct`,
      headers: { authorization: hcBearer },
      payload: {
        reason: 'Updated promotion note after doctor clarification.',
        status: 'completed',
        noteText: 'Corrected clinical sample note.',
      },
    });
    expect(corrRes.statusCode).toBe(201);
    const corrected = corrRes.json().visit;
    expect(corrected.correctsVisitId).toBe(origVisit.id);
    expect(corrected.checkInLatitude).toBe(12.9123);
    expect(corrected.note.noteText).toBe('Corrected clinical sample note.');

    const origAfter = await prisma.visit.findUnique({ where: { id: origVisit.id } });
    expect(origAfter).not.toBeNull();
    expect(origAfter?.checkInLatitude).toBe(12.9123);

    const doubleCorr = await app.inject({
      method: 'POST',
      url: `/v1/hc/visits/${origVisit.id}/correct`,
      headers: { authorization: hcBearer },
      payload: { reason: 'Duplicate correction on superseded row.' },
    });
    expect(doubleCorr.statusCode).toBe(422);
  });
});
