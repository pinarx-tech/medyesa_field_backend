import { VisitVerificationStatus } from '@prisma/client';
import { z } from 'zod';

export const visitIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const startWorkdayBodySchema = z.object({
  clientId: z.string().trim().min(1).max(128),
  startedAt: z.string().datetime(),
});

export const endWorkdayBodySchema = z.object({
  clientId: z.string().trim().min(1).max(128),
  workDayClientId: z.string().trim().min(1).max(128),
  endedAt: z.string().datetime(),
  autoClosed: z.boolean().default(false),
});

export const createVisitBodySchema = z.object({
  clientId: z.string().trim().min(1).max(128),
  doctorId: z.string().uuid(),
  workDayId: z.string().uuid().optional().nullable(),
  status: z.string().trim().min(1).max(40).default('completed'),
  checkInLatitude: z.number().min(-90).max(90).optional().nullable(),
  checkInLongitude: z.number().min(-180).max(180).optional().nullable(),
  checkInAccuracyMeters: z.number().min(0).optional().nullable(),
  checkInDistanceMeters: z.number().min(0).optional().nullable(),
  checkInVerificationStatus: z
    .nativeEnum(VisitVerificationStatus)
    .default(VisitVerificationStatus.unverified),
  checkInOverrideReason: z.string().trim().max(300).optional().nullable(),
  checkInCapturedAt: z.string().datetime().optional().nullable(),
  checkOutAt: z.string().datetime().optional().nullable(),
  doctorClinicLocationIdAtCheckIn: z.string().uuid().optional().nullable(),
  territoryIdAtVisit: z.string().uuid().optional().nullable(),
  correctsVisitId: z.string().uuid().optional().nullable(),
  capturedAtClient: z.string().datetime(),
  noteText: z.string().max(500).optional().nullable(),
});

export const upsertVisitNoteBodySchema = z.object({
  noteText: z.string().max(500, 'Promotion Notes cannot exceed 500 characters'),
});

export const syncOperationItemSchema = z.object({
  clientId: z.string().trim().min(1).max(128),
  entityType: z.enum(['workDay', 'visit', 'visitNote']),
  entityId: z.string().trim().min(1).max(128),
  operation: z.enum(['start', 'end', 'create', 'upsert']),
  payload: z.record(z.unknown()),
  capturedAtClient: z.string().datetime(),
});

export const syncBatchBodySchema = z.object({
  operations: z.array(syncOperationItemSchema).min(1).max(100),
});
