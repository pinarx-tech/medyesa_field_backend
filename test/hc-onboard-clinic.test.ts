import { PrismaClient, VisitVerificationStatus } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearerForUser,
  createTestContext,
  resetDatabase,
  seedCompanyWithUsers,
} from './helpers.js';

describe('Part 2 — One-Page Add Doctor & Clinic Management', () => {
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

  it('atomically creates doctor + new GPS clinic + new territory + MR assignment, and rejects duplicate clinic with 409 without partial writes', async () => {
    const tenantA = await seedCompanyWithUsers(prisma, {
      code: 'compa',
      name: 'Company A',
    });
    const hcBearer = await bearerForUser(tenantA.hc);

    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors/onboard',
      headers: { authorization: hcBearer },
      payload: {
        clientId: 'onboard-1',
        doctor: {
          name: 'Dr. Kavita Rao',
          specialty: 'Cardiology',
          geofenceRadiusMeters: 120,
        },
        clinic: {
          mode: 'new',
          name: 'Sahyadri Heart Clinic',
          formattedAddress: '4th Block, Jayanagar, Bengaluru',
          latitude: 12.9279,
          longitude: 77.5838,
          accuracyMeters: 8.5,
          source: 'gps',
        },
        territory: {
          mode: 'new',
          code: 'JAYANAGAR',
          name: 'Jayanagar',
        },
        assignMrId: tenantA.mr.id,
      },
    });

    expect(onboardRes.statusCode).toBe(201);
    const body = onboardRes.json();
    expect(body.doctor.name).toBe('Dr. Kavita Rao');
    expect(body.clinic.name).toBe('Sahyadri Heart Clinic');
    expect(body.territory.code).toBe('JAYANAGAR');
    expect(body.mrAssignment.mrId).toBe(tenantA.mr.id);

    // Duplicate clinic at same address -> 409 conflict + full transaction rollback
    const dupRes = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors/onboard',
      headers: { authorization: hcBearer },
      payload: {
        doctor: { name: 'Dr. Second', specialty: 'Diabetology' },
        clinic: {
          mode: 'new',
          name: '  sahyadri   heart clinic ',
          formattedAddress: '4th Block, Jayanagar, Bengaluru',
          source: 'manual',
        },
        territory: {
          mode: 'new',
          code: 'NEW_ZONE',
          name: 'New Zone',
        },
      },
    });

    expect(dupRes.statusCode).toBe(409);
    expect(dupRes.json().error.details.existingClinicId).toBe(body.clinic.id);
    expect(
      await prisma.doctor.count({ where: { companyId: tenantA.company.id } }),
    ).toBe(1);
    expect(
      await prisma.territory.count({ where: { companyId: tenantA.company.id } }),
    ).toBe(1);

    // Selecting existing clinic + existing territory succeeds cleanly
    const reuseRes = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors/onboard',
      headers: { authorization: hcBearer },
      payload: {
        doctor: { name: 'Dr. Second', specialty: 'Diabetology' },
        clinic: { mode: 'existing', clinicId: body.clinic.id },
        territory: { mode: 'existing', territoryId: body.territory.id },
      },
    });
    expect(reuseRes.statusCode).toBe(201);
  });

  it('rejects cross-company MR assignment with 404 and rolls back the entire onboard transaction', async () => {
    const tenantA = await seedCompanyWithUsers(prisma, {
      code: 'compa',
      name: 'Company A',
    });
    const tenantB = await seedCompanyWithUsers(prisma, {
      code: 'compb',
      name: 'Company B',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors/onboard',
      headers: { authorization: await bearerForUser(tenantA.hc) },
      payload: {
        doctor: { name: 'Dr. Rollback', specialty: 'Cardiology' },
        clinic: {
          mode: 'new',
          name: 'Rollback Clinic',
          formattedAddress: '100 Feet Road, Indiranagar',
          source: 'manual',
        },
        territory: {
          mode: 'new',
          code: 'INDIRA',
          name: 'Indiranagar',
        },
        assignMrId: tenantB.mr.id,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(
      await prisma.doctor.count({ where: { companyId: tenantA.company.id } }),
    ).toBe(0);
    expect(
      await prisma.clinic.count({ where: { companyId: tenantA.company.id } }),
    ).toBe(0);
  });

  it('editing a clinic creates a new versioned DoctorClinicLocation while keeping historical visit GPS untouched', async () => {
    const tenantA = await seedCompanyWithUsers(prisma, {
      code: 'compa',
      name: 'Company A',
    });
    const hcBearer = await bearerForUser(tenantA.hc);

    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors/onboard',
      headers: { authorization: hcBearer },
      payload: {
        doctor: { name: 'Dr. History', specialty: 'Neurology' },
        clinic: {
          mode: 'new',
          name: 'Old Clinic Name',
          formattedAddress: 'Old Address Street',
          latitude: 12.90,
          longitude: 77.50,
          source: 'gps',
        },
        territory: { mode: 'new', code: 'NORTH', name: 'North' },
      },
    });
    const { doctor, clinic, clinicLocation } = onboardRes.json();

    const historicalVisit = await prisma.visit.create({
      data: {
        companyId: tenantA.company.id,
        mrId: tenantA.mr.id,
        doctorId: doctor.id,
        status: 'completed',
        checkInLatitude: 12.9001,
        checkInLongitude: 77.5001,
        checkInDistanceMeters: 15,
        checkInVerificationStatus: VisitVerificationStatus.verified,
        doctorClinicLocationIdAtCheckIn: clinicLocation.id,
        capturedAtClient: new Date(),
      },
    });

    const editRes = await app.inject({
      method: 'PATCH',
      url: `/v1/hc/clinics/${clinic.id}`,
      headers: { authorization: hcBearer },
      payload: {
        name: 'Relocated Clinic Name',
        formattedAddress: 'New Address Avenue',
        latitude: 13.05,
        longitude: 77.65,
      },
    });
    expect(editRes.statusCode).toBe(200);

    const visitAfter = await prisma.visit.findUnique({
      where: { id: historicalVisit.id },
    });
    expect(visitAfter?.checkInLatitude).toBe(12.9001);
    expect(visitAfter?.doctorClinicLocationIdAtCheckIn).toBe(clinicLocation.id);

    const locs = await prisma.doctorClinicLocation.findMany({
      where: { doctorId: doctor.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(locs).toHaveLength(2);
    expect(locs[0]?.isCurrent).toBe(false);
    expect(locs[0]?.latitude).toBe(12.90);
    expect(locs[1]?.isCurrent).toBe(true);
    expect(locs[1]?.latitude).toBe(13.05);
  });
});
