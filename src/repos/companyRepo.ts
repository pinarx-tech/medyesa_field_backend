import { AccountStatus, Role, SubscriptionStatus } from '@prisma/client';
import { writeAuditLog } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import { Repo } from '../lib/repo.js';

export class CompanyRepo extends Repo {
  private ensurePlatformAdmin(): void {
    if (this.ctx.role !== Role.platformAdmin) {
      throw new AppError('forbidden', 403, 'Platform admin role required.');
    }
  }

  async listAllWithSeats() {
    this.ensurePlatformAdmin();
    const companies = await this.prisma.company.findMany({
      orderBy: { id: 'asc' },
    });

    const activeUsers = await this.prisma.user.groupBy({
      by: ['companyId', 'role'],
      where: {
        companyId: { not: null },
        accountStatus: AccountStatus.active,
        deletedAt: null,
      },
      _count: { _all: true },
    });

    return companies.map((company) => {
      const usedMrSeats =
        activeUsers.find(
          (g) => g.companyId === company.id && g.role === Role.mr,
        )?._count._all ?? 0;
      const usedHcSeats =
        activeUsers.find(
          (g) => g.companyId === company.id && g.role === Role.headController,
        )?._count._all ?? 0;
      return {
        ...company,
        usedMrSeats,
        usedHcSeats,
        availableMrSeats: Math.max(0, company.licensedMrSeats - usedMrSeats),
        availableHcSeats: Math.max(0, company.licensedHcSeats - usedHcSeats),
      };
    });
  }

  async create(input: {
    name: string;
    code: string;
    licensedMrSeats: number;
    licensedHcSeats: number;
  }) {
    this.ensurePlatformAdmin();
    const existing = await this.prisma.company.findUnique({
      where: { code: input.code },
    });
    if (existing) {
      throw new AppError('conflict', 409, 'Company code already exists.');
    }

    const company = await this.prisma.company.create({
      data: {
        name: input.name,
        code: input.code,
        licensedMrSeats: input.licensedMrSeats,
        licensedHcSeats: input.licensedHcSeats,
      },
    });

    await writeAuditLog(this.prisma, {
      companyId: company.id,
      actorId: this.ctx.userId,
      action: 'company_created',
      targetType: 'company',
      targetId: String(company.id),
      metadata: {
        code: company.code,
        licensedMrSeats: company.licensedMrSeats,
        licensedHcSeats: company.licensedHcSeats,
      },
      ipAddress: this.ctx.ipAddress,
    });

    return {
      ...company,
      usedMrSeats: 0,
      usedHcSeats: 0,
      availableMrSeats: company.licensedMrSeats,
      availableHcSeats: company.licensedHcSeats,
    };
  }

