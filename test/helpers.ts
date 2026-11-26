import { AccountStatus, PrismaClient, Role } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { resetEnvForTests } from '../src/env.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { hashPassword } from '../src/lib/password.js';

export const TEST_PASSWORD = 'TestPassword!123';

export function ensureTestEnv(): void {
  if (process.env.DATABASE_URL_TEST) {
    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL must point to a Neon test branch before running npm test.',
    );
  }
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ??
    'test-only-jwt-secret-with-at-least-sixty-four-characters-1234567890abcd';
  process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';
  process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX ?? '100';
  resetEnvForTests();
}

export async function createTestContext(options?: {
  disableRateLimit?: boolean;
}): Promise<{ prisma: PrismaClient; app: FastifyInstance }> {
  ensureTestEnv();
  const prisma = new PrismaClient();
  const app = await buildApp({
    prisma,
    disableRateLimit: options?.disableRateLimit ?? true,
  });
  return { prisma, app };
}

/**
 * Clears all rows in FK-safe order on the dedicated Neon test branch.
 * Never run against production!
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.syncOperation.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.hcNotificationPrefs.deleteMany(),
    prisma.activityLog.deleteMany(),
    prisma.visitNote.deleteMany(),
    prisma.visit.deleteMany(),
    prisma.workDay.deleteMany(),
    prisma.territoryDoctor.deleteMany(),
    prisma.mrTerritoryAssignment.deleteMany(),
    prisma.doctorClinicLocation.deleteMany(),
    prisma.doctor.deleteMany(),
    prisma.territory.deleteMany(),
    prisma.platformAdmin.deleteMany(),
    prisma.user.deleteMany(),
    prisma.company.deleteMany(),
  ]);
}

export async function seedCompanyWithUsers(
  prisma: PrismaClient,
  input: {
    code: string;
    name: string;
    licensedMrSeats?: number;
    licensedHcSeats?: number;
  },
) {
  const passwordHash = await hashPassword(TEST_PASSWORD);
  const company = await prisma.company.create({
    data: {
      name: input.name,
      code: input.code,
      licensedMrSeats: input.licensedMrSeats ?? 10,
      licensedHcSeats: input.licensedHcSeats ?? 2,
    },
  });

  const hc = await prisma.user.create({
    data: {
      companyId: company.id,
      employeeId: `HC_${input.code.toUpperCase()}`,
      email: `hc@${input.code}.test`,
      displayName: `${input.name} HC`,
      passwordHash,
      role: Role.headController,
      accountStatus: AccountStatus.active,
    },
  });

  const mr = await prisma.user.create({
    data: {
      companyId: company.id,
      employeeId: `MR_${input.code.toUpperCase()}`,
      email: `mr@${input.code}.test`,
      displayName: `${input.name} MR`,
      passwordHash,
      role: Role.mr,
      accountStatus: AccountStatus.active,
    },
  });

  return { company, hc, mr };
}

export async function seedPlatformAdmin(prisma: PrismaClient) {
  const passwordHash = await hashPassword(TEST_PASSWORD);
  const user = await prisma.user.create({
    data: {
      companyId: null,
      employeeId: 'PA0001',
      email: 'platform.admin@pinarx.test',
      displayName: 'PINARX Platform Admin',
      passwordHash,
      role: Role.platformAdmin,
      accountStatus: AccountStatus.active,
    },
  });
  await prisma.platformAdmin.create({
    data: { userId: user.id },
  });
  const token = await signAccessToken({
    userId: user.id,
    role: Role.platformAdmin,
  });
  return { user, token };
}

export async function bearerForUser(user: {
  id: string;
  role: Role;
}): Promise<string> {
  const token = await signAccessToken({ userId: user.id, role: user.role });
  return `Bearer ${token}`;
}
