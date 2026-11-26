import {
  AccountStatus,
  DataClassification,
  PrismaClient,
  Role,
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

describe('Part 7 — Chunk 3 Strict Tenant Isolation & Data Cleanliness Security Tests', () => {
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

  it('denies all cross-company Chunk 3 reads, writes, clinics, monitoring, activity, and recovery with 404 and ignores forged companyId headers/queries', async () => {
    const tenantA = await seedCompanyWithUsers(prisma, {
      code: 'compa',
      name: 'Company A',
    });
    const tenantB = await seedCompanyWithUsers(prisma, {
      code: 'compb',
      name: 'Company B',
    });

    const hcABearer = await bearerForUser(tenantA.hc);
    const now = new Date();

    const clinicB = await prisma.clinic.create({
      data: {
        companyId: tenantB.company.id,
        name: 'Secret Clinic B',
        normalizedName: 'secret clinic b',
        formattedAddress: 'Confidential Road, Bengaluru',
      },
    });
    const terB = await prisma.territory.create({
      data: { companyId: tenantB.company.id, code: 'TERB', name: 'Zone B' },
    });
    const docB = await prisma.doctor.create({
      data: {
        companyId: tenantB.company.id,
        clinicId: clinicB.id,
        name: 'Dr. Secret B',
        specialty: 'Cardiology',
      },
    });
    const wdB = await prisma.workDay.create({
      data: {
        companyId: tenantB.company.id,
        mrId: tenantB.mr.id,
        startedAt: new Date(now.getTime() - 3_600_000),
        endedAt: new Date(now.getTime() - 60_000),
      },
    });
    const visitB = await prisma.visit.create({
      data: {
        companyId: tenantB.company.id,
        mrId: tenantB.mr.id,
        doctorId: docB.id,
        workDayId: wdB.id,
        status: 'completed',
        checkInVerificationStatus: VisitVerificationStatus.verified,
        capturedAtClient: now,
      },
    });

    const attacks = [
      {
        method: 'PATCH' as const,
        url: `/v1/hc/clinics/${clinicB.id}`,
        payload: { name: 'Hijacked Clinic' },
      },
      {
        method: 'GET' as const,
        url: `/v1/hc/territories/${terB.id}`,
      },
      {
        method: 'GET' as const,
        url: `/v1/hc/mrs/${tenantB.mr.id}/monitoring`,
      },
      {
        method: 'POST' as const,
        url: `/v1/hc/workdays/${wdB.id}/reopen`,
        payload: { reason: 'Cross-tenant workday hijack attempt' },
      },
      {
        method: 'POST' as const,
        url: `/v1/hc/visits/${visitB.id}/correct`,
        payload: { reason: 'Cross-tenant visit hijack attempt' },
      },
      {
        method: 'POST' as const,
        url: '/v1/hc/doctors/onboard',
        payload: {
          doctor: { name: 'Dr. Inject', specialty: 'Cardio' },
          clinic: { mode: 'existing', clinicId: clinicB.id },
          territory: { mode: 'new', code: 'ZONEA1', name: 'Zone A1' },
        },
      },
    ];

    for (const attack of attacks) {
      const res = await app.inject({
        method: attack.method,
        url: attack.url,
        headers: {
          authorization: hcABearer,
          'x-company-id': String(tenantB.company.id),
        },
        ...(attack.payload ? { payload: attack.payload } : {}),
      });
      expect(res.statusCode, `${attack.method} ${attack.url}`).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }

    const forgedDash = await app.inject({
      method: 'GET',
      url: `/v1/hc/dashboard?companyId=${tenantB.company.id}`,
      headers: {
        authorization: hcABearer,
        'x-company-id': String(tenantB.company.id),
      },
    });
    expect(forgedDash.statusCode).toBe(200);
    expect(forgedDash.json().company.id).toBe(tenantA.company.id);
    expect(forgedDash.json().metrics.visitsCompletedToday).toBe(0);

    const forgedClinics = await app.inject({
      method: 'GET',
      url: `/v1/hc/clinics?companyId=${tenantB.company.id}`,
      headers: {
        authorization: hcABearer,
        'x-company-id': String(tenantB.company.id),
      },
    });
    expect(forgedClinics.statusCode).toBe(200);
    expect(forgedClinics.json().clinics).toHaveLength(0);

    const forgedActivity = await app.inject({
      method: 'GET',
      url: `/v1/hc/activity?mrId=${tenantB.mr.id}`,
      headers: { authorization: hcABearer },
    });
    expect(forgedActivity.statusCode).toBe(200);
    expect(forgedActivity.json().events).toHaveLength(0);
  });

  it('brand-new Company C and new HC C see zero demo, seed, test, or other-company records across every HC endpoint', async () => {
    const demoCo = await prisma.company.create({
      data: {
        name: 'Demo Pharma',
        code: 'demo_co',
        dataClassification: DataClassification.demo,
      },
    });
    await prisma.doctor.create({
      data: {
        companyId: demoCo.id,
        name: 'Dr. Demo Seed',
        specialty: 'Cardio',
        dataClassification: DataClassification.demo,
      },
    });
    await seedCompanyWithUsers(prisma, { code: 'compa', name: 'Company A' });

    const companyC = await prisma.company.create({
      data: { name: 'CleanStart Healthcare', code: 'cleanstart' },
    });
    const hcC = await prisma.user.create({
      data: {
        companyId: companyC.id,
        employeeId: 'HC_CLEAN',
        email: 'hc@cleanstart.test',
        displayName: 'Clean HC',
        passwordHash: await hashPassword(TEST_PASSWORD),
        role: Role.headController,
        accountStatus: AccountStatus.active,
      },
    });

    const hcCBearer = await bearerForUser(hcC);
    const [dash, docs, clinics, ters, mrs, act] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/v1/hc/dashboard',
        headers: { authorization: hcCBearer },
      }),
      app.inject({
        method: 'GET',
        url: '/v1/hc/doctors',
        headers: { authorization: hcCBearer },
      }),
      app.inject({
        method: 'GET',
        url: '/v1/hc/clinics',
        headers: { authorization: hcCBearer },
      }),
      app.inject({
        method: 'GET',
        url: '/v1/hc/territories',
        headers: { authorization: hcCBearer },
      }),
      app.inject({
        method: 'GET',
        url: '/v1/hc/mrs',
        headers: { authorization: hcCBearer },
      }),
      app.inject({
        method: 'GET',
        url: '/v1/hc/activity',
        headers: { authorization: hcCBearer },
      }),
    ]);

    expect(dash.statusCode).toBe(200);
    expect(dash.json().metrics.totalAssignedMrs).toBe(0);
    expect(dash.json().metrics.visitsCompletedToday).toBe(0);
    expect(dash.json().mrSummaries).toEqual([]);
    expect(docs.json().doctors).toEqual([]);
    expect(clinics.json().clinics).toEqual([]);
    expect(ters.json().territories).toEqual([]);
    expect(mrs.json().mrs).toEqual([]);
    expect(act.json().events).toEqual([]);
  });
});
