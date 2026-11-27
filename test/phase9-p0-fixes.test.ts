import {
  DataClassification,
  PrismaClient,
  VisitVerificationStatus,
} from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearerForUser,
  createTestContext,
  resetDatabase,
  seedCompanyWithUsers,
} from './helpers.js';

describe('Phase 9 P0 Fixes — Territory Detail, Doctor Detail, Safe Delete, MR Hydration Payload & Consistency', () => {
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

  it('includes clinic and clinicLocations in GET /v1/hc/territories/:id and accurate locationPendingCount in GET /v1/hc/territories', async () => {
    const tenant = await seedCompanyWithUsers(prisma, {
      code: 'compa',
      name: 'Company A',
    });
    const hcBearer = await bearerForUser(tenant.hc);

    const onboardComplete = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors/onboard',
      headers: { authorization: hcBearer },
      payload: {
        doctor: { name: 'Dr. Stone', specialty: 'Cardiology' },
        clinic: {
          mode: 'new',
          name: 'RR Nagar Heart Clinic',
          formattedAddress: '12th Main, RR Nagar, Bengaluru',
          latitude: 12.9141,
          longitude: 77.5212,
          accuracyMeters: 9,
          source: 'gps',
        },
        territory: { mode: 'new', code: 'RR_NAGAR', name: 'RR Nagar' },
        assignMrId: tenant.mr.id,
      },
    });
    expect(onboardComplete.statusCode).toBe(201);
    const { territory, doctor } = onboardComplete.json();

    const onboardPending = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors/onboard',
      headers: { authorization: hcBearer },
      payload: {
        doctor: { name: 'Dr. Pending', specialty: 'General Medicine' },
        clinic: {
          mode: 'new',
          name: 'No GPS Clinic',
          formattedAddress: '5th Cross, RR Nagar, Bengaluru',
          source: 'manual',
        },
        territory: { mode: 'existing', territoryId: territory.id },
      },
    });
    expect(onboardPending.statusCode).toBe(201);

    const detailRes = await app.inject({
      method: 'GET',
      url: `/v1/hc/territories/${territory.id}`,
      headers: { authorization: hcBearer },
    });
    expect(detailRes.statusCode).toBe(200);
    const detailBody = detailRes.json();
    const stone = detailBody.doctors.find(
      (d: { id: string }) => d.id === doctor.id,
    );
    expect(stone.clinic?.latitude).toBe(12.9141);
    expect(stone.clinicLocations).toHaveLength(1);
    expect(stone.clinicLocations[0].latitude).toBe(12.9141);
    expect(stone.clinicLocations[0].longitude).toBe(77.5212);

    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/hc/territories',
      headers: { authorization: hcBearer },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().territories[0].locationPendingCount).toBe(1);
  });

  it('serves GET /v1/hc/doctors/:id with clinic, current location, capturer name, and active territories while enforcing tenant isolation and RBAC', async () => {
    const tenantA = await seedCompanyWithUsers(prisma, {
      code: 'compa',
      name: 'Company A',
    });
    const tenantB = await seedCompanyWithUsers(prisma, {
      code: 'compb',
      name: 'Company B',
    });
    const hcABearer = await bearerForUser(tenantA.hc);
    const hcBBearer = await bearerForUser(tenantB.hc);
    const mrABearer = await bearerForUser(tenantA.mr);

    const onboard = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors/onboard',
      headers: { authorization: hcABearer },
      payload: {
        doctor: { name: 'Dr. Stone', specialty: 'Cardiology' },
        clinic: {
          mode: 'new',
          name: 'Stone Clinic',
          formattedAddress: '1st Block, RR Nagar, Bengaluru',
          latitude: 12.92,
          longitude: 77.52,
          source: 'gps',
        },
        territory: { mode: 'new', code: 'RR_NAGAR', name: 'RR Nagar' },
      },
    });
    const doctorId = onboard.json().doctor.id as string;

    const okRes = await app.inject({
      method: 'GET',
      url: `/v1/hc/doctors/${doctorId}`,
      headers: { authorization: hcABearer },
    });
    expect(okRes.statusCode).toBe(200);
    const docBody = okRes.json().doctor;
    expect(docBody.id).toBe(doctorId);
    expect(docBody.clinic?.name).toBe('Stone Clinic');
    expect(docBody.clinicLocations).toHaveLength(1);
    expect(docBody.capturedByDisplayName).toBe(tenantA.hc.displayName);
    expect(docBody.territoryDoctors).toHaveLength(1);

    const crossTenant = await app.inject({
      method: 'GET',
      url: `/v1/hc/doctors/${doctorId}`,
      headers: { authorization: hcBBearer },
    });
    expect(crossTenant.statusCode).toBe(404);

    const mrForbidden = await app.inject({
      method: 'GET',
      url: `/v1/hc/doctors/${doctorId}`,
      headers: { authorization: mrABearer },
    });
    expect(mrForbidden.statusCode).toBe(403);
  });

  it('allows DELETE /v1/hc/territories/:id only for genuinely empty territories and rejects territories with assignments or visits with 422', async () => {
    const tenantA = await seedCompanyWithUsers(prisma, {
      code: 'compa',
      name: 'Company A',
    });
    const tenantB = await seedCompanyWithUsers(prisma, {
      code: 'compb',
      name: 'Company B',
    });
    const hcABearer = await bearerForUser(tenantA.hc);
    const hcBBearer = await bearerForUser(tenantB.hc);

    const createEmpty = await app.inject({
      method: 'POST',
      url: '/v1/hc/territories',
      headers: { authorization: hcABearer },
      payload: { code: 'EMPTY_T', name: 'Empty Territory' },
    });
    expect(createEmpty.statusCode).toBe(201);
    const emptyId = createEmpty.json().territory.id as string;

    const crossDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/hc/territories/${emptyId}`,
      headers: { authorization: hcBBearer },
    });
    expect(crossDelete.statusCode).toBe(404);

    const okDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/hc/territories/${emptyId}`,
      headers: { authorization: hcABearer },
    });
    expect(okDelete.statusCode).toBe(200);
    expect(okDelete.json().ok).toBe(true);
    expect(
      await prisma.territory.findUnique({ where: { id: emptyId } }),
    ).toBeNull();

    // Territory with doctor cannot be hard-deleted -> must return 422
    const withDoctorRes = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors/onboard',
      headers: { authorization: hcABearer },
      payload: {
        doctor: { name: 'Dr. Keep', specialty: 'Ortho' },
        clinic: {
          mode: 'new',
          name: 'Ortho Hub',
          formattedAddress: '10th Main, Jayanagar, Bengaluru',
          source: 'manual',
        },
        territory: { mode: 'new', code: 'BUSY_T', name: 'Busy Territory' },
      },
    });
    const busyId = withDoctorRes.json().territory.id as string;

    const blockedDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/hc/territories/${busyId}`,
      headers: { authorization: hcABearer },
    });
    expect(blockedDelete.statusCode).toBe(422);
  });

  it('filters archived territories and non-matching dataClassification in MR endpoints and respects IST date window on GET /v1/mr/today', async () => {
    const tenant = await seedCompanyWithUsers(prisma, {
      code: 'compa',
      name: 'Company A',
    });
    const hcBearer = await bearerForUser(tenant.hc);
    const mrBearer = await bearerForUser(tenant.mr);

    // 1. Active territory + production doctor + archived territory + demo doctor
    const activeOnboard = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors/onboard',
      headers: { authorization: hcBearer },
      payload: {
        doctor: { name: 'Dr. Live', specialty: 'Cardio' },
        clinic: {
          mode: 'new',
          name: 'Live Clinic',
          formattedAddress: 'MG Road, Bengaluru',
          latitude: 12.97,
          longitude: 77.6,
          source: 'gps',
        },
        territory: { mode: 'new', code: 'LIVE_TER', name: 'Live Zone' },
        assignMrId: tenant.mr.id,
      },
    });
    const liveDocId = activeOnboard.json().doctor.id as string;

    // Seed an archived territory also linked to the MR
    const archivedTer = await prisma.territory.create({
      data: {
        companyId: tenant.company.id,
        code: 'ARCH_TER',
        name: 'Archived Zone',
        isArchived: true,
        archivedAt: new Date(),
      },
    });
    const archivedDoc = await prisma.doctor.create({
      data: {
        companyId: tenant.company.id,
        name: 'Dr. Archived Zone',
        specialty: 'ENT',
      },
    });
    await prisma.territoryDoctor.create({
      data: {
        companyId: tenant.company.id,
        territoryId: archivedTer.id,
        doctorId: archivedDoc.id,
        assignedByHeadControllerId: tenant.hc.id,
      },
    });
    await prisma.mrTerritoryAssignment.create({
      data: {
        companyId: tenant.company.id,
        mrId: tenant.mr.id,
        territoryId: archivedTer.id,
        assignedByHeadControllerId: tenant.hc.id,
      },
    });

    // Seed a demo-classified doctor in the active territory
    const demoDoc = await prisma.doctor.create({
      data: {
        companyId: tenant.company.id,
        name: 'Dr. Demo Leak',
        specialty: 'Demo',
        dataClassification: DataClassification.demo,
      },
    });
    await prisma.territoryDoctor.create({
      data: {
        companyId: tenant.company.id,
        territoryId: activeOnboard.json().territory.id,
        doctorId: demoDoc.id,
        assignedByHeadControllerId: tenant.hc.id,
      },
    });

    // Visit recorded at 2026-11-26T19:00:00Z = 2026-11-27 00:30 AM IST!
    const istMidnightPlus30 = new Date('2026-11-26T19:00:00.000Z');
    await prisma.workDay.create({
      data: {
        companyId: tenant.company.id,
        mrId: tenant.mr.id,
        startedAt: istMidnightPlus30,
      },
    });
    await prisma.visit.create({
      data: {
        companyId: tenant.company.id,
        mrId: tenant.mr.id,
        doctorId: liveDocId,
        status: 'completed',
        checkInVerificationStatus: VisitVerificationStatus.verified,
        capturedAtClient: istMidnightPlus30,
      },
    });

    const docsRes = await app.inject({
      method: 'GET',
      url: '/v1/mr/doctors',
      headers: { authorization: mrBearer },
    });
    expect(docsRes.statusCode).toBe(200);
    const docsBody = docsRes.json();
    expect(docsBody.territory?.code).toBe('LIVE_TER');
    expect(docsBody.doctors.map((d: { id: string }) => d.id)).toEqual([
      liveDocId,
    ]);

    const todayIstRes = await app.inject({
      method: 'GET',
      url: '/v1/mr/today?date=2026-11-27&tzOffsetMinutes=330',
      headers: { authorization: mrBearer },
    });
    expect(todayIstRes.statusCode).toBe(200);
    const todayBody = todayIstRes.json();
    expect(todayBody.date).toBe('2026-11-27');
    expect(todayBody.workDay).not.toBeNull();
    expect(todayBody.visits).toHaveLength(1);
    expect(todayBody.doctors.map((d: { id: string }) => d.id)).toEqual([
      liveDocId,
    ]);

    // Prior UTC day window should NOT falsely show 2026-11-27 IST activity on 2026-11-26 IST
    const prevIstRes = await app.inject({
      method: 'GET',
      url: '/v1/mr/today?date=2026-11-26&tzOffsetMinutes=330',
      headers: { authorization: mrBearer },
    });
    expect(prevIstRes.statusCode).toBe(200);
    expect(prevIstRes.json().workDay).toBeNull();
    expect(prevIstRes.json().visits).toHaveLength(0);
  });

  it('keeps dashboard visitsCompletedToday consistent with assignedDoctorsCount and visitsPendingToday', async () => {
    const tenant = await seedCompanyWithUsers(prisma, {
      code: 'compa',
      name: 'Company A',
    });
    const hcBearer = await bearerForUser(tenant.hc);

    const onboard = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors/onboard',
      headers: { authorization: hcBearer },
      payload: {
        doctor: { name: 'Dr. Assigned', specialty: 'Cardio' },
        clinic: {
          mode: 'new',
          name: 'Assigned Clinic',
          formattedAddress: 'Main Road, Bengaluru',
          source: 'manual',
        },
        territory: { mode: 'new', code: 'ZONE1', name: 'Zone 1' },
        assignMrId: tenant.mr.id,
      },
    });
    const assignedDocId = onboard.json().doctor.id as string;

    const unassignedDoc = await prisma.doctor.create({
      data: {
        companyId: tenant.company.id,
        name: 'Dr. Unassigned',
        specialty: 'ENT',
      },
    });

    const visitTime = new Date('2026-11-27T04:00:00.000Z');
    // Two completed visits for the assigned doctor + one for an unassigned doctor
    await prisma.visit.createMany({
      data: [
        {
          companyId: tenant.company.id,
          mrId: tenant.mr.id,
          doctorId: assignedDocId,
          status: 'completed',
          checkInVerificationStatus: VisitVerificationStatus.unverified,
          capturedAtClient: visitTime,
        },
        {
          companyId: tenant.company.id,
          mrId: tenant.mr.id,
          doctorId: assignedDocId,
          status: 'completed',
          checkInVerificationStatus: VisitVerificationStatus.unverified,
          capturedAtClient: new Date(visitTime.getTime() + 60_000),
        },
        {
          companyId: tenant.company.id,
          mrId: tenant.mr.id,
          doctorId: unassignedDoc.id,
          status: 'completed',
          checkInVerificationStatus: VisitVerificationStatus.unverified,
          capturedAtClient: visitTime,
        },
      ],
    });

    const dashRes = await app.inject({
      method: 'GET',
      url: '/v1/hc/dashboard?date=2026-11-27&tzOffsetMinutes=330',
      headers: { authorization: hcBearer },
    });
    expect(dashRes.statusCode).toBe(200);
    const body = dashRes.json();
    expect(body.metrics.visitsCompletedToday).toBe(1);
    expect(body.metrics.visitsPendingToday).toBe(0);
    expect(body.mrSummaries[0].assignedDoctorsCount).toBe(1);
    expect(body.mrSummaries[0].visitsCompletedToday).toBe(1);
    expect(body.mrSummaries[0].visitsPendingToday).toBe(0);
  });
});
