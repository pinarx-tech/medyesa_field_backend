import { Prisma } from '@prisma/client';
import { writeAuditLog } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';
import { Repo } from '../lib/repo.js';

export function normalizeClinicName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeAddress(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const r = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export class ClinicRepo extends Repo {
  async listForCompany(query?: string) {
    const companyId = this.scopeCompany();
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { dataClassification: true },
    });
    if (!company) {
      throw new AppError('not_found', 404, 'Company not found.');
    }

    const q = query?.trim();
    const clinics = await this.prisma.clinic.findMany({
      where: {
        companyId,
        isArchived: false,
        dataClassification: company.dataClassification,
        ...(q && q.length > 0
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { formattedAddress: { contains: q, mode: 'insensitive' } },
                { landmark: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        _count: {
          select: {
            doctors: {
              where: { companyId, isArchived: false, deletedAt: null },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
      take: 100,
    });

    return clinics.map((c) => ({
      id: c.id,
      name: c.name,
      formattedAddress: c.formattedAddress,
      landmark: c.landmark,
      phone: c.phone,
      latitude: c.latitude,
      longitude: c.longitude,
      accuracyMeters: c.accuracyMeters,
      source: c.source,
      doctorCount: c._count.doctors,
      updatedAt: c.updatedAt.toISOString(),
    }));
  }

  async findDuplicateInCompany(
    tx: Prisma.TransactionClient,
    companyId: number,
    input: {
      name: string;
      formattedAddress: string;
      latitude?: number | null;
      longitude?: number | null;
      excludeClinicId?: string;
    },
  ) {
    const normalized = normalizeClinicName(input.name);
    const normAddr = normalizeAddress(input.formattedAddress);
    const candidates = await tx.clinic.findMany({
      where: {
        companyId,
        normalizedName: normalized,
        isArchived: false,
        ...(input.excludeClinicId
          ? { id: { not: input.excludeClinicId } }
          : {}),
      },
    });

    for (const candidate of candidates) {
      if (normalizeAddress(candidate.formattedAddress) === normAddr) {
        return candidate;
      }
      if (
        input.latitude != null &&
        input.longitude != null &&
        candidate.latitude != null &&
        candidate.longitude != null
      ) {
        const dist = haversineMeters(
          input.latitude,
          input.longitude,
          candidate.latitude,
          candidate.longitude,
        );
        if (dist <= 50) {
          return candidate;
        }
      }
    }
    return null;
  }

  async create(input: {
    name: string;
    formattedAddress: string;
    landmark?: string | null;
    phone?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    accuracyMeters?: number | null;
    source: 'gps' | 'search' | 'manual';
  }) {
    const companyId = this.scopeCompany();
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { dataClassification: true },
    });
    if (!company) {
      throw new AppError('not_found', 404, 'Company not found.');
    }

    const clinic = await this.prisma.$transaction(async (tx) => {
      const duplicate = await this.findDuplicateInCompany(tx, companyId, input);
      if (duplicate) {
        throw new AppError(
          'conflict',
          409,
          `Clinic "${duplicate.name}" already exists at this location in your company.`,
          undefined,
          {
            existingClinicId: duplicate.id,
            existingClinicName: duplicate.name,
            existingClinicAddress: duplicate.formattedAddress,
          },
        );
      }

      const created = await tx.clinic.create({
        data: {
          companyId,
          name: input.name.trim(),
          normalizedName: normalizeClinicName(input.name),
          formattedAddress: input.formattedAddress.trim(),
          landmark: input.landmark?.trim() || null,
          phone: input.phone?.trim() || null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          accuracyMeters: input.accuracyMeters ?? null,
          source: input.source,
          dataClassification: company.dataClassification,
        },
      });

      await tx.activityLog.create({
        data: {
          companyId,
          actorId: this.ctx.userId,
          actorRole: this.ctx.role,
          actorDisplayName: this.ctx.displayName,
          actionType: 'clinic_created',
          subjectType: 'clinic',
          subjectId: created.id,
          subjectDisplayName: created.name,
          dataClassification: company.dataClassification,
        },
      });

      return created;
    }, { maxWait: 10_000, timeout: 20_000 });

    await writeAuditLog(this.prisma, {
      companyId,
      actorId: this.ctx.userId,
      action: 'clinic_created',
      targetType: 'clinic',
      targetId: clinic.id,
      metadata: {
        name: clinic.name,
        formattedAddress: clinic.formattedAddress,
        hasCoordinates: clinic.latitude != null && clinic.longitude != null,
      },
      ipAddress: this.ctx.ipAddress,
    });

    return clinic;
  }

  /**
   * Edits clinic details and creates a NEW versioned `DoctorClinicLocation`
   * (`isCurrent = true`) for linked doctors whenever name/address/coordinates
   * change. Historical `DoctorClinicLocation` snapshots and `Visit` rows are
   * NEVER modified.
   */
  async update(
    clinicId: string,
    input: {
      name?: string;
      formattedAddress?: string;
      landmark?: string | null;
      phone?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      accuracyMeters?: number | null;
      source?: 'gps' | 'search' | 'manual';
    },
  ) {
    const companyId = this.scopeCompany();

    const { before, after } = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.clinic.findFirst({
        where: { companyId, id: clinicId, isArchived: false },
      });
      if (!existing) {
        throw new AppError('not_found', 404, 'Clinic not found.');
      }

      const nextName = input.name?.trim() ?? existing.name;
      const nextAddress =
        input.formattedAddress?.trim() ?? existing.formattedAddress;
      const nextLat =
        input.latitude !== undefined ? input.latitude : existing.latitude;
      const nextLng =
        input.longitude !== undefined ? input.longitude : existing.longitude;
      const nextAcc =
        input.accuracyMeters !== undefined
          ? input.accuracyMeters
          : existing.accuracyMeters;
      const nextSource = input.source ?? existing.source;

      const duplicate = await this.findDuplicateInCompany(tx, companyId, {
        name: nextName,
        formattedAddress: nextAddress,
        latitude: nextLat,
        longitude: nextLng,
        excludeClinicId: clinicId,
      });
      if (duplicate) {
        throw new AppError(
          'conflict',
          409,
          `Another clinic named "${duplicate.name}" already exists at this location.`,
          undefined,
          { existingClinicId: duplicate.id },
        );
      }

      const updated = await tx.clinic.update({
        where: { id: clinicId },
        data: {
          name: nextName,
          normalizedName: normalizeClinicName(nextName),
          formattedAddress: nextAddress,
          ...(input.landmark !== undefined
            ? { landmark: input.landmark?.trim() || null }
            : {}),
          ...(input.phone !== undefined
            ? { phone: input.phone?.trim() || null }
            : {}),
          latitude: nextLat,
          longitude: nextLng,
          accuracyMeters: nextAcc,
          source: nextSource,
        },
      });

      const locationChanged =
        nextName !== existing.name ||
        nextAddress !== existing.formattedAddress ||
        nextLat !== existing.latitude ||
        nextLng !== existing.longitude;

      if (locationChanged) {
        const linkedDoctors = await tx.doctor.findMany(/* companyId */ {
          where: { companyId, clinicId, deletedAt: null },
          select: { id: true },
        });

        for (const doc of linkedDoctors) {
          await tx.doctor.updateMany(/* companyId */ {
            where: { companyId, id: doc.id },
            data: { clinicName: nextName },
          });

          // Mark previous current location inactive; keep historical row intact.
          await tx.doctorClinicLocation.updateMany(/* companyId */ {
            where: { companyId, doctorId: doc.id, isCurrent: true },
            data: { isCurrent: false },
          });

          await tx.doctorClinicLocation.create({
            data: {
              companyId,
              doctorId: doc.id,
              clinicName: nextName,
              formattedAddress: nextAddress,
              latitude: nextLat,
              longitude: nextLng,
              accuracyMeters: nextAcc,
              source: nextSource,
              status:
                nextLat != null && nextLng != null ? 'complete' : 'pending',
              isCurrent: true,
              capturedByUserId: this.ctx.userId,
            },
          });
        }
      }

      return { before: existing, after: updated };
    }, { maxWait: 10_000, timeout: 20_000 });

    await writeAuditLog(this.prisma, {
      companyId,
      actorId: this.ctx.userId,
      action: 'clinic_updated',
      targetType: 'clinic',
      targetId: clinicId,
      metadata: {
        before: {
          name: before.name,
          formattedAddress: before.formattedAddress,
          latitude: before.latitude,
          longitude: before.longitude,
        },
        after: {
          name: after.name,
          formattedAddress: after.formattedAddress,
          latitude: after.latitude,
          longitude: after.longitude,
        },
      },
      ipAddress: this.ctx.ipAddress,
    });

    return after;
  }
}
