import { Role } from '@prisma/client';
import { writeAuditLog } from '../lib/audit.js';
import { resolveDoctorClinicLocation } from '../lib/clinicLocation.js';
import { AppError } from '../lib/errors.js';
import { Repo } from '../lib/repo.js';

export class TerritoryRepo extends Repo {
  async listForCompany(options: { includeArchived?: boolean } = {}) {
    const companyId = this.scopeCompany();
    const classification = this.scopeClassification();
    const includeArchived = options.includeArchived === true;

    const territories = await this.prisma.territory.findMany(/* companyId */ {
      where: {
        companyId,
        dataClassification: classification,
        ...(includeArchived ? {} : { isArchived: false }),
      },
      include: {
        _count: {
          select: {
            mrAssignments: { where: { companyId, unassignedAt: null } },
            territoryDoctors: {
              where: {
                companyId,
                unassignedAt: null,
                doctor: {
                  companyId,
                  isArchived: false,
                  deletedAt: null,
                  dataClassification: classification,
                },
              },
            },
          },
        },
        territoryDoctors: {
          where: {
            companyId,
            unassignedAt: null,
            doctor: {
              companyId,
              isArchived: false,
              deletedAt: null,
              dataClassification: classification,
            },
          },
          select: {
            doctor: {
              select: {
                clinicId: true,
                clinicName: true,
                clinic: {
                  select: {
                    id: true,
                    name: true,
                    formattedAddress: true,
                    landmark: true,
                    phone: true,
                    latitude: true,
                    longitude: true,
                    accuracyMeters: true,
                    source: true,
                  },
                },
                clinicLocations: {
                  where: { companyId, isCurrent: true },
                  take: 1,
                  select: {
                    id: true,
                    clinicName: true,
                    formattedAddress: true,
                    latitude: true,
                    longitude: true,
                    accuracyMeters: true,
                    source: true,
                    status: true,
                    isCurrent: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    return territories.map(({ territoryDoctors, ...t }) => {
      const locationPendingCount = territoryDoctors.filter(
        (link) =>
          resolveDoctorClinicLocation(link.doctor).locationStatus !==
          'configured',
      ).length;
      return {
        ...t,
        locationPendingCount,
      };
    });
  }

  async getDetail(territoryId: string) {
    const companyId = this.scopeCompany();
    const classification = this.scopeClassification();
    const territory = await this.prisma.territory.findFirst(/* companyId */ {
      where: { companyId, id: territoryId },
    });
    if (!territory) {
      throw new AppError('not_found', 404, 'Territory not found.');
    }

    const [
      doctorLinks,
      mrAssignments,
      totalMrHistory,
      totalDocHistory,
      totalVisits,
    ] = await Promise.all([
      this.prisma.territoryDoctor.findMany(/* companyId */ {
        where: { companyId, territoryId, unassignedAt: null },
        include: {
          doctor: {
            include: {
              clinic: true,
              clinicLocations: {
                where: { companyId, isCurrent: true },
                orderBy: { capturedAt: 'desc' },
                take: 1,
              },
            },
          },
        },
        orderBy: { doctor: { name: 'asc' } },
      }),
      this.prisma.mrTerritoryAssignment.findMany(/* companyId */ {
        where: { companyId, territoryId, unassignedAt: null },
        select: { mrId: true, assignedAt: true },
      }),
      this.prisma.mrTerritoryAssignment.count({
        where: { companyId, territoryId },
      }),
      this.prisma.territoryDoctor.count({
        where: { companyId, territoryId },
      }),
      this.prisma.visit.count({
        where: { companyId, territoryIdAtVisit: territoryId },
      }),
    ]);

    const mrIds = mrAssignments.map((m) => m.mrId);
    const mrs =
      mrIds.length > 0
        ? await this.prisma.user.findMany({
            where: { companyId, id: { in: mrIds }, deletedAt: null },
            select: {
              id: true,
              employeeId: true,
              displayName: true,
              accountStatus: true,
            },
            orderBy: { displayName: 'asc' },
          })
        : [];

    const doctors = doctorLinks
      .filter(
        (l) =>
          !l.doctor.isArchived &&
          l.doctor.deletedAt === null &&
          l.doctor.dataClassification === classification,
      )
      .map((l) => {
        const loc = resolveDoctorClinicLocation(l.doctor);
        return {
          id: l.doctor.id,
          name: l.doctor.name,
          specialty: l.doctor.specialty,
          clinicId: l.doctor.clinicId,
          clinicName: loc.clinicName ?? l.doctor.clinicName,
          phone: l.doctor.phone,
          email: l.doctor.email,
          geofenceRadiusMeters: l.doctor.geofenceRadiusMeters,
          isArchived: l.doctor.isArchived,
          clinicLocation: loc,
          clinic: l.doctor.clinic,
          clinicLocations: l.doctor.clinicLocations,
        };
      });

    return {
      territory,
      doctors,
      mrs,
      canDeleteEmpty:
        totalMrHistory === 0 && totalDocHistory === 0 && totalVisits === 0,
    };
  }

  async create(input: {
    code: string;
    name: string;
    description?: string | null;
    notes?: string | null;
  }) {
    const companyId = this.scopeCompany();
    const classification = this.scopeClassification();
    const existing = await this.prisma.territory.findFirst(/* companyId */ {
      where: { companyId, code: input.code },
    });
    if (existing) {
      throw new AppError('conflict', 409, 'Territory code already exists.');
    }

    const territory = await this.prisma.territory.create({
      data: {
        companyId,
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        notes: input.notes ?? null,
        createdByHeadControllerId: this.ctx.userId,
        dataClassification: classification,
      },
    });

    await this.prisma.activityLog.create({
      data: {
        companyId,
        actorId: this.ctx.userId,
        actorRole: this.ctx.role,
        actorDisplayName: this.ctx.displayName,
        actionType: 'territory_created',
        subjectType: 'territory',
        subjectId: territory.id,
        subjectDisplayName: territory.name,
        territoryId: territory.id,
        dataClassification: classification,
      },
    });

    return territory;
  }

  async update(
    territoryId: string,
    input: {
      name?: string;
      description?: string | null;
      notes?: string | null;
    },
  ) {
    const companyId = this.scopeCompany();
    const result = await this.prisma.territory.updateMany(/* companyId */ {
      where: { companyId, id: territoryId },
      data: input,
    });
    if (result.count !== 1) {
      throw new AppError('not_found', 404, 'Territory not found.');
    }
    return this.prisma.territory.findFirst(/* companyId */ {
      where: { companyId, id: territoryId },
    });
  }

  async archive(territoryId: string) {
    const companyId = this.scopeCompany();
    const result = await this.prisma.territory.updateMany(/* companyId */ {
      where: { companyId, id: territoryId, isArchived: false },
      data: { isArchived: true, archivedAt: new Date() },
    });
    if (result.count !== 1) {
      throw new AppError('not_found', 404, 'Territory not found.');
    }

    const updated = await this.prisma.territory.findFirst(/* companyId */ {
      where: { companyId, id: territoryId },
    });

    await this.prisma.activityLog.create({
      data: {
        companyId,
        actorId: this.ctx.userId,
        actorRole: this.ctx.role,
        actorDisplayName: this.ctx.displayName,
        actionType: 'territory_archived',
        subjectType: 'territory',
        subjectId: territoryId,
        subjectDisplayName: updated?.name ?? territoryId,
        territoryId,
        dataClassification: this.scopeClassification(),
      },
    });

    return updated;
  }

  /**
   * Safely hard-deletes a truly empty territory with ZERO active or historical
   * MR assignments, doctor links, visits, or operational history.
   * Never deletes historical records — returns 422 recommending Archive instead.
   */
  async deleteEmpty(territoryId: string) {
    const companyId = this.scopeCompany();

    const deleted = await this.prisma.$transaction(async (tx) => {
      const territory = await tx.territory.findFirst({
        where: { companyId, id: territoryId },
      });
      if (!territory) {
        throw new AppError('not_found', 404, 'Territory not found.');
      }

      const [
        mrAssignmentsCount,
        territoryDoctorsCount,
        visitsCount,
        operationalActivityCount,
      ] = await Promise.all([
        tx.mrTerritoryAssignment.count({
          where: { companyId, territoryId },
        }),
        tx.territoryDoctor.count({
          where: { companyId, territoryId },
        }),
        tx.visit.count({
          where: { companyId, territoryIdAtVisit: territoryId },
        }),
        tx.activityLog.count({
          where: {
            companyId,
            territoryId,
            actionType: { notIn: ['territory_created', 'territory_archived'] },
          },
        }),
      ]);

      if (
        mrAssignmentsCount > 0 ||
        territoryDoctorsCount > 0 ||
        visitsCount > 0 ||
        operationalActivityCount > 0
      ) {
        throw new AppError(
          'business_rule_violation',
          422,
          'This territory has active or historical assignments, doctors, or visits and cannot be deleted. Archive it instead.',
          undefined,
          {
            canArchive: true,
            mrAssignmentsCount,
            territoryDoctorsCount,
            visitsCount,
            operationalActivityCount,
          },
        );
      }

      // Preserve creation/archive audit logs intact while unlinking the deleted ID.
      await tx.activityLog.updateMany({
        where: { companyId, territoryId },
        data: { territoryId: null },
      });

      await tx.territory.deleteMany({
        where: { companyId, id: territoryId },
      });

      return territory;
    });

    await writeAuditLog(this.prisma, {
      companyId,
      actorId: this.ctx.userId,
      action: 'territory_deleted',
      targetType: 'territory',
      targetId: deleted.id,
      metadata: { code: deleted.code, name: deleted.name },
      ipAddress: this.ctx.ipAddress,
    });

    return {
      ok: true,
      deletedId: deleted.id,
      deletedTerritoryId: deleted.id,
    };
  }

  async addDoctor(territoryId: string, doctorId: string) {
    const companyId = this.scopeCompany();
    const territory = await this.prisma.territory.findFirst(/* companyId */ {
      where: { companyId, id: territoryId },
    });
    if (!territory) {
      throw new AppError('not_found', 404, 'Territory not found.');
    }
    if (territory.isArchived) {
      throw new AppError(
        'business_rule_violation',
        422,
        'Cannot assign a doctor to an archived territory.',
      );
    }

    const doctor = await this.prisma.doctor.findFirst(/* companyId */ {
      where: { companyId, id: doctorId, deletedAt: null },
    });
    if (!doctor) {
      throw new AppError('not_found', 404, 'Doctor not found.');
    }

    const existing = await this.prisma.territoryDoctor.findFirst(/* companyId */ {
      where: { companyId, territoryId, doctorId, unassignedAt: null },
    });
    if (existing) {
      return existing;
    }

    const link = await this.prisma.territoryDoctor.create({
      data: {
        companyId,
        territoryId,
        doctorId,
        assignedByHeadControllerId: this.ctx.userId,
      },
    });

    await this.prisma.activityLog.create({
      data: {
        companyId,
        actorId: this.ctx.userId,
        actorRole: this.ctx.role,
        actorDisplayName: this.ctx.displayName,
        actionType: 'doctor_added_to_territory',
        subjectType: 'doctor',
        subjectId: doctor.id,
        subjectDisplayName: doctor.name,
        territoryId,
        dataClassification: this.scopeClassification(),
      },
    });

    return link;
  }

  async removeDoctor(territoryId: string, doctorId: string) {
    const companyId = this.scopeCompany();
    const result = await this.prisma.territoryDoctor.updateMany(/* companyId */ {
      where: { companyId, territoryId, doctorId, unassignedAt: null },
      data: { unassignedAt: new Date() },
    });
    if (result.count === 0) {
      throw new AppError('not_found', 404, 'Active doctor assignment not found.');
    }

    await this.prisma.activityLog.create({
      data: {
        companyId,
        actorId: this.ctx.userId,
        actorRole: this.ctx.role,
        actorDisplayName: this.ctx.displayName,
        actionType: 'doctor_removed_from_territory',
        subjectType: 'doctor',
        subjectId: doctorId,
        territoryId,
        dataClassification: this.scopeClassification(),
      },
    });

    return { ok: true };
  }

  async reassignMrTerritory(mrId: string, territoryId: string | null) {
    const companyId = this.scopeCompany();
    const mr = await this.prisma.user.findFirst({
      where: { companyId, id: mrId, role: Role.mr, deletedAt: null },
    });
    if (!mr) {
      throw new AppError('not_found', 404, 'MR not found.');
    }

    let nextTerritoryName: string | null = null;
    if (territoryId !== null) {
      const territory = await this.prisma.territory.findFirst(/* companyId */ {
        where: { companyId, id: territoryId },
      });
      if (!territory) {
        throw new AppError('not_found', 404, 'Territory not found.');
      }
      if (territory.isArchived) {
        throw new AppError(
          'business_rule_violation',
          422,
          'Cannot assign an MR to an archived territory.',
        );
      }
      nextTerritoryName = territory.name;
    }

    const prevAssignment = await this.prisma.mrTerritoryAssignment.findFirst(/* companyId */ {
      where: { companyId, mrId, unassignedAt: null },
      include: { territory: { select: { id: true, name: true } } },
    });

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.mrTerritoryAssignment.updateMany({
        where: { companyId, mrId, unassignedAt: null },
        data: { unassignedAt: now },
      });

      if (territoryId !== null) {
        await tx.mrTerritoryAssignment.create({
          data: {
            companyId,
            mrId,
            territoryId,
            assignedAt: now,
            assignedByHeadControllerId: this.ctx.userId,
          },
        });
      }
    }, { maxWait: 10_000, timeout: 20_000 });

    const auditPayload = {
      mrId: mr.id,
      beforeTerritoryId: prevAssignment?.territoryId ?? null,
      beforeTerritoryName: prevAssignment?.territory.name ?? 'Not assigned',
      afterTerritoryId: territoryId,
      afterTerritoryName: nextTerritoryName ?? 'Not assigned',
      changedByUserId: this.ctx.userId,
      changedByName: this.ctx.displayName,
      changedAt: now.toISOString(),
    };

    await this.prisma.activityLog.create({
      data: {
        companyId,
        actorId: this.ctx.userId,
        actorRole: this.ctx.role,
        actorDisplayName: this.ctx.displayName,
        actionType: 'territory_assigned',
        subjectType: 'mr',
        subjectId: mr.id,
        subjectDisplayName: mr.displayName,
        territoryId,
        detailsJson: auditPayload,
        dataClassification: this.scopeClassification(),
      },
    });

    await writeAuditLog(this.prisma, {
      companyId,
      actorId: this.ctx.userId,
      action: 'hc_territory_reassigned',
      targetType: 'mr',
      targetId: mr.id,
      metadata: auditPayload,
      ipAddress: this.ctx.ipAddress,
    });

    return {
      mrId: mr.id,
      territoryId,
      previousTerritoryId: prevAssignment?.territoryId ?? null,
    };
  }
}
