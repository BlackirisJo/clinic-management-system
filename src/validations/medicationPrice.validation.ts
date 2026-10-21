import { z } from 'zod';

/* ==========================================================================
 * Phase 10E.2 — Medication selling-price validation
 * يقابل قيود migration 039: unit_price NUMERIC(10,2) NOT NULL CHECK >= 0،
 * و is_active ⟺ effective_to IS NULL.
 *
 * نموذج التاريخ: صف واحد لكل سعر. تغيير السعر يُنهي صلاحية الصف القديم
 * (effective_to) وينشئ صفاً جديداً — ولا يُعدَّل unit_price على صف قائم أبداً.
 * لذلك لا يوجد أي مُدخَل here للسماح بتعديل مبلغ قائم.
 *
 * كل القيم المشتقّة (clinic_id, medication_id, is_active, effective_to,
 * price_id, المنشئ) تُشتق من الخادم ويُرفض وجودها في جسم الطلب.
 * ========================================================================== */

const id = z.coerce.number().int().positive();

/** حدود NUMERIC(10,2): ثماني خانات صحيحة قبل الفاصلة، وخانتان بعدها */
export const MAX_MEDICATION_UNIT_PRICE = 99_999_999.99;
const SCALE = 100;

/**
 * سعر بيع الصنف: صفر مسموح (دواء مجاني قرار مالي مشروع)، سالب مرفوض،
 * ولا خانتان عشريتان زائدتان — التقريب الصامت لسعر نقدي غير مقبول.
 */
export const unitPrice = z.coerce
  .number()
  .finite('سعر البيع يجب أن يكون رقماً منتهياً')
  .min(0, 'سعر البيع لا يمكن أن يكون سالباً')
  .max(MAX_MEDICATION_UNIT_PRICE, 'سعر البيع يتجاوز الحد المسموح')
  .refine((value) => Math.abs(value * SCALE - Math.round(value * SCALE)) < 1e-6, {
    message: 'سعر البيع لا يقبل أكثر من خانتين عشريتين',
  });

/** طابع زمني ISO8601 صالح ل effective_from الاختياري (رجوع فعلي للتأريخ) */
const optionalTimestamp = z.preprocess(
  (value) => (value === '' || value === null ? undefined : value),
  z.string().datetime({ offset: true, message: 'الطابع الزمني غير صالح' }).optional(),
);

/**
 * حقول يُرفض وجودها في جسم طلب السعر. عيادة السعر ليست مُدخَلاً: تُشتق من
 * صنف المخزون الذي يقع تحته السعر، والخادم وحده من يقرّرها.
 */
export const FORBIDDEN_MEDICATION_PRICE_FIELDS = [
  'clinic_id',
  'medication_id',
  'price_id',
  'is_active',
  'effective_to',
  'created_by_user_id',
  'user_id',
] as const;

/** إنشاء سعر بيع صنف مخزون */
export const medicationPriceCreateSchema = z.object({
  inventory_id: id,
  unit_price: unitPrice,
  effective_from: optionalTimestamp,
});

/**
 * تحديث سعر = إنهاء صلاحية السعر الحالي وإنشاء سعر جديد بنفس الصنف.
 * الجسم يحمل السعر الجديد فقط؛ لا يُقبل أي تعديل على صف قائم.
 */
export const medicationPriceUpdateSchema = z.object({
  unit_price: unitPrice,
  effective_from: optionalTimestamp,
});

/** قراءة قائمة الأسعار: مرشّحات اختيارية فقط */
export const medicationPriceQuerySchema = z.object({
  clinic_id: id.optional(),
  inventory_id: id.optional(),
  is_active: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .optional(),
});

export type MedicationPriceCreateInput = z.infer<typeof medicationPriceCreateSchema>;
export type MedicationPriceUpdateInput = z.infer<typeof medicationPriceUpdateSchema>;
export type MedicationPriceQueryInput = z.infer<typeof medicationPriceQuerySchema>;