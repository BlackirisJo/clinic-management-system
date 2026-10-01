import { z } from 'zod';

/* ==========================================================================
 * Phase 10D.6 — Stock count validation
 * يقابل قيود migration 037: status ∈ ('OPEN','FINALISED','CANCELLED')،
 * system_quantity / counted_quantity غير سالبة، و variance = counted - system.
 *
 * counted_quantity: unlike stock adjustments and returns, a counted quantity may
 * legitimately be ZERO: "the shelf is empty" is a real, valuable answer, and it
 * is exactly how a shortage is detected. There is no minimum above zero here.
 *
 * كلSnapshot value غير مُدخَل: system_quantity وvariance وmedication_id
 * كلها تُشتق من الخادم تحت قفل صف الدفعة. جسم الطلب لا يقبل أياً منها.
 *
 * Phase 10D.7 (finalisation) لا تضيف أي حقل أعمال: إنهاء العد لا يحتاج سبباً ولا
 * ملاحظة من العميل — الحالة والوقت والمنفّذ كلّها مشتقّة من الخادم.
 * ========================================================================== */

export const STOCK_COUNT_STATUSES = ['OPEN', 'FINALISED', 'CANCELLED'] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];

/** الحالة التي تُنشأ بها كل عملية فتح عد — والخادم وحده من يقررها */
export const INITIAL_STOCK_COUNT_STATUS: StockCountStatus = 'OPEN';

// حدود NUMERIC(12,3) في inventory_batches وstock_count_lines
export const MAX_COUNT_QUANTITY = 999_999_999.999;
const SCALE = 1000;

const id = z.coerce.number().int().positive();

/** كمية فعلية معدودة: صفر مسموح، سالب مرفوض، ولا أكثر من 3 خانات عشرية */
export const countedQuantity = z
  .coerce.number()
  .finite()
  .min(0, 'الكمية المعدودة لا يمكن أن تكون سالبة')
  .max(MAX_COUNT_QUANTITY, 'الكمية تتجاوز الحد المسموح')
  .refine((value) => Math.abs(value * SCALE - Math.round(value * SCALE)) < 1e-6, {
    message: 'الكمية لا تقبل أكثر من 3 خانات عشرية',
  });

// '' يعني "غير مُرسل" — يُخزَّن NULL
const optionalNotes = z.preprocess(
  (value) => (value === '' || value === undefined ? null : value),
  z.string().trim().max(5000, 'الملاحظات طويلة جداً').nullable(),
).optional();

/**
 * حقول يُرفض وجودها في جسم طلب فتح العد.
 * الهوية والنطاق والحالة وكل الأرقام المُشتقّة ليست مُدخَلات. وجود أي منها خطأ
 * صريح (400) قبل أي وصول لقاعدة البيانات — لا تجاهل صامت.
 */
export const FORBIDDEN_STOCK_COUNT_FIELDS = [
  'clinic_id',
  'user_id',
  'counted_by_user_id',
  'approved_by_user_id',
  'status',
  'finalised_at',
  'count_id',
] as const;

/**
 * حقول يُرفض وجودها في جسم طلب تسجيل سطر عد.
 * snapshot الفارق هو جوهر السطر: لا يُكتب إلا من الخادم.
 */
export const FORBIDDEN_STOCK_COUNT_LINE_FIELDS = [
  'clinic_id',
  'user_id',
  'counted_by_user_id',
  'medication_id',
  'inventory_id',
  'system_quantity',
  'variance',
  'system_quantity_at_finalisation',
  'adjusted_quantity',
  'quantity_on_hand',
  'quantity_reserved',
  'status',
  'finalised_at',
  'count_id',
  'count_line_id',
] as const;

/** فتح جلسة عد جديدة. لا شيء سوى ملاحظات اختيارية. */
export const stockCountCreateSchema = z.object({
  notes: optionalNotes,
});

export type StockCountCreateInput = z.infer<typeof stockCountCreateSchema>;

/** تسجيل سطر عد واحد: الدفعة والكمية الفعلية فقط. */
export const stockCountLineCreateSchema = z.object({
  batch_id: id,
  counted_quantity: countedQuantity,
});

export type StockCountLineCreateInput = z.infer<typeof stockCountLineCreateSchema>;

/* ==========================================================================
 * Phase 10D.7 — Finalisation
 * ========================================================================== */

/**
 * حقول يُرفض وجودها في جسم طلب إنهاء العد.
 * كل ما يخصّ الإنهاء مُشتقّ: العيادة من سجل العد، والمنفّذ من المستخدم الموثّق،
 * والحالة والوقت-now من الخادم، والكميات من الدفعات المقفولة. لا يوجد حقل أعمال
 * واحد في هذا الطلب — ووجود أي من هذه الحقول خطأ صريح (400) قبل أي وصول لـDB.
 */
export const FORBIDDEN_STOCK_COUNT_FINALISE_FIELDS = [
  'clinic_id',
  'user_id',
  'counted_by_user_id',
  'finalised_by_user_id',
  'approved_by_user_id',
  'status',
  'finalised_at',
  'system_quantity',
  'system_quantity_at_finalisation',
  'counted_quantity',
  'variance',
  'adjusted_quantity',
  'quantity_on_hand',
  'quantity_reserved',
  'adjustment_id',
  'movement_type',
  'reference_type',
  'reference_id',
  'count_id',
  'notes',
  'reason',
] as const;

/**
 * جسم طلب الإنهاء فارغ تماماً — و .strict() يرفض أي حقل زائد لم نتوقعه،
 * فتصبح القائمة أعلاه شبكة أمان إضافية لا ثغرة في التحقق.
 */
export const stockCountFinaliseSchema = z.object({}).strict();

/** السبب الثابت المكتوب في stock_adjustments.reason — لا يأتي من العميل أبداً */
export const STOCK_COUNT_FINALISATION_REASON = 'STOCK_COUNT';

/** المرجع المستخدم في stock_movements لتمييز حركة arising من جرد */
export const STOCK_COUNT_REFERENCE_TYPE = 'STOCK_COUNT';

/** اتجاه التسوية المشتقّ من الفارق النهائي */
export const FINAL_VARIANCE_ADJUSTMENT: Record<'POSITIVE' | 'NEGATIVE', {
  direction: 'INCREASE' | 'DECREASE';
  movement_type: 'ADJUSTMENT' | 'ADJUSTMENT_DECREASE';
}> = {
  POSITIVE: { direction: 'INCREASE', movement_type: 'ADJUSTMENT' },
  NEGATIVE: { direction: 'DECREASE', movement_type: 'ADJUSTMENT_DECREASE' },
};

/** الكميات مخزّنة NUMERIC(12,3) — لا نسبة عائمة عابرة إلى الـDB ولا ردّها */
export const roundCountQuantity = (value: number): number => Number(value.toFixed(3));
