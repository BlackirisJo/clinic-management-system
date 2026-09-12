import { z } from 'zod';

// أعمدة CSV المطلوبة لدليل الأدوية
export const REQUIRED_CSV_COLUMNS = ['trade_name', 'scientific_name'] as const;
export const OPTIONAL_CSV_COLUMNS = ['default_dosage', 'instructions'] as const;
export const ALL_CSV_COLUMNS = [...REQUIRED_CSV_COLUMNS, ...OPTIONAL_CSV_COLUMNS] as const;

// مخطط التحقق لسطر واحد من CSV
export const medicationImportRowSchema = z.object({
  trade_name: z.string().trim().min(1, 'الاسم التجاري مطلوب').max(150, 'الاسم التجاري طويل جداً'),
  scientific_name: z.string().trim().min(1, 'الاسم العلمي مطلوب').max(150, 'الاسم العلمي طويل جداً'),
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