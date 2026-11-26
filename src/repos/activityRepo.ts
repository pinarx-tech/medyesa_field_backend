import { AccountStatus, Role } from '@prisma/client';
import { AppError } from '../lib/errors.js';
import { Repo } from '../lib/repo.js';

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export class ActivityRepo extends Repo {
  async getHcDashboard() {
    const companyId = this.scopeCompany();
    const todayStart = startOfUtcDay(new Date());

    const mrs = await this.prisma.user.findMany({
      where: { companyId, role: Role.mr, deletedAt: null },
      select: {
        id: true,
        employeeId: true,
        displayName: true,
        accountStatus: true,
      },
      orderBy: { displayName: 'asc' },
    });

    const workDaysToday = await this.prisma.workDay.findMany(/* companyId */ {
      where: { companyId, startedAt: { gte: todayStart } },
    });

    const visitsToday = await this.prisma.visit.findMany(/* companyId */ {
      where: { companyId, capturedAtClient: { gte: todayStart } },
      select: { id: true, mrId: true, status: true },
    });

    const activeWorkdayMrIds = new Set(
      workDaysToday.filter((w) => w.endedAt === null).map((w) => w.mrId),
    );
    const completedWorkdayMrIds = new Set(
      workDaysToday.filter((w) => w.endedAt !== null).map((w) => w.mrId),
    );

    const completedVisitsToday = visitsToday.filter(
      (v) => v.status === 'completed',
    ).length;
    const pendingVisitsToday = visitsToday.length - completedVisitsToday;

    const perMrSummary = mrs.map((mr) => {
      const mrVisits = visitsToday.filter((v) => v.mrId === mr.id);
      const mrCompleted = mrVisits.filter(
        (v) => v.status === 'completed',
      ).length;
      const mrWorkDay = workDaysToday.find((w) => w.mrId === mr.id) ?? null;
      return {
        mrId: mr.id,
        employeeId: mr.employeeId,
        displayName: mr.displayName,
        accountStatus: mr.accountStatus,
        workDayStartedAt: mrWorkDay?.startedAt ?? null,
        workDayEndedAt: mrWorkDay?.endedAt ?? null,
        visitsCompletedToday: mrCompleted,
        visitsTotalToday: mrVisits.length,
      };
    });

    return {
      date: todayStart.toISOString().slice(0, 10),
      totalMrs: mrs.length,
      activeMrs: mrs.filter((m) => m.accountStatus === AccountStatus.active)
        .length,
      mrsWithActiveWorkday: activeWorkdayMrIds.size,
      mrsWithCompletedWorkdayToday: completedWorkdayMrIds.size,
      visitsCompletedToday: completedVisitsToday,
      pendingVisitsToday,
      perMrSummary,
    };
  }

  async getMrTimeline(mrId: string) {
    const companyId = this.scopeCompany();
    const mr = await this.prisma.user.findFirst({
      where: { companyId, id: mrId, role: Role.mr, deletedAt: null },
      select: { id: true, employeeId: true, displayName: true },
    });
    if (!mr) {
      throw new AppError('not_found', 404, 'MR not found.');
    }

    const [workDays, visits, logs] = await Promise.all([
      this.prisma.workDay.findMany(/* companyId */ {
        where: { companyId, mrId },
        orderBy: { startedAt: 'desc' },
        take: 30,
      }),
      this.prisma.visit.findMany(/* companyId */ {
        where: { companyId, mrId },
        include: {
          doctor: { select: { id: true, name: true, clinicName: true } },
          note: true,
        },
        orderBy: { capturedAtClient: 'desc' },
        take: 100,
      }),
      this.prisma.activityLog.findMany(/* companyId */ {
        where: { companyId, actorId: mrId },
        orderBy: { occurredAt: 'desc' },
        take: 100,
      }),
    ]);

    return { mr, workDays, visits, logs };
  }

  async listCompanyActivity(filter: {
    mrId?: string;
    from?: string;
    to?: string;
    type?: string;
    limit: number;
  }) {
    const companyId = this.scopeCompany();
    return this.prisma.activityLog.findMany(/* companyId */ {
      where: {
        companyId,
        ...(filter.mrId ? { actorId: filter.mrId } : {}),
        ...(filter.type ? { actionType: filter.type } : {}),
        ...(filter.from || filter.to
          ? {
              occurredAt: {
                ...(filter.from ? { gte: new Date(filter.from) } : {}),
                ...(filter.to ? { lte: new Date(filter.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: filter.limit,
    });
  }

  async getNotificationPrefs() {
    const companyId = this.scopeCompany();
    const headControllerId = this.ctx.userId;

    const existing = await this.prisma.hcNotificationPrefs.findFirst(/* companyId */ {
      where: { companyId, headControllerId },
    });
    if (existing) {
      return existing;
    }

    return this.prisma.hcNotificationPrefs.create({
      data: {
        companyId,
        headControllerId,
        verifiedVisitNotificationsEnabled: true,
        overrideNotificationsEnabled: true,
      },
    });
  }

  async updateNotificationPrefs(input: {
    verifiedVisitNotificationsEnabled?: boolean;
    overrideNotificationsEnabled?: boolean;
  }) {
    const companyId = this.scopeCompany();
    const headControllerId = this.ctx.userId;

    return this.prisma.hcNotificationPrefs.upsert({
      where: {
        companyId_headControllerId: { companyId, headControllerId },
      },
      update: input,
      create: {
        companyId,
        headControllerId,
        verifiedVisitNotificationsEnabled:
          input.verifiedVisitNotificationsEnabled ?? true,
        overrideNotificationsEnabled:
          input.overrideNotificationsEnabled ?? true,
      },
    });
  }
}
