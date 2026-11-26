import { PrismaClient, Role, AccountStatus } from '@prisma/client';
import { hashPassword } from '../src/lib/password.js';

const prisma = new PrismaClient();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required seed environment variable: ${name}. Set it before running prisma db seed.`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  const platformAdminPassword = requireEnv('SEED_PLATFORM_ADMIN_PASSWORD');
  const hcPassword = requireEnv('SEED_HC_PASSWORD');
  const mrPassword = requireEnv('SEED_MR_PASSWORD');

  // 1. Default company
  const company = await prisma.company.upsert({
    where: { code: 'medyesa' },
    update: {
      name: 'Medyesa Healthcare',
      licensedMrSeats: 10,
      licensedHcSeats: 2,
      isActive: true,
    },
    create: {
      name: 'Medyesa Healthcare',
      code: 'medyesa',
      licensedMrSeats: 10,
      licensedHcSeats: 2,
      isActive: true,
    },
  });

  // 2. Platform Admin (companyId = null; findFirst avoids Postgres NULL compound-unique gotcha)
  const platformAdminHash = await hashPassword(platformAdminPassword);
  const existingPa = await prisma.user.findFirst({
    where: { companyId: null, employeeId: 'PA0001' },
  });

  const platformAdminUser = existingPa
    ? await prisma.user.update({
        where: { id: existingPa.id },
        data: {
          email: 'platform.admin@pinarx.demo',
          displayName: 'PINARX Platform Admin',
          passwordHash: platformAdminHash,
          role: Role.platformAdmin,
          accountStatus: AccountStatus.active,
          deletedAt: null,
        },
      })
    : await prisma.user.create({
        data: {
          companyId: null,
          employeeId: 'PA0001',
          email: 'platform.admin@pinarx.demo',
          displayName: 'PINARX Platform Admin',
          passwordHash: platformAdminHash,
          role: Role.platformAdmin,
          accountStatus: AccountStatus.active,
        },
      });

  await prisma.platformAdmin.upsert({
    where: { userId: platformAdminUser.id },
    update: {},
    create: { userId: platformAdminUser.id },
  });

  // 3. Head Controller
  const hcHash = await hashPassword(hcPassword);
  await prisma.user.upsert({
    where: {
      companyId_employeeId: { companyId: company.id, employeeId: 'HC1001' },
    },
    update: {
      email: 'hc1001@medyesa.demo',
      displayName: 'Demo Head Controller',
      passwordHash: hcHash,
      role: Role.headController,
      accountStatus: AccountStatus.active,
      deletedAt: null,
    },
    create: {
      companyId: company.id,
      employeeId: 'HC1001',
      email: 'hc1001@medyesa.demo',
      displayName: 'Demo Head Controller',
      passwordHash: hcHash,
      role: Role.headController,
      accountStatus: AccountStatus.active,
    },
  });

  // 4. Medical Representative
  const mrHash = await hashPassword(mrPassword);
  await prisma.user.upsert({
    where: {
      companyId_employeeId: { companyId: company.id, employeeId: 'MR1001' },
    },
    update: {
      email: 'mr1001@medyesa.demo',
      displayName: 'Demo MR',
      passwordHash: mrHash,
      role: Role.mr,
      accountStatus: AccountStatus.active,
      deletedAt: null,
    },
    create: {
      companyId: company.id,
      employeeId: 'MR1001',
      email: 'mr1001@medyesa.demo',
      displayName: 'Demo MR',
      passwordHash: mrHash,
      role: Role.mr,
      accountStatus: AccountStatus.active,
    },
  });

  console.log(
    `Seed complete: company=${company.code} (id=${company.id}), users=[PA0001, HC1001, MR1001]`,
  );
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
