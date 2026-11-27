import { writeAuditLog } from '../lib/audit.js';
import {
  isValidCoordinatePair,
  resolveDoctorClinicLocation,
} from '../lib/clinicLocation.js';
import { AppError } from '../lib/errors.js';
import { Repo } from '../lib/repo.js';

export class DoctorRepo extends Repo {
  async listForCompany() {
    const companyId = this.scopeCompany();
    const classification = this.scopeClassification();
    const rows = await this.prisma.doctor.findMany(/* companyId */ {
      where: {
        companyId,
        deletedAt: null,
        dataClassification: classification,
      },
      include: {
        clinic: true,
        clinicLocations: {
          where: { companyId, isCurrent: true },
          take: 1,
        },
        territoryDoctors: {
          where: {
            companyId,
            unassignedAt: null,
            territory: { companyId, isArchived: false },
          },
          include: {
            territory: {
              select: { id: true, code: true, name: true, isArchived: true },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    return rows.map((row) => ({
      ...row,
      clinicLocation: resolveDoctorClinicLocation(row),
    }));
  }

  async getDetailForCompany(doctorId: string) {
    const companyId = this.scopeCompany();
    const row = await this.prisma.doctor.findFirst(/* companyId */ {
      where: { companyId, id: doctorId, deletedAt: null },
      include: {
        clinic: true,
        clinicLocations: {
          where: { companyId, isCurrent: true },
          orderBy: { capturedAt: 'desc' },
          take: 1,
        },
        territoryDoctors: {
          where: {
            companyId,
            unassignedAt: null,
            territory: { companyId, isArchived: false },
          },
          include: {
            territory: {
              select: { id: true, code: true, name: true, isArchived: true },
            },
          },
        },
      },
    });
    if (!row) {
      throw new AppError('not_found', 404, 'Doctor not found.');
    }

    let capturedByDisplayName: string | null = null;
    const latestLoc = row.clinicLocations[0] ?? null;
    if (latestLoc?.capturedByUserId) {
      const capturer = await this.prisma.user.findFirst({
        where: { companyId, id: latestLoc.capturedByUserId },
        select: { displayName: true },
      });
      capturedByDisplayName = capturer?.displayName ?? null;
    }

    return {
      ...row,
      capturedByDisplayName,
      clinicLocation: resolveDoctorClinicLocation(row),
    };
  }

  /**
   * Returns complete hydration context for the signed-in MR:
   * company metadata, active non-archived territory, and every active doctor
   * in that territory with normalized `clinicLocation`.
   */
  async listForMrSelfWithContext() {
    const companyId = this.scopeCompany();
    const mrId = this.scopeSelf(this.ctx.userId);
    const classification = this.scopeClassification();

    const activeAssignment = await this.prisma.mrTerritoryAssignment.findFirst(/* companyId */ {
      where: {
        companyId,
        mrId,
        unassignedAt: null,
        territory: {
          companyId,
          isArchived: false,
          dataClassification: classification,
        },
      },
      include: {
        territory: {
          select: {
            id: true,
            code: true,
            name: true,
            description: true,
            notes: true,
            isArchived: true,
            createdByHeadControllerId: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { assignedAt: 'desc' },
    });

    const companyInfo = {
      id: companyId,
      name: this.ctx.companyName ?? 'Company',
      code: this.ctx.companyCode ?? `company_${companyId}`,
    };

    if (!activeAssignment) {
      return {
        company: companyInfo,
        territory: null,
        activeTerritory: null,
        assignment: null,
        doctors: [],
      };
    }

    const territoryId = activeAssignment.territory.id;
    const links = await this.prisma.territoryDoctor.findMany(/* companyId */ {
      where: {
        companyId,
        territoryId,
        unassignedAt: null,
        territory: { companyId, isArchived: false },
        doctor: {
          companyId,
          isArchived: false,
          deletedAt: null,
          dataClassification: classification,
        },
      },
      include: {
        doctor: {
          include: {
            clinic: true,
            clinicLocations: {
              where: { companyId, isCurrent: true },
              take: 1,
            },
          },
        },
      },
      orderBy: { doctor: { name: 'asc' } },
    });

    const seen = new Set<string>();
    const doctors = [];
    for (const link of links) {
      const d = link.doctor;
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const loc = resolveDoctorClinicLocation(d);
      doctors.push({
        id: d.id,
        companyId: d.companyId,
        clinicId: d.clinicId,
        name: d.name,
        specialty: d.specialty,
        clinicName: loc.clinicName ?? d.clinicName ?? '',
        clinicAddress: loc.formattedAddress ?? '',
        landmark: loc.landmark,
        clinicPhone: loc.phone,
        phone: d.phone,
        email: d.email,
        latitude: loc.latitude,
        longitude: loc.longitude,
        geofenceRadiusMeters: d.geofenceRadiusMeters,
        isCustom: d.isCustom,
        isArchived: d.isArchived,
        updatedAt: d.updatedAt.toISOString(),
        territoryId,
        clinicLocation: loc,
        clinic: d.clinic,
        clinicLocations: d.clinicLocations,
      });
    }

    const activeTerritory = {
      id: activeAssignment.territory.id,
      code: activeAssignment.territory.code,
      name: activeAssignment.territory.name,
      description: activeAssignment.territory.description,
      notes: activeAssignment.territory.notes,
      isArchived: activeAssignment.territory.isArchived,
      createdByHeadControllerId:
        activeAssignment.territory.createdByHeadControllerId,
      createdAt: activeAssignment.territory.createdAt.toISOString(),
      updatedAt: activeAssignment.territory.updatedAt.toISOString(),
      assignedAt: activeAssignment.assignedAt.toISOString(),
      assignedByHeadControllerId: activeAssignment.assignedByHeadControllerId,
    };

    return {
      company: companyInfo,
      territory: activeTerritory,
      activeTerritory,
      assignment: {
        id: activeAssignment.id,
        mrId: activeAssignment.mrId,
        territoryId: activeAssignment.territoryId,
        assignedAt: activeAssignment.assignedAt.toISOString(),
        assignedByHeadControllerId: activeAssignment.assignedByHeadControllerId,
      },
      doctors,
    };
  }

  async listForMrSelf() {
    const { doctors } = await this.listForMrSelfWithContext();
    return doctors;
  }

  async create(input: {
    name: string;
    specialty: string;
    clinicId?: string | null;
    clinicName?: string | null;
    phone?: string | null;
    email?: string | null;
    geofenceRadiusMeters: number;
    isCustom: boolean;
    territoryId?: string | null;
  }) {
    const companyId = this.scopeCompany();
    const classification = this.scopeClassification();

    if (input.territoryId) {
      const territory = await this.prisma.territory.findFirst(/* companyId */ {
        where: { companyId, id: input.territoryId, isArchived: false },
      });
      if (!territory) {
        throw new AppError('not_found', 404, 'Territory not found.');
      }
    }

    let linkedClinic = null;
    if (input.clinicId) {
      linkedClinic = await this.prisma.clinic.findFirst({
        where: { companyId, id: input.clinicId, isArchived: false },
      });
      if (!linkedClinic) {
        throw new AppError('not_found', 404, 'Clinic not found.');
      }
    }

    const doctor = await this.prisma.doctor.create({
      data: {
        companyId,
        clinicId: linkedClinic?.id ?? null,
        name: input.name,
        specialty: input.specialty,
        clinicName: linkedClinic?.name ?? input.clinicName ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        geofenceRadiusMeters: input.geofenceRadiusMeters,
        isCustom: input.isCustom,
        dataClassification: classification,
      },
    });

    if (linkedClinic) {
      await this.prisma.doctorClinicLocation.create({
        data: {
          companyId,
          doctorId: doctor.id,
          clinicName: linkedClinic.name,
          formattedAddress: linkedClinic.formattedAddress,
          latitude: linkedClinic.latitude,
          longitude: linkedClinic.longitude,
          accuracyMeters: linkedClinic.accuracyMeters,
          source: linkedClinic.source,
          status: isValidCoordinatePair(
            linkedClinic.latitude,
            linkedClinic.longitude,
          )
            ? 'complete'
            : 'pending',
          isCurrent: true,
          capturedByUserId: this.ctx.userId,
        },
      });
    }

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
        dataClassification: classification,
      },
    });

    return this.getDetailForCompany(doctor.id);
  }

  async update(
    doctorId: string,
    input: {
      name?: string;
      specialty?: string;
      clinicId?: string | null;
      clinicName?: string | null;
      phone?: string | null;
      email?: string | null;
      geofenceRadiusMeters?: number;
    },
  ) {
    const companyId = this.scopeCompany();
    if (input.clinicId) {
      const clinic = await this.prisma.clinic.findFirst({
        where: { companyId, id: input.clinicId, isArchived: false },
      });
      if (!clinic) {
        throw new AppError('not_found', 404, 'Clinic not found.');
      }
    }
    const result = await this.prisma.doctor.updateMany(/* companyId */ {
      where: { companyId, id: doctorId, deletedAt: null },
      data: input,
    });
    if (result.count !== 1) {
      throw new AppError('not_found', 404, 'Doctor not found.');
    }

    const updated = await this.getDetailForCompany(doctorId);

    await this.prisma.activityLog.create({
      data: {
        companyId,
        actorId: this.ctx.userId,
        actorRole: this.ctx.role,
        actorDisplayName: this.ctx.displayName,
        actionType: 'doctor_edited',
        subjectType: 'doctor',
        subjectId: doctorId,
        subjectDisplayName: updated.name,
        dataClassification: this.scopeClassification(),
      },
    });

    return updated;
  }

  /**
   * Updates a doctor's clinic location by creating a NEW versioned
   * `DoctorClinicLocation` (`isCurrent = true`) and syncing linked `Clinic`
   * coordinates if present. Never rewrites historical `Visit` rows.
   */
  async updateLocationForCompany(
    doctorId: string,
    input: {
      clinicName?: string | null;
      formattedAddress?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      accuracyMeters?: number | null;
      source: 'gps' | 'search' | 'manual';
    },
  ) {
    const companyId = this.scopeCompany();
    const hasCoords = isValidCoordinatePair(input.latitude, input.longitude);

    await this.prisma.$transaction(async (tx) => {
      const doctor = await tx.doctor.findFirst({
        where: { companyId, id: doctorId, deletedAt: null },
        include: { clinic: true },
      });
      if (!doctor) {
        throw new AppError('not_found', 404, 'Doctor not found.');
      }

      const nextClinicName =
        input.clinicName?.trim() ||
        doctor.clinic?.name ||
        doctor.clinicName ||
        null;
      const nextAddress =
        input.formattedAddress?.trim() ||
        doctor.clinic?.formattedAddress ||
        null;

      await tx.doctorClinicLocation.updateMany({
        where: { companyId, doctorId, isCurrent: true },
        data: { isCurrent: false },
      });

      await tx.doctorClinicLocation.create({
        data: {
          companyId,
          doctorId,
          clinicName: nextClinicName,
          formattedAddress: nextAddress,
          latitude: hasCoords ? input.latitude! : null,
          longitude: hasCoords ? input.longitude! : null,
          accuracyMeters: hasCoords ? (input.accuracyMeters ?? null) : null,
          source: input.source,
          status: hasCoords ? 'complete' : 'pending',
          isCurrent: true,
          capturedByUserId: this.ctx.userId,
        },
      });

      if (nextClinicName && nextClinicName !== doctor.clinicName) {
        await tx.doctor.updateMany({
          where: { companyId, id: doctorId },
          data: { clinicName: nextClinicName },
        });
      }

      if (doctor.clinicId && (hasCoords || nextAddress)) {
        await tx.clinic.updateMany({
          where: { companyId, id: doctor.clinicId },
          data: {
            ...(nextAddress ? { formattedAddress: nextAddress } : {}),
            ...(hasCoords
              ? {
                  latitude: input.latitude!,
                  longitude: input.longitude!,
                  accuracyMeters: input.accuracyMeters ?? null,
                  source: input.source,
                }
              : {}),
          },
        });
      }
    });

    await writeAuditLog(this.prisma, {
      companyId,
      actorId: this.ctx.userId,
      action: 'doctor_location_updated',
      targetType: 'doctor',
      targetId: doctorId,
      metadata: {
        hasValidCoordinates: hasCoords,
        source: input.source,
      },
      ipAddress: this.ctx.ipAddress,
    });

    return this.getDetailForCompany(doctorId);
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

    const updated = await this.getDetailForCompany(doctorId);

    await this.prisma.activityLog.create({
      data: {
        companyId,
        actorId: this.ctx.userId,
        actorRole: this.ctx.role,
        actorDisplayName: this.ctx.displayName,
        actionType: 'doctor_archived',
        subjectType: 'doctor',
        subjectId: doctorId,
        subjectDisplayName: updated.name,
        dataClassification: this.scopeClassification(),
      },
    });

    return updated;
  }
}
