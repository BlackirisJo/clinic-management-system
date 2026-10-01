import { z } from 'zod';

/* ==========================================================================
 * Phase 10B.2B — Supplier validation
 * يقابل قيود migration 029: name VARCHAR(200) NOT NULL، contact_info TEXT،
 * is_active BOOLEAN NOT NULL DEFAULT TRUE، UNIQUE(clinic_id, name).
 * ========================================================================== */

const id = z.coerce.number().int().positive();

const supplierName = z
  .string()
  .trim()
  .min(1, 'اسم المورد مطلوب')
  .max(200, 'اسم المورد طويل جداً');

// '' يعني "لا بيانات تواصل" — و undefined يعني "لم يُرسل" (يُميّزه .optional)
const contactInfo = z.preprocess(
  (value) => (value === '' || value === undefined ? null : value),
  z.string().trim().max(2000, 'بيانات التواصل طويلة جداً').nullable(),
);

// تحويل صريح بلا z.coerce.boolean (الذي يحوّل أي نص غير فارغ — بما فيه "false" — إلى true)
const booleanFlag = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

export const supplierCreateSchema = z.object({
  clinic_id: id,
  name: supplierName,
  contact_info: contactInfo.default(null),
  is_active: booleanFlag.default(true),
});

export const supplierUpdateSchema = z.object({
  // clinic_id مُرسل للتحقق من النطاق فقط — لا يُغيَّر (انظر الكنترولر)
  clinic_id: id.optional(),
  name: supplierName.optional(),
  contact_info: contactInfo.optional(),
  is_active: booleanFlag.optional(),
});

export type SupplierCreateInput = z.infer<typeof supplierCreateSchema>;
export type SupplierUpdateInput = z.infer<typeof supplierUpdateSchema>;
