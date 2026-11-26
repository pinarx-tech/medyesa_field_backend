import { writeAuditLog } from '../lib/audit.js';
import { resolveDayWindow } from '../lib/dateWindow.js';
import { AppError } from '../lib/errors.js';
import { Repo } from '../lib/repo.js';

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export class HcRecoveryRepo extends Repo {
  /**
   * Audited recovery for an accidentally ended workday (today only).
   * Never deletes the original end time — stores it in `previousEndedAt`
   * and writes immutable `workday_reopened` activity + audit logs.
   */
  async reopenWorkDay(
    workDayId: string,
    input: { reason: string; tzOffsetMinutes?: number },
  ) {
    const companyId = this.scopeCompany();
    const todayWindow = resolveDayWindow({
      tzOffsetMinutes: input.tzOffsetMinutes,
    });

    const result = await this.prisma.$transaction(async (tx) => {
      const wd = await tx.workDay.findFirst(/* companyId */ {
        where: { companyId, id: workDayId },
        include: {
          mr: { select: { id: true, displayName: true, employeeId: true } },
        },
      });
      if (!wd) {
        throw new AppError('not_found', 404, 'Workday not found.');
      }

      if (wd.endedAt === null) {
        throw new AppError(
          'business_rule_violation',
          422,
          'Workday is already active and does not need reopening.',
        );
      }

      if (
        wd.startedAt < todayWindow.startUtc ||
        wd.startedAt >= todayWindow.endUtc
      ) {
        throw new AppError(
          'business_rule_violation',
          422,
          'Only today’s workday can be reopened. Past workdays remain locked for audit integrity.',
        );
      }

      const now = new Date();
      const originalEndedAt = wd.endedAt;
      const originalAutoClosed = wd.autoClosed;

      const updated = await tx.workDay.update({
        where: { id: wd.id },
        data: {
          endedAt: null,
          autoClosed: false,
          previousEndedAt: originalEndedAt,
          reopenedAt: now,
          reopenedByUserId: this.ctx.userId,
          reopenReason: input.reason.trim(),
        },
      });

      await tx.activityLog.create({
        data: {
          companyId,
          actorId: this.ctx.userId,
          actorRole: this.ctx.role,
          actorDisplayName: this.ctx.displayName,
          actionType: 'workday_reopened',
          subjectType: 'workDay',
          subjectId: wd.id,
          subjectDisplayName: wd.mr.displayName,
          dataClassification: wd.dataClassification,
          detailsJson: {
            mrId: wd.mrId,
            mrEmployeeId: wd.mr.employeeId,
            originalEndedAt: originalEndedAt.toISOString(),
            originalAutoClosed,
            reopenedAt: now.toISOString(),
            reopenedByUserId: this.ctx.userId,
            reopenedByName: this.ctx.displayName,
            reason: input.reason.trim(),
          },
        },
      });

      return { updated, wd, originalEndedAt, originalAutoClosed, now };
    }, { maxWait: 10_000, timeout: 20_000 });

    await writeAuditLog(this.prisma, {
      companyId,
      actorId: this.ctx.userId,
      action: 'hc_workday_reopened',
      targetType: 'workDay',
      targetId: workDayId,
      metadata: {
        mrId: result.wd.mrId,
        originalEndedAt: result.originalEndedAt.toISOString(),
        originalAutoClosed: result.originalAutoClosed,
        reopenedAt: result.now.toISOString(),
        reason: input.reason.trim(),
      },
      ipAddress: this.ctx.ipAddress,
    });

    return {
      workDay: {
        id: result.updated.id,
        mrId: result.updated.mrId,
        startedAt: result.updated.startedAt.toISOString(),
        endedAt: null,
        autoClosed: false,
        previousEndedAt: result.originalEndedAt.toISOString(),
        reopenedAt: result.now.toISOString(),
        reopenedByUserId: this.ctx.userId,
        reopenedByName: this.ctx.displayName,
        reopenReason: result.updated.reopenReason,
      },
    };
  }

  /**
   * Creates a new audited correcting visit referencing `correctsVisitId`.
   * Preserves the original visit intact and copies immutable historical GPS
   * coordinates, distance, verification status, clinic location snapshot, and
   * capture timestamp so field evidence is never rewritten.
   */
  async correctVisit(
    originalVisitId: string,
    input: {
      reason: string;
      status: 'completed' | 'skipped';
      noteText?: string | null;
    },
  ) {
    const companyId = this.scopeCompany();

    const result = await this.prisma.$transaction(async (tx) => {
      const original = await tx.visit.findFirst(/* companyId */ {
        where: { companyId, id: originalVisitId },
        include: {
          doctor: { select: { id: true, name: true } },
          note: true,
        },
      });
      if (!original) {
        throw new AppError('not_found', 404, 'Visit not found.');
      }

      const alreadySuperseded = await tx.visit.findFirst(/* companyId */ {
        where: { companyId, correctsVisitId: original.id },
        select: { id: true },
      });
      if (alreadySuperseded) {
        throw new AppError(
          'business_rule_violation',
          422,
          'This visit has already been superseded by a newer correction. Correct the latest record instead.',
        );
      }

      const now = new Date();
      const corrected = await tx.visit.create({
        data: {
          companyId,
          mrId: original.mrId,
          doctorId: original.doctorId,
          workDayId: original.workDayId,
          status: input.status,
          // Strictly preserve immutable historical GPS & verification truth!
          checkInLatitude: original.checkInLatitude,
          checkInLongitude: original.checkInLongitude,
          checkInAccuracyMeters: original.checkInAccuracyMeters,
          checkInDistanceMeters: original.checkInDistanceMeters,
          checkInVerificationStatus: original.checkInVerificationStatus,
          checkInOverrideReason: original.checkInOverrideReason,
          checkInCapturedAt: original.checkInCapturedAt,
          checkOutAt: original.checkOutAt ?? now,
          doctorClinicLocationIdAtCheckIn:
            original.doctorClinicLocationIdAtCheckIn,
          territoryIdAtVisit: original.territoryIdAtVisit,
          correctsVisitId: original.id,
          capturedAtClient: original.capturedAtClient,
          dataClassification: original.dataClassification,
        },
      });

      const resolvedNote =
        input.noteText !== undefined
          ? input.noteText?.trim()
          : original.note?.noteText?.trim();
      if (resolvedNote && resolvedNote.length > 0) {
        await tx.visitNote.create({
          data: {
            companyId,
            visitId: corrected.id,
            doctorId: original.doctorId,
            visitDate: startOfUtcDay(original.capturedAtClient),
            noteText: resolvedNote,
          },
        });
      }

      await tx.activityLog.create({
        data: {
          companyId,
          actorId: this.ctx.userId,
          actorRole: this.ctx.role,
          actorDisplayName: this.ctx.displayName,
          actionType: 'visit_corrected',
          subjectType: 'visit',
          subjectId: corrected.id,
          subjectDisplayName: original.doctor.name,
          territoryId: original.territoryIdAtVisit,
          dataClassification: original.dataClassification,
          detailsJson: {
            originalVisitId: original.id,
            mrId: original.mrId,
            previousStatus: original.status,
            newStatus: input.status,
            reason: input.reason.trim(),
            correctedByUserId: this.ctx.userId,
            correctedByName: this.ctx.displayName,
            correctedAt: now.toISOString(),
          },
        },
      });

      const fullCorrected = await tx.visit.findFirst(/* companyId */ {
        where: { companyId, id: corrected.id },
        include: { note: true },
      });

      return { original, corrected: fullCorrected!, now };
    }, { maxWait: 10_000, timeout: 20_000 });

    await writeAuditLog(this.prisma, {
      companyId,
      actorId: this.ctx.userId,
      action: 'hc_visit_corrected',
      targetType: 'visit',
      targetId: result.corrected.id,
      metadata: {
        supersededVisitId: result.original.id,
        mrId: result.original.mrId,
        previousStatus: result.original.status,
        newStatus: input.status,
        reason: input.reason.trim(),
        correctedAt: result.now.toISOString(),
      },
      ipAddress: this.ctx.ipAddress,
    });

    return {
      visit: result.corrected,
      supersededVisitId: result.original.id,
    };
  }
}
