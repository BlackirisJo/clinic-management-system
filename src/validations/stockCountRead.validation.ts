import { z } from 'zod';
import { STOCK_COUNT_STATUSES } from './stockCount.validation';

/* ==========================================================================
 * Phase 10D.6 — Stock count read query validation
 * لا clinic_id ولا user id — الاستعلام فقط، والنطاق يأتي من الخادم.
 * ========================================================================== */

export const DEFAULT_STOCK_COUNT_LIMIT = 50;
export const MAX_STOCK_COUNT_LIMIT = 200;

const optionalQueryInt = (min: number, max: number, message: string) =>
  z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().int().min(min, message).max(max, message),
  ).optional();

export const stockCountListQuerySchema = z.object({
  status: z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.enum(STOCK_COUNT_STATUSES),
  ).optional(),
  limit: optionalQueryInt(1, MAX_STOCK_COUNT_LIMIT, `الحد يجب أن يكون بين 1 و ${MAX_STOCK_COUNT_LIMIT}`),
  offset: optionalQueryInt(0, Number.MAX_SAFE_INTEGER, 'البداية يجب أن تكون 0 أو أكثر'),
  // clinic_id غير مُعرَّف عمداً: أي قيمة ترسل من العميل تُهمَل ولا تُستخدم في الاستعلام
});

export type StockCountListQuery = z.infer<typeof stockCountListQuerySchema>;

/* ==========================================================================
 * Phase 10D.9 — Stock reconciliation report query validation
 * تصفية اختيارية فقط؛ النطاق يأتي من الجلسة في كل الأحوال.
 * ========================================================================== */

export const stockCountReconciliationQuerySchema = z.object({
  // count_id اختياري: عند حذفه يُختار أحدث جلسة FINALISED ضمن نطاق المستخدم
  count_id: optionalQueryInt(1, Number.MAX_SAFE_INTEGER, 'معرّف جلسة الجرد يجب أن يكون عدداً صحيحاً موجباً'),
  inventory_id: optionalQueryInt(1, Number.MAX_SAFE_INTEGER, 'معرّف صنف المخزون يجب أن يكون عدداً صحيحاً موجباً'),
  batch_id: optionalQueryInt(1, Number.MAX_SAFE_INTEGER, 'معرّف الدفعة يجب أن يكون عدداً صحيحاً موجباً'),
  limit: optionalQueryInt(1, MAX_STOCK_COUNT_LIMIT, `الحد يجب أن يكون بين 1 و ${MAX_STOCK_COUNT_LIMIT}`),
  offset: optionalQueryInt(0, Number.MAX_SAFE_INTEGER, 'البداية يجب أن تكون 0 أو أكثر'),
  // clinic_id غير مُعرَّف عمداً: التقرير لا يقبل تحديد العيادة من العميل
});

export type StockCountReconciliationQuery = z.infer<typeof stockCountReconciliationQuerySchema>;
