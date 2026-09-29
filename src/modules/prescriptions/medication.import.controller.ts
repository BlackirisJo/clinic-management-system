import { Response } from 'express';
import { pool } from '../../config/database';
import { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { parse } from 'csv-parse/sync';
import {
  ALL_CSV_COLUMNS,
  medicationImportRowSchema,
  type MedicationImportRow,
  type ImportPreviewResult,
  type ImportExecutionResult,
} from '../../validations/medication.import.validation';

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_ROWS = 50000;
const BATCH_SIZE = 500;

function csvInjectionSafe(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

// قواعد الأعمدة الموحّدة — نفس القاعدة تماماً في /validate و /import (عمود ناقص أو مجهول = رفض)
function checkCsvColumns(fileColumns: string[]): { missing: string[]; unknown: string[] } {
  const allowed: readonly string[] = ALL_CSV_COLUMNS;
  return {
    missing: ALL_CSV_COLUMNS.filter((c) => !fileColumns.includes(c)),
    unknown: fileColumns.filter((c) => !allowed.includes(c)),
  };
}

// تحليل صف واحد: مسار واحد مشترك للفحص والتنفيذ (نفس القواعد ونفس رسائل الخطأ)
function parseImportRow(rawRow: Record<string, string>): { row: MedicationImportRow } | { error: string } {
  const parsed = medicationImportRowSchema.safeParse({
    trade_name: rawRow.trade_name ?? '',
    scientific_name: rawRow.scientific_name ?? '',
    strength: rawRow.strength ?? '',
    dosage_form: rawRow.dosage_form ?? '',
    default_dosage: rawRow.default_dosage && rawRow.default_dosage !== '' ? rawRow.default_dosage : null,
    instructions: rawRow.instructions && rawRow.instructions !== '' ? rawRow.instructions : null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join('؛ ') };
  }
  return {
    row: {
      ...parsed.data,
      trade_name: csvInjectionSafe(parsed.data.trade_name),
      scientific_name: csvInjectionSafe(parsed.data.scientific_name),
      strength: csvInjectionSafe(parsed.data.strength),
      default_dosage: parsed.data.default_dosage ? csvInjectionSafe(parsed.data.default_dosage) : null,
      instructions: parsed.data.instructions ? csvInjectionSafe(parsed.data.instructions) : null,
    },
  };
}

function parseCsvBuffer(buffer: Buffer): Record<string, string>[] {
  const raw = buffer.toString('utf8').replace(/^﻿/, '');
  if (!raw.trim()) throw new Error('الملف فارغ');
  return parse(raw, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: false,
    bom: true,
  });
}

export const generateMedicationTemplate = (_req: AuthenticatedRequest, res: Response) => {
  const header = ALL_CSV_COLUMNS.join(',');
  // مثال صالح بالترتيب الكانوني: trade_name, scientific_name, strength, dosage_form, default_dosage, instructions
  const exampleRow = [
    'Panadol', 'Paracetamol', '500 mg', 'TABLET', '1-2 tablets every 4-6 hours', 'Take after food',
  ].map((v) => `"${v.replace(/"/g, '""')}"`).join(',');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="medication_template.csv"');
  res.status(200).send('﻿' + header + '\n' + exampleRow + '\n');
};

export const validateMedicationImport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const file = (req as any).file;
    if (!file) return res.status(400).json({ message: 'لم يتم رفع أي ملف' });
    if (file.size > MAX_FILE_SIZE) return res.status(400).json({ message: `حجم الملف يتجاوز الحد المسموح (${MAX_FILE_SIZE / 1024 / 1024}MB)` });

    let records: Record<string, string>[];
    try { records = parseCsvBuffer(file.buffer); }
    catch (e: any) { return res.status(400).json({ message: e.message || 'فشل قراءة الملف' }); }
    if (!records.length) return res.status(400).json({ message: 'الملف لا يحتوي على صفوف' });

    const fileColumns = Object.keys(records[0] ?? {});
    const { missing, unknown } = checkCsvColumns(fileColumns);
    if (missing.length) return res.status(400).json({ message: `الأعمدة الناقصة: ${missing.join('، ')}`, missingColumns: missing });
    if (unknown.length) return res.status(400).json({ message: `أعمدة غير معروفة: ${unknown.join('، ')}`, unknownColumns: unknown });
    if (records.length > MAX_ROWS) return res.status(400).json({ message: `عدد الصفوف يتجاوز الحد المسموح (${MAX_ROWS})` });

    const existingRes = await pool.query('SELECT lower(trade_name) AS trade_name FROM medications');
    const existingNames = new Set(existingRes.rows.map((r) => r.trade_name));
    const seenInFile = new Set<string>();
    const validRows: MedicationImportRow[] = [];
    const invalidRows: { rowNumber: number; raw: Record<string, string>; error: string }[] = [];
    let existing = 0;
    let duplicateInFile = 0;

    records.forEach((rawRow, idx) => {
      const rowNumber = idx + 1;
      const parsedRow = parseImportRow(rawRow);
      if ('error' in parsedRow) { invalidRows.push({ rowNumber, raw: rawRow, error: parsedRow.error }); return; }
      const n = parsedRow.row;
      const key = n.trade_name.toLowerCase();
      if (existingNames.has(key)) { existing++; return; }
      if (seenInFile.has(key)) { duplicateInFile++; return; }
      seenInFile.add(key);
      validRows.push(n);
    });

    const preview: ImportPreviewResult = { totalRows: records.length, validNew: validRows.length, existing, duplicateInFile, invalid: invalidRows.length, validRows, invalidRows };
    return res.status(200).json({ preview });
  } catch (error: any) {
    console.error('Validate Medication Import Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء فحص الملف' });
  }
};
// 3) تنفيذ الاستيراد النهائي بـ Transaction
export const executeMedicationImport = async (req: AuthenticatedRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const file = (req as any).file;
    if (!file) return res.status(400).json({ message: 'لم يتم رفع أي ملف' });
    if (file.size > MAX_FILE_SIZE) return res.status(400).json({ message: `حجم الملف يتجاوز الحد المسموح (${MAX_FILE_SIZE / 1024 / 1024}MB)` });

    let records: Record<string, string>[];
    try {
      records = parseCsvBuffer(file.buffer);
    } catch (e: any) {
      return res.status(400).json({ message: e.message || 'فشل قراءة الملف' });
    }
    if (!records.length) return res.status(400).json({ message: 'الملف لا يحتوي على صفوف' });

    const fileColumns = Object.keys(records[0] ?? {});
    const { missing, unknown } = checkCsvColumns(fileColumns);
    if (missing.length) return res.status(400).json({ message: `الأعمدة الناقصة: ${missing.join('، ')}`, missingColumns: missing });
    if (unknown.length) return res.status(400).json({ message: `أعمدة غير معروفة: ${unknown.join('، ')}`, unknownColumns: unknown });

    const existingRes = await client.query('SELECT lower(trade_name) AS trade_name FROM medications');
    const existingNames = new Set(existingRes.rows.map((r) => r.trade_name));
    const seenInFile = new Set<string>();
    const toInsert: MedicationImportRow[] = [];
    let skippedExisting = 0;
    let skippedDuplicate = 0;
    let failed = 0;

    // الصفوف غير الصالحة تُعدّ ولا تُسقط بصمت — لتطابق النتيجة مع معاينة /validate وتفادي
    // إيهام المستخدم بأن كل الصفوف استُوردت.
    records.forEach((rawRow) => {
      const parsedRow = parseImportRow(rawRow);
      if ('error' in parsedRow) { failed++; return; }
      const normalized = parsedRow.row;
      const key = normalized.trade_name.toLowerCase();
      if (existingNames.has(key)) { skippedExisting++; return; }
      if (seenInFile.has(key)) { skippedDuplicate++; return; }
      seenInFile.add(key);
      toInsert.push(normalized);
    });

    if (!toInsert.length && failed === 0) {
      const result: ImportExecutionResult = { totalRows: records.length, added: 0, skippedExisting, skippedDuplicate, failed };
      return res.status(200).json({ message: 'لا توجد أدوية جديدة لإضافتها', result });
    }
    if (!toInsert.length) {
      const result: ImportExecutionResult = { totalRows: records.length, added: 0, skippedExisting, skippedDuplicate, failed };
      return res.status(200).json({
        message: failed === records.length ? 'ملف غير صالح: لم يحتوِ على أي صف مقروء صحيح' : `تم رفض ${failed} صفاً غير صالح`,
        result,
      });
    }

    await client.query('BEGIN');
    let added = 0;
    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const chunk = toInsert.slice(i, i + BATCH_SIZE);
      const values: unknown[] = [];
      const placeholders = chunk.map((m, idx) => {
        const b = idx * 6;
        values.push(m.trade_name, m.scientific_name, m.strength, m.dosage_form, m.default_dosage, m.instructions);
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
      });
      const insertRes = await client.query(
        `INSERT INTO medications (trade_name, scientific_name, strength, dosage_form, default_dosage, instructions)
         VALUES ${placeholders.join(', ')} RETURNING medication_id`,
        values,
      );
      added += insertRes.rowCount ?? 0;
    }

    await client.query(
      `INSERT INTO audit_logs (user_id, clinic_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'MEDICATIONS_IMPORTED', 'MEDICATION', null, $3)`,
      [req.user?.userId ?? null, req.user?.clinicId ?? null, JSON.stringify({ totalRows: records.length, added, skippedExisting, skippedDuplicate, failed })],
    );
    await client.query('COMMIT');

    const result: ImportExecutionResult = { totalRows: records.length, added, skippedExisting, skippedDuplicate, failed };
    const message = failed > 0
      ? `تم استيراد ${added} دواء بنجاح، وتخطّي ${skippedExisting} موجودة و${skippedDuplicate} مكررة، ورفض ${failed} صفاً غير صالح`
      : `تم استيراد ${added} دواء بنجاح`;
    return res.status(201).json({ message, result });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Execute Medication Import Error:', error);
    return res.status(500).json({ message: 'حدث خطأ أثناء الاستيراد' });
  } finally {
    client.release();
  }
};
