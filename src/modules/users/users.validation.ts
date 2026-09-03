import { z } from 'zod';

export const createUserSchema = z.object({
  full_name: z.string().trim().min(3).max(150),
  username: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9_.-]+$/),
  password: z.string().min(12).max(128),
  role_name: z.enum(['DOCTOR', 'ACCOUNTANT', 'RECEPTIONIST', 'SUPER_ADMIN']),
  clinic_id: z.coerce.number().int().positive().nullable().optional(),
  phone: z.string().max(20).optional(),
  medical_license_no: z.string().max(50).optional(),
  sub_specialty: z.string().max(200).optional(),
  direct_phone: z.string().max(20).optional(),
});

export const updateUserSchema = z.object({
  full_name: z.string().trim().min(3).max(150).optional(),
  password: z.string().min(12).max(128).optional(),
  role_name: z.enum(['DOCTOR', 'ACCOUNTANT', 'RECEPTIONIST', 'SUPER_ADMIN']).optional(),
  clinic_id: z.coerce.number().int().positive().nullable().optional(),
  phone: z.string().max(20).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'PASSWORD_RESET_REQUIRED']).optional(),
  is_force_password_change: z.boolean().optional(),
  medical_license_no: z.string().max(50).optional(),
  sub_specialty: z.string().max(200).optional(),
  direct_phone: z.string().max(20).optional(),
});