import { SubscriptionStatus } from '@prisma/client';
import { z } from 'zod';

export const companyIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const userIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const createCompanyBodySchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'Code must be 2–40 lowercase alphanumeric characters'),
  licensedMrSeats: z.number().int().min(0).max(10000).default(10),
  licensedHcSeats: z.number().int().min(0).max(1000).default(2),
});

export const updateCompanyBodySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    licensedMrSeats: z.number().int().min(0).max(10000).optional(),
    licensedHcSeats: z.number().int().min(0).max(1000).optional(),
    subscriptionStatus: z.nativeEnum(SubscriptionStatus).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const createUserBodySchema = z.object({
  companyId: z.number().int().positive(),
  employeeId: z.string().trim().min(3).max(32),
  email: z.string().trim().toLowerCase().email(),
  displayName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(20).optional().nullable(),
  role: z.enum(['headController', 'mr']),
  initialPassword: z.string().min(8).max(128),
});

export const updateUserBodySchema = z
  .object({
    displayName: z.string().trim().min(2).max(120).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    phone: z.string().trim().min(7).max(20).optional().nullable(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const adminResetPasswordBodySchema = z.object({
  newPassword: z.string().min(8).max(128),
});

export const listUsersQuerySchema = z.object({
  companyId: z.coerce.number().int().positive().optional(),
  role: z.enum(['platformAdmin', 'headController', 'mr']).optional(),
  status: z.enum(['active', 'deactivated', 'suspended']).optional(),
});
