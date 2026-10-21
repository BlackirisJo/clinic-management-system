import { z } from 'zod';

// تحويل صريح بلا z.coerce.boolean (الذي يحوّل أي نص غير فارغ — بما فيه "false" — إلى true).
// مهم هنا: confirm_impact = true هو ما يسمح بتضييق نافذة العمل رغم وجود مواعيد قائمة،
// فتحويل "false" إلى true يعني تجاوز تأكيد الأثر بلا قصد.
const booleanFlag = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

export const createDoctorScheduleSchema = z.object({
  doctor_id: z.coerce.number().int().positive(),
  clinic_id: z.coerce.number().int().positive(),
  day_of_week: z.coerce.number().int().min(0).max(6),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'صيغة وقت البداية غير صحيحة (HH:MM)'),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'صيغة وقت النهاية غير صحيحة (HH:MM)'),
  is_working_day: z.boolean().optional().default(true),
}).refine((data) => {
  if (data.start_time && data.end_time) {
    return data.end_time > data.start_time;
  }
  return false;
}, {
  message: 'وقت النهاية يجب أن يكون بعد وقت البداية',
  path: ['end_time'],
});

export const updateDoctorScheduleSchema = z.object({
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'صيغة وقت البداية غير صحيحة (HH:MM)').optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'صيغة وقت النهاية غير صحيحة (HH:MM)').optional(),
  is_working_day: z.boolean().optional(),
  // تأكيد صريح عند تضييق نافذة العمل: المواعيد القائمة لا تُلغى، لكنها تتعارض.
  confirm_impact: booleanFlag.optional(),
}).refine((data) => {
  if (data.start_time && data.end_time) {
    return data.end_time > data.start_time;
  }
  return true;
}, {
  message: 'وقت النهاية يجب أن يكون بعد وقت البداية',
  path: ['end_time'],
});

export const doctorScheduleQuerySchema = z.object({
  doctor_id: z.coerce.number().int().positive().optional(),
  clinic_id: z.coerce.number().int().positive().optional(),
  day_of_week: z.coerce.number().int().min(0).max(6).optional(),
});

export const availabilityQuerySchema = z.object({
  doctor_id: z.coerce.number().int().positive(),
  clinic_id: z.coerce.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ يجب أن تكون YYYY-MM-DD'),
});

export type CreateDoctorScheduleDTO = z.infer<typeof createDoctorScheduleSchema>;
export type UpdateDoctorScheduleDTO = z.infer<typeof updateDoctorScheduleSchema>;
export type DoctorScheduleQueryDTO = z.infer<typeof doctorScheduleQuerySchema>;
export type AvailabilityQueryDTO = z.infer<typeof availabilityQuerySchema>;