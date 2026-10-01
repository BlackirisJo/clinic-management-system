import { z } from 'zod';

/* ==========================================================================
 * Phase 10C.5 — Read-only dispensing query validation
 * لا clinic_id ولا ترتيب حر من العميل. الاستعلام فقط.
 * ========================================================================== */

export const DISPENSING_STATUSES = ['COMPLETED', 'PARTIAL', 'VOIDED'] as const;

export const DEFAULT_DISPENSING_LIMIT = 50;
export const MAX_DISPENSING_LIMIT = 200;

const optionalQueryInt = (min: number, max: number, message: string) =>
  z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().int().min(min, message).max(max, message),
  ).optional();

// تواريخ ISO فقط — لا يُمرَّر نص حر إلى الاستعلام
const optionalDate = (message: string) =>
  z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, message),
  ).optional();

export const dispensingListQuerySchema = z
  .object({
    prescription_id: optionalQueryInt(1, Number.MAX_SAFE_INTEGER, 'prescription_id is invalid'),
    patient_id: optionalQueryInt(1, Number.MAX_SAFE_INTEGER, 'patient_id is invalid'),
    status: z.preprocess(
      (value) => (value === '' || value === undefined || value === null ? undefined : value),
      z.enum(DISPENSING_STATUSES),
    ).optional(),
    dispensed_by_user_id: optionalQueryInt(1, Number.MAX_SAFE_INTEGER, 'dispensed_by_user_id is invalid'),
    cycle_index: optionalQueryInt(0, 9999, 'cycle_index is invalid'),
    date_from: optionalDate('date_from must be YYYY-MM-DD'),
    date_to: optionalDate('date_to must be YYYY-MM-DD'),
    limit: optionalQueryInt(1, MAX_DISPENSING_LIMIT, `limit must be between 1 and ${MAX_DISPENSING_LIMIT}`),
    offset: optionalQueryInt(0, Number.MAX_SAFE_INTEGER, 'offset must be 0 or greater'),
    // clinic_id غير مُعرَّف عمداً: أي قيمة ترسل من العميل تُهمَل
  })
  .refine((value) => !(value.date_from && value.date_to) || value.date_from <= value.date_to, {
    message: 'date_from must not be after date_to',
    path: ['date_from'],
  });

export type DispensingListQuery = z.infer<typeof dispensingListQuerySchema>;
