import { z } from 'zod';

export const createPatientSchema = z.object({
  fullName: z.string().min(3, 'الاسم يجب أن يكون 3 أحرف على الأقل'),
  gender: z.enum(['MALE', 'FEMALE']),
  dateOfBirth: z.string().optional(),
  phone: z.string().min(7, 'رقم الهاتف غير صحيح'),
  email: z.string().email('البريد الإلكتروني غير صحيح').optional().or(z.literal('')),
  address: z.string().optional(),
  medicalHistory: z.string().optional(),
});

export const updatePatientSchema = createPatientSchema.partial();