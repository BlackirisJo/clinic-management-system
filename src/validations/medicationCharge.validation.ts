import { z } from 'zod';

/* ==========================================================================
 * Phase 10E.4 — Medication charge (dispensing → invoice) validation
 *
 * القاعدة الأساسية: الفوترة بالصرف لا بالروشتة. الوحدة التي تُحمَّل هي سجل
 * الصرف نفسه، فالمقابل/التكرار/الاستكمال كلها_OPERATIONS صرف منفصلة، ولكل
 * منها رسومه. الفوترة بالروشتة كانت ستطوي رسوم الصرف الثاني في الأول.
 *
 * جسم الطلب يحمل معرّف الصرف فقط. كل شيء آخر — العيادة، المريض، الزيارة،
 * الدواء، الكمية، السعر — يُشتق من سجل الصرف على الخادم.
 * ========================================================================== */

const id = z.coerce.number().int().positive();

/**
 /**
 * حقول يُرفض وجودها في جسم الطلب: محاولة توجيه هوية أو سعر أو كمية محاسبية
 * = تزوير. تُرفض كلها قبل أي وصول لقاعدة البيانات، ولا تُتجاهل بصمت.
 */
export const FORBIDDEN_MEDICATION_CHARGE_FIELDS = [
  'clinic_id',
  'patient_id',
  'visit_id',
  'prescription_id',
  'medication_id',
  'inventory_item_id',
  'quantity',
  'dispensed_quantity',
  'price',
  'unit_price',
  'unit_price_snapshot',
  'line_total',
  'total_amount',
  'net_amount',
  'paid_amount',
  'discount_amount',
  'invoice_id',
  'service_id',
  'items',
] as const;

/** إصدار رسم شحن دواء لسجل صرف واحد */
export const medicationChargeSchema = z.object({
  dispensing_id: id,
});

export type MedicationChargeInput = z.infer<typeof medicationChargeSchema>;

/** حالات الصرف المؤهَّلة للاشهار — VOIDED مستبعدة دائماً */
export const INVOICABLE_DISPENSING_STATUSES = ['COMPLETED', 'PARTIAL'] as const;
export type InvoicableDispensingStatus = (typeof INVOICABLE_DISPENSING_STATUSES)[number];