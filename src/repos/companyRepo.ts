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
}
