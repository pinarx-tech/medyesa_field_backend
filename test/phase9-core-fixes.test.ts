import { PrismaClient, VisitVerificationStatus } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearerForUser,
  createTestContext,
  resetDatabase,
  seedCompanyWithUsers,
} from './helpers.js';

describe('Phase 9 — MR Visibility, Clinic Location Truth, Empty Territory Delete & Timing', () => {
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

  it('P0-1 & P0-2: HC onboards Dr. Stone & Dr. Kavita to RR Nagar assigned to Arnav -> Territory detail shows configured location AND Arnav sees both doctors via /v1/mr/doctors and /v1/mr/today', async () => {
    const tenant = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });
    const hcBearer = await bearerForUser(tenant.hc);
    const mrBearer = await bearerForUser(tenant.mr);

    // Onboard Dr. Stone (new GPS clinic + new RR Nagar territory + assign MR)
    const stoneRes = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors/onboard',
      headers: { authorization: hcBearer },
      payload: {
        doctor: {
          name: 'Dr. Stone',
          specialty: 'Cardiology',
          geofenceRadiusMeters: 100,
        },
        clinic: {
          mode: 'new',
          name: 'Stone Heart Clinic',
          formattedAddress: 'BEML Layout, RR Nagar, Bengaluru',
          latitude: 12.9141,
          longitude: 77.5196,
          accuracyMeters: 7.5,
          source: 'gps',
        },
        territory: {
          mode: 'new',
          code: 'RR_NAGAR',
          name: 'RR Nagar',
        },
        assignMrId: tenant.mr.id,
      },
    });
    expect(stoneRes.statusCode).toBe(201);
    const territoryId = stoneRes.json().territory.id as string;

    // Onboard Dr. Kavita into RR Nagar with a second GPS clinic
    const kavitaRes = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors/onboard',
      headers: { authorization: hcBearer },
      payload: {
        doctor: {
          name: 'Dr. Kavita',
          specialty: 'Diabetology',
          geofenceRadiusMeters: 100,
        },
        clinic: {
          mode: 'new',
          name: 'Kavita Care Center',
          formattedAddress: 'Ideal Homes, RR Nagar, Bengaluru',
          latitude: 12.9212,
          longitude: 77.5234,
          accuracyMeters: 9.0,
          source: 'gps',
        },
        territory: { mode: 'existing', territoryId },
      },
    });
    expect(kavitaRes.statusCode).toBe(201);

    // P0-2: HC Territory detail MUST show locationStatus = 'configured' (NOT pending)
    const terDetailRes = await app.inject({
      method: 'GET',
      url: `/v1/hc/territories/${territoryId}`,
      headers: { authorization: hcBearer },
    });
    expect(terDetailRes.statusCode).toBe(200);
    expect(terDetailRes.headers['x-response-time-ms']).toBeDefined();
    expect(terDetailRes.headers['server-timing']).toBeDefined();
    const terDetail = terDetailRes.json();
    expect(terDetail.mrs).toHaveLength(1);
    expect(terDetail.doctors).toHaveLength(2);
    for (const d of terDetail.doctors) {
      expect(d.clinicLocation.locationStatus).toBe('configured');
      expect(d.clinicLocation.hasValidCoordinates).toBe(true);
      expect(d.clinicLocation.latitude).toBeTypeOf('number');
    }

    // P0-1: MR /v1/mr/doctors & /v1/mr/today return company, activeTerritory, and both doctors with clinicLocation
    const mrDocsRes = await app.inject({
      method: 'GET',
      url: '/v1/mr/doctors',
      headers: { authorization: mrBearer },
    });
    expect(mrDocsRes.statusCode).toBe(200);
    const mrDocsBody = mrDocsRes.json();
    expect(mrDocsBody.company.id).toBe(tenant.company.id);
    expect(mrDocsBody.activeTerritory.name).toBe('RR Nagar');
    expect(mrDocsBody.doctors.map((d: { name: string }) => d.name)).toEqual([
      'Dr. Kavita',
      'Dr. Stone',
    ]);
    expect(mrDocsBody.doctors[0].clinicLocation.locationStatus).toBe('configured');

    const mrTodayRes = await app.inject({
      method: 'GET',
      url: '/v1/mr/today?tzOffsetMinutes=330',
      headers: { authorization: mrBearer },
    });
    expect(mrTodayRes.statusCode).toBe(200);
    expect(mrTodayRes.json().doctors).toHaveLength(2);
    expect(mrTodayRes.json().activeTerritory.id).toBe(territoryId);
  });

  it('P0-3: deletes truly empty Indramagar territory with 200, blocks non-empty/historical territory with 422, and enforces 404 cross-company', async () => {
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

    // 1. Create truly empty territory Indramagar -> DELETE succeeds 200 + writes AuditLog
    const emptyTerRes = await app.inject({
      method: 'POST',
      url: '/v1/hc/territories',
      headers: { authorization: hcABearer },
      payload: { code: 'INDRAMAGAR', name: 'Indramagar' },
    });
    expect(emptyTerRes.statusCode).toBe(201);
    const indraId = emptyTerRes.json().territory.id as string;

    // Cross-company HC cannot delete Company A's empty territory -> 404
    const crossDel = await app.inject({
      method: 'DELETE',
      url: `/v1/hc/territories/${indraId}`,
      headers: { authorization: hcBBearer },
    });
    expect(crossDel.statusCode).toBe(404);

    // Owner HC deletes empty territory -> 200
    const okDel = await app.inject({
      method: 'DELETE',
      url: `/v1/hc/territories/${indraId}`,
      headers: { authorization: hcABearer },
    });
    expect(okDel.statusCode).toBe(200);
    expect(okDel.json().deletedTerritoryId).toBe(indraId);

    const audit = await prisma.auditLog.findFirst({
      where: { companyId: tenantA.company.id, action: 'territory_deleted' },
    });
    expect(audit).not.toBeNull();

    // 2. Territory with historical visit MUST fail DELETE with 422 (never delete history!)
    const usedTerRes = await app.inject({
      method: 'POST',
      url: '/v1/hc/territories',
      headers: { authorization: hcABearer },
      payload: { code: 'HISTORY_ZONE', name: 'History Zone' },
    });
    const usedTerId = usedTerRes.json().territory.id as string;
    const doc = await prisma.doctor.create({
      data: { companyId: tenantA.company.id, name: 'Dr. Past', specialty: 'Cardio' },
    });
    await prisma.visit.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        doctorId: doc.id,
        territoryIdAtVisit: usedTerId,
        status: 'completed',
        checkInVerificationStatus: VisitVerificationStatus.verified,
        capturedAtClient: new Date(),
      },
    });

    const blockedDel = await app.inject({
      method: 'DELETE',
      url: `/v1/hc/territories/${usedTerId}`,
      headers: { authorization: hcABearer },
    });
    expect(blockedDel.statusCode).toBe(422);
    expect(blockedDel.json().error.details.canArchive).toBe(true);
    expect(blockedDel.json().error.details.visitsCount).toBe(1);
  });

  it('P1: PATCH /v1/hc/doctors/:id/location transitions doctor from pending to configured immediately and GET /v1/hc/territories supports includeArchived', async () => {
    const tenant = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa',
    });
    const hcBearer = await bearerForUser(tenant.hc);

    const docRes = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors',
      headers: { authorization: hcBearer },
      payload: { name: 'Dr. Pending', specialty: 'Neurology', isCustom: true },
    });
    expect(docRes.statusCode).toBe(201);
    const docId = docRes.json().doctor.id as string;
    expect(docRes.json().doctor.clinicLocation.locationStatus).toBe('pending');

    const locRes = await app.inject({
      method: 'PATCH',
      url: `/v1/hc/doctors/${docId}/location`,
      headers: { authorization: hcBearer },
      payload: {
        clinicName: 'Neuro Clinic',
        formattedAddress: '100 Feet Road, Indiranagar, Bengaluru',
        latitude: 12.9784,
        longitude: 77.6408,
        accuracyMeters: 6.0,
        source: 'gps',
      },
    });
    expect(locRes.statusCode).toBe(200);
    expect(locRes.json().doctor.clinicLocation.locationStatus).toBe('configured');
    expect(locRes.json().doctor.clinicLocation.latitude).toBe(12.9784);

    // Archive territory filtering
    const terCreate = await app.inject({
      method: 'POST',
      url: '/v1/hc/territories',
      headers: { authorization: hcBearer },
      payload: { code: 'ARCH_CHECK', name: 'Archive Check' },
    });
    const terId = terCreate.json().territory.id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/hc/territories/${terId}/archive`,
      headers: { authorization: hcBearer },
    });

    const activeList = await app.inject({
      method: 'GET',
      url: '/v1/hc/territories',
      headers: { authorization: hcBearer },
    });
    expect(activeList.json().territories).toHaveLength(0);

    const allList = await app.inject({
      method: 'GET',
      url: '/v1/hc/territories?includeArchived=true',
      headers: { authorization: hcBearer },
    });
    expect(allList.json().territories).toHaveLength(1);
    expect(allList.json().territories[0].isArchived).toBe(true);
  });
});
