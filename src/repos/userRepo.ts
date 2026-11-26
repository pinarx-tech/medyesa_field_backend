import { AccountStatus, Role } from '@prisma/client';
import { AppError } from '../lib/errors.js';
import { writeAuditLog } from '../lib/audit.js';
import { hashPassword } from '../lib/password.js';
import { Repo } from '../lib/repo.js';

const SAFE_USER_SELECT = {
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
  createdAt: true,
  updatedAt: true,
} as const;

export class UserRepo extends Repo {
  private ensurePlatformAdmin(): void {
    if (this.ctx.role !== Role.platformAdmin) {
      throw new AppError('forbidden', 403, 'Platform admin role required.');
    }
  }

  private async assertSeatAvailable(
    companyId: number,
    role: Role,
  ): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    });
    if (!company) {
      throw new AppError('not_found', 404, 'Company not found.');
    }

    const activeCount = await this.prisma.user.count({
      where: {
        companyId,
        role,
        accountStatus: AccountStatus.active,
        deletedAt: null,
      },
    });

    if (role === Role.mr && activeCount >= company.licensedMrSeats) {
      throw new AppError(
        'business_rule_violation',
        422,
        `Company MR seat limit reached (${activeCount}/${company.licensedMrSeats}).`,
      );
    }
    if (
      role === Role.headController &&
      activeCount >= company.licensedHcSeats
    ) {
      throw new AppError(
        'business_rule_violation',
        422,
        `Company Head Controller seat limit reached (${activeCount}/${company.licensedHcSeats}).`,
      );
    }
  }

  async listAdmin(filter: {
    companyId?: number;
    role?: Role;
    status?: AccountStatus;
  }) {
    this.ensurePlatformAdmin();
    return this.prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(filter.companyId !== undefined
          ? { companyId: filter.companyId }
          : {}),
        ...(filter.role ? { role: filter.role } : {}),
        ...(filter.status ? { accountStatus: filter.status } : {}),
      },
      select: SAFE_USER_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async createUser(input: {
    companyId: number;
    employeeId: string;
    email: string;
    displayName: string;
    phone?: string | null;
    role: 'headController' | 'mr';
    initialPassword: string;
  }) {
    this.scopeCompanyExplicit(input.companyId);
    const targetRole =
      input.role === 'headController' ? Role.headController : Role.mr;

    await this.assertSeatAvailable(input.companyId, targetRole);

    const existingDup = await this.prisma.user.findFirst({
      where: {
        companyId: input.companyId,
        OR: [
          { employeeId: { equals: input.employeeId, mode: 'insensitive' } },
          { email: { equals: input.email, mode: 'insensitive' } },
        ],
      },
    });
    if (existingDup) {
      throw new AppError(
        'conflict',
        409,
        'Employee ID or email already exists in this company.',
      );
    }

    const passwordHash = await hashPassword(input.initialPassword);
    const user = await this.prisma.user.create({
      data: {
        companyId: input.companyId,
        employeeId: input.employeeId,
        email: input.email.toLowerCase(),
        displayName: input.displayName,
        phone: input.phone ?? null,
        passwordHash,
        role: targetRole,
        accountStatus: AccountStatus.active,
        mustChangePassword: true,
      },
      select: SAFE_USER_SELECT,
    });

    await writeAuditLog(this.prisma, {
      companyId: input.companyId,
      actorId: this.ctx.userId,
      action: 'user_created',
      targetType: 'user',
      targetId: user.id,
      metadata: { employeeId: user.employeeId, role: user.role },
      ipAddress: this.ctx.ipAddress,
    });

    return user;
  }

  async updateUser(
    userId: string,
    input: { displayName?: string; email?: string; phone?: string | null },
  ) {
    this.ensurePlatformAdmin();
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!existing || existing.deletedAt !== null) {
      throw new AppError('not_found', 404, 'User not found.');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.displayName !== undefined
          ? { displayName: input.displayName }
          : {}),
        ...(input.email !== undefined
          ? { email: input.email.toLowerCase() }
          : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
      },
      select: SAFE_USER_SELECT,
    });

    await writeAuditLog(this.prisma, {
      companyId: existing.companyId,
      actorId: this.ctx.userId,
      action: 'user_updated',
      targetType: 'user',
      targetId: userId,
      metadata: input,
      ipAddress: this.ctx.ipAddress,
    });

    return updated;
  }

  async setAccountStatus(userId: string, nextStatus: AccountStatus) {
    this.ensurePlatformAdmin();
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!existing || existing.deletedAt !== null) {
      throw new AppError('not_found', 404, 'User not found.');
    }

    if (
      nextStatus === AccountStatus.active &&
      existing.accountStatus !== AccountStatus.active &&
      existing.companyId !== null
    ) {
      await this.assertSeatAvailable(existing.companyId, existing.role);
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { accountStatus: nextStatus },
      select: SAFE_USER_SELECT,
    });

    if (nextStatus !== AccountStatus.active) {
      await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await writeAuditLog(this.prisma, {
      companyId: existing.companyId,
      actorId: this.ctx.userId,
      action: `user_${nextStatus}`,
      targetType: 'user',
      targetId: userId,
      metadata: { before: existing.accountStatus, after: nextStatus },
      ipAddress: this.ctx.ipAddress,
    });

    return updated;
  }

  async adminResetPassword(userId: string, newPassword: string) {
    this.ensurePlatformAdmin();
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!existing || existing.deletedAt !== null) {
      throw new AppError('not_found', 404, 'User not found.');
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: true },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await writeAuditLog(this.prisma, {
      companyId: existing.companyId,
      actorId: this.ctx.userId,
      action: 'user_password_reset_by_admin',
      targetType: 'user',
      targetId: userId,
      ipAddress: this.ctx.ipAddress,
    });

    return { ok: true };
  }

  /** Company-scoped MR list for Head Controllers. */
  async listCompanyMrs() {
    const companyId = this.scopeCompany();
    const mrs = await this.prisma.user.findMany({
      where: { companyId, role: Role.mr, deletedAt: null },
      select: SAFE_USER_SELECT,
      orderBy: { displayName: 'asc' },
    });

    const activeAssignments = await this.prisma.mrTerritoryAssignment.findMany(/* companyId */ {
      where: { companyId, unassignedAt: null },
      include: { territory: { select: { id: true, code: true, name: true } } },
    });

    const assignmentByMr = new Map(
      activeAssignments.map((a) => [a.mrId, a]),
    );

    return mrs.map((mr) => {
      const active = assignmentByMr.get(mr.id);
      return {
        ...mr,
        currentTerritory: active?.territory ?? null,
        territoryAssignedAt: active?.assignedAt ?? null,
      };
    });
  }
}
