import fs from 'fs';
import path from 'path';
import { pool } from '../config/database';

const FILE = path.resolve(process.cwd(), 'jordan_obgyn_medications_1000.txt');

async function main() {
  const raw = fs.readFileSync(FILE, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split('|').map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iT = idx('trade_name'), iS = idx('scientific_name'), iD = idx('default_dosage'), iI = idx('instructions');

  const meds = lines.slice(1).map((line) => {
    const parts = line.split('|');
    return {
      trade_name: (parts[iT] || '').trim(),
      scientific_name: (parts[iS] || '').trim(),
      default_dosage: (parts[iD] || '').trim() || null,
      instructions: (parts[iI] || '').trim() || null,
    };
  }).filter((m) => m.trade_name && m.scientific_name);

  console.log(`قراءة ${meds.length} دواء من الملف`);

  // منع التكرار: الحقول الموجودة مسبقاً بنفس الاسم التجاري تُحدَّث فقط
  const client = await pool.connect();
  try {
    // شرط عدم التكرار: الأدوية الموجودة مسبقاً بنفس الاسم التجاري تُتجاهل تماماً
    const existingRes = await client.query('SELECT trade_name FROM medications');
    const existing = new Set(existingRes.rows.map((r) => String(r.trade_name).toLowerCase()));

    const toInsert = meds.filter((m) => !existing.has(m.trade_name.toLowerCase()));
    console.log(`جديد: ${toInsert.length} | متجاهل (مكرر): ${meds.length - toInsert.length}`);

    let inserted = 0;
    for (let i = 0; i < toInsert.length; i += 100) {
      const chunk = toInsert.slice(i, i + 100);
      const values: unknown[] = [];
      const placeholders = chunk.map((m, idx) => {
        const b = idx * 4;
        values.push(m.trade_name, m.scientific_name, m.default_dosage, m.instructions);
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
      });
      const res = await client.query(
        `INSERT INTO medications (trade_name, scientific_name, default_dosage, instructions) VALUES ${placeholders.join(', ')}`,
        values
      );
      inserted += res.rowCount ?? 0;
    }
    const total = await client.query('SELECT COUNT(*)::int AS c FROM medications');
    console.log(`تم إدراج ${inserted} دواءً جديداً. الإجمالي الآن: ${total.rows[0].c}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error('فشل الاستيراد:', err); process.exit(1); });