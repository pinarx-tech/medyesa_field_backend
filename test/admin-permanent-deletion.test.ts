import { PrismaClient, Role, SyncStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/lib/password.js';
import { CompanyRepo } from '../src/repos/companyRepo.js';
import { UserRepo } from '../src/repos/userRepo.js';
import {
  TEST_PASSWORD,
  bearerForUser,
  createTestContext,
  resetDatabase,
  seedCompanyWithUsers,
  seedPlatformAdmin,
} from './helpers.js';

async function seedFullCompanyGraph(prisma: PrismaClient, codeSuffix: string) {
  const { company, hc, mr } = await seedCompanyWithUsers(prisma, {
    code: `co_${codeSuffix}`,
    name: `Pharma ${codeSuffix}`,
    licensedHcSeats: 4,
    licensedMrSeats: 6,
  });

  const passwordHash = await hashPassword(TEST_PASSWORD);
  const hc2 = await prisma.user.create({
    data: {
      companyId: company.id,
      employeeId: `HC2_${codeSuffix.toUpperCase()}`,
      email: `hc2@${codeSuffix}.test`,
      displayName: `Second HC ${codeSuffix}`,
      passwordHash,
      role: Role.headController,
    },
  });

  const mr2 = await prisma.user.create({
    data: {
      companyId: company.id,
      employeeId: `MR2_${codeSuffix.toUpperCase()}`,
      email: `mr2@${codeSuffix}.test`,
      displayName: `Second MR ${codeSuffix}`,
      passwordHash,
      role: Role.mr,
    },
  });

  const allUserIds = [hc.id, hc2.id, mr.id, mr2.id];
  for (const uid of allUserIds) {
    await prisma.refreshToken.create({
      data: {
        userId: uid,
        tokenHash: `rt_${uid}_${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.passwordResetToken.create({
      data: {
        userId: uid,
        tokenHash: `prt_${uid}_${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await prisma.syncOperation.create({
      data: {
        id: randomUUID(),
        companyId: company.id,
        actorId: uid,
        entityType: 'visit',
        entityId: randomUUID(),
        operation: 'create',
        payload: { sample: true },
        status: SyncStatus.synced,
      },
    });
  }

  await prisma.hcNotificationPrefs.createMany({
    data: [
      { companyId: company.id, headControllerId: hc.id },
      { companyId: company.id, headControllerId: hc2.id },
    ],
  });

  const clinic = await prisma.clinic.create({
    data: {
      companyId: company.id,
      name: `Central Clinic ${codeSuffix}`,
      normalizedName: `centralclinic${codeSuffix.toLowerCase()}`,
      formattedAddress: '100 Main Road, Bengaluru',
      latitude: 12.9716,
      longitude: 77.5946,
    },
  });

  const doctor = await prisma.doctor.create({
    data: {
      companyId: company.id,
      clinicId: clinic.id,
      name: `Dr. Shared ${codeSuffix}`,
      specialty: 'Cardiology',
      clinicName: clinic.name,
    },
  });

  const location = await prisma.doctorClinicLocation.create({
    data: {
      companyId: company.id,
      doctorId: doctor.id,
      latitude: 12.9716,
      longitude: 77.5946,
      clinicName: clinic.name,
      formattedAddress: clinic.formattedAddress,
      source: 'gps',
      status: 'complete',
      isCurrent: true,
      capturedByUserId: hc.id,
    },
  });

  const territory = await prisma.territory.create({
    data: {
      companyId: company.id,
      code: `TER_${codeSuffix.toUpperCase()}`,
      name: `Territory ${codeSuffix}`,
      createdByHeadControllerId: hc.id,
    },
  });

  await prisma.territoryDoctor.create({
    data: {
      companyId: company.id,
      territoryId: territory.id,
      doctorId: doctor.id,
      assignedByHeadControllerId: hc.id,
    },
  });

  await prisma.mrTerritoryAssignment.createMany({
    data: [
      {
        companyId: company.id,
        mrId: mr.id,
        territoryId: territory.id,
        assignedByHeadControllerId: hc.id,
      },
      {
        companyId: company.id,
        mrId: mr2.id,
        territoryId: territory.id,
        assignedByHeadControllerId: hc.id,
      },
    ],
  });

  const workDayMr1 = await prisma.workDay.create({
    data: {
      companyId: company.id,
      mrId: mr.id,
      startedAt: new Date('2026-11-27T04:00:00.000Z'),
      reopenedByUserId: hc.id,
    },
  });

  const workDayMr2 = await prisma.workDay.create({
    data: {
      companyId: company.id,
      mrId: mr2.id,
      startedAt: new Date('2026-11-27T04:05:00.000Z'),
      reopenedByUserId: hc.id,
    },
  });

  const visitOrig = await prisma.visit.create({
    data: {
      companyId: company.id,
      mrId: mr.id,
      doctorId: doctor.id,
      workDayId: workDayMr1.id,
      status: 'superseded',
      capturedAtClient: new Date('2026-11-27T05:00:00.000Z'),
      doctorClinicLocationIdAtCheckIn: location.id,
      territoryIdAtVisit: territory.id,
    },
  });

  const visitCorrection = await prisma.visit.create({
    data: {
      companyId: company.id,
      mrId: mr.id,
      doctorId: doctor.id,
      workDayId: workDayMr1.id,
      status: 'completed',
      correctsVisitId: visitOrig.id,
      capturedAtClient: new Date('2026-11-27T05:15:00.000Z'),
      doctorClinicLocationIdAtCheckIn: location.id,
      territoryIdAtVisit: territory.id,
    },
  });

  await prisma.visitNote.create({
    data: {
      companyId: company.id,
      visitId: visitCorrection.id,
      doctorId: doctor.id,
      visitDate: new Date('2026-11-27T00:00:00.000Z'),
      noteText: 'MR1 promotion note',
    },
  });

  const visitMr2 = await prisma.visit.create({
    data: {
      companyId: company.id,
      mrId: mr2.id,
      doctorId: doctor.id,
      workDayId: workDayMr2.id,
      status: 'completed',
      capturedAtClient: new Date('2026-11-27T05:30:00.000Z'),
    },
  });

  await prisma.visitNote.create({
    data: {
      companyId: company.id,
      visitId: visitMr2.id,
      doctorId: doctor.id,
      visitDate: new Date('2026-11-27T00:00:00.000Z'),
      noteText: 'MR2 promotion note',
    },
  });

  await prisma.activityLog.createMany({
    data: [
      {
        companyId: company.id,
        actorId: hc.id,
        actorRole: Role.headController,
        actorDisplayName: hc.displayName,
        actionType: 'territory_created',
        subjectType: 'territory',
        subjectId: territory.id,
      },
      {
        companyId: company.id,
        actorId: mr.id,
        actorRole: Role.mr,
        actorDisplayName: mr.displayName,
        actionType: 'visit_recorded',
        subjectType: 'visit',
        subjectId: visitCorrection.id,
      },
      {
        companyId: company.id,
        actorId: mr2.id,
        actorRole: Role.mr,
        actorDisplayName: mr2.displayName,
        actionType: 'visit_recorded',
        subjectType: 'visit',
        subjectId: visitMr2.id,
      },
    ],
  });

  await prisma.auditLog.createMany({
    data: [
      {
        companyId: company.id,
        actorId: hc.id,
        action: 'company_activity',
        targetType: 'company',
        targetId: String(company.id),
      },
      {
        companyId: company.id,
        actorId: mr.id,
        action: 'mr_login',
        targetType: 'user',
        targetId: mr.id,
        metadata: { email: mr.email, employeeId: mr.employeeId },
      },
    ],
  });

  return {
    company,
    hc,
    hc2,
    mr,
    mr2,
    clinic,
    doctor,
    location,
    territory,
    workDayMr1,
    workDayMr2,
    visitOrig,
    visitCorrection,
    visitMr2,
  };
}

describe('Platform Admin Permanent Deletion (Company, HC & MR)', () => {
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

  it('1 & 2. Platform Admin permanently deletes a company and ALL dependent records without affecting other companies', async () => {
    const { token: paToken } = await seedPlatformAdmin(prisma);
    const paBearer = `Bearer ${paToken}`;

    const target = await seedFullCompanyGraph(prisma, 'alpha');
    const survivor = await seedFullCompanyGraph(prisma, 'beta');
    const targetUserIds = [
      target.hc.id,
      target.hc2.id,
      target.mr.id,
      target.mr2.id,
    ];

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/companies/${target.company.id}`,
      headers: { authorization: paBearer },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.deletedCompanyId).toBe(target.company.id);

    expect(
      await prisma.company.findUnique({ where: { id: target.company.id } }),
    ).toBeNull();
    expect(
      await prisma.user.count({ where: { id: { in: targetUserIds } } }),
    ).toBe(0);
    expect(
      await prisma.refreshToken.count({
        where: { userId: { in: targetUserIds } },
      }),
    ).toBe(0);
    expect(
      await prisma.passwordResetToken.count({
        where: { userId: { in: targetUserIds } },
      }),
    ).toBe(0);
    expect(
      await prisma.hcNotificationPrefs.count({
        where: { companyId: target.company.id },
      }),
    ).toBe(0);
    expect(
      await prisma.visitNote.count({ where: { companyId: target.company.id } }),
    ).toBe(0);
    expect(
      await prisma.visit.count({ where: { companyId: target.company.id } }),
    ).toBe(0);
    expect(
      await prisma.workDay.count({ where: { companyId: target.company.id } }),
    ).toBe(0);
    expect(
      await prisma.territoryDoctor.count({
        where: { companyId: target.company.id },
      }),
    ).toBe(0);
    expect(
      await prisma.mrTerritoryAssignment.count({
        where: { companyId: target.company.id },
      }),
    ).toBe(0);
    expect(
      await prisma.doctorClinicLocation.count({
        where: { companyId: target.company.id },
      }),
    ).toBe(0);
    expect(
      await prisma.doctor.count({ where: { companyId: target.company.id } }),
    ).toBe(0);
    expect(
      await prisma.clinic.count({ where: { companyId: target.company.id } }),
    ).toBe(0);
    expect(
      await prisma.territory.count({ where: { companyId: target.company.id } }),
    ).toBe(0);
    expect(
      await prisma.activityLog.count({
        where: {
          OR: [
            { companyId: target.company.id },
            { actorId: { in: targetUserIds } },
          ],
        },
      }),
    ).toBe(0);
    expect(
      await prisma.syncOperation.count({
        where: { companyId: target.company.id },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { companyId: target.company.id } }),
    ).toBe(0);

    // Company 2 remains completely intact.
    expect(
      await prisma.company.findUnique({ where: { id: survivor.company.id } }),
    ).not.toBeNull();
    expect(
      await prisma.user.count({ where: { companyId: survivor.company.id } }),
    ).toBe(4);
    expect(
      await prisma.visit.count({ where: { companyId: survivor.company.id } }),
    ).toBe(3);

    // Company detail endpoint returns 404 for deleted company.
    const check404 = await app.inject({
      method: 'GET',
      url: `/v1/admin/companies/${target.company.id}`,
      headers: { authorization: paBearer },
    });
    expect(check404.statusCode).toBe(404);
  });

  it('4, 5 & 7. Platform Admin permanently deletes an MR, removing visits (with self-ref corrections), notes, workdays, assignments, tokens, sync ops & activity while preserving shared company data and siblings', async () => {
    const { token: paToken } = await seedPlatformAdmin(prisma);
    const paBearer = `Bearer ${paToken}`;
    const g = await seedFullCompanyGraph(prisma, 'mrdel');

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/users/${g.mr.id}`,
      headers: { authorization: paBearer },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.deletedUserId).toBe(g.mr.id);
    expect(body.deletedRole).toBe('mr');

    expect(await prisma.user.findUnique({ where: { id: g.mr.id } })).toBeNull();
    expect(
      await prisma.refreshToken.count({ where: { userId: g.mr.id } }),
    ).toBe(0);
    expect(
      await prisma.passwordResetToken.count({ where: { userId: g.mr.id } }),
    ).toBe(0);
    expect(await prisma.workDay.count({ where: { mrId: g.mr.id } })).toBe(0);
    expect(await prisma.visit.count({ where: { mrId: g.mr.id } })).toBe(0);
    expect(
      await prisma.visitNote.count({ where: { visitId: g.visitCorrection.id } }),
    ).toBe(0);
    expect(
      await prisma.mrTerritoryAssignment.count({ where: { mrId: g.mr.id } }),
    ).toBe(0);
    expect(
      await prisma.syncOperation.count({ where: { actorId: g.mr.id } }),
    ).toBe(0);
    expect(
      await prisma.activityLog.count({ where: { actorId: g.mr.id } }),
    ).toBe(0);

    // Sibling MR, HCs, doctor, clinic, territory, and MR2 records remain intact.
    expect(
      await prisma.user.findUnique({ where: { id: g.mr2.id } }),
    ).not.toBeNull();
    expect(
      await prisma.visit.findUnique({ where: { id: g.visitMr2.id } }),
    ).not.toBeNull();
    expect(
      await prisma.workDay.findUnique({ where: { id: g.workDayMr2.id } }),
    ).not.toBeNull();
    expect(
      await prisma.doctor.findUnique({ where: { id: g.doctor.id } }),
    ).not.toBeNull();
    expect(
      await prisma.clinic.findUnique({ where: { id: g.clinic.id } }),
    ).not.toBeNull();
    expect(
      await prisma.territory.findUnique({ where: { id: g.territory.id } }),
    ).not.toBeNull();
    expect(
      await prisma.mrTerritoryAssignment.count({ where: { mrId: g.mr2.id } }),
    ).toBe(1);
  });

  it('3, 6 & 7. Platform Admin permanently deletes an HC, removing HC prefs, tokens, sync & actor logs while clearing dangling HC IDs from surviving territories/assignments/locations', async () => {
    const { token: paToken } = await seedPlatformAdmin(prisma);
    const paBearer = `Bearer ${paToken}`;
    const g = await seedFullCompanyGraph(prisma, 'hcdel');

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/users/${g.hc.id}`,
      headers: { authorization: paBearer },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.deletedUserId).toBe(g.hc.id);
    expect(body.deletedRole).toBe('headController');

    expect(await prisma.user.findUnique({ where: { id: g.hc.id } })).toBeNull();
    expect(
      await prisma.hcNotificationPrefs.count({
        where: { headControllerId: g.hc.id },
      }),
    ).toBe(0);
    expect(
      await prisma.refreshToken.count({ where: { userId: g.hc.id } }),
    ).toBe(0);
    expect(
      await prisma.passwordResetToken.count({ where: { userId: g.hc.id } }),
    ).toBe(0);
    expect(
      await prisma.syncOperation.count({ where: { actorId: g.hc.id } }),
    ).toBe(0);
    expect(
      await prisma.activityLog.count({ where: { actorId: g.hc.id } }),
    ).toBe(0);

    // Surviving company records remain intact AND no dangling deleted HC ID stays in them.
    const survivingTerritory = await prisma.territory.findUnique({
      where: { id: g.territory.id },
    });
    expect(survivingTerritory).not.toBeNull();
    expect(survivingTerritory?.createdByHeadControllerId).toBeNull();

    const survivingLocation = await prisma.doctorClinicLocation.findUnique({
      where: { id: g.location.id },
    });
    expect(survivingLocation).not.toBeNull();
    expect(survivingLocation?.capturedByUserId).toBe(g.hc2.id);

    const survivingMrAssignments = await prisma.mrTerritoryAssignment.findMany({
      where: { companyId: g.company.id },
    });
    expect(survivingMrAssignments.length).toBe(2);
    expect(
      survivingMrAssignments.every(
        (a) => a.assignedByHeadControllerId === g.hc2.id,
      ),
    ).toBe(true);

    const survivingWorkDay = await prisma.workDay.findUnique({
      where: { id: g.workDayMr1.id },
    });
    expect(survivingWorkDay?.reopenedByUserId).toBeNull();

    expect(
      await prisma.hcNotificationPrefs.count({
        where: { headControllerId: g.hc2.id },
      }),
    ).toBe(1);
    expect(
      await prisma.visit.count({ where: { companyId: g.company.id } }),
    ).toBe(3);
  });

  it('8 & 9. Non-admin users (HC & MR) and unauthenticated callers cannot delete companies or users', async () => {
    await seedPlatformAdmin(prisma);
    const { company, hc, mr } = await seedCompanyWithUsers(prisma, {
      code: 'sec',
      name: 'Security Co',
    });
    const hcBearer = await bearerForUser(hc);
    const mrBearer = await bearerForUser(mr);

    for (const bearer of [hcBearer, mrBearer]) {
      const delCo = await app.inject({
        method: 'DELETE',
        url: `/v1/admin/companies/${company.id}`,
        headers: { authorization: bearer },
      });
      expect(delCo.statusCode).toBe(403);

      const delUser = await app.inject({
        method: 'DELETE',
        url: `/v1/admin/users/${mr.id}`,
        headers: { authorization: bearer },
      });
      expect(delUser.statusCode).toBe(403);
    }

    const unauthCo = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/companies/${company.id}`,
    });
    expect(unauthCo.statusCode).toBe(401);

    const unauthUser = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/users/${mr.id}`,
    });
    expect(unauthUser.statusCode).toBe(401);

    expect(
      await prisma.company.findUnique({ where: { id: company.id } }),
    ).not.toBeNull();
    expect(await prisma.user.findUnique({ where: { id: mr.id } })).not.toBeNull();
  });

  it('10 & 11. Platform Admin cannot delete their own account or another Platform Admin', async () => {
    const { user: pa1, token: pa1Token } = await seedPlatformAdmin(prisma);
    const paBearer = `Bearer ${pa1Token}`;

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const pa2 = await prisma.user.create({
      data: {
        companyId: null,
        employeeId: 'PA0002',
        email: 'pa2@pinarx.test',
        displayName: 'Second Platform Admin',
        passwordHash,
        role: Role.platformAdmin,
        platformAdmin: { create: {} },
      },
    });

    const selfDel = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/users/${pa1.id}`,
      headers: { authorization: paBearer },
    });
    expect(selfDel.statusCode).toBe(403);

    const otherAdminDel = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/users/${pa2.id}`,
      headers: { authorization: paBearer },
    });
    expect(otherAdminDel.statusCode).toBe(403);

    expect(await prisma.user.findUnique({ where: { id: pa1.id } })).not.toBeNull();
    expect(await prisma.user.findUnique({ where: { id: pa2.id } })).not.toBeNull();
  });

  it('12, 13 & 14. Missing company/user return 404 and invalid IDs return 400 validation_error', async () => {
    const { token: paToken } = await seedPlatformAdmin(prisma);
    const paBearer = `Bearer ${paToken}`;

    const missingCo = await app.inject({
      method: 'DELETE',
      url: '/v1/admin/companies/999999',
      headers: { authorization: paBearer },
    });
    expect(missingCo.statusCode).toBe(404);

    const missingUser = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/users/${randomUUID()}`,
      headers: { authorization: paBearer },
    });
    expect(missingUser.statusCode).toBe(404);

    for (const badId of ['abc', '0', '-5']) {
      const badCo = await app.inject({
        method: 'DELETE',
        url: `/v1/admin/companies/${badId}`,
        headers: { authorization: paBearer },
      });
      expect(badCo.statusCode).toBe(400);
      expect(badCo.json().error.code).toBe('validation_error');
    }

    const badUser = await app.inject({
      method: 'DELETE',
      url: '/v1/admin/users/not-a-uuid',
      headers: { authorization: paBearer },
    });
    expect(badUser.statusCode).toBe(400);
    expect(badUser.json().error.code).toBe('validation_error');
  });

  it('15. Transaction rollback leaves all company and user data unchanged if deletion fails mid-transaction', async () => {
    const { user: pa } = await seedPlatformAdmin(prisma);
    const g = await seedFullCompanyGraph(prisma, 'rollback');

    const ctx = {
      userId: pa.id,
      companyId: null,
      role: Role.platformAdmin,
      employeeId: pa.employeeId,
      displayName: pa.displayName,
      ipAddress: '127.0.0.1',
    };

    const companyRepo = new CompanyRepo(prisma, ctx as any);
    await expect(
      companyRepo.deletePermanent(g.company.id, {
        beforeCommit: () => {
          throw new Error('Simulated mid-transaction failure');
        },
      }),
    ).rejects.toThrow('Simulated mid-transaction failure');

    expect(
      await prisma.company.findUnique({ where: { id: g.company.id } }),
    ).not.toBeNull();
    expect(
      await prisma.user.count({ where: { companyId: g.company.id } }),
    ).toBe(4);
    expect(
      await prisma.visit.count({ where: { companyId: g.company.id } }),
    ).toBe(3);
    expect(
      await prisma.workDay.count({ where: { companyId: g.company.id } }),
    ).toBe(2);
    expect(
      await prisma.doctor.count({ where: { companyId: g.company.id } }),
    ).toBe(1);

    const userRepo = new UserRepo(prisma, ctx as any);
    await expect(
      userRepo.deletePermanent(g.mr.id, {
        beforeCommit: () => {
          throw new Error('Simulated user delete rollback');
        },
      }),
    ).rejects.toThrow('Simulated user delete rollback');

    expect(
      await prisma.user.findUnique({ where: { id: g.mr.id } }),
    ).not.toBeNull();
    expect(await prisma.visit.count({ where: { mrId: g.mr.id } })).toBe(2);
    expect(await prisma.workDay.count({ where: { mrId: g.mr.id } })).toBe(1);
  });
});
