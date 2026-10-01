import { z } from 'zod';

/* ==========================================================================
 * Phase 10D.2 — Manual stock adjustment validation
 * يقابل قيود migration 034: direction IN ('INCREASE','DECREASE')،
 * quantity > 0 (NUMERIC 12,3)، reason غير فارغ.
 *
 * quantity موجبة دائماً — الاتجاه يُنقل في direction صراحةً، لا في إشارة على
 * الكمية. لا يوجد أي مَدخل Для الاتجاه المشتق أو لِكمية الرصيد الحالي.
 * ========================================================================== */

export const STOCK_ADJUSTMENT_DIRECTIONS = ['INCREASE', 'DECREASE'] as const;
export type StockAdjustmentDirection = (typeof STOCK_ADJUSTMENT_DIRECTIONS)[number];

/**
 * اتجاه التسوية → نوع حركة المخزون.
 * مطابقة لـ chk_movement_type_valid: لا يوجد أي نوع حركة جديد في هذه المرحلة.
 */
export const ADJUSTMENT_MOVEMENT_TYPE: Record<StockAdjustmentDirection, 'ADJUSTMENT' | 'ADJUSTMENT_DECREASE'> = {
  INCREASE: 'ADJUSTMENT',
  DECREASE: 'ADJUSTMENT_DECREASE',
};

// حدود inventory_batches.quantity_on_hand (NUMERIC 12,3)
export const MAX_ADJUSTMENT_QUANTITY = 999_999_999.999;
const SCALE = 1000;

const id = z.coerce.number().int().positive();

// quantity موجبة دائماً؛ الاتجاه يُنقل في direction لا في إشارة
const adjustmentQuantity = z
  .coerce.number()
  .finite()
  .positive('الكمية يجب أن تكون أكبر من صفر')
  .max(MAX_ADJUSTMENT_QUANTITY, 'الكمية تتجاوز الحد المسموح')
  .refine((value) => Math.abs(value * SCALE - Math.round(value * SCALE)) < 1e-6, {
    message: 'الكمية لا تقبل أكثر من 3 خانات عشرية',
  });

// سبب إلزامي وغير فارغ — مسافة بيضاء فقط ليست سبباً
const reason = z
  .string({ error: 'سبب التسوية مطلوب' })
  .trim()
  .min(1, 'سبب التسوية مطلوب')
  .max(2000, 'سبب التسوية طويل جداً');

// '' يعني "غير مُرسل" — يُخزَّن NULL
const optionalNotes = z.preprocess(
  (value) => (value === '' || value === undefined ? null : value),
  z.string().trim().max(5000, 'الملاحظات طويلة جداً').nullable(),
).optional();

/**
 * حقول يُرفض وجودها في جسم الطلب.
 * كل هوية في هذه العملية تُشتق من الخادم: batch_id وحده يُحلّ إلى
 * inventory_item -> clinic_id، والمنفّذ هو المستخدم الموثّق.
 * وجود أي منها في الطلب خطأ صريح (400) لا تجاهل صامت.
 */
export const FORBIDDEN_ADJUSTMENT_FIELDS = [
  'clinic_id',
  'user_id',
  'performed_by_user_id',
  'medication_id',
  'inventory_id',
  'quantity_on_hand',
  'quantity_before',
  'quantity_after',
  'quantity_reserved',
  'movement_type',
  'reference_type',
  'reference_id',
  'adjustment_id',
] as const;

export const stockAdjustmentCreateSchema = z.object({
  batch_id: id,
  quantity: adjustmentQuantity,
  direction: z.enum(STOCK_ADJUSTMENT_DIRECTIONS),
  reason,
  notes: optionalNotes,
});

export type StockAdjustmentCreateInput = z.infer<typeof stockAdjustmentCreateSchema>;

/** الكميات مخزّنة NUMERIC(12,3) — لا نسبة عائمة عابرة إلى الـDB ولا ردّها */
export const roundAdjustmentQuantity = (value: number): number => Number(value.toFixed(3));

/** نفس قيد chk_batch_qty_reserved_le_on_hand في migration 029 */
export const isReservedWithinOnHand = (reserved: number, onHand: number): boolean => reserved <= onHand;
