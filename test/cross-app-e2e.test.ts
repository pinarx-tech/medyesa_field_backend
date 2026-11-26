import { PrismaClient, VisitVerificationStatus } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  resetDatabase,
  seedPlatformAdmin,
} from './helpers.js';

describe('Part 8 — Cross-Application End-to-End Integration (Portal + HC + MR)', () => {
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

  it('executes full Portal -> HC Onboard -> MR Visit/Sync -> HC Dashboard/Activity/Recovery -> Portal Suspend lifecycle', async () => {
    const { token: paToken } = await seedPlatformAdmin(prisma);
    const paBearer = `Bearer ${paToken}`;

    // Step 1: Portal creates Brand-New Company X
    const coRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/companies',
      headers: { authorization: paBearer },
      payload: {
        name: 'Zenith Lifesciences',
        code: 'zenith',
        licensedMrSeats: 2,
        licensedHcSeats: 1,
      },
    });
    expect(coRes.statusCode).toBe(201);
    const companyId = coRes.json().company.id as number;

    // Step 2 & 3: Portal creates HC X and MR X with backend-generated temp passwords
    const hcCreate = await app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: { authorization: paBearer },
      payload: {
        companyId,
        employeeId: 'HC9001',
        email: 'meera@zenith.test',
        displayName: 'Meera Krishnan',
        role: 'headController',
      },
    });
    expect(hcCreate.statusCode).toBe(201);
    const hcTempPass = hcCreate.json().temporaryPassword as string;
    expect(hcTempPass).toMatch(/^Meera@\d{6}$/);

    const mrCreate = await app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: { authorization: paBearer },
      payload: {
        companyId,
        employeeId: 'MR9001',
        email: 'priya@zenith.test',
        displayName: 'Priya Nair',
        role: 'mr',
      },
    });
    expect(mrCreate.statusCode).toBe(201);
    const mrUserId = mrCreate.json().user.id as string;
    const mrTempPass = mrCreate.json().temporaryPassword as string;
    expect(mrTempPass).toMatch(/^Priya@\d{6}$/);

    // Step 4: HC X logs in -> changes temp password -> confirms spotless empty dashboard
    const hcLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { employeeIdOrEmail: 'HC9001', password: hcTempPass },
    });
    expect(hcLogin.statusCode).toBe(200);
    const hcBearer = `Bearer ${hcLogin.json().accessToken}`;

    const hcChange = await app.inject({
      method: 'POST',
      url: '/v1/auth/change-password',
      headers: { authorization: hcBearer },
      payload: {
        currentPassword: hcTempPass,
        newPassword: 'HcNewPassword!99',
        currentRefreshToken: hcLogin.json().refreshToken,
      },
    });
    expect(hcChange.statusCode).toBe(200);

    const initialDash = await app.inject({
      method: 'GET',
      url: '/v1/hc/dashboard',
      headers: { authorization: hcBearer },
    });
    expect(initialDash.statusCode).toBe(200);
    expect(initialDash.json().metrics).toMatchObject({
      totalAssignedMrs: 1,
      mrsCurrentlyWorking: 0,
      mrsNotStarted: 1,
      visitsCompletedToday: 0,
      visitsPendingToday: 0,
      syncFailuresCount: 0,
    });

    // Step 5: HC X executes One-Page Add Doctor
    const onboard = await app.inject({
      method: 'POST',
      url: '/v1/hc/doctors/onboard',
      headers: { authorization: hcBearer },
      payload: {
        doctor: {
          name: 'Dr. Ananya Rao',
          specialty: 'Cardiology',
          geofenceRadiusMeters: 100,
        },
        clinic: {
          mode: 'new',
          name: 'Zenith Heart Center',
          formattedAddress: 'MG Road, Bengaluru',
          latitude: 12.975,
          longitude: 77.605,
          accuracyMeters: 8,
          source: 'gps',
        },
        territory: {
          mode: 'new',
          code: 'BLR_CENTRAL',
          name: 'Bengaluru Central',
        },
        assignMrId: mrUserId,
      },
    });
    expect(onboard.statusCode).toBe(201);
    const doctorId = onboard.json().doctor.id as string;

    // Step 6: MR X logs in -> changes temp password -> sees assigned doctor -> starts day & records visit via sync batch
    const mrLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { employeeIdOrEmail: 'MR9001', password: mrTempPass },
    });
    expect(mrLogin.statusCode).toBe(200);
    const mrBearer = `Bearer ${mrLogin.json().accessToken}`;

    await app.inject({
      method: 'POST',
      url: '/v1/auth/change-password',
      headers: { authorization: mrBearer },
      payload: {
        currentPassword: mrTempPass,
        newPassword: 'MrNewPassword!99',
        currentRefreshToken: mrLogin.json().refreshToken,
      },
    });

    const mrToday = await app.inject({
      method: 'GET',
      url: '/v1/mr/today',
      headers: { authorization: mrBearer },
    });
    expect(mrToday.statusCode).toBe(200);
    expect(mrToday.json().doctors.map((d: { id: string }) => d.id)).toContain(
      doctorId,
    );

    const nowIso = new Date().toISOString();
    const syncRes = await app.inject({
      method: 'POST',
      url: '/v1/mr/sync/batch',
      headers: { authorization: mrBearer },
      payload: {
        operations: [
          {
            clientId: 'e2e-wd-start',
            entityType: 'workDay',
            entityId: 'local-wd',
            operation: 'start',
            payload: { startedAt: nowIso },
            capturedAtClient: nowIso,
          },
          {
            clientId: 'e2e-visit-1',
            entityType: 'visit',
            entityId: 'local-v1',
            operation: 'create',
            payload: {
              doctorId,
              status: 'completed',
              checkInDistanceMeters: 25,
              checkInVerificationStatus: VisitVerificationStatus.verified,
            },
            capturedAtClient: nowIso,
          },
        ],
      },
    });
    expect(syncRes.statusCode).toBe(200);
    const workDayServerId = syncRes.json().results[0].serverId as string;
    const visitServerId = syncRes.json().results[1].serverId as string;

    // Step 7: HC X refreshes Dashboard & Activity -> sees MR working + 1 completed visit
    const liveDash = await app.inject({
      method: 'GET',
      url: '/v1/hc/dashboard',
      headers: { authorization: hcBearer },
    });
    expect(liveDash.json().metrics.mrsCurrentlyWorking).toBe(1);
    expect(liveDash.json().metrics.visitsCompletedToday).toBe(1);
    expect(liveDash.json().metrics.visitsPendingToday).toBe(0);

    // Step 8: HC X corrects visit -> original preserved as superseded
    const corrRes = await app.inject({
      method: 'POST',
      url: `/v1/hc/visits/${visitServerId}/correct`,
      headers: { authorization: hcBearer },
      payload: {
        reason: 'Added follow-up product note.',
        status: 'completed',
        noteText: 'Follow up with GlucoNorm samples.',
      },
    });
    expect(corrRes.statusCode).toBe(201);

    // Step 9: MR X accidentally ends day -> HC X reopens workday -> audited and active again
    const endRes = await app.inject({
      method: 'POST',
      url: '/v1/mr/workday/end',
      headers: { authorization: mrBearer },
      payload: {
        clientId: 'e2e-wd-end',
        workDayClientId: workDayServerId,
        endedAt: new Date().toISOString(),
        autoClosed: false,
      },
    });
    expect(endRes.statusCode).toBe(200);

    const reopenRes = await app.inject({
      method: 'POST',
      url: `/v1/hc/workdays/${workDayServerId}/reopen`,
      headers: { authorization: hcBearer },
      payload: { reason: 'Accidental End Day tap by MR.' },
    });
    expect(reopenRes.statusCode).toBe(200);
    expect(reopenRes.json().workDay.endedAt).toBeNull();

    // Step 10: Portal suspends MR X -> MR X immediately rejected with 403 account_inactive
    const suspendRes = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${mrUserId}/suspend`,
      headers: { authorization: paBearer },
    });
    expect(suspendRes.statusCode).toBe(200);

    const blockedMrCall = await app.inject({
      method: 'GET',
      url: '/v1/mr/today',
      headers: { authorization: mrBearer },
    });
    expect(blockedMrCall.statusCode).toBe(403);
    expect(blockedMrCall.json().error.code).toBe('account_inactive');
  });
});
