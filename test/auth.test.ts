import { AccountStatus, PrismaClient, Role } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_PASSWORD,
  bearerForUser,
  createTestContext,
  resetDatabase,
  seedCompanyWithUsers,
  seedPlatformAdmin,
} from './helpers.js';
import { hashPassword } from '../src/lib/password.js';

describe('Auth endpoints (Tests 4–18)', () => {
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

  it('4. login succeeds with employeeId', async () => {
    const { company, mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        employeeIdOrEmail: mr.employeeId,
        password: TEST_PASSWORD,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.refreshToken).toBeTypeOf('string');
    expect(body.user.id).toBe(mr.id);
    expect(body.user.companyId).toBe(company.id);
    expect(body.user.role).toBe('mr');
    expect(body.user.passwordHash).toBeUndefined();
  });

  it('5. login succeeds with email', async () => {
    const { company, mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        employeeIdOrEmail: mr.email,
        password: TEST_PASSWORD,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.user.id).toBe(mr.id);
    expect(body.user.companyId).toBe(company.id);
  });

  it('6. login rejects wrong password (401)', async () => {
    const { mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        employeeIdOrEmail: mr.employeeId,
        password: 'WrongPassword!999',
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('7. login rejects deactivated account (403 account_inactive)', async () => {
    const { mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    await prisma.user.update({
      where: { id: mr.id },
      data: { accountStatus: AccountStatus.deactivated },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        employeeIdOrEmail: mr.employeeId,
        password: TEST_PASSWORD,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('account_inactive');
  });

  it('8. login rejects platformAdmin (403)', async () => {
    const { user: pa } = await seedPlatformAdmin(prisma);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        employeeIdOrEmail: pa.employeeId,
        password: TEST_PASSWORD,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('9. login with companyCode disambiguates duplicate employeeIds', async () => {
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const companyA = await prisma.company.create({
      data: { name: 'Alpha Pharma', code: 'alpha' },
    });
    const companyB = await prisma.company.create({
      data: { name: 'Beta Pharma', code: 'beta' },
    });

    // Both companies have an employee with ID MR1001
    await prisma.user.create({
      data: {
        companyId: companyA.id,
        employeeId: 'MR1001',
        email: 'mr1001@alpha.test',
        displayName: 'Alpha MR',
        passwordHash,
        role: Role.mr,
      },
    });

    await prisma.user.create({
      data: {
        companyId: companyB.id,
        employeeId: 'MR1001',
        email: 'mr1001@beta.test',
        displayName: 'Beta MR',
        passwordHash,
        role: Role.mr,
      },
    });

    // Without companyCode, ambiguous match returns 400 validation_error
    const ambiguousRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        employeeIdOrEmail: 'MR1001',
        password: TEST_PASSWORD,
      },
    });
    expect(ambiguousRes.statusCode).toBe(400);
    expect(ambiguousRes.json().error.code).toBe('validation_error');

    // With companyCode 'alpha', resolves to Alpha MR
    const disambiguatedRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        employeeIdOrEmail: 'MR1001',
        companyCode: 'alpha',
        password: TEST_PASSWORD,
      },
    });
    expect(disambiguatedRes.statusCode).toBe(200);
    expect(disambiguatedRes.json().user.companyId).toBe(companyA.id);
  });

  it('10. refresh rotates token and revokes old token', async () => {
    const { hc } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { employeeIdOrEmail: hc.email, password: TEST_PASSWORD },
    });
    const firstRefresh = loginRes.json().refreshToken as string;

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: firstRefresh },
    });
    expect(refreshRes.statusCode).toBe(200);
    const secondRefresh = refreshRes.json().refreshToken as string;
    expect(secondRefresh).not.toBe(firstRefresh);

    // Old token was revoked
    const replayRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: firstRefresh },
    });
    expect(replayRes.statusCode).toBe(401);
  });

  it('11. refresh rejects revoked token (401)', async () => {
    const { mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { employeeIdOrEmail: mr.email, password: TEST_PASSWORD },
    });
    const refreshToken = loginRes.json().refreshToken as string;

    // Logout revokes it
    await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refreshToken },
    });

    // Refresh with revoked token must return 401
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('12. logout revokes refresh token', async () => {
    const { mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { employeeIdOrEmail: mr.email, password: TEST_PASSWORD },
    });
    const refreshToken = loginRes.json().refreshToken as string;

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refreshToken },
    });
    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.json().ok).toBe(true);

    const afterLogout = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('13. logout-all revokes all refresh tokens for user', async () => {
    const { mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    // Create 2 sessions
    const session1 = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { employeeIdOrEmail: mr.email, password: TEST_PASSWORD },
      })
    ).json();

    const session2 = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { employeeIdOrEmail: mr.email, password: TEST_PASSWORD },
      })
    ).json();

    // Call logout-all with session1 accessToken
    const logoutAllRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { authorization: `Bearer ${session1.accessToken}` },
    });
    expect(logoutAllRes.statusCode).toBe(200);
    expect(logoutAllRes.json().ok).toBe(true);

    // Both refresh tokens are now revoked
    const refresh1 = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session1.refreshToken },
    });
    expect(refresh1.statusCode).toBe(401);

    const refresh2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session2.refreshToken },
    });
    expect(refresh2.statusCode).toBe(401);
  });

  it('14. me returns user with companyId', async () => {
    const { company, mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { employeeIdOrEmail: mr.email, password: TEST_PASSWORD },
    });
    const accessToken = loginRes.json().accessToken as string;

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().user.id).toBe(mr.id);
    expect(meRes.json().user.companyId).toBe(company.id);
    expect(meRes.json().user.role).toBe('mr');
    expect(meRes.json().user.passwordHash).toBeUndefined();
  });

  it('15. change-password requires correct currentPassword', async () => {
    const { mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    const token = await bearerForUser(mr);

    const failRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/change-password',
      headers: { authorization: token },
      payload: {
        currentPassword: 'IncorrectPassword!999',
        newPassword: 'UpdatedPassword!456',
      },
    });
    expect(failRes.statusCode).toBe(401);
    expect(failRes.json().error.code).toBe('unauthenticated');
  });

  it('16. change-password updates hash and revokes other refresh tokens', async () => {
    const { mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    const session1 = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { employeeIdOrEmail: mr.email, password: TEST_PASSWORD },
      })
    ).json();
    const session2 = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { employeeIdOrEmail: mr.email, password: TEST_PASSWORD },
      })
    ).json();

    const changeRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/change-password',
      headers: { authorization: `Bearer ${session1.accessToken}` },
      payload: {
        currentPassword: TEST_PASSWORD,
        newPassword: 'UpdatedPassword!456',
        currentRefreshToken: session1.refreshToken,
      },
    });
    expect(changeRes.statusCode).toBe(200);

    // Other device's refresh token is revoked
    const otherRefresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session2.refreshToken },
    });
    expect(otherRefresh.statusCode).toBe(401);

    // New password logs in cleanly
    const newLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        employeeIdOrEmail: mr.email,
        password: 'UpdatedPassword!456',
      },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it('17. forgot-password returns 501 regardless of email existence', async () => {
    const { mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    // Existing user email
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email: mr.email },
    });
    expect(res1.statusCode).toBe(501);
    expect(res1.json().error.code).toBe('not_implemented');

    // Non-existent email
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email: 'nonexistent@example.com' },
    });
    expect(res2.statusCode).toBe(501);
    expect(res2.json().error.code).toBe('not_implemented');
  });

  it('18. reset-password consumes token and revokes refresh tokens', async () => {
    const { mr } = await seedCompanyWithUsers(prisma, {
      code: 'medyesa',
      name: 'Medyesa Healthcare',
    });

    // Create session to verify it gets revoked
    const session = (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { employeeIdOrEmail: mr.email, password: TEST_PASSWORD },
      })
    ).json();

    // Directly insert password reset token
    const rawResetToken = 'valid-reset-token-abc-123-xyz-789';
    const { createHash } = await import('node:crypto');
    const tokenHash = createHash('sha256').update(rawResetToken).digest('hex');

    await prisma.passwordResetToken.create({
      data: {
        userId: mr.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 1000 * 60 * 30),
      },
    });

    const resetRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: {
        token: rawResetToken,
        newPassword: 'BrandNewPassword!999',
      },
    });
    expect(resetRes.statusCode).toBe(200);
    expect(resetRes.json().ok).toBe(true);

    // Old refresh token is revoked
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(refreshRes.statusCode).toBe(401);

    // Replay reset token fails 401
    const replayRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: {
        token: rawResetToken,
        newPassword: 'BrandNewPassword!999',
      },
    });
    expect(replayRes.statusCode).toBe(401);

    // New password logs in cleanly
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        employeeIdOrEmail: mr.email,
        password: 'BrandNewPassword!999',
      },
    });
    expect(loginRes.statusCode).toBe(200);
  });

  describe('Platform Admin login', () => {
    it('logs in using email', async () => {
      const { user } = await seedPlatformAdmin(prisma);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/platform-admin/login',
        payload: {
          employeeIdOrEmail: user.email,
          password: TEST_PASSWORD,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accessToken).toBeTypeOf('string');
      expect(body.refreshToken).toBeTypeOf('string');
      expect(body.user.id).toBe(user.id);
      expect(body.user.role).toBe('platformAdmin');
      expect(body.user.passwordHash).toBeUndefined();

      const storedTokens = await prisma.refreshToken.count({
        where: { userId: user.id },
      });
      expect(storedTokens).toBe(1);
    });

    it('logs in using employee ID', async () => {
      const { user } = await seedPlatformAdmin(prisma);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/platform-admin/login',
        payload: {
          employeeIdOrEmail: user.employeeId,
          password: TEST_PASSWORD,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().user.id).toBe(user.id);
    });

    it('rejects an incorrect password', async () => {
      const { user } = await seedPlatformAdmin(prisma);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/platform-admin/login',
        payload: {
          employeeIdOrEmail: user.email,
          password: 'WrongPassword!123',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('rejects a company HC/MR account', async () => {
      const { mr } = await seedCompanyWithUsers(prisma, {
        code: 'medyesa',
        name: 'Medyesa Healthcare',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/platform-admin/login',
        payload: {
          employeeIdOrEmail: mr.email,
          password: TEST_PASSWORD,
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('rejects a deactivated Platform Admin', async () => {
      const { user } = await seedPlatformAdmin(prisma);

      await prisma.user.update({
        where: { id: user.id },
        data: { accountStatus: AccountStatus.deactivated },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/platform-admin/login',
        payload: {
          employeeIdOrEmail: user.email,
          password: TEST_PASSWORD,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('account_inactive');
    });

    it('rejects a suspended Platform Admin', async () => {
      const { user } = await seedPlatformAdmin(prisma);

      await prisma.user.update({
        where: { id: user.id },
        data: { accountStatus: AccountStatus.suspended },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/platform-admin/login',
        payload: {
          employeeIdOrEmail: user.email,
          password: TEST_PASSWORD,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('account_inactive');
    });
  });

});
