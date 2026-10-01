import { z } from 'zod';

/* ==========================================================================
 * Phase 10D.3 — Inventory write-off validation (damage/waste and expiry)
 * يقابل قيود migration 035: type IN ('WASTE','EXPIRE')، quantity > 0
 * (NUMERIC 12,3)، reason غير فارغ، quantity_after = quantity_before - quantity.
 *
 * لا يوجد أي حقل اتجاه هنا: الكتابة offs تُنقص دائماً. quantity موجبة، والفرق
 * هو ما يجعل النوع Typpen صحيحاً — لا إشارة ولا عمود اتجاه.
 *
 * EXPIRE عملية محاسبة يدوية، وليست عملية انتهاء صلاحية تلقائية: لا cron ولا
 * ماسح ولا خصم تلقائي. المستخدم هو من يستدعي المسار صراحةً.
 * ========================================================================== */

export const INVENTORY_WRITE_OFF_TYPES = ['WASTE', 'EXPIRE'] as const;
export type InventoryWriteOffType = (typeof INVENTORY_WRITE_OFF_TYPES)[number];

/** نوع الكتابة-off → نوع حركة المخزون. مطابقة لـ chk_movement_type_valid بلا أي نوع جديد. */
export const WRITE_OFF_MOVEMENT_TYPE: Record<InventoryWriteOffType, 'WASTE' | 'EXPIRE'> = {
  WASTE: 'WASTE',
  EXPIRE: 'EXPIRE',
};

/** نوع الكتابة-off → إجراء التدقيق. صف تدقيق واحد لكل عملية. */
export const WRITE_OFF_AUDIT_ACTION: Record<InventoryWriteOffType, 'STOCK_WASTED' | 'STOCK_EXPIRED'> = {
  WASTE: 'STOCK_WASTED',
  EXPIRE: 'STOCK_EXPIRED',
};

/** reference_type الثابت لكل حركة منبثقة عن الكتابة-off */
export const WRITE_OFF_REFERENCE_TYPE = 'INVENTORY_WRITE_OFF';

// حدود inventory_batches.quantity_on_hand (NUMERIC 12,3)
export const MAX_WRITE_OFF_QUANTITY = 999_999_999.999;
const SCALE = 1000;

const id = z.coerce.number().int().positive();

// quantity موجبة دائماً؛ الكتابة-off تُنقص فقط ولا تُمثَّل بإشارة
const writeOffQuantity = z
  .coerce.number()
  .finite()
  .positive('الكمية يجب أن تكون أكبر من صفر')
  .max(MAX_WRITE_OFF_QUANTITY, 'الكمية تتجاوز الحد المسموح')
  .refine((value) => Math.abs(value * SCALE - Math.round(value * SCALE)) < 1e-6, {
    message: 'الكمية لا تقبل أكثر من 3 خانات عشرية',
  });

// سبب إلزامي وغير فارغ — مسافة بيضاء فقط ليست سبباً
const reason = z
  .string({ error: 'سبب الكتابة-off مطلوب' })
  .trim()
  .min(1, 'سبب الكتابة-off مطلوب')
  .max(2000, 'سبب الكتابة-off طويل جداً');

// '' يعني "غير مُرسل" — يُخزَّن NULL
const optionalNotes = z.preprocess(
  (value) => (value === '' || value === undefined ? null : value),
  z.string().trim().max(5000, 'الملاحظات طويلة جداً').nullable(),
).optional();

/**
 * حقول يُرفض وجودها في جسم الطلب.
 * كل هوية في هذه العملية تُشتق من الخادم: batch_id وحده يُحلّ إلى
 * inventory_item -> clinic_id، والمنفّذ هو المستخدم الموثّق، ونوع الحركة
 * وإجراء التدقيق ثابتان للخادم.
 * وجود أي منها في الطلب خطأ صريح (400) لا تجاهل صامت.
 */
export const FORBIDDEN_WRITE_OFF_FIELDS = [
  'clinic_id',
  'user_id',
  'performed_by_user_id',
  'medication_id',
  'inventory_id',
  'movement_type',
  'reference_type',
  'reference_id',
  'quantity_on_hand',
  'quantity_reserved',
  'quantity_before',
  'quantity_after',
  'direction',
  'write_off_id',
  'adjustment_id',
] as const;

export const writeOffCreateSchema = z.object({
  batch_id: id,
  quantity: writeOffQuantity,
  type: z.enum(INVENTORY_WRITE_OFF_TYPES),
  reason,
  notes: optionalNotes,
});

export type WriteOffCreateInput = z.infer<typeof writeOffCreateSchema>;

/** الكميات مخزّنة NUMERIC(12,3) — لا نسبة عائمة عابرة إلى الـDB ولا ردّها */
export const roundWriteOffQuantity = (value: number): number => Number(value.toFixed(3));
