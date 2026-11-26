import { AppError } from '../lib/errors.js';
import { Repo } from '../lib/repo.js';

export class DoctorRepo extends Repo {
  async listForCompany() {
    const companyId = this.scopeCompany();
    return this.prisma.doctor.findMany(/* companyId */ {
      where: { companyId, deletedAt: null },
      include: {
        clinicLocations: {
          where: { companyId, isCurrent: true },
          take: 1,
        },
        territoryDoctors: {
          where: { companyId, unassignedAt: null },
          include: {
            territory: { select: { id: true, code: true, name: true } },
          },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async listForMrSelf() {
    const companyId = this.scopeCompany();
    const mrId = this.scopeSelf(this.ctx.userId);

    const assignments = await this.prisma.mrTerritoryAssignment.findMany(/* companyId */ {
      where: { companyId, mrId, unassignedAt: null },
      select: { territoryId: true },
    });
    const territoryIds = assignments.map((a) => a.territoryId);
    if (territoryIds.length === 0) {
      return [];
    }

    const links = await this.prisma.territoryDoctor.findMany(/* companyId */ {
      where: { companyId, territoryId: { in: territoryIds }, unassignedAt: null },
      select: { doctorId: true },
    });
    const doctorIds = [...new Set(links.map((l) => l.doctorId))];
    if (doctorIds.length === 0) {
      return [];
    }

    return this.prisma.doctor.findMany(/* companyId */ {
      where: { companyId, id: { in: doctorIds }, isArchived: false, deletedAt: null },
      include: {
        clinicLocations: {
          where: { companyId, isCurrent: true },
          take: 1,
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async create(input: {
    name: string;
    specialty: string;
    clinicName?: string | null;
    phone?: string | null;
    email?: string | null;
    geofenceRadiusMeters: number;
    isCustom: boolean;
    territoryId?: string | null;
  }) {
    const companyId = this.scopeCompany();

    if (input.territoryId) {
      const territory = await this.prisma.territory.findFirst(/* companyId */ {
        where: { companyId, id: input.territoryId, isArchived: false },
      });
      if (!territory) {
        throw new AppError('not_found', 404, 'Territory not found.');
      }
    }

    const doctor = await this.prisma.doctor.create({
      data: {
        companyId,
        name: input.name,
        specialty: input.specialty,
        clinicName: input.clinicName ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        geofenceRadiusMeters: input.geofenceRadiusMeters,
        isCustom: input.isCustom,
      },
    });

    if (input.territoryId) {
      await this.prisma.territoryDoctor.create({
        data: {
          companyId,
          territoryId: input.territoryId,
          doctorId: doctor.id,
          assignedByHeadControllerId: this.ctx.userId,
        },
      });
    }

    await this.prisma.activityLog.create({
      data: {
        companyId,
        actorId: this.ctx.userId,
        actorRole: this.ctx.role,
        actorDisplayName: this.ctx.displayName,
        actionType: 'doctor_created',
        subjectType: 'doctor',
        subjectId: doctor.id,
        subjectDisplayName: doctor.name,
        territoryId: input.territoryId ?? null,
      },
    });

    return doctor;
  }

  async update(
    doctorId: string,
    input: {
      name?: string;
      specialty?: string;
      clinicName?: string | null;
      phone?: string | null;
      email?: string | null;
      geofenceRadiusMeters?: number;
    },
  ) {
    const companyId = this.scopeCompany();
    const result = await this.prisma.doctor.updateMany(/* companyId */ {
      where: { companyId, id: doctorId, deletedAt: null },
      data: input,
    });
    if (result.count !== 1) {
      throw new AppError('not_found', 404, 'Doctor not found.');
    }

    const updated = await this.prisma.doctor.findFirst(/* companyId */ {
      where: { companyId, id: doctorId },
    });

    await this.prisma.activityLog.create({
      data: {
        companyId,
        actorId: this.ctx.userId,
        actorRole: this.ctx.role,
        actorDisplayName: this.ctx.displayName,
        actionType: 'doctor_edited',
        subjectType: 'doctor',
        subjectId: doctorId,
        subjectDisplayName: updated?.name ?? doctorId,
      },
    });

    return updated;
  }

  async archive(doctorId: string) {
    const companyId = this.scopeCompany();
    const result = await this.prisma.doctor.updateMany(/* companyId */ {
      where: { companyId, id: doctorId, deletedAt: null },
      data: { isArchived: true },
    });
    if (result.count !== 1) {
      throw new AppError('not_found', 404, 'Doctor not found.');
    }

    const updated = await this.prisma.doctor.findFirst(/* companyId */ {
      where: { companyId, id: doctorId },
    });

    await this.prisma.activityLog.create({
      data: {
        companyId,
        actorId: this.ctx.userId,
        actorRole: this.ctx.role,
        actorDisplayName: this.ctx.displayName,
        actionType: 'doctor_archived',
        subjectType: 'doctor',
        subjectId: doctorId,
        subjectDisplayName: updated?.name ?? doctorId,
      },
    });

    return updated;
  }
}
