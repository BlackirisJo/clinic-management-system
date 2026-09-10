import { z } from 'zod';

// مخطط التحقق من بيانات إنشاء موعد جديد
export const createAppointmentSchema = z.object({
  clinic_id: z.coerce.number().int().positive(),
  patient_id: z.coerce.number().int().positive(),
  doctor_id: z.coerce.number().int().positive(),
  appointment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ يجب أن تكون YYYY-MM-DD'),
    start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'صيغة وقت البداية غير صحيحة').optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'صيغة وقت النهاية غير صحيحة').optional(),
  reason: z.string().optional(),
  notes: z.string().optional(),
}).refine((data) => {
  // فقط فحص الترتيب إذا تم توفير كلا الوقتين
  if (data.start_time && data.end_time) {
    return data.end_time > data.start_time;
  }
  return !data.start_time && !data.end_time;
}, {
  message: 'يجب تقديم وقتَي البداية والنهاية معاً (أو تركهما معاً), على أن تكون النهاية بعد البداية',
  path: ['end_time'],
});

// مخطط التحقق من تحديث حالة الموعد
export const updateAppointmentStatusSchema = z.object({
  status: z.enum(['SCHEDULED', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'], {
    message: 'حالة الموعد غير صحيحة',
  }),
  cancellation_reason: z.string().optional(),
});

export type CreateAppointmentDTO = z.infer<typeof createAppointmentSchema>;
export type UpdateAppointmentStatusDTO = z.infer<typeof updateAppointmentStatusSchema>;