import { FastifyRequest } from 'fastify';
import { AccountStatus, PrismaClient, Role } from '@prisma/client';
import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { RequestContext } from '../lib/repo.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: RequestContext;
  }
}

/**
 * Verifies Bearer JWT and loads fresh user state (`companyId`, `role`,
 * `accountStatus`, `deletedAt`) from PostgreSQL on every request.
 */
export function buildAuthPreHandler(prisma: PrismaClient) {
  return async function authenticate(req: FastifyRequest): Promise<void> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new AppError(
        'unauthenticated',
        401,
        'Missing or malformed Authorization header.',
      );
    }

    const token = header.slice('Bearer '.length).trim();
    const payload = await verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        companyId: true,
        role: true,
        accountStatus: true,
        deletedAt: true,
        employeeId: true,
        displayName: true,
      },
    });

    if (!user) {
      throw new AppError('unauthenticated', 401, 'Account no longer exists.');
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

    req.authUser = {
      userId: user.id,
      companyId: user.companyId,
      role: user.role,
      employeeId: user.employeeId,
      displayName: user.displayName,
      ipAddress: req.ip,
    };
  };
}

export function requireRoles(allowed: readonly Role[]) {
  return async function checkRole(req: FastifyRequest): Promise<void> {
    if (!req.authUser) {
      throw new AppError('unauthenticated', 401, 'Authentication required.');
    }
    if (!allowed.includes(req.authUser.role)) {
      throw new AppError(
        'forbidden',
        403,
        'You do not have permission to access this resource.',
      );
    }
  };
}
