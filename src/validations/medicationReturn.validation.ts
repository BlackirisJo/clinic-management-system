import { z } from 'zod';
import { RESTOCK_DECISIONS } from './medicationReturnRead.validation';

/* ==========================================================================
 * Phase 10D.5 — Patient medication return execution (validation)
 *
 * كل هوية في العملية مُشتقّة من الخادم: العيادة والمريض والدواء والصنف من سجل
 * الصرف الأصلي، والمنفّذ من المستخدم الموثّق، ونوع الحركة والمرجع من قرار
 * الإرجاع نفسه. جسم الطلب لا يقبل أياً منها.
 *
 * الاستثناء الوحيد: batch_id داخل بند واحد — وهو *طلب صريح* لدفعة بديلة، لا
 * هوية مُدخَلة. وهو مسموح فقط مع RESTOCK (انظر أدناه) ومع سبب إلزامي عند
 * اختلاف الدفعة عن الأصل.
 * ========================================================================== */

// حدود inventory_batches.quantity_on_hand (NUMERIC 12,3)
export const MAX_RETURN_QUANTITY = 999_999_999.999;
const SCALE = 1000;

const id = z.coerce.number().int().positive();

// dispensing_item_batches.dispensing_item_batch_id من نوع BIGINT — نقبل ما
// دون حدود JavaScript الآمنة، فنُسقِط أي قيمة أكبر بدل تمريرها إلى الاستعلام
const allocationId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER, 'معرّف التخصيص غير صالح');

const returnQuantity = z
  .coerce.number()
  .finite()
  .positive('الكمية يجب أن تكون أكبر من صفر')
  .max(MAX_RETURN_QUANTITY, 'الكمية تتجاوز الحد المسموح')
  .refine((value) => Math.abs(value * SCALE - Math.round(value * SCALE)) < 1e-6, {
    message: 'الكمية لا تقبل أكثر من 3 خانات عشرية',
  });

// سبب إلزامي وغير فارغ — مسافة بيضاء فقط ليست سبباً
const reason = z
  .string({ error: 'سبب الإرجاع مطلوب' })
  .trim()
  .min(1, 'سبب الإرجاع مطلوب')
  .max(2000, 'سبب الإرجاع طويل جداً');

const optionalText = (max: number, message: string) =>
  z.preprocess((value) => (value === '' || value === undefined ? null : value), z.string().trim().max(max, message).nullable())
    .optional();

/**
 * حقول يُرفض وجودها على مستوى الطلب.
 * كل خطأ منها خطأ صريح (400) قبل أي وصول لقاعدة البيانات — لا تجاهل صامت.
 */
export const FORBIDDEN_RETURN_FIELDS = [
  'clinic_id',
  'patient_id',
  'user_id',
  'returned_by_user_id',
  'dispensed_to_patient_id',
  'inventory_id',
  'medication_id',
  'batch_id',
  'original_dispensing_id',
  'unit_cost_snapshot',
  'quantity_before',
  'quantity_after',
  'quantity_on_hand',
  'quantity_reserved',
  'movement_type',
  'reference_type',
  'reference_id',
  'return_id',
  'status',
] as const;

/** نفس القاعدة على مستوى البند — الدفعة البديلة وحدها مسموحة. */
export const FORBIDDEN_RETURN_ITEM_FIELDS = [
  'clinic_id',
  'patient_id',
  'user_id',
  'inventory_id',
  'medication_id',
  'unit_cost_snapshot',
  'quantity_on_hand',
  'movement_type',
  'return_id',
  'return_item_id',
] as const;

const returnItemSchema = z.object({
  dispensing_item_batch_id: allocationId,
  quantity: returnQuantity,
  restock_decision: z.enum(RESTOCK_DECISIONS),
  /**
   * دفعة بديلة مطلوبة صراحةً. مسموحة فقط مع RESTOCK — WASTE لا تُعيد مخزوناً
   * فلا يوجد أين تذهب الكمية، وQUARANTINE تعزل الدفعة الأصلية نفسها.
   */
  batch_id: id.optional(),
});

export const medicationReturnCreateSchema = z
  .object({
    dispensing_id: id,
    reason,
    notes: optionalText(5000, 'الملاحظات طويلة جداً'),
    // إلزامي بمجرد استخدام دفعة بديلة — يُفحص في الكنترولر بعد قراءة الدفعات
    substitution_reason: optionalText(2000, 'سبب استخدام دفعة بديلة طويل جداً'),
    items: z.array(returnItemSchema).min(1, 'يجب إرسال بند واحد على الأقل').max(200, 'عدد البنود كبير جداً'),
  })
  // نفس التخصيص لا يُطلب مرتين في طلب واحد — يُجمَّع مرة واحدة
  .refine(
    (value) => new Set(value.items.map((item) => item.dispensing_item_batch_id)).size === value.items.length,
    { message: 'لا يجوز تكرار نفس التخصيص في بندين', path: ['items'] },
  );

export type MedicationReturnCreateInput = z.infer<typeof medicationReturnCreateSchema>;
export type MedicationReturnItemInput = z.infer<typeof returnItemSchema>;

/** الكميات مخزّنة NUMERIC(12,3) — لا نسبة عائمة عابرة إلى الـDB ولا ردّها */
export const roundReturnQuantity = (value: number): number => Number(value.toFixed(3));
