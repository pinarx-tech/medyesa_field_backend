import { AccountStatus, Role } from '@prisma/client';
import { writeAuditLog } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import { Repo } from '../lib/repo.js';
import { generateTemporaryPassword } from '../lib/tempPassword.js';

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
  company: {
    select: { id: true, name: true, code: true },
  },
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
    if (!company.isActive) {
      throw new AppError(
        'business_rule_violation',
        422,
        'Cannot provision or reactivate accounts in an inactive company.',
      );
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
    q?: string;
  }) {
    this.ensurePlatformAdmin();
    const search = filter.q?.trim();
    return this.prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(filter.companyId !== undefined
          ? { companyId: filter.companyId }
          : {}),
        ...(filter.role ? { role: filter.role } : {}),
        ...(filter.status ? { accountStatus: filter.status } : {}),
        ...(search && search.length > 0
          ? {
              OR: [
                { displayName: { contains: search, mode: 'insensitive' } },
                { employeeId: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
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
    initialPassword?: string;
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

    const generated = !input.initialPassword;
    const plainPassword =
      input.initialPassword ?? generateTemporaryPassword(input.displayName);
    const passwordHash = await hashPassword(plainPassword);

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
      metadata: {
        employeeId: user.employeeId,
        role: user.role,
        temporaryPasswordGenerated: generated,
      },
      ipAddress: this.ctx.ipAddress,
    });

    return {
      user,
      temporaryPassword: plainPassword,
    };
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

  async adminResetPassword(userId: string, newPassword?: string) {
    this.ensurePlatformAdmin();
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!existing || existing.deletedAt !== null) {
      throw new AppError('not_found', 404, 'User not found.');
    }

    const plainPassword =
      newPassword ?? generateTemporaryPassword(existing.displayName);
    const passwordHash = await hashPassword(plainPassword);

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
      metadata: { generatedByBackend: !newPassword },
      ipAddress: this.ctx.ipAddress,
    });

    return {
      ok: true,
      temporaryPassword: plainPassword,
    };
  }

  /**
   * Irreversibly deletes an individual HC or MR account and all user-owned
   * tokens, sync ops, preferences, workdays, visits, notes, and activity logs,
   * while preserving unrelated employees and shared company entities cleanly.
   */
  async deletePermanent(
    userId: string,
    options?: { beforeCommit?: () => Promise<void> | void },
  ) {
    this.ensurePlatformAdmin();

    if (userId === this.ctx.userId) {
      throw new AppError(
        'forbidden',
        403,
        'Administrators cannot permanently delete their own account.',
      );
    }

    const result = await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            companyId: true,
            role: true,
          },
        });

        if (!existing) {
          throw new AppError('not_found', 404, 'User not found.');
        }

        if (
          existing.role !== Role.headController &&
          existing.role !== Role.mr
        ) {
          throw new AppError(
            'forbidden',
            403,
            'Only Head Controller and MR accounts can be permanently deleted.',
          );
        }

        const companyId = existing.companyId;
        const companyScope = companyId !== null ? { companyId } : {};

        const userVisits = await tx.visit.findMany({
          where: { ...companyScope, mrId: userId },
          select: { id: true },
        });
        const visitIds = userVisits.map((v) => v.id);

        const userWorkDays = await tx.workDay.findMany({
          where: { ...companyScope, mrId: userId },
          select: { id: true },
        });
        const workDayIds = userWorkDays.map((w) => w.id);

        const passwordResetTokens = (
          await tx.passwordResetToken.deleteMany({
            where: { userId },
          })
        ).count;

        const refreshTokens = (
          await tx.refreshToken.deleteMany({
            where: { userId },
          })
        ).count;

        const syncOperations = (
          await tx.syncOperation.deleteMany({
            where: { ...companyScope, actorId: userId },
          })
        ).count;

        const hcNotificationPrefs = (
          await tx.hcNotificationPrefs.deleteMany({
            where: { ...companyScope, headControllerId: userId },
          })
        ).count;

        let visitNotes = 0;
        let visits = 0;
        if (visitIds.length > 0) {
          // Break any incoming or internal VisitCorrection links before deletion.
          await tx.visit.updateMany({
            where: { ...companyScope, correctsVisitId: { in: visitIds } },
            data: { correctsVisitId: null },
          });
          await tx.visit.updateMany({
            where: {
              ...companyScope,
              id: { in: visitIds },
              correctsVisitId: { not: null },
            },
            data: { correctsVisitId: null },
          });

          visitNotes = (
            await tx.visitNote.deleteMany({
              where: { ...companyScope, visitId: { in: visitIds } },
            })
          ).count;

          visits = (
            await tx.visit.deleteMany({
              where: { ...companyScope, id: { in: visitIds } },
            })
          ).count;
        }

        let workDays = 0;
        if (workDayIds.length > 0) {
          await tx.visit.updateMany({
            where: { ...companyScope, workDayId: { in: workDayIds } },
            data: { workDayId: null },
          });
          workDays = (
            await tx.workDay.deleteMany({
              where: { ...companyScope, id: { in: workDayIds } },
            })
          ).count;
        }

        // Clear nullable reopenedByUserId attribution on surviving company workdays.
        await tx.workDay.updateMany({
          where: { ...companyScope, reopenedByUserId: userId },
          data: { reopenedByUserId: null },
        });

        const mrTerritoryAssignments = (
          await tx.mrTerritoryAssignment.deleteMany({
            where: { ...companyScope, mrId: userId },
          })
        ).count;

        // Clean up HC references on surviving shared company entities without leaving dangling IDs.
        let territoriesUnlinked = 0;
        let mrAssignmentsReattributed = 0;
        let territoryDoctorsReattributed = 0;
        let doctorLocationsReattributed = 0;

        if (companyId !== null) {
          territoriesUnlinked = (
            await tx.territory.updateMany({
              where: { companyId, createdByHeadControllerId: userId },
              data: { createdByHeadControllerId: null },
            })
          ).count;

          const survivingHc = await tx.user.findFirst({
            where: {
              companyId,
              id: { not: userId },
              role: Role.headController,
              deletedAt: null,
            },
            orderBy: [{ accountStatus: 'asc' }, { createdAt: 'asc' }],
            select: { id: true },
          });
          const replacementAttributionId = survivingHc?.id ?? this.ctx.userId;

          mrAssignmentsReattributed = (
            await tx.mrTerritoryAssignment.updateMany({
              where: { companyId, assignedByHeadControllerId: userId },
              data: { assignedByHeadControllerId: replacementAttributionId },
            })
          ).count;

          territoryDoctorsReattributed = (
            await tx.territoryDoctor.updateMany({
              where: { companyId, assignedByHeadControllerId: userId },
              data: { assignedByHeadControllerId: replacementAttributionId },
            })
          ).count;

          doctorLocationsReattributed = (
            await tx.doctorClinicLocation.updateMany({
              where: { companyId, capturedByUserId: userId },
              data: { capturedByUserId: replacementAttributionId },
            })
          ).count;
        }

        const deletedSubjectIds = [...visitIds, ...workDayIds];
        const activityLogs = (
          await tx.activityLog.deleteMany({
            where: {
              OR: [
                { actorId: userId },
                { ...companyScope, subjectType: 'user', subjectId: userId },
                ...(deletedSubjectIds.length > 0
                  ? [{ ...companyScope, subjectId: { in: deletedSubjectIds } }]
                  : []),
              ],
            },
          })
        ).count;

        const auditLogs = (
          await tx.auditLog.deleteMany({
            where: {
              OR: [
                { actorId: userId },
                { targetType: 'user', targetId: userId },
              ],
            },
          })
        ).count;

        await tx.user.delete({
          where: { id: userId },
        });

        await tx.auditLog.create({
          data: {
            companyId: existing.companyId,
            actorId: this.ctx.userId,
            action: 'user_permanently_deleted',
            targetType: 'user',
            targetId: userId,
            metadata: { role: existing.role },
            ipAddress: this.ctx.ipAddress ?? null,
          },
        });

        if (options?.beforeCommit) {
          await options.beforeCommit();
        }

        return {
          role: existing.role,
          companyId: existing.companyId,
          deleted: {
            passwordResetTokens,
            refreshTokens,
            syncOperations,
            hcNotificationPrefs,
            visitNotes,
            visits,
            workDays,
            mrTerritoryAssignments,
            activityLogs,
            auditLogs,
            territoriesUnlinked,
            mrAssignmentsReattributed,
            territoryDoctorsReattributed,
            doctorLocationsReattributed,
          },
        };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );

    return {
      ok: true,
      deletedUserId: userId,
      deletedRole: result.role,
      companyId: result.companyId,
      deleted: result.deleted,
    };
  }

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
