import { z } from 'zod';

export const loginBodySchema = z.object({
  employeeIdOrEmail: z.string().trim().min(1, 'Employee ID or email is required'),
  password: z.string().min(1, 'Password is required'),
  companyCode: z.string().trim().min(1).optional(),
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const logoutBodySchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
  currentRefreshToken: z.string().min(1).optional(),
});

export const forgotPasswordBodySchema = z.object({
  email: z.string().trim().email('Valid email is required'),
});

export const resetPasswordBodySchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

// Dedicated login schema for the PINARX Platform Admin portal.
export const platformAdminLoginBodySchema = z.object({
  employeeIdOrEmail: z.string().trim().min(1, 'Email or employee ID is required'),
  password: z.string().min(1, 'Password is required'),
});
