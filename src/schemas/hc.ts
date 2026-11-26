import { z } from 'zod';

export const uuidIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const territoryDoctorParamsSchema = z.object({
  id: z.string().uuid(),
  doctorId: z.string().uuid(),
});

export const createDoctorBodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  specialty: z.string().trim().min(2).max(60),
  clinicName: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().max(24).optional().nullable(),
  email: z.string().trim().toLowerCase().email().optional().nullable(),
  geofenceRadiusMeters: z.number().int().min(25).max(5000).default(100),
  isCustom: z.boolean().default(true),
  territoryId: z.string().uuid().optional().nullable(),
});

export const updateDoctorBodySchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    specialty: z.string().trim().min(2).max(60).optional(),
    clinicName: z.string().trim().max(120).optional().nullable(),
    phone: z.string().trim().max(24).optional().nullable(),
    email: z.string().trim().toLowerCase().email().optional().nullable(),
    geofenceRadiusMeters: z.number().int().min(25).max(5000).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const createTerritoryBodySchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/, 'Code must be 2–32 alphanumeric characters'),
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(250).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

export const updateTerritoryBodySchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    description: z.string().trim().max(250).optional().nullable(),
    notes: z.string().trim().max(500).optional().nullable(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const assignDoctorToTerritoryBodySchema = z.object({
  doctorId: z.string().uuid(),
});

export const assignMrTerritoryBodySchema = z.object({
  territoryId: z.string().uuid().nullable(),
});

export const hcActivityQuerySchema = z.object({
  mrId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  type: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const updateNotificationPrefsBodySchema = z
  .object({
    verifiedVisitNotificationsEnabled: z.boolean().optional(),
    overrideNotificationsEnabled: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one preference field must be provided',
  });
