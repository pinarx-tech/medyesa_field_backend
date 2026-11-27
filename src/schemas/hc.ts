import { z } from 'zod';

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const uuidIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const territoryDoctorParamsSchema = z.object({
  id: z.string().uuid(),
  doctorId: z.string().uuid(),
});

export const hcDateQuerySchema = z.object({
  date: z.string().regex(isoDateRegex, 'date must be YYYY-MM-DD').optional(),
  tzOffsetMinutes: z.coerce.number().int().min(-720).max(840).default(330),
});

export const hcTerritoryListQuerySchema = z.object({
  includeArchived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .default(false),
});

export const clinicSearchQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
});

export const createClinicBodySchema = z.object({
  name: z.string().trim().min(2).max(120),
  formattedAddress: z.string().trim().min(5).max(250),
  landmark: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().max(24).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  accuracyMeters: z.number().min(0).max(5000).optional().nullable(),
  source: z.enum(['gps', 'search', 'manual']).default('manual'),
});

export const updateClinicBodySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    formattedAddress: z.string().trim().min(5).max(250).optional(),
    landmark: z.string().trim().max(120).optional().nullable(),
    phone: z.string().trim().max(24).optional().nullable(),
    latitude: z.number().min(-90).max(90).optional().nullable(),
    longitude: z.number().min(-180).max(180).optional().nullable(),
    accuracyMeters: z.number().min(0).max(5000).optional().nullable(),
    source: z.enum(['gps', 'search', 'manual']).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const updateDoctorLocationBodySchema = z.object({
  clinicName: z.string().trim().min(2).max(120).optional().nullable(),
  formattedAddress: z.string().trim().min(5).max(250).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  accuracyMeters: z.number().min(0).max(5000).optional().nullable(),
  source: z.enum(['gps', 'search', 'manual']).default('gps'),
});

export const createDoctorBodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  specialty: z.string().trim().min(2).max(60),
  clinicId: z.string().uuid().optional().nullable(),
  clinicName: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().max(24).optional().nullable(),
  email: z.string().trim().toLowerCase().email().optional().nullable(),
  geofenceRadiusMeters: z.number().int().min(25).max(5000).default(100),
  isCustom: z.boolean().default(true),
  territoryId: z.string().uuid().optional().nullable(),
});

export const onboardDoctorBodySchema = z.object({
  clientId: z.string().trim().min(1).max(128).optional(),
  doctor: z.object({
    name: z.string().trim().min(2).max(80),
    specialty: z.string().trim().min(2).max(60),
    phone: z.string().trim().max(24).optional().nullable(),
    email: z.string().trim().toLowerCase().email().optional().nullable(),
    geofenceRadiusMeters: z.number().int().min(25).max(5000).default(100),
  }),
  clinic: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('existing'),
      clinicId: z.string().uuid(),
    }),
    z.object({
      mode: z.literal('new'),
      name: z.string().trim().min(2).max(120),
      formattedAddress: z.string().trim().min(5).max(250),
      landmark: z.string().trim().max(120).optional().nullable(),
      phone: z.string().trim().max(24).optional().nullable(),
      latitude: z.number().min(-90).max(90).optional().nullable(),
      longitude: z.number().min(-180).max(180).optional().nullable(),
      accuracyMeters: z.number().min(0).max(5000).optional().nullable(),
      source: z.enum(['gps', 'search', 'manual']).default('manual'),
    }),
  ]),
  territory: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('existing'),
      territoryId: z.string().uuid(),
    }),
    z.object({
      mode: z.literal('new'),
      code: z
        .string()
        .trim()
        .toUpperCase()
        .regex(
          /^[A-Z0-9][A-Z0-9_-]{1,31}$/,
          'Code must be 2-32 uppercase alphanumeric characters',
        ),
      name: z.string().trim().min(2).max(60),
      description: z.string().trim().max(250).optional().nullable(),
      notes: z.string().trim().max(500).optional().nullable(),
    }),
  ]),
  assignMrId: z.string().uuid().optional().nullable(),
});

export const updateDoctorBodySchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    specialty: z.string().trim().min(2).max(60).optional(),
    clinicId: z.string().uuid().optional().nullable(),
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
    .regex(
      /^[A-Z0-9][A-Z0-9_-]{1,31}$/,
      'Code must be 2-32 alphanumeric characters',
    ),
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

export const hcActivityCategorySchema = z.enum([
  'employee_login',
  'start_day',
  'visit_completed',
  'visit_corrected',
  'end_day',
  'pending_visit',
]);

export const hcActivityQuerySchema = z.object({
  mrId: z.string().uuid().optional(),
  territoryId: z.string().uuid().optional(),
  category: hcActivityCategorySchema.optional(),
  date: z.string().regex(isoDateRegex, 'date must be YYYY-MM-DD').optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  tzOffsetMinutes: z.coerce.number().int().min(-720).max(840).default(330),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const reopenWorkdayBodySchema = z.object({
  reason: z.string().trim().min(5, 'Reason must be at least 5 characters').max(250),
  tzOffsetMinutes: z.coerce.number().int().min(-720).max(840).default(330),
});

export const correctVisitBodySchema = z.object({
  reason: z.string().trim().min(5, 'Reason must be at least 5 characters').max(250),
  status: z.enum(['completed', 'skipped']).default('completed'),
  noteText: z.string().max(500).optional().nullable(),
});

export const updateNotificationPrefsBodySchema = z
  .object({
    verifiedVisitNotificationsEnabled: z.boolean().optional(),
    overrideNotificationsEnabled: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one preference field must be provided',
  });
