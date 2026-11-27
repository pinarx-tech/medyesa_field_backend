import { AccountStatus, Prisma, Role, SyncStatus } from '@prisma/client';
import { writeAuditLog } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import { Repo } from '../lib/repo.js';
import { ClinicRepo, normalizeClinicName } from './clinicRepo.js';

export interface OnboardDoctorInput {
  clientId?: string;
  doctor: {
    name: string;
    specialty: string;
    phone?: string | null;
    email?: string | null;
    geofenceRadiusMeters: number;
  };
  clinic:
    | { mode: 'existing'; clinicId: string }
    | {
        mode: 'new';
        name: string;
        formattedAddress: string;
        landmark?: string | null;
        phone?: string | null;
        latitude?: number | null;
        longitude?: number | null;
        accuracyMeters?: number | null;
        source: 'gps' | 'search' | 'manual';
      };
  territory:
    | { mode: 'existing'; territoryId: string }
    | {
        mode: 'new';
        code: string;
        name: string;
        description?: string | null;
        notes?: string | null;
      };
  assignMrId?: string | null;
}

export class DoctorOnboardRepo extends Repo {
  async onboard(input: OnboardDoctorInput) {
    const companyId = this.scopeCompany();
    const classification = this.scopeClassification();

    const opKey = input.clientId ? `${companyId}:onboard:${input.clientId}` : null;
    if (opKey) {
      const existingOp = await this.prisma.syncOperation.findUnique({
        where: { id: opKey },
      });
      if (existingOp?.serverId) {
        const existingDoctor = await this.prisma.doctor.findFirst(/* companyId */ {
          where: { companyId, id: existingOp.serverId },
          include: { clinic: true },
        });
        if (existingDoctor) {
          return {
            doctor: existingDoctor,
            clinic: existingDoctor.clinic,
            deduplicated: true,
          };
        }
      }
    }

    const clinicHelper = new ClinicRepo(this.prisma, this.ctx);
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Resolve or create Clinic strictly inside companyId
      let clinic;
      let createdNewClinic = false;
      if (input.clinic.mode === 'existing') {
        clinic = await tx.clinic.findFirst({
          where: {
            companyId,
            id: input.clinic.clinicId,
            isArchived: false,
          },
        });
        if (!clinic) {
          throw new AppError('not_found', 404, 'Selected clinic not found.');
        }
      } else {
        const duplicate = await clinicHelper.findDuplicateInCompany(
          tx,
          companyId,
          input.clinic,
        );
        if (duplicate) {
          throw new AppError(
            'conflict',
            409,
            `Clinic "${duplicate.name}" already exists in your company. Select the existing clinic instead.`,
            undefined,
            {
              existingClinicId: duplicate.id,
              existingClinicName: duplicate.name,
              existingClinicAddress: duplicate.formattedAddress,
            },
          );
        }

        clinic = await tx.clinic.create({
          data: {
            companyId,
            name: input.clinic.name.trim(),
            normalizedName: normalizeClinicName(input.clinic.name),
            formattedAddress: input.clinic.formattedAddress.trim(),
            landmark: input.clinic.landmark?.trim() || null,
            phone: input.clinic.phone?.trim() || null,
            latitude: input.clinic.latitude ?? null,
            longitude: input.clinic.longitude ?? null,
            accuracyMeters: input.clinic.accuracyMeters ?? null,
            source: input.clinic.source,
            dataClassification: classification,
          },
        });
        createdNewClinic = true;
      }

      // 2. Resolve or create Territory strictly inside companyId
      let territory;
      let createdNewTerritory = false;
      if (input.territory.mode === 'existing') {
        territory = await tx.territory.findFirst(/* companyId */ {
          where: { companyId, id: input.territory.territoryId },
        });
        if (!territory) {
          throw new AppError('not_found', 404, 'Selected territory not found.');
        }
        if (territory.isArchived) {
          throw new AppError(
            'business_rule_violation',
            422,
            'Cannot assign a doctor to an archived territory.',
          );
        }
      } else {
        const dupTer = await tx.territory.findFirst(/* companyId */ {
          where: { companyId, code: input.territory.code },
        });
        if (dupTer) {
          throw new AppError(
            'conflict',
            409,
            `Territory code "${input.territory.code}" already exists in your company.`,
          );
        }
        territory = await tx.territory.create({
          data: {
            companyId,
            code: input.territory.code,
            name: input.territory.name.trim(),
            description: input.territory.description?.trim() || null,
            notes: input.territory.notes?.trim() || null,
            createdByHeadControllerId: this.ctx.userId,
            dataClassification: classification,
          },
        });
        createdNewTerritory = true;
      }

      // 3. Create Doctor + current DoctorClinicLocation + TerritoryDoctor link
      const doctor = await tx.doctor.create({
        data: {
          companyId,
          clinicId: clinic.id,
          name: input.doctor.name.trim(),
          specialty: input.doctor.specialty.trim(),
          clinicName: clinic.name,
          phone: input.doctor.phone?.trim() || null,
          email: input.doctor.email?.trim().toLowerCase() || null,
          geofenceRadiusMeters: input.doctor.geofenceRadiusMeters,
          isCustom: true,
          dataClassification: classification,
        },
      });

      const clinicLocation = await tx.doctorClinicLocation.create({
        data: {
          companyId,
          doctorId: doctor.id,
          clinicName: clinic.name,
          formattedAddress: clinic.formattedAddress,
          latitude: clinic.latitude,
          longitude: clinic.longitude,
          accuracyMeters: clinic.accuracyMeters,
          source: clinic.source,
          status:
            clinic.latitude != null && clinic.longitude != null
              ? 'complete'
              : 'pending',
          isCurrent: true,
          capturedByUserId: this.ctx.userId,
        },
      });

      await tx.territoryDoctor.create({
        data: {
          companyId,
          territoryId: territory.id,
          doctorId: doctor.id,
          assignedAt: now,
          assignedByHeadControllerId: this.ctx.userId,
        },
      });

      // 4. Optional MR Territory Assignment (strictly company-scoped active MR)
      let mrAssignment: {
        mrId: string;
        mrName: string;
        previousTerritoryId: string | null;
        previousTerritoryName: string | null;
        territoryId: string;
      } | null = null;

      if (input.assignMrId) {
        const mr = await tx.user.findFirst({
          where: {
            companyId,
            id: input.assignMrId,
            role: Role.mr,
            accountStatus: AccountStatus.active,
            deletedAt: null,
          },
        });
        if (!mr) {
          throw new AppError(
            'not_found',
            404,
            'Selected MR was not found in your company.',
          );
        }

        const prevAssignment = await tx.mrTerritoryAssignment.findFirst(/* companyId */ {
          where: { companyId, mrId: mr.id, unassignedAt: null },
          include: { territory: { select: { id: true, name: true } } },
        });

        await tx.mrTerritoryAssignment.updateMany(/* companyId */ {
          where: { companyId, mrId: mr.id, unassignedAt: null },
          data: { unassignedAt: now },
        });

        await tx.mrTerritoryAssignment.create({
          data: {
            companyId,
            mrId: mr.id,
            territoryId: territory.id,
            assignedAt: now,
            assignedByHeadControllerId: this.ctx.userId,
          },
        });

        mrAssignment = {
          mrId: mr.id,
          mrName: mr.displayName,
          previousTerritoryId: prevAssignment?.territoryId ?? null,
          previousTerritoryName: prevAssignment?.territory.name ?? null,
          territoryId: territory.id,
        };

        await tx.activityLog.create({
          data: {
            companyId,
            actorId: this.ctx.userId,
            actorRole: this.ctx.role,
            actorDisplayName: this.ctx.displayName,
            actionType: 'territory_assigned',
            subjectType: 'mr',
            subjectId: mr.id,
            subjectDisplayName: mr.displayName,
            territoryId: territory.id,
            dataClassification: classification,
            detailsJson: {
              beforeTerritoryId: prevAssignment?.territoryId ?? null,
              beforeTerritoryName:
                prevAssignment?.territory.name ?? 'Not assigned',
              afterTerritoryId: territory.id,
              afterTerritoryName: territory.name,
            },
          },
        });
      }

      // 5. Activity log entries for doctor/clinic/territory creation (batched)
      const activityRows: Prisma.ActivityLogCreateManyInput[] = [];
      if (createdNewClinic) {
        activityRows.push({
          companyId,
          actorId: this.ctx.userId,
          actorRole: this.ctx.role,
          actorDisplayName: this.ctx.displayName,
          actionType: 'clinic_created',
          subjectType: 'clinic',
          subjectId: clinic.id,
          subjectDisplayName: clinic.name,
          dataClassification: classification,
        });
      }

      if (createdNewTerritory) {
        activityRows.push({
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
        });
      }

      activityRows.push({
        companyId,
        actorId: this.ctx.userId,
        actorRole: this.ctx.role,
        actorDisplayName: this.ctx.displayName,
        actionType: 'doctor_created',
        subjectType: 'doctor',
        subjectId: doctor.id,
        subjectDisplayName: doctor.name,
        territoryId: territory.id,
        dataClassification: classification,
        detailsJson: {
          clinicId: clinic.id,
          clinicName: clinic.name,
          territoryName: territory.name,
        },
      });

      await tx.activityLog.createMany({ data: activityRows });

      if (opKey) {
        await tx.syncOperation.create({
          data: {
            id: opKey,
            companyId,
            actorId: this.ctx.userId,
            entityType: 'doctor_onboard',
            entityId: input.clientId!,
            operation: 'create',
            payload: input as unknown as Prisma.InputJsonValue,
            status: SyncStatus.synced,
            attempts: 1,
            serverId: doctor.id,
            processedAt: now,
          },
        });
      }

      return {
        doctor,
        clinic,
        clinicLocation,
        territory,
        mrAssignment,
        deduplicated: false,
      };
    },
    { maxWait: 10_000, timeout: 20_000 });

    await writeAuditLog(this.prisma, {
      companyId,
      actorId: this.ctx.userId,
      action: 'doctor_onboarded',
      targetType: 'doctor',
      targetId: result.doctor.id,
      metadata: {
        clinicId: result.clinic.id,
        territoryId: result.territory.id,
        assignedMrId: result.mrAssignment?.mrId ?? null,
      },
      ipAddress: this.ctx.ipAddress,
    });

    return result;
  }
}
