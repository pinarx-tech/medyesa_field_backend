import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AccountStatus, PrismaClient, Role } from '@prisma/client';
import { AppError } from '../lib/errors.js';
import { signAccessToken } from '../lib/jwt.js';
import {
  generateOpaqueToken,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from '../lib/password.js';
import { writeAuditLog } from '../lib/audit.js';
import { buildAuthPreHandler } from '../plugins/auth.js';
import {
  changePasswordBodySchema,
  forgotPasswordBodySchema,
  loginBodySchema,
  logoutBodySchema,
  refreshBodySchema,
  resetPasswordBodySchema,
  platformAdminLoginBodySchema,
} from '../schemas/auth.js';

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export async function registerAuthRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = buildAuthPreHandler(prisma);

  // Dedicated authentication endpoint for the PINARX administration portal.
  typed.post(
    '/v1/auth/platform-admin/login',
    { schema: { body: platformAdminLoginBodySchema } },
    async (req) => {
      const { employeeIdOrEmail, password } = req.body;

      const user = await prisma.user.findFirst({
        where: {
          platformAdmin: { isNot: null },
          role: Role.platformAdmin,
          OR: [
            { employeeId: { equals: employeeIdOrEmail, mode: 'insensitive' } },
            { email: { equals: employeeIdOrEmail, mode: 'insensitive' } },
          ],
        },
      });

      if (!user) {
        throw new AppError('unauthenticated', 401, 'Invalid credentials.');
      }

      const passwordOk = await verifyPassword(user.passwordHash, password);
      if (!passwordOk) {
        throw new AppError('unauthenticated', 401, 'Invalid credentials.');
      }

      if (user.deletedAt !== null) {
        throw new AppError('account_deleted', 403, 'Account has been deleted.');
      }

      if (user.accountStatus !== AccountStatus.active) {
        throw new AppError('account_inactive', 403, 'Account is not active.');
      }

      const accessToken = await signAccessToken({
        userId: user.id,
        role: Role.platformAdmin,
      });

      const refreshToken = generateOpaqueToken();

      await prisma.$transaction([
        prisma.refreshToken.create({
          data: {
            userId: user.id,
            tokenHash: sha256Hex(refreshToken),
            expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
            userAgent: req.headers['user-agent'] ?? null,
            ipAddress: req.ip,
          },
        }),
        prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        }),
      ]);

      await writeAuditLog(prisma, {
        companyId: null,
        actorId: user.id,
        action: 'platform_admin_login',
        targetType: 'user',
        targetId: user.id,
        ipAddress: req.ip,
      });

      return {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          displayName: user.displayName,
          role: user.role,
          companyId: user.companyId,
          accountStatus: user.accountStatus,
          mustChangePassword: user.mustChangePassword,
        },
      };
    },
  );

  typed.post(
    '/v1/auth/login',
    { schema: { body: loginBodySchema } },
    async (req) => {
      const { employeeIdOrEmail, password, companyCode } = req.body;

      let companyFilter: number | undefined;
      if (companyCode) {
        const company = await prisma.company.findUnique({
          where: { code: companyCode.toLowerCase() },
        });
        if (!company) {
          throw new AppError('unauthenticated', 401, 'Invalid credentials.');
        }
        companyFilter = company.id;
      }

      const candidates = await prisma.user.findMany({
        where: {
          ...(companyFilter !== undefined ? { companyId: companyFilter } : {}),
          OR: [
            { employeeId: { equals: employeeIdOrEmail, mode: 'insensitive' } },
            { email: { equals: employeeIdOrEmail, mode: 'insensitive' } },
          ],
        },
        take: 2,
      });

      if (candidates.length === 0) {
        throw new AppError('unauthenticated', 401, 'Invalid credentials.');
      }
      if (candidates.length > 1) {
        throw new AppError(
          'validation_error',
          400,
          'Multiple accounts match this identifier; please provide companyCode or email.',
        );
      }

      const user = candidates[0]!;
      const passwordOk = await verifyPassword(user.passwordHash, password);
      if (!passwordOk) {
        throw new AppError('unauthenticated', 401, 'Invalid credentials.');
      }

      if (user.role === Role.platformAdmin) {
        throw new AppError(
          'forbidden',
          403,
          'Platform admin login is not permitted on this endpoint.',
        );
      }
      if (user.deletedAt !== null) {
        throw new AppError('account_deleted', 403, 'Account has been deleted.');
      }
      if (user.accountStatus !== AccountStatus.active) {
        throw new AppError(
          'account_inactive',
          403,
          'Account is not active. Contact your administrator.',
        );
      }

      const accessToken = await signAccessToken({
        userId: user.id,
        role: user.role,
      });
      const refreshToken = generateOpaqueToken();
      const tokenHash = sha256Hex(refreshToken);

      await prisma.$transaction([
        prisma.refreshToken.create({
          data: {
            userId: user.id,
            tokenHash,
            expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
            userAgent: req.headers['user-agent'] ?? null,
            ipAddress: req.ip,
          },
        }),
        prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        }),
      ]);

      await writeAuditLog(prisma, {
        companyId: user.companyId,
        actorId: user.id,
        action: user.role === Role.headController ? 'admin_login' : 'mr_login',
        targetType: 'user',
        targetId: user.id,
        ipAddress: req.ip,
      });

      return {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          displayName: user.displayName,
          role: user.role,
          companyId: user.companyId,
          accountStatus: user.accountStatus,
          mustChangePassword: user.mustChangePassword,
        },
      };
    },
  );

  typed.post(
    '/v1/auth/refresh',
    { schema: { body: refreshBodySchema } },
    async (req) => {
      const tokenHash = sha256Hex(req.body.refreshToken);
      const existing = await prisma.refreshToken.findUnique({
        where: { tokenHash },
        include: { user: true },
      });

      if (
        !existing ||
        existing.revokedAt !== null ||
        existing.expiresAt <= new Date()
      ) {
        throw new AppError(
          'unauthenticated',
          401,
          'Invalid or expired refresh token.',
        );
      }

      if (existing.user.deletedAt !== null) {
        throw new AppError('account_deleted', 403, 'Account has been deleted.');
      }
      if (existing.user.accountStatus !== AccountStatus.active) {
        throw new AppError('account_inactive', 403, 'Account is not active.');
      }

      const nextRefreshToken = generateOpaqueToken();
      const nextHash = sha256Hex(nextRefreshToken);
      const nextAccessToken = await signAccessToken({
        userId: existing.user.id,
        role: existing.user.role,
      });

      await prisma.$transaction([
        prisma.refreshToken.update({
          where: { id: existing.id },
          data: { revokedAt: new Date() },
        }),
        prisma.refreshToken.create({
          data: {
            userId: existing.user.id,
            tokenHash: nextHash,
            expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
            userAgent: req.headers['user-agent'] ?? null,
            ipAddress: req.ip,
          },
        }),
      ]);

      return {
        accessToken: nextAccessToken,
        refreshToken: nextRefreshToken,
      };
    },
  );

  typed.post(
    '/v1/auth/logout',
    { schema: { body: logoutBodySchema } },
    async (req) => {
      const tokenHash = sha256Hex(req.body.refreshToken);
      await prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { ok: true };
    },
  );

  typed.post(
    '/v1/auth/logout-all',
    { preHandler: [authenticate] },
    async (req) => {
      const userId = req.authUser!.userId;
      await prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { ok: true };
    },
  );

  typed.get('/v1/auth/me', { preHandler: [authenticate] }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.authUser!.userId },
      select: {
        id: true,
        companyId: true,
        employeeId: true,
        email: true,
        displayName: true,
        phone: true,
        role: true,
        accountStatus: true,
        mustChangePassword: true,
        lastLoginAt: true,
      },
    });
    if (!user) {
      throw new AppError('unauthenticated', 401, 'Account not found.');
    }
    return { user };
  });

  typed.post(
    '/v1/auth/change-password',
    {
      preHandler: [authenticate],
      schema: { body: changePasswordBodySchema },
    },
    async (req) => {
      const userId = req.authUser!.userId;
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new AppError('unauthenticated', 401, 'Account not found.');
      }

      const valid = await verifyPassword(
        user.passwordHash,
        req.body.currentPassword,
      );
      if (!valid) {
        throw new AppError(
          'unauthenticated',
          401,
          'Current password is incorrect.',
        );
      }

      const nextHash = await hashPassword(req.body.newPassword);
      const keepHash = req.body.currentRefreshToken
        ? sha256Hex(req.body.currentRefreshToken)
        : null;

      await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data: { passwordHash: nextHash, mustChangePassword: false },
        }),
        prisma.refreshToken.updateMany({
          where: {
            userId,
            revokedAt: null,
            ...(keepHash ? { tokenHash: { not: keepHash } } : {}),
          },
          data: { revokedAt: new Date() },
        }),
      ]);

      await writeAuditLog(prisma, {
        companyId: user.companyId,
        actorId: userId,
        action: 'password_changed',
        targetType: 'user',
        targetId: userId,
        ipAddress: req.ip,
      });

      return { ok: true };
    },
  );

  typed.post(
    '/v1/auth/forgot-password',
    { schema: { body: forgotPasswordBodySchema } },
    async (req) => {
      const user = await prisma.user.findFirst({
        where: {
          email: { equals: req.body.email, mode: 'insensitive' },
          deletedAt: null,
        },
      });

      if (user) {
        const resetToken = generateOpaqueToken();
        await prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: sha256Hex(resetToken),
            expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
          },
        });
        req.log.info(
          { userId: user.id, stubTokenPrefix: resetToken.slice(0, 6) },
          '[STUB] Password reset token created; email delivery not configured in Chunk 1.',
        );
      }

      throw new AppError(
        'not_implemented',
        501,
        'Email delivery is not configured in Chunk 1.',
      );
    },
  );

  typed.post(
    '/v1/auth/reset-password',
    { schema: { body: resetPasswordBodySchema } },
    async (req) => {
      const tokenHash = sha256Hex(req.body.token);
      const record = await prisma.passwordResetToken.findUnique({
        where: { tokenHash },
      });

      if (!record || record.usedAt !== null || record.expiresAt <= new Date()) {
        throw new AppError(
          'unauthenticated',
          401,
          'Invalid or expired password reset token.',
        );
      }

      const nextHash = await hashPassword(req.body.newPassword);
      await prisma.$transaction([
        prisma.user.update({
          where: { id: record.userId },
          data: { passwordHash: nextHash, mustChangePassword: false },
        }),
        prisma.refreshToken.updateMany({
          where: { userId: record.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
        prisma.passwordResetToken.delete({
          where: { id: record.id },
        }),
      ]);

      return { ok: true };
    },
  );
}
