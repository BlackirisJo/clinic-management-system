import { z } from 'zod';

/* ==========================================================================
 * Phase 10F.1 — Patient fulfilment decision validation
 *
 * هذا المسار يسجّل رأي المريض فقط: هل سيأخذ الدواء من العيادة، أم من صيدلية
 * خارجية، أم Decline، أم أُلغي البند. لا يصرف ولا يخصم مخزون ولا يصدر فاتورة.
 *
 * الحالات المملوكة لهذا المسار أربعة فقط. أما DISPENSED_FROM_CLINIC و
 * PARTIALLY_DISPENSED فليست في هذه القائمة إطلاقاً: ملكيتهما لمسار الصرف
 * القائم، وقبولهما هنا يعني أن أحداً يستطيع ادعاء صرف لم يحدث.
 * ========================================================================== */

/** الحالات التي يملكها مسار القرار (الطبيب) — لا غير */
export const DECISION_OWNED_FULFILMENT_STATUSES = [
  'PENDING',
  'CLINIC_DISPENSING',
  'EXTERNAL_PHARMACY',
  'PATIENT_DECLINED',
  'CANCELLED',
] as const;
export type DecisionOwnedFulfilmentStatus = (typeof DECISION_OWNED_FULFILMENT_STATUSES)[number];

/** كل الحالات المخزَّنة، منها اثنتان يملكهما مسار الصرف وحده */
export const FULFILMENT_STATUSES = [
  'PENDING',
  'CLINIC_DISPENSING',
  'DISPENSED_FROM_CLINIC',
  'EXTERNAL_PHARMACY',
  'PATIENT_DECLINED',
  'PARTIALLY_DISPENSED',
  'CANCELLED',
] as const;
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number];

export const FULFILMENT_SOURCES = ['CLINIC', 'EXTERNAL'] as const;
export type FulfilmentSource = (typeof FULFILMENT_SOURCES)[number];

/** الحالات التي يكتبها مسار الصرف وحده — لا يمكن للقرار أن يدّعيها */
export const DISPENSING_OWNED_FULFILMENT_STATUSES = [
  'DISPENSED_FROM_CLINIC',
  'PARTIALLY_DISPENSED',
] as const;

/**
 * حقول تُرفض وجودها في جسم الطلب: كل ما يخص الصرف أو المال أو المخزون. وجودها
 * = محاولة توجيه عملية من مسار لا يملكها. تُرفض كلها قبل أي وصول لقاعدة
 * البيانات ولا تُتجاهل بصمت (يفحصها الكنترولر صريحاً قبل التحقق من المخطط).
 */
export const FORBIDDEN_FULFILMENT_FIELDS = [
  'dispensing_id',
  'dispensing_item_id',
  'prescription_id',
  'medication_id',
  'inventory_item_id',
  'batch_id',
  'quantity',
  'dispensed_quantity',
  'prescribed_quantity',
  'unit_price',
  'unit_price_snapshot',
  'line_total',
  'invoice_id',
  'amount',
  'total_amount',
  'net_amount',
  'paid_amount',
  'discount_amount',
  // هوية المُسجِّل قراره من الجلسة لا من الطلب
  'decided_by_user_id',
  'decided_at',
  'clinic_id',
  'patient_id',
  'visit_id',
] as const;

/**
 * تسجيل/تحديث قرار المريض لبند واحد.
 *
 * - fulfilment_status مطلوب: لا قرار بلا إجابة صريحة (وPENDING نفسه إجابة).
 * - decision_note اختياري (≤ 500 كما في العمود).
 * - source اختياري، والافتراضي CLINIC.
 * - reset_to_pending: تأكيد صريح للرجوع إلى "لم يُقرَّر بعد". بدونه لا يُمحى
 *   قرار مسجَّل (EXTERNAL_PHARMACY / PATIENT_DECLINED / CANCELLED)، حتى لا
 *   يُطمس رأي المريض بخطأ.
 */
export const fulfilmentDecisionSchema = z.object({
  // DISPENSED_FROM_CLINIC / PARTIALLY_DISPENSED ليست في هذه القائمة عمداً:
  // z.enum يرفضهما بـ 400 قبل أي وصول لقاعدة البيانات.
  fulfilment_status: z.enum(DECISION_OWNED_FULFILMENT_STATUSES),
  decision_note: z
    .string()
    .trim()
    .max(500, 'decision_note must be at most 500 characters')
    .optional(),
  source: z.enum(FULFILMENT_SOURCES).optional(),
  reset_to_pending: z.boolean().optional(),
});

export type FulfilmentDecisionInput = z.infer<typeof fulfilmentDecisionSchema>;
