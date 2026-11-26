import { Role } from '@prisma/client';
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
        where: { companyId, id: territoryId, isArchived: false },
      });
      if (!territory) {
        throw new AppError('not_found', 404, 'Territory not found.');
      }
      nextTerritoryName = territory.name;
    }

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
    });

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
        detailsJson: { after: nextTerritoryName ?? 'Not assigned' },
      },
    });

    return { mrId: mr.id, territoryId };
  }
}
