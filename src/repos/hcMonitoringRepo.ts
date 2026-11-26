import { Role, SyncStatus } from '@prisma/client';
import { resolveDayWindow } from '../lib/dateWindow.js';
import { AppError } from '../lib/errors.js';
import { Repo } from '../lib/repo.js';

export type MonitoredDoctorVisitState =
  | 'notVisited'
  | 'awaitingSync'
  | 'synced'
  | 'syncFailed'
  | 'corrected';

export class HcMonitoringRepo extends Repo {
  async getMrMonitoring(
    mrId: string,
    input: { date?: string; tzOffsetMinutes?: number },
  ) {
    const companyId = this.scopeCompany();
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { dataClassification: true },
    });
    if (!company) {
      throw new AppError('not_found', 404, 'Company not found.');
    }

    const mr = await this.prisma.user.findFirst({
      where: { companyId, id: mrId, role: Role.mr, deletedAt: null },
      select: {
        id: true,
        employeeId: true,
        displayName: true,
        email: true,
        phone: true,
        accountStatus: true,
        lastLoginAt: true,
      },
    });
    if (!mr) {
      throw new AppError('not_found', 404, 'Medical Representative not found.');
    }

    const classification = company.dataClassification;
    const window = resolveDayWindow({
      date: input.date,
      tzOffsetMinutes: input.tzOffsetMinutes,
    });
    const fourteenDaysAgo = new Date(
      window.startUtc.getTime() - 14 * 24 * 60 * 60_000,
    );

    const [
      activeAssignment,
      workDayToday,
      autoClosedWorkDays,
      visitsToday,
      pendingOrFailedOps,
      latestSyncedOp,
    ] = await Promise.all([
      this.prisma.mrTerritoryAssignment.findFirst(/* companyId */ {
        where: { companyId, mrId, unassignedAt: null },
        include: {
          territory: {
            select: { id: true, code: true, name: true, isArchived: true },
          },
        },
      }),
      this.prisma.workDay.findFirst(/* companyId */ {
        where: {
          companyId,
          mrId,
          dataClassification: classification,
          startedAt: { gte: window.startUtc, lt: window.endUtc },
        },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.workDay.findMany(/* companyId */ {
        where: {
          companyId,
          mrId,
          autoClosed: true,
          dataClassification: classification,
          startedAt: { gte: fourteenDaysAgo, lt: window.endUtc },
        },
        orderBy: { startedAt: 'desc' },
        take: 14,
      }),
      this.prisma.visit.findMany(/* companyId */ {
        where: {
          companyId,
          mrId,
          dataClassification: classification,
          capturedAtClient: { gte: window.startUtc, lt: window.endUtc },
        },
        include: {
          doctor: { select: { id: true, name: true, clinicName: true } },
          note: { select: { id: true, noteText: true } },
        },
        orderBy: { capturedAtClient: 'desc' },
      }),
      this.prisma.syncOperation.findMany({
        where: {
          companyId,
          actorId: mrId,
          status: { in: [SyncStatus.pending, SyncStatus.failed] },
        },
        orderBy: { receivedAt: 'desc' },
      }),
      this.prisma.syncOperation.findFirst({
        where: { companyId, actorId: mrId, status: SyncStatus.synced },
        orderBy: { processedAt: 'desc' },
        select: { processedAt: true },
      }),
    ]);

    let reopenedByName: string | null = null;
    if (workDayToday?.reopenedByUserId) {
      const reopener = await this.prisma.user.findFirst({
        where: { companyId, id: workDayToday.reopenedByUserId },
        select: { displayName: true },
      });
      reopenedByName = reopener?.displayName ?? null;
    }

    const activeTerritory =
      activeAssignment && !activeAssignment.territory.isArchived
        ? {
            id: activeAssignment.territory.id,
            code: activeAssignment.territory.code,
            name: activeAssignment.territory.name,
            assignedAt: activeAssignment.assignedAt.toISOString(),
          }
        : null;

    const territoryDoctors = activeTerritory
      ? await this.prisma.territoryDoctor.findMany(/* companyId */ {
          where: {
            companyId,
            territoryId: activeTerritory.id,
            unassignedAt: null,
            doctor: {
              companyId,
              isArchived: false,
              deletedAt: null,
              dataClassification: classification,
            },
          },
          include: {
            doctor: {
              select: {
                id: true,
                name: true,
                specialty: true,
                clinicName: true,
                clinicId: true,
              },
            },
          },
          orderBy: { doctor: { name: 'asc' } },
        })
      : [];

    // Identify superseded original visits.
    const supersededVisitIds = new Set<string>();
    for (const v of visitsToday) {
      if (v.correctsVisitId) {
        supersededVisitIds.add(v.correctsVisitId);
      }
    }

    // Index pending/failed sync ops by doctorId if payload carries doctorId.
    const pendingDoctorIds = new Set<string>();
    const failedOpByDoctorId = new Map<
      string,
      { id: string; lastError: string | null; attempts: number }
    >();
    for (const op of pendingOrFailedOps) {
      const payload =
        op.payload && typeof op.payload === 'object'
          ? (op.payload as Record<string, unknown>)
          : {};
      const docId =
        typeof payload.doctorId === 'string' ? payload.doctorId : null;
      if (!docId) continue;

      if (op.status === SyncStatus.failed && !failedOpByDoctorId.has(docId)) {
        failedOpByDoctorId.set(docId, {
          id: op.id,
          lastError: op.lastError,
          attempts: op.attempts,
        });
      } else if (op.status === SyncStatus.pending) {
        pendingDoctorIds.add(docId);
      }
    }

    const assignedDoctors = territoryDoctors.map((td) => {
      const doc = td.doctor;
      const docVisits = visitsToday.filter((v) => v.doctorId === doc.id);
      const activeVisit =
        docVisits.find((v) => !supersededVisitIds.has(v.id)) ?? null;
      const failedOp = failedOpByDoctorId.get(doc.id) ?? null;

      let visitState: MonitoredDoctorVisitState = 'notVisited';
      if (failedOp) {
        visitState = 'syncFailed';
      } else if (pendingDoctorIds.has(doc.id)) {
        visitState = 'awaitingSync';
      } else if (activeVisit) {
        visitState = activeVisit.correctsVisitId ? 'corrected' : 'synced';
      }

      return {
        doctorId: doc.id,
        doctorName: doc.name,
        specialty: doc.specialty,
        clinicName: doc.clinicName,
        clinicId: doc.clinicId,
        visitState,
        latestVisit: activeVisit
          ? {
              id: activeVisit.id,
              status: activeVisit.status,
              verificationStatus: activeVisit.checkInVerificationStatus,
              distanceMeters: activeVisit.checkInDistanceMeters,
              capturedAtClient: activeVisit.capturedAtClient.toISOString(),
              correctsVisitId: activeVisit.correctsVisitId,
              noteText: activeVisit.note?.noteText ?? null,
            }
          : null,
        supersededVisits: docVisits
          .filter((v) => supersededVisitIds.has(v.id))
          .map((v) => ({
            id: v.id,
            capturedAtClient: v.capturedAtClient.toISOString(),
            verificationStatus: v.checkInVerificationStatus,
            noteText: v.note?.noteText ?? null,
          })),
        syncFailure: failedOp,
      };
    });

    // Determine latest sync freshness timestamp.
    let lastSyncedAt = latestSyncedOp?.processedAt ?? null;
    for (const v of visitsToday) {
      if (!lastSyncedAt || v.createdAt > lastSyncedAt) {
        lastSyncedAt = v.createdAt;
      }
    }

    const syncFailures = pendingOrFailedOps
      .filter((op) => op.status === SyncStatus.failed)
      .map((op) => ({
        id: op.id,
        entityType: op.entityType,
        entityId: op.entityId,
        operation: op.operation,
        attempts: op.attempts,
        lastError: op.lastError ?? 'Synchronization failed.',
        receivedAt: op.receivedAt.toISOString(),
      }));

    return {
      date: window.date,
      mr: {
        id: mr.id,
        employeeId: mr.employeeId,
        displayName: mr.displayName,
        email: mr.email,
        phone: mr.phone,
        accountStatus: mr.accountStatus,
        lastLoginAt: mr.lastLoginAt?.toISOString() ?? null,
        lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
        territory: activeTerritory,
      },
      workDay: workDayToday
        ? {
            id: workDayToday.id,
            startedAt: workDayToday.startedAt.toISOString(),
            endedAt: workDayToday.endedAt?.toISOString() ?? null,
            autoClosed: workDayToday.autoClosed,
            previousEndedAt: workDayToday.previousEndedAt?.toISOString() ?? null,
            reopenedAt: workDayToday.reopenedAt?.toISOString() ?? null,
            reopenedByUserId: workDayToday.reopenedByUserId,
            reopenedByName,
            reopenReason: workDayToday.reopenReason,
          }
        : null,
      assignedDoctors,
      syncFailures,
      autoClosedWorkDays: autoClosedWorkDays.map((wd) => ({
        id: wd.id,
        startedAt: wd.startedAt.toISOString(),
        endedAt: wd.endedAt?.toISOString() ?? null,
      })),
    };
  }
}
