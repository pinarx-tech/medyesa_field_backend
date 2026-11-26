import { Role } from '@prisma/client';
import { writeAuditLog } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import { Repo } from '../lib/repo.js';

export class TerritoryRepo extends Repo {
  async listForCompany() {
    const companyId = this.scopeCompany();
    return this.prisma.territory.findMany(/* companyId */ {
      where: { companyId },
      include: {
        _count: {
          select: {
            mrAssignments: { where: { companyId, unassignedAt: null } },
            territoryDoctors: { where: { companyId, unassignedAt: null } },
          },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async getDetail(territoryId: string) {
    const companyId = this.scopeCompany();
    const territory = await this.prisma.territory.findFirst(/* companyId */ {
      where: { companyId, id: territoryId },
    });
    if (!territory) {
      throw new AppError('not_found', 404, 'Territory not found.');
    }

    const [doctorLinks, mrAssignments] = await Promise.all([
      this.prisma.territoryDoctor.findMany(/* companyId */ {
        where: { companyId, territoryId, unassignedAt: null },
        include: {
          doctor: {
            select: {
              id: true,
              name: true,
              specialty: true,
              clinicName: true,
              isArchived: true,
              deletedAt: true,
            },
          },
        },
      }),
      this.prisma.mrTerritoryAssignment.findMany(/* companyId */ {
        where: { companyId, territoryId, unassignedAt: null },
        select: { mrId: true, assignedAt: true },
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
          })
        : [];

    return {
      territory,
      doctors: doctorLinks
        .filter((l) => !l.doctor.isArchived && l.doctor.deletedAt === null)
        .map((l) => l.doctor),
      mrs,
    };
  }

  async create(input: {
    code: string;
    name: string;
    description?: string | null;
    notes?: string | null;
  }) {
    const companyId = this.scopeCompany();
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
      },
    });

    return updated;
  }

  async addDoctor(territoryId: string, doctorId: string) {
    const companyId = this.scopeCompany();
    const territory = await this.prisma.territory.findFirst(/* companyId */ {
      where: { companyId, id: territoryId, isArchived: false },
    });
    if (!territory) {
      throw new AppError('not_found', 404, 'Territory not found.');
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
      await tx.mrTerritoryAssignment.updateMany(/* companyId */ {
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
