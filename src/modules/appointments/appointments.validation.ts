import { z } from 'zod';

// مخطط التحقق من بيانات إنشاء موعد جديد
export const createAppointmentSchema = z.object({
  patientId: z.string().min(1, 'معرف المريض مطلوب'),
  doctorId: z.string().min(1, 'معرف الطبيب مطلوب'),
  appointmentDate: z.string().datetime({ message: 'صيغة تاريخ الموعد غير صحيحة، يجب استخدام صيغة (ISO Format)' }),
  notes: z.string().optional(),
  type: z.enum(['CHECKUP', 'FOLLOW_UP', 'EMERGENCY', 'CONSULTATION'], {
    message: 'نوع الموعد غير مقبول، القيم المتاحة: معاينة، متابعة، طوارئ، استشارة',
  }).default('CHECKUP'),
});

// مخطط التحقق من تحديث حالة الموعد
export const updateAppointmentStatusSchema = z.object({
  status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'], {
    message: 'حالة الموعد غير صحيحة',
  }),
});

export type CreateAppointmentDTO = z.infer<typeof createAppointmentSchema>;
export type UpdateAppointmentStatusDTO = z.infer<typeof updateAppointmentStatusSchema>;