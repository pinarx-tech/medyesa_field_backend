import { AccountStatus, Role } from '@prisma/client';
import { resolveDayWindow } from '../lib/dateWindow.js';
import { AppError } from '../lib/errors.js';
import { Repo } from '../lib/repo.js';

export type HcActivityCategory =
  | 'employee_login'
  | 'start_day'
  | 'visit_completed'
  | 'visit_corrected'
  | 'end_day'
  | 'pending_visit';

export interface HcActivityEventDto {
  id: string;
  category: HcActivityCategory;
  actorId: string;
  actorName: string;
  actorEmployeeId: string;
  doctorId: string | null;
  doctorName: string | null;
  territoryId: string | null;
  territoryName: string | null;
  activityLabel: string;
  statusLabel: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

export class HcActivityRepo extends Repo {
  async listOperationalActivity(filter: {
    mrId?: string;
    territoryId?: string;
    category?: HcActivityCategory;
    date?: string;
    from?: string;
    to?: string;
    tzOffsetMinutes?: number;
    limit: number;
  }) {
    const companyId = this.scopeCompany();
    const classification = this.scopeClassification();
    const window = resolveDayWindow({
      date: filter.date,
      tzOffsetMinutes: filter.tzOffsetMinutes,
    });
    const rangeStart = filter.from ? new Date(filter.from) : window.startUtc;
    const rangeEnd = filter.to ? new Date(filter.to) : window.endUtc;

    // Validate optional filter IDs strictly inside this company (return empty if foreign)
    if (filter.mrId) {
      const ownedMr = await this.prisma.user.findFirst({
        where: { companyId, id: filter.mrId, deletedAt: null },
        select: { id: true },
      });
      if (!ownedMr) {
        return { date: window.date, events: [] as HcActivityEventDto[] };
      }
    }
    if (filter.territoryId) {
      const ownedTer = await this.prisma.territory.findFirst(/* companyId */ {
        where: { companyId, id: filter.territoryId },
        select: { id: true },
      });
      if (!ownedTer) {
        return { date: window.date, events: [] as HcActivityEventDto[] };
      }
    }

    const [users, territories, activeAssignments] = await Promise.all([
      this.prisma.user.findMany({
        where: { companyId, deletedAt: null },
        select: {
          id: true,
          employeeId: true,
          displayName: true,
          role: true,
          accountStatus: true,
        },
      }),
      this.prisma.territory.findMany(/* companyId */ {
        where: { companyId },
        select: { id: true, name: true, isArchived: true },
      }),
      this.prisma.mrTerritoryAssignment.findMany(/* companyId */ {
        where: {
          companyId,
          unassignedAt: null,
          territory: { companyId, isArchived: false },
        },
        select: { mrId: true, territoryId: true },
      }),
    ]);

    const userById = new Map(users.map((u) => [u.id, u]));
    const terById = new Map(territories.map((t) => [t.id, t]));
    const activeTerByMr = new Map(
      activeAssignments.map((a) => [a.mrId, a.territoryId]),
    );

    const want = (cat: HcActivityCategory) =>
      !filter.category || filter.category === cat;

    const events: HcActivityEventDto[] = [];

    // 1. Employee login events
    if (want('employee_login')) {
      const loginLogs = await this.prisma.activityLog.findMany(/* companyId */ {
        where: {
          companyId,
          dataClassification: classification,
          actionType: { in: ['mr_login', 'admin_login'] },
          ...(filter.mrId ? { actorId: filter.mrId } : {}),
          occurredAt: { gte: rangeStart, lt: rangeEnd },
        },
        orderBy: { occurredAt: 'desc' },
        take: filter.limit,
      });

      for (const log of loginLogs) {
        const actor = userById.get(log.actorId);
        const terId = log.territoryId ?? activeTerByMr.get(log.actorId) ?? null;
        if (filter.territoryId && terId !== filter.territoryId) {
          continue;
        }
        events.push({
          id: `login:${log.id}`,
          category: 'employee_login',
          actorId: log.actorId,
          actorName: actor?.displayName ?? log.actorDisplayName,
          actorEmployeeId: actor?.employeeId ?? '',
          doctorId: null,
          doctorName: null,
          territoryId: terId,
          territoryName: terId ? (terById.get(terId)?.name ?? null) : null,
          activityLabel: 'Employee login',
          statusLabel: 'Signed in',
          occurredAt: log.occurredAt.toISOString(),
          metadata: { role: log.actorRole },
        });
      }
    }

    // 2 & 5. Start Day and End Day events (preserving reopened & auto-closed status)
    if (want('start_day') || want('end_day')) {
      const workDays = await this.prisma.workDay.findMany(/* companyId */ {
        where: {
          companyId,
          dataClassification: classification,
          ...(filter.mrId ? { mrId: filter.mrId } : {}),
          startedAt: { gte: rangeStart, lt: rangeEnd },
        },
        orderBy: { startedAt: 'desc' },
        take: filter.limit,
      });

      for (const wd of workDays) {
        const actor = userById.get(wd.mrId);
        const terId = activeTerByMr.get(wd.mrId) ?? null;
        if (filter.territoryId && terId !== filter.territoryId) {
          continue;
        }
        const terName = terId ? (terById.get(terId)?.name ?? null) : null;

        if (want('start_day')) {
          events.push({
            id: `wd_start:${wd.id}`,
            category: 'start_day',
            actorId: wd.mrId,
            actorName: actor?.displayName ?? 'MR',
            actorEmployeeId: actor?.employeeId ?? '',
            doctorId: null,
            doctorName: null,
            territoryId: terId,
            territoryName: terName,
            activityLabel: 'Start Day',
            statusLabel:
              wd.endedAt === null
                ? wd.reopenedAt
                  ? 'Reopened by HC'
                  : 'Working'
                : 'Completed',
            occurredAt: wd.startedAt.toISOString(),
            metadata: { workDayId: wd.id },
          });
        }

        const effectiveEnd = wd.endedAt ?? wd.previousEndedAt;
        if (want('end_day') && effectiveEnd) {
          const statusLabel = wd.reopenedAt
            ? 'Reopened by HC'
            : wd.autoClosed
              ? 'Day ended automatically'
              : 'Ended manually';
          events.push({
            id: `wd_end:${wd.id}`,
            category: 'end_day',
            actorId: wd.mrId,
            actorName: actor?.displayName ?? 'MR',
            actorEmployeeId: actor?.employeeId ?? '',
            doctorId: null,
            doctorName: null,
            territoryId: terId,
            territoryName: terName,
            activityLabel: 'End Day',
            statusLabel,
            occurredAt: effectiveEnd.toISOString(),
            metadata: {
              workDayId: wd.id,
              autoClosed: wd.autoClosed,
              reopenedAt: wd.reopenedAt?.toISOString() ?? null,
              reopenReason: wd.reopenReason ?? null,
            },
          });
        }
      }
    }

    // 3 & 4. Completed doctor visits & Corrected/re-recorded visits
    const visitsInRange =
      want('visit_completed') ||
      want('visit_corrected') ||
      want('pending_visit')
        ? await this.prisma.visit.findMany(/* companyId */ {
            where: {
              companyId,
              dataClassification: classification,
              ...(filter.mrId ? { mrId: filter.mrId } : {}),
              capturedAtClient: { gte: rangeStart, lt: rangeEnd },
            },
            include: {
              doctor: { select: { id: true, name: true, clinicName: true } },
              note: { select: { noteText: true } },
            },
            orderBy: { capturedAtClient: 'desc' },
            take: filter.limit * 2,
          })
        : [];

    const supersededIds = new Set<string>();
    for (const v of visitsInRange) {
      if (v.correctsVisitId) {
        supersededIds.add(v.correctsVisitId);
      }
    }

    if (want('visit_completed') || want('visit_corrected')) {
      for (const v of visitsInRange) {
        const terId = v.territoryIdAtVisit ?? activeTerByMr.get(v.mrId) ?? null;
        if (filter.territoryId && terId !== filter.territoryId) {
          continue;
        }
        const isCorrection = v.correctsVisitId !== null;
        const category: HcActivityCategory = isCorrection
          ? 'visit_corrected'
          : 'visit_completed';
        if (!want(category)) {
          continue;
        }

        const actor = userById.get(v.mrId);
        const isSuperseded = supersededIds.has(v.id);
        const statusLabel = isCorrection
          ? 'Corrected'
          : isSuperseded
            ? 'Superseded'
            : v.checkInVerificationStatus === 'verified'
              ? 'Verified'
              : v.checkInVerificationStatus === 'outsideRadius'
                ? 'Outside clinic radius'
                : 'Completed';

        events.push({
          id: `visit:${v.id}`,
          category,
          actorId: v.mrId,
          actorName: actor?.displayName ?? 'MR',
          actorEmployeeId: actor?.employeeId ?? '',
          doctorId: v.doctorId,
          doctorName: v.doctor.name,
          territoryId: terId,
          territoryName: terId ? (terById.get(terId)?.name ?? null) : null,
          activityLabel: isCorrection
            ? 'Corrected visit'
            : 'Completed doctor visit',
          statusLabel,
          occurredAt: v.capturedAtClient.toISOString(),
          metadata: {
            visitId: v.id,
            correctsVisitId: v.correctsVisitId,
            isSuperseded,
            verificationStatus: v.checkInVerificationStatus,
            distanceMeters: v.checkInDistanceMeters,
            promotionNotes: v.note?.noteText ?? null,
          },
        });
      }
    }

    // 6. Pending visits (assigned territory doctors with no non-superseded completed visit in date window)
    if (want('pending_visit')) {
      const targetMrs = users.filter(
        (u) =>
          u.role === Role.mr &&
          u.accountStatus === AccountStatus.active &&
          (!filter.mrId || u.id === filter.mrId),
      );

      const territoryDoctors = await this.prisma.territoryDoctor.findMany(/* companyId */ {
        where: {
          companyId,
          unassignedAt: null,
          ...(filter.territoryId ? { territoryId: filter.territoryId } : {}),
          territory: { companyId, isArchived: false },
          doctor: {
            companyId,
            isArchived: false,
            deletedAt: null,
            dataClassification: classification,
          },
        },
        include: {
          doctor: { select: { id: true, name: true } },
          territory: { select: { id: true, name: true } },
        },
      });

      const visitedKeys = new Set<string>();
      for (const v of visitsInRange) {
        if (v.status === 'completed' && !supersededIds.has(v.id)) {
          visitedKeys.add(`${v.mrId}:${v.doctorId}`);
        }
      }

      for (const mr of targetMrs) {
        const mrTerId = activeTerByMr.get(mr.id);
        if (!mrTerId) continue;
        if (filter.territoryId && mrTerId !== filter.territoryId) continue;

        const docsInTer = territoryDoctors.filter(
          (td) => td.territoryId === mrTerId,
        );
        for (const td of docsInTer) {
          if (visitedKeys.has(`${mr.id}:${td.doctorId}`)) {
            continue;
          }
          events.push({
            id: `pending:${window.date}:${mr.id}:${td.doctorId}`,
            category: 'pending_visit',
            actorId: mr.id,
            actorName: mr.displayName,
            actorEmployeeId: mr.employeeId,
            doctorId: td.doctorId,
            doctorName: td.doctor.name,
            territoryId: td.territoryId,
            territoryName: td.territory.name,
            activityLabel: 'Pending visit',
            statusLabel: 'Not visited',
            occurredAt: rangeStart.toISOString(),
            metadata: { date: window.date },
          });
        }
      }
    }

    // Sort newest timestamp first, placing pending items cleanly after timed events when unfiltered.
    events.sort((a, b) => {
      if (a.category === 'pending_visit' && b.category !== 'pending_visit') {
        return 1;
      }
      if (b.category === 'pending_visit' && a.category !== 'pending_visit') {
        return -1;
      }
      return b.occurredAt.localeCompare(a.occurredAt);
    });

    return {
      date: window.date,
      events: events.slice(0, filter.limit),
    };
  }
}