  async getDetail(companyId: number) {
    this.scopeCompanyExplicit(companyId);
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    });
    if (!company) {
      throw new AppError('not_found', 404, 'Company not found.');
    }

    const users = await this.prisma.user.findMany({
      where: { companyId, deletedAt: null },
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
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const usedMrSeats = users.filter(
      (u) => u.role === Role.mr && u.accountStatus === AccountStatus.active,
    ).length;
    const usedHcSeats = users.filter(
      (u) =>
        u.role === Role.headController &&
        u.accountStatus === AccountStatus.active,
    ).length;

    return {
      ...company,
      usedMrSeats,
      usedHcSeats,
      availableMrSeats: Math.max(0, company.licensedMrSeats - usedMrSeats),
      availableHcSeats: Math.max(0, company.licensedHcSeats - usedHcSeats),
      users,
    };
  }

  async update(
    companyId: number,
    input: {
      name?: string;
      licensedMrSeats?: number;
      licensedHcSeats?: number;
      subscriptionStatus?: SubscriptionStatus;
      isActive?: boolean;
    },
  ) {
    this.scopeCompanyExplicit(companyId);
    const existing = await this.prisma.company.findUnique({
      where: { id: companyId },
    });
    if (!existing) {
      throw new AppError('not_found', 404, 'Company not found.');
    }

    // Seat-shrink protection: prevent lowering licensed seats below active occupied seats.
    if (
      input.licensedMrSeats !== undefined ||
      input.licensedHcSeats !== undefined
    ) {
      const [activeMrs, activeHcs] = await Promise.all([
        this.prisma.user.count({
          where: {
            companyId,
            role: Role.mr,
            accountStatus: AccountStatus.active,
            deletedAt: null,
          },
        }),
        this.prisma.user.count({
          where: {
            companyId,
            role: Role.headController,
            accountStatus: AccountStatus.active,
            deletedAt: null,
          },
        }),
      ]);

      if (
        input.licensedMrSeats !== undefined &&
        input.licensedMrSeats < activeMrs
      ) {
        throw new AppError(
          'business_rule_violation',
          422,
          `Cannot reduce licensed MR seats to ${input.licensedMrSeats} while ${activeMrs} active MR(s) occupy seats.`,
        );
      }
      if (
        input.licensedHcSeats !== undefined &&
        input.licensedHcSeats < activeHcs
      ) {
        throw new AppError(
          'business_rule_violation',
          422,
          `Cannot reduce licensed HC seats to ${input.licensedHcSeats} while ${activeHcs} active HC(s) occupy seats.`,
        );
      }
    }

    const updated = await this.prisma.company.update({
      where: { id: companyId },
      data: input,
    });

    await writeAuditLog(this.prisma, {
      companyId,
      actorId: this.ctx.userId,
      action: 'company_updated',
      targetType: 'company',
      targetId: String(companyId),
      metadata: input,
      ipAddress: this.ctx.ipAddress,
    });

    return updated;
  }

  /**
   * Irreversibly deletes an entire pharma company and all company-owned
   * operational, user, token, sync, and audit data inside one transaction.
   */
  async deletePermanent(
    companyId: number,
    options?: { beforeCommit?: () => Promise<void> | void },
  ) {
    this.scopeCompanyExplicit(companyId);

    const deleted = await this.prisma.$transaction(
      async (tx) => {
        const company = await tx.company.findUnique({
          where: { id: companyId },
          select: { id: true },
        });
        if (!company) {
          throw new AppError('not_found', 404, 'Company not found.');
        }

        const companyUsers = await tx.user.findMany({
          where: { companyId },
          select: { id: true },
        });
        const userIds = companyUsers.map((u) => u.id);

        const passwordResetTokens =
          userIds.length > 0
            ? (
                await tx.passwordResetToken.deleteMany({
                  where: { userId: { in: userIds } },
                })
              ).count
            : 0;

        const refreshTokens =
          userIds.length > 0
            ? (
                await tx.refreshToken.deleteMany({
                  where: { userId: { in: userIds } },
                })
              ).count
            : 0;

        const syncOperations = (
          await tx.syncOperation.deleteMany({
            where:
              userIds.length > 0
                ? { OR: [{ companyId }, { actorId: { in: userIds } }] }
                : { companyId },
          })
        ).count;

        const auditLogs = (
          await tx.auditLog.deleteMany({
            where: {
              OR: [
                { companyId },
                { targetType: 'company', targetId: String(companyId) },
                ...(userIds.length > 0
                  ? [
                      { actorId: { in: userIds } },
                      { targetType: 'user', targetId: { in: userIds } },
                    ]
                  : []),
              ],
            },
          })
        ).count;

        const hcNotificationPrefs = (
          await tx.hcNotificationPrefs.deleteMany({
            where: { companyId },
          })
        ).count;

        const activityLogs = (
          await tx.activityLog.deleteMany({
            where:
              userIds.length > 0
                ? { OR: [{ companyId }, { actorId: { in: userIds } }] }
                : { companyId },
          })
        ).count;

        const visitNotes = (
          await tx.visitNote.deleteMany({
            where: { companyId },
          })
        ).count;

        // Break self-referencing visit correction pointers before bulk deletion.
        await tx.visit.updateMany({
          where: { companyId, correctsVisitId: { not: null } },
          data: { correctsVisitId: null },
        });
        const visits = (
          await tx.visit.deleteMany({
            where: { companyId },
          })
        ).count;

        const workDays = (
          await tx.workDay.deleteMany({
            where: { companyId },
          })
        ).count;

        const territoryDoctors = (
          await tx.territoryDoctor.deleteMany({
            where: { companyId },
          })
        ).count;

        const mrTerritoryAssignments = (
          await tx.mrTerritoryAssignment.deleteMany({
            where: { companyId },
          })
        ).count;

        const doctorClinicLocations = (
          await tx.doctorClinicLocation.deleteMany({
            where: { companyId },
          })
        ).count;

        const doctors = (
          await tx.doctor.deleteMany({
            where: { companyId },
          })
        ).count;

        const clinics = (
          await tx.clinic.deleteMany({
            where: { companyId },
          })
        ).count;

        const territories = (
          await tx.territory.deleteMany({
            where: { companyId },
          })
        ).count;

        const users = (
          await tx.user.deleteMany({
            where: { companyId },
          })
        ).count;

        await tx.company.delete({
          where: { id: companyId },
        });

        // Minimal platform-level deletion trace with no retained company PII/details.
        await tx.auditLog.create({
          data: {
            companyId: null,
            actorId: this.ctx.userId,
            action: 'company_permanently_deleted',
            targetType: 'company',
            targetId: String(companyId),
            ipAddress: this.ctx.ipAddress ?? null,
          },
        });

        if (options?.beforeCommit) {
          await options.beforeCommit();
        }

        return {
          users,
          clinics,
          doctors,
          doctorClinicLocations,
          territories,
          territoryDoctors,
          mrTerritoryAssignments,
          workDays,
          visits,
          visitNotes,
          activityLogs,
          hcNotificationPrefs,
          syncOperations,
          refreshTokens,
          passwordResetTokens,
          auditLogs,
        };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );

    return {
      ok: true,
      deletedCompanyId: companyId,
      deleted,
    };
  }
}
