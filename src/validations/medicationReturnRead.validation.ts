import { z } from 'zod';

/* ==========================================================================
 * Phase 10D.4 — Read-only medication-return query validation
 * لا clinic_id ولا patient_id ولا user id — الاستعلام فقط.
 *
 * There is deliberately no mutation schema in this phase: nothing writes a
 * return yet (that is Phase 10D.5).
 * ========================================================================== */

export const MEDICATION_RETURN_STATUSES = ['COMPLETED', 'VOIDED'] as const;
export type MedicationReturnStatus = (typeof MEDICATION_RETURN_STATUSES)[number];

export const RESTOCK_DECISIONS = ['RESTOCK', 'QUARANTINE', 'WASTE'] as const;
export type RestockDecision = (typeof RESTOCK_DECISIONS)[number];

/** reference_type that 10D.5 will use for any stock movement it creates. */
export const MEDICATION_RETURN_REFERENCE_TYPE = 'MEDICATION_RETURN';

export const DEFAULT_MEDICATION_RETURN_LIMIT = 50;
export const MAX_MEDICATION_RETURN_LIMIT = 200;

const optionalQueryInt = (min: number, max: number, message: string) =>
  z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().int().min(min, message).max(max, message),
  ).optional();

export const medicationReturnListQuerySchema = z.object({
  patient_id: optionalQueryInt(1, Number.MAX_SAFE_INTEGER, 'patient_id غير صالح'),
  original_dispensing_id: optionalQueryInt(1, Number.MAX_SAFE_INTEGER, 'original_dispensing_id غير صالح'),
  returned_by_user_id: optionalQueryInt(1, Number.MAX_SAFE_INTEGER, 'returned_by_user_id غير صالح'),
  status: z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.enum(MEDICATION_RETURN_STATUSES),
  ).optional(),
  limit: optionalQueryInt(1, MAX_MEDICATION_RETURN_LIMIT, `الحد يجب أن يكون بين 1 و ${MAX_MEDICATION_RETURN_LIMIT}`),
  offset: optionalQueryInt(0, Number.MAX_SAFE_INTEGER, 'البداية يجب أن تكون 0 أو أكثر'),
  // clinic_id غير مُعرَّف عمداً: أي قيمة ترسل من العميل تُهمَل ولا تُستخدم في الاستعلام
});

export type MedicationReturnListQuery = z.infer<typeof medicationReturnListQuerySchema>;
