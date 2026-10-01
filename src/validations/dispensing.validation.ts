import { z } from 'zod';

/* ==========================================================================
 * Phase 10C.3 — Core dispensing request validation (full dispensing only)
 *
 * لا يوجد وضع جزئي في هذه المرحلة، ولا clinic_id ولا معرّف صيدلي من العميل.
 * هوية الصيدلي تُؤخذ من req.user.userId حصراً.
 * ========================================================================== */

export const dispensingCreateSchema = z.object({
  prescription_id: z.coerce.number().int().positive('prescription_id is required'),
  notes: z.string().trim().max(2000).optional().nullable(),
  // لا client_clinic_id ولا performed_by_user_id عمداً — كلها تُشتق من الخادم
});

export type DispensingCreateInput = z.infer<typeof dispensingCreateSchema>;

/* ==========================================================================
 * Phase 10C.4A — Void an existing dispensing
 * السبب اختياري؛ هوية المستخدم من الجلسة حصراً.
 * ========================================================================== */

export const dispensingVoidSchema = z.object({
  reason: z.string().trim().min(1, 'reason must not be empty').max(1000).optional().nullable(),
});

export type DispensingVoidInput = z.infer<typeof dispensingVoidSchema>;
