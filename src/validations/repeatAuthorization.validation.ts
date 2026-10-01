import { z } from 'zod';

/* ==========================================================================
 * Phase 10C.4C — Repeat dispensing authorization
 * التفويض اختياري وليس تلقائياً: لا صف = max_cycles = 1 ضمنياً.
 * repeats_count لا يُقرأ ولا يُترجم هنا إطلاقاً.
 * ========================================================================== */

export const repeatAuthorizationCreateSchema = z.object({
  max_cycles: z.coerce.number().int().min(1, 'max_cycles must be at least 1').max(99),
  // لا clinic_id ولا authorized_by_user_id — كلاهما من الخادم
});

export const repeatAuthorizationUpdateSchema = z.object({
  max_cycles: z.coerce.number().int().min(1, 'max_cycles must be at least 1').max(99).optional(),
});

export type RepeatAuthorizationCreateInput = z.infer<typeof repeatAuthorizationCreateSchema>;
export type RepeatAuthorizationUpdateInput = z.infer<typeof repeatAuthorizationUpdateSchema>;
