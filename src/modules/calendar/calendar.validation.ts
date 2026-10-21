import { z } from 'zod';
import { isValidIsoDate, isValidTimeString } from '../../utils/calendarTime';

const isoDate = z
  .string()
  .refine((value) => isValidIsoDate(value), { message: 'صيغة التاريخ يجب أن تكون YYYY-MM-DD' });

const optionalTime = z
  .string()
  .refine((value) => isValidTimeString(value), { message: 'صيغة الوقت يجب أن تكون HH:MM' })
  .optional();

const holidayType = z.enum(['OFFICIAL', 'EMERGENCY', 'MAINTENANCE']);
const leaveType = z.enum(['ANNUAL', 'SICK', 'UNPAID', 'OTHER']);

// تحويل صريح بلا z.coerce.boolean (الذي يحوّل أي نص غير فارغ — بما فيه "false" — إلى true).
// confirm_impact = true هو ما يسمح بتغيير تقويمي trotz وجود مواعيد قائمة،
// فتحويل "false" إلى true يعني تجاوز تأكيد الأثر بلا قصد.
const booleanFlag = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

// ————— تقويم العطل الرسمية —————

export const listHolidaysQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  clinic_id: z.coerce.number().int().positive().optional(),
  include_cancelled: booleanFlag.optional(),
});

export const createHolidaySchema = z.object({
  holiday_date: isoDate,
  // clinic_id = null يعني عطلة وطنية (كل العيادات)
  clinic_id: z.coerce.number().int().positive().nullable().optional(),
  name_ar: z.string().trim().min(2).max(150),
  name_en: z.string().trim().max(150).optional(),
  holiday_type: holidayType.optional(),
});

export const updateHolidaySchema = z
  .object({
    holiday_date: isoDate.optional(),
    name_ar: z.string().trim().min(2).max(150).optional(),
    name_en: z.string().trim().max(150).optional(),
    holiday_type: holidayType.optional(),
    // تأكيد صريح لأثر التغيير على المواعيد القائمة
    confirm_impact: booleanFlag.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'لا توجد بيانات للتحديث' });

export const cancelHolidaySchema = z.object({
  reason: z.string().trim().min(2).max(500),
});

export const impactQuerySchema = z.object({
  date: isoDate,
  to_date: isoDate.optional(),
  clinic_id: z.coerce.number().int().positive().optional(),
});

// معاينة أثر عطلة بعينها: التاريخ المرجع هو تاريخ العطلة نفسها (يُقرأ من
// القاعدة)، و to_date اختياري للمقارنة بين تاريخين. هنا absence التاريخ
// ليس خطأ — بخلاف /api/calendar/impact الذي لا مرجع له إلا التاريخ المطلوب.
export const holidayImpactQuerySchema = z.object({
  date: isoDate.optional(),
  to_date: isoDate.optional(),
  clinic_id: z.coerce.number().int().positive().optional(),
});

// ————— إجازات الأطباء —————

export const listLeaveQuerySchema = z.object({
  doctor_id: z.coerce.number().int().positive().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
});

export const createLeaveSchema = z
  .object({
    doctor_id: z.coerce.number().int().positive(),
    clinic_id: z.coerce.number().int().positive(),
    start_date: isoDate,
    end_date: isoDate,
    leave_type: leaveType.optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((data) => data.end_date >= data.start_date, {
    message: 'تاريخ نهاية الإجازة يجب أن يكون بعد تاريخ البداية',
    path: ['end_date'],
  });

export const decideLeaveSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'CANCELLED']),
  reason: z.string().trim().max(500).optional(),
});

// ————— استثناءات العمل —————

export const listExceptionsQuerySchema = z.object({
  doctor_id: z.coerce.number().int().positive().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
});

export const createExceptionSchema = z
  .object({
    doctor_id: z.coerce.number().int().positive(),
    clinic_id: z.coerce.number().int().positive(),
    exception_date: isoDate,
    holiday_id: z.coerce.number().int().positive().optional(),
    start_time: optionalTime,
    end_time: optionalTime,
    reason: z.string().trim().min(2).max(500),
  })
  .refine((data) => Boolean(data.start_time) === Boolean(data.end_time), {
    message: 'يجب تقديم وقتَي البداية والنهاية معاً، أو تركهما معاً',
    path: ['end_time'],
  })
  .refine((data) => !data.start_time || !data.end_time || data.end_time > data.start_time, {
    message: 'وقت النهاية يجب أن يكون بعد وقت البداية',
    path: ['end_time'],
  });

export const decideExceptionSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'CANCELLED']),
  reason: z.string().trim().max(500).optional(),
});

// ————— مهام الإشعار اليدوية —————

export const listNotificationsQuerySchema = z.object({
  status: z.enum(['PENDING_CONTACT', 'ACKNOWLEDGED', 'SKIPPED']).optional(),
});

export type CreateHolidayDTO = z.infer<typeof createHolidaySchema>;
export type UpdateHolidayDTO = z.infer<typeof updateHolidaySchema>;
export type CreateLeaveDTO = z.infer<typeof createLeaveSchema>;
export type DecideLeaveDTO = z.infer<typeof decideLeaveSchema>;
export type CreateExceptionDTO = z.infer<typeof createExceptionSchema>;
export type DecideExceptionDTO = z.infer<typeof decideExceptionSchema>;
