import { FastifyRequest } from 'fastify';
import {
  AccountStatus,
  DataClassification,
  PrismaClient,
  Role,
} from '@prisma/client';
import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { RequestContext } from '../lib/repo.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: RequestContext;
  }
}

/**
 * Verifies Bearer JWT and loads fresh user + company state (`companyId`,
 * `dataClassification`, `isActive`, `role`, `accountStatus`, `deletedAt`) in a
 * single query, eliminating redundant company lookups across repositories.
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
        company: {
          select: {
            id: true,
            name: true,
            code: true,
            isActive: true,
            dataClassification: true,
          },
        },
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
    if (
      user.role !== Role.platformAdmin &&
      user.company &&
      !user.company.isActive
    ) {
      throw new AppError(
        'account_inactive',
        403,
        'Company account is inactive. Contact PINARX support.',
      );
    }

    req.authUser = {
      userId: user.id,
      companyId: user.companyId,
      companyName: user.company?.name ?? null,
      companyCode: user.company?.code ?? null,
      companyClassification:
        user.company?.dataClassification ?? DataClassification.production,
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
