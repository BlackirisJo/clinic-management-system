import fs from 'fs';
import path from 'path';
import { pool } from '../config/database';

/**
 * سكربت استيراد دليل الأدوية الأردنية من ملف jordan_medications.txt
 * الاستخدام: npm run seed:medications (أو npx ts-node src/scripts/importMedications.ts)
 * - يتجاوز الأدوية الموجودة مسبقاً (مطابقة حسب trade_name)
 * - يدخل الباقي على شكل دفعات (chunks)
 */

const FILE_PATH = path.resolve(process.cwd(), 'jordan_medications.txt');
const CHUNK_SIZE = 50;

interface MedicationRow {
  trade_name: string;
  scientific_name: string;
  default_dosage: string | null;
  instructions: string | null;
}

function parseFile(): MedicationRow[] {
  const raw = fs.readFileSync(FILE_PATH, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const rows: MedicationRow[] = [];
  for (const line of lines) {
    const cols = line.split('|').map((c) => c.trim());
    if (cols.length < 4) continue;
    // تخطي سطر العناوين
    if ((cols[0] ?? '').toLowerCase() === 'trade_name') continue;
    const [trade_name, scientific_name, default_dosage, ...rest] = cols;
    if (!trade_name || !scientific_name) continue;
    // التعليمات قد تحتوي على '|' داخلها — نعيد دمج البقية
    rows.push({
      trade_name,
      scientific_name,
      default_dosage: default_dosage || null,
      instructions: rest.join(' | ') || null,
    });
  }
  return rows;
}

async function existingTradeNames(): Promise<Set<string>> {
  const result = await pool.query<{ trade_name: string }>(`SELECT trade_name FROM medications`);
  return new Set(result.rows.map((r) => r.trade_name.toLowerCase()));
}

async function importMedications() {
  const rows = parseFile();
  console.log(`✔ تم قراءة ${rows.length} دوماً من الملف`);

  const existing = await existingTradeNames();
  const toInsert = rows.filter((r) => !existing.has(r.trade_name.toLowerCase()));
  console.log(`✔ ${toInsert.length} دوماً جديداً سيتم إدخاله (${rows.length - toInsert.length} موجود مسبقاً)`);
  if (toInsert.length === 0) {
    console.log('لا يوجد جديد للإدخال. تم.');
    return;
  }

  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CHUNK_SIZE);
    const values: unknown[] = [];
    const placeholders = chunk.map((m, idx) => {
      const b = idx * 4;
      values.push(m.trade_name, m.scientific_name, m.default_dosage, m.instructions);
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
    });
    const result = await pool.query(
      `INSERT INTO medications (trade_name, scientific_name, default_dosage, instructions)
       VALUES ${placeholders.join(', ')}
       RETURNING medication_id`,
      values
    );
    inserted += result.rowCount ?? 0;
    console.log(`  ⤷ دفعة ${Math.floor(i / CHUNK_SIZE) + 1}: ${result.rowCount} دواء`);
  }

  console.log(`✅ تم إدخال ${inserted} دوماً بنجاح`);
}

importMedications()
  .catch((error) => {
    console.error('✖ فشل استيراد الأدوية:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
