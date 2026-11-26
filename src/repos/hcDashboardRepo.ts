import { AccountStatus, Role, SyncStatus } from '@prisma/client';
import { resolveDayWindow } from '../lib/dateWindow.js';
import { AppError } from '../lib/errors.js';
import { Repo } from '../lib/repo.js';

export type MrWorkdayStatus =
  | 'notStarted'
  | 'working'
  | 'ended'
  | 'autoClosed'
  | 'reopened';

export class HcDashboardRepo extends Repo {
  async getDashboard(input: { date?: string; tzOffsetMinutes?: number }) {
    const companyId = this.scopeCompany();
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        code: true,
        dataClassification: true,
      },
    });
    if (!company) {
      throw new AppError('not_found', 404, 'Company not found.');
    }

    const window = resolveDayWindow({
      date: input.date,
      tzOffsetMinutes: input.tzOffsetMinutes,
    });
    const allowedClassification = company.dataClassification;

    // 1. Active MRs belonging strictly to this company.
    const mrs = await this.prisma.user.findMany({
      where: {
        companyId,
        role: Role.mr,
        accountStatus: AccountStatus.active,
        deletedAt: null,
      },
      select: {
        id: true,
        employeeId: true,
        displayName: true,
        email: true,
        phone: true,
      },
      orderBy: { displayName: 'asc' },
    });

    const mrIds = mrs.map((m) => m.id);

    // 2. Active territory assignments + active territory doctors + today's workdays/visits + failed sync ops.
    const [
      activeAssignments,
      territoryDoctors,
      workDaysToday,
      visitsToday,
      failedSyncOps,
      latestSyncOps,
    ] = await Promise.all([
      this.prisma.mrTerritoryAssignment.findMany(/* companyId */ {
        where: { companyId, unassignedAt: null, mrId: { in: mrIds } },
        include: {
          territory: {
            select: { id: true, code: true, name: true, isArchived: true },
          },
        },
      }),
      this.prisma.territoryDoctor.findMany(/* companyId */ {
        where: {
          companyId,
          unassignedAt: null,
          territory: { companyId, isArchived: false },
          doctor: {
            companyId,
            isArchived: false,
            deletedAt: null,
            dataClassification: allowedClassification,
          },
        },
        select: { territoryId: true, doctorId: true },
      }),
      this.prisma.workDay.findMany(/* companyId */ {
        where: {
          companyId,
          mrId: { in: mrIds },
          dataClassification: allowedClassification,
          startedAt: { gte: window.startUtc, lt: window.endUtc },
        },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.visit.findMany(/* companyId */ {
        where: {
          companyId,
          mrId: { in: mrIds },
          dataClassification: allowedClassification,
          capturedAtClient: { gte: window.startUtc, lt: window.endUtc },
        },
        select: {
          id: true,
          mrId: true,
          doctorId: true,
          status: true,
          correctsVisitId: true,
          createdAt: true,
        },
      }),
      this.prisma.syncOperation.findMany({
        where: {
          companyId,
          status: SyncStatus.failed,
        },
        select: { id: true, actorId: true },
      }),
      this.prisma.syncOperation.groupBy({
        by: ['actorId'],
        where: { companyId, status: SyncStatus.synced },
        _max: { processedAt: true },
      }),
    ]);

    // Map territory -> unique active doctor IDs.
    const doctorsByTerritory = new Map<string, Set<string>>();
    for (const td of territoryDoctors) {
      let set = doctorsByTerritory.get(td.territoryId);
      if (!set) {
        set = new Set<string>();
        doctorsByTerritory.set(td.territoryId, set);
      }
      set.add(td.doctorId);
    }

    // Active assignment per MR (skip archived territories).
    const assignmentByMr = new Map<
      string,
      { id: string; code: string; name: string }
    >();
    for (const a of activeAssignments) {
      if (!a.territory.isArchived) {
        assignmentByMr.set(a.mrId, {
          id: a.territory.id,
          code: a.territory.code,
          name: a.territory.name,
        });
      }
    }

    // Identify superseded visit IDs so corrected visits never double-count.
    const supersededVisitIds = new Set<string>();
    for (const v of visitsToday) {
      if (v.correctsVisitId) {
        supersededVisitIds.add(v.correctsVisitId);
      }
    }

    const effectiveCompletedVisits = visitsToday.filter(
      (v) => v.status === 'completed' && !supersededVisitIds.has(v.id),
    );

    const failedSyncCountByMr = new Map<string, number>();
    for (const op of failedSyncOps) {
      failedSyncCountByMr.set(
        op.actorId,
        (failedSyncCountByMr.get(op.actorId) ?? 0) + 1,
      );
    }

    const lastSyncedByMr = new Map<string, Date | null>();
    for (const g of latestSyncOps) {
      lastSyncedByMr.set(g.actorId, g._max.processedAt ?? null);
    }

    // Latest workday row for each MR today.
    const workDayByMr = new Map<string, (typeof workDaysToday)[number]>();
    for (const wd of workDaysToday) {
      if (!workDayByMr.has(wd.mrId)) {
        workDayByMr.set(wd.mrId, wd);
      }
    }

    let mrsCurrentlyWorking = 0;
    let mrsNotStarted = 0;
    let mrsEndedToday = 0;
    let visitsPendingToday = 0;

    const mrSummaries = mrs.map((mr) => {
      const territory = assignmentByMr.get(mr.id) ?? null;
      const assignedDoctorIds = territory
        ? (doctorsByTerritory.get(territory.id) ?? new Set<string>())
        : new Set<string>();

      const mrCompletedVisits = effectiveCompletedVisits.filter(
        (v) => v.mrId === mr.id,
      );
      const visitedAssignedDoctorIds = new Set<string>();
      for (const v of mrCompletedVisits) {
        if (assignedDoctorIds.has(v.doctorId)) {
          visitedAssignedDoctorIds.add(v.doctorId);
        }
      }

      const mrPendingVisits = Math.max(
        0,
        assignedDoctorIds.size - visitedAssignedDoctorIds.size,
      );
      visitsPendingToday += mrPendingVisits;

      const wd = workDayByMr.get(mr.id) ?? null;
      let workdayStatus: MrWorkdayStatus = 'notStarted';
      if (!wd) {
        workdayStatus = 'notStarted';
        mrsNotStarted += 1;
      } else if (wd.endedAt === null) {
        workdayStatus = wd.reopenedAt ? 'reopened' : 'working';
        mrsCurrentlyWorking += 1;
      } else {
        workdayStatus = wd.autoClosed ? 'autoClosed' : 'ended';
        mrsEndedToday += 1;
      }

      const mrFailedSyncs = failedSyncCountByMr.get(mr.id) ?? 0;

      // Fallback lastSyncedAt to latest visit createdAt if MR synced via direct POST /v1/mr/visits.
      let lastSyncedAt = lastSyncedByMr.get(mr.id) ?? null;
      for (const v of mrCompletedVisits) {
        if (!lastSyncedAt || v.createdAt > lastSyncedAt) {
          lastSyncedAt = v.createdAt;
        }
      }

      return {
        mrId: mr.id,
        employeeId: mr.employeeId,
        displayName: mr.displayName,
        territory,
        workdayStatus,
        startedAt: wd?.startedAt.toISOString() ?? null,
        endedAt: wd?.endedAt?.toISOString() ?? null,
        autoClosed: wd?.autoClosed ?? false,
        reopenedAt: wd?.reopenedAt?.toISOString() ?? null,
        assignedDoctorsCount: assignedDoctorIds.size,
        visitsCompletedToday: mrCompletedVisits.length,
        visitsPendingToday: mrPendingVisits,
        syncFailuresCount: mrFailedSyncs,
        lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
      };
    });

    // Sort by operational urgency: sync failures -> not started -> working/reopened -> ended.
    const urgencyRank = (s: (typeof mrSummaries)[number]): number => {
      if (s.syncFailuresCount > 0) return 0;
      if (s.workdayStatus === 'notStarted') return 1;
      if (s.workdayStatus === 'working' || s.workdayStatus === 'reopened') {
        return 2;
      }
      return 3;
    };
    mrSummaries.sort((a, b) => {
      const rankDiff = urgencyRank(a) - urgencyRank(b);
      return rankDiff !== 0
        ? rankDiff
        : a.displayName.localeCompare(b.displayName);
    });

    return {
      date: window.date,
      company: {
        id: company.id,
        name: company.name,
        code: company.code,
      },
      metrics: {
        totalAssignedMrs: mrs.length,
        mrsCurrentlyWorking,
        mrsNotStarted,
        mrsEndedToday,
        visitsCompletedToday: effectiveCompletedVisits.length,
        visitsPendingToday,
        syncFailuresCount: failedSyncOps.length,
      },
      mrSummaries,
    };
  }
}
