import { z } from 'zod';
import { DOSAGE_FORM_CODES, isDosageForm } from '../lib/dosageForm';

// أعمدة CSV المطلوبة لدليل الأدوية (Phase 9D — الترتيب الكانوني: القوة وشكل الجرعة قبل الجرعة الافتراضية)
export const REQUIRED_CSV_COLUMNS = ['trade_name', 'scientific_name', 'strength', 'dosage_form'] as const;
export const OPTIONAL_CSV_COLUMNS = ['default_dosage', 'instructions'] as const;
export const ALL_CSV_COLUMNS = [
  'trade_name',
  'scientific_name',
  'strength',
  'dosage_form',
  'default_dosage',
  'instructions',
] as const;

// شكل الدواء: قيمة مُشغّلة من القائمة الواحدة الموحّدة (src/lib/dosageForm.ts) — بلا قائمة ثانية يدوية
const dosageFormCodeSchema = z
  .string()
  .trim()
  .min(1, 'شكل الدواء مطلوب')
  .transform((value) => value.toUpperCase())
  .refine((value) => isDosageForm(value), {
    message: `شكل الدواء غير صحيح. القيم المسموحة: ${DOSAGE_FORM_CODES.join(', ')}`,
  });

// مخطط التحقق لسطر واحد من CSV
export const medicationImportRowSchema = z.object({
  trade_name: z.string().trim().min(1, 'الاسم التجاري مطلوب').max(150, 'الاسم التجاري طويل جداً'),
  scientific_name: z.string().trim().min(1, 'الاسم العلمي مطلوب').max(150, 'الاسم العلمي طويل جداً'),
  strength: z.string().trim().min(1, 'قوة الدواء مطلوبة').max(100, 'قوة الدواء طويلة جداً'),
  dosage_form: dosageFormCodeSchema,
  default_dosage: z.union([z.string().max(100), z.null()]).optional().default(null),
  instructions: z.union([z.string().max(5000), z.null()]).optional().default(null),
});

export type MedicationImportRow = z.infer<typeof medicationImportRowSchema>;

// نتيجة التحقق من صف واحد
export interface RowValidationResult {
  rowNumber: number;
  raw: Record<string, string>;
  status: 'valid_new' | 'existing' | 'duplicate_in_file' | 'invalid';
  normalized?: MedicationImportRow;
  error?: string;
}

// نتيجة الفحص الكامل للملف
export interface ImportPreviewResult {
  totalRows: number;
  validNew: number;
  existing: number;
  duplicateInFile: number;
  invalid: number;
  validRows: MedicationImportRow[];
  invalidRows: { rowNumber: number; raw: Record<string, string>; error: string }[];
}

// نتيجة الاستيراد النهائي
export interface ImportExecutionResult {
  totalRows: number;
  added: number;
  skippedExisting: number;
  skippedDuplicate: number;
  failed: number;
}