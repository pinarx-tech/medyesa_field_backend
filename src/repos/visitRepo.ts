import { Prisma, SyncStatus, VisitVerificationStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { resolveDayWindow } from '../lib/dateWindow.js';
import { AppError } from '../lib/errors.js';
import { Repo } from '../lib/repo.js';
import { DoctorRepo } from './doctorRepo.js';

function stablePayloadHash(payload: unknown): string {
  function sortKeys(val: unknown): unknown {
    if (val === null || typeof val !== 'object') {
      return val;
    }
    if (Array.isArray(val)) {
      return val.map(sortKeys);
    }
    const record = val as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) {
        sorted[key] = sortKeys(record[key]);
      }
    }
    return sorted;
  }
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(payload ?? {})))
    .digest('hex');
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export class VisitRepo extends Repo {
  private syncKey(companyId: number, clientId: string): string {
    return `${companyId}:${clientId}`;
  }

  /**
   * Single-round-trip MR hydration payload using IST/client `tzOffsetMinutes`
   * day window (fixes UTC midnight mismatch between 00:00 and 05:30 IST).
   */
  async getTodayForMr(input: { date?: string; tzOffsetMinutes?: number } = {}) {
    const companyId = this.scopeCompany();
    const mrId = this.scopeSelf(this.ctx.userId);
    const classification = this.scopeClassification();
    const window = resolveDayWindow({
      date: input.date,
      tzOffsetMinutes: input.tzOffsetMinutes,
    });

    const doctorRepo = new DoctorRepo(this.prisma, this.ctx);

    const [mrContext, activeWorkDay, visits] = await Promise.all([
      doctorRepo.listForMrSelfWithContext(),
      this.prisma.workDay.findFirst(/* companyId */ {
        where: {
          companyId,
          mrId,
          dataClassification: classification,
          startedAt: { gte: window.startUtc, lt: window.endUtc },
        },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.visit.findMany(/* companyId */ {
        where: {
          companyId,
          mrId,
          dataClassification: classification,
          capturedAtClient: { gte: window.startUtc, lt: window.endUtc },
        },
        include: { note: true },
        orderBy: { capturedAtClient: 'asc' },
      }),
    ]);

    return {
      date: window.date,
      company: mrContext.company,
      activeTerritory: mrContext.activeTerritory,
      territory: mrContext.territory,
      assignment: mrContext.assignment,
      workDay: activeWorkDay,
      doctors: mrContext.doctors,
      visits,
    };
  }

  async startWorkDay(input: { clientId: string; startedAt: string }) {
    const companyId = this.scopeCompany();
    const mrId = this.scopeSelf(this.ctx.userId);
    const classification = this.scopeClassification();
    const opKey = this.syncKey(companyId, input.clientId);

    const existingOp = await this.prisma.syncOperation.findUnique({
      where: { id: opKey },
    });
    if (existingOp?.serverId) {
      const existing = await this.prisma.workDay.findFirst(/* companyId */ {
        where: { companyId, id: existingOp.serverId, mrId },
      });
      if (existing) {
        return { workDay: existing, serverId: existing.id, deduplicated: true };
      }
    }

    const workDay = await this.prisma.workDay.create({
      data: {
        companyId,
        mrId,
        startedAt: new Date(input.startedAt),
        dataClassification: classification,
      },
    });

    await this.prisma.syncOperation.upsert({
      where: { id: opKey },
      update: {
        status: SyncStatus.synced,
        serverId: workDay.id,
        processedAt: new Date(),
      },
      create: {
        id: opKey,
        companyId,
        actorId: mrId,
        entityType: 'workDay',
        entityId: input.clientId,
        operation: 'start',
        payload: input as Prisma.InputJsonValue,
        status: SyncStatus.synced,
        attempts: 1,
        serverId: workDay.id,
        processedAt: new Date(),
      },
    });

    await this.prisma.activityLog.create({
      data: {
        companyId,
        actorId: mrId,
        actorRole: this.ctx.role,
        actorDisplayName: this.ctx.displayName,
        actionType: 'day_start',
        subjectType: 'workDay',
        subjectId: workDay.id,
        dataClassification: classification,
      },
    });

    return { workDay, serverId: workDay.id, deduplicated: false };
  }

  async endWorkDay(input: {
    clientId: string;
    workDayClientId: string;
    endedAt: string;
    autoClosed: boolean;
  }) {
    const companyId = this.scopeCompany();
    const mrId = this.scopeSelf(this.ctx.userId);
    const opKey = this.syncKey(companyId, input.clientId);

    const existingOp = await this.prisma.syncOperation.findUnique({
      where: { id: opKey },
    });
    if (existingOp?.serverId) {
      const existing = await this.prisma.workDay.findFirst(/* companyId */ {
        where: { companyId, id: existingOp.serverId, mrId },
      });
      if (existing) {
        return { workDay: existing, serverId: existing.id, deduplicated: true };
      }
    }

    // Resolve workDay by either prior sync clientId or direct workDay UUID.
    const startOp = await this.prisma.syncOperation.findUnique({
      where: { id: this.syncKey(companyId, input.workDayClientId) },
    });
    const resolvedWorkDayId = startOp?.serverId ?? input.workDayClientId;

    const updated = await this.prisma.workDay.updateMany(/* companyId */ {
      where: { companyId, id: resolvedWorkDayId, mrId },
      data: {
        endedAt: new Date(input.endedAt),
        autoClosed: input.autoClosed,
      },
    });
    if (updated.count !== 1) {
      throw new AppError('not_found', 404, 'Workday not found.');
    }

    const workDay = await this.prisma.workDay.findFirst(/* companyId */ {
      where: { companyId, id: resolvedWorkDayId, mrId },
    });

    await this.prisma.syncOperation.upsert({
      where: { id: opKey },
      update: {
        status: SyncStatus.synced,
        serverId: resolvedWorkDayId,
        processedAt: new Date(),
      },
      create: {
        id: opKey,
        companyId,
        actorId: mrId,
        entityType: 'workDay',
        entityId: input.clientId,
        operation: 'end',
        payload: input as Prisma.InputJsonValue,
        status: SyncStatus.synced,
        attempts: 1,
        serverId: resolvedWorkDayId,
        processedAt: new Date(),
      },
    });

    await this.prisma.activityLog.create({
      data: {
        companyId,
        actorId: mrId,
        actorRole: this.ctx.role,
        actorDisplayName: this.ctx.displayName,
        actionType: 'day_end',
        subjectType: 'workDay',
        subjectId: resolvedWorkDayId,
        detailsJson: { autoClosed: input.autoClosed },
        dataClassification: this.scopeClassification(),
      },
    });

    return { workDay, serverId: resolvedWorkDayId, deduplicated: false };
  }

  async createVisit(input: {
    clientId: string;
    doctorId: string;
    workDayId?: string | null;
    status: string;
    checkInLatitude?: number | null;
    checkInLongitude?: number | null;
    checkInAccuracyMeters?: number | null;
    checkInDistanceMeters?: number | null;
    checkInVerificationStatus: VisitVerificationStatus;
    checkInOverrideReason?: string | null;
    checkInCapturedAt?: string | null;
    checkOutAt?: string | null;
    doctorClinicLocationIdAtCheckIn?: string | null;
    territoryIdAtVisit?: string | null;
    correctsVisitId?: string | null;
    capturedAtClient: string;
    noteText?: string | null;
  }) {
    const companyId = this.scopeCompany();
    const mrId = this.scopeSelf(this.ctx.userId);
    const classification = this.scopeClassification();
    const opKey = this.syncKey(companyId, input.clientId);

    // 1. Idempotency check by clientId (409 on conflicting payload).
    const existingOp = await this.prisma.syncOperation.findUnique({
      where: { id: opKey },
    });
    if (existingOp?.serverId) {
      const prevHash = stablePayloadHash(existingOp.payload);
      const nextHash = stablePayloadHash(input);
      if (prevHash !== nextHash) {
        throw new AppError(
          'conflict',
          409,
          'Idempotency key reused with a different payload.',
        );
      }
      const existingVisit = await this.prisma.visit.findFirst(/* companyId */ {
        where: { companyId, id: existingOp.serverId, mrId },
        include: { note: true },
      });
      if (existingVisit) {
        return {
          visit: existingVisit,
          serverId: existingVisit.id,
          deduplicated: true,
        };
      }
    }

    // 2. Load doctor and current clinic location scoped to companyId.
    const doctor = await this.prisma.doctor.findFirst(/* companyId */ {
      where: { companyId, id: input.doctorId, deletedAt: null },
      include: {
        clinicLocations: {
          where: { companyId, isCurrent: true },
          take: 1,
        },
      },
    });
    if (!doctor) {
      throw new AppError('not_found', 404, 'Doctor not found.');
    }

    // 3. Server-authoritative Verification Integrity Rule (§7.5).
    if (input.checkInVerificationStatus === VisitVerificationStatus.verified) {
      if (
        input.checkInDistanceMeters == null ||
        input.checkInDistanceMeters > doctor.geofenceRadiusMeters
      ) {
        throw new AppError(
          'business_rule_violation',
          422,
          `Cannot mark visit verified: distance exceeds doctor geofence radius (${doctor.geofenceRadiusMeters} m) or distance is missing.`,
        );
      }
    }

    const currentLocationId =
      input.doctorClinicLocationIdAtCheckIn ??
      doctor.clinicLocations[0]?.id ??
      null;
    const capturedAt = new Date(input.capturedAtClient);

    const visit = await this.prisma.$transaction(async (tx) => {
      const created = await tx.visit.create({
        data: {
          companyId,
          mrId,
          doctorId: doctor.id,
          workDayId: input.workDayId ?? null,
          status: input.status,
          checkInLatitude: input.checkInLatitude ?? null,
          checkInLongitude: input.checkInLongitude ?? null,
          checkInAccuracyMeters: input.checkInAccuracyMeters ?? null,
          checkInDistanceMeters: input.checkInDistanceMeters ?? null,
          checkInVerificationStatus: input.checkInVerificationStatus,
          checkInOverrideReason: input.checkInOverrideReason ?? null,
          checkInCapturedAt: input.checkInCapturedAt
            ? new Date(input.checkInCapturedAt)
            : null,
          checkOutAt: input.checkOutAt ? new Date(input.checkOutAt) : null,
          doctorClinicLocationIdAtCheckIn: currentLocationId,
          territoryIdAtVisit: input.territoryIdAtVisit ?? null,
          correctsVisitId: input.correctsVisitId ?? null,
          capturedAtClient: capturedAt,
          dataClassification: classification,
        },
      });

      const cleanNote = input.noteText?.trim();
      if (cleanNote && cleanNote.length > 0) {
        await tx.visitNote.create({
          data: {
            companyId,
            visitId: created.id,
            doctorId: doctor.id,
            visitDate: startOfUtcDay(capturedAt),
            noteText: cleanNote,
          },
        });
      }

      await tx.syncOperation.create({
        data: {
          id: opKey,
          companyId,
          actorId: mrId,
          entityType: 'visit',
          entityId: input.clientId,
          operation: 'create',
          payload: input as Prisma.InputJsonValue,
          status: SyncStatus.synced,
          attempts: 1,
          serverId: created.id,
          processedAt: new Date(),
        },
      });

      await tx.activityLog.create({
        data: {
          companyId,
          actorId: mrId,
          actorRole: this.ctx.role,
          actorDisplayName: this.ctx.displayName,
          actionType: 'visit_completed',
          subjectType: 'visit',
          subjectId: created.id,
          subjectDisplayName: doctor.name,
          territoryId: input.territoryIdAtVisit ?? null,
          dataClassification: classification,
          detailsJson: {
            verificationStatus: input.checkInVerificationStatus,
            distanceMeters: input.checkInDistanceMeters ?? null,
            overrideReason: input.checkInOverrideReason ?? null,
          },
        },
      });

      return tx.visit.findFirst({
        where: { companyId, id: created.id },
        include: { note: true },
      });
    });

    return {
      visit,
      serverId: visit!.id,
      deduplicated: false,
    };
  }

  async upsertVisitNote(visitId: string, rawNoteText: string) {
    const companyId = this.scopeCompany();
    const mrId = this.scopeSelf(this.ctx.userId);

    const visit = await this.prisma.visit.findFirst(/* companyId */ {
      where: { companyId, id: visitId, mrId },
    });
    if (!visit) {
      throw new AppError('not_found', 404, 'Visit not found.');
    }

    const trimmed = rawNoteText.trim();
    if (trimmed.length === 0) {
      await this.prisma.visitNote.deleteMany(/* companyId */ {
        where: { companyId, visitId: visit.id },
      });
      return { visitId: visit.id, note: null };
    }

    const existing = await this.prisma.visitNote.findFirst(/* companyId */ {
      where: { companyId, visitId: visit.id },
    });

    const note = existing
      ? await this.prisma.visitNote.update(/* companyId */ {
          where: { id: existing.id, companyId },
          data: { noteText: trimmed },
        })
      : await this.prisma.visitNote.create({
          data: {
            companyId,
            visitId: visit.id,
            doctorId: visit.doctorId,
            visitDate: startOfUtcDay(visit.capturedAtClient),
            noteText: trimmed,
          },
        });

    return { visitId: visit.id, note };
  }

  async getSyncStatusForMr() {
    const companyId = this.scopeCompany();
    const mrId = this.scopeSelf(this.ctx.userId);

    const [pending, failed, synced] = await Promise.all([
      this.prisma.syncOperation.count({
        where: { companyId, actorId: mrId, status: SyncStatus.pending },
      }),
      this.prisma.syncOperation.count({
        where: { companyId, actorId: mrId, status: SyncStatus.failed },
      }),
      this.prisma.syncOperation.count({
        where: { companyId, actorId: mrId, status: SyncStatus.synced },
      }),
    ]);

    return { pending, failed, synced };
  }
}
