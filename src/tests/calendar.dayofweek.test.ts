import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * T7 — حساب يوم الأسبوع (R3).
 *
 * العيب كان: day_of_week = new Date('YYYY-MM-DD').getDay() في ذاكرة Node،
 * أي في منطقة زمنية العملية لا المنطقة الزمنية للعيادة. في أي منطقة UTC−
 * (مثل America/New_York) ينزاح اليوم يوماً كاملاً ⇒ جدول خاطئ أو رفض حجز خاطئ.
 *
 * البديل المعتمد: EXTRACT(DOW FROM date) داخل PostgreSQL — مستقل عن المنطقة
 * الزمنية تماماً، ومطابق تماماً لقيود 054 (CHECK 0..6).
 *
 * ما يثبته هذا الاختبار:
 *  1) EXTRACT(DOW) يطابق اليوم الحقيقي للتاريخ (0=الأحد).
 *  2) EXTRACT(DOW) لا يتغيّر بتغيّر منطقة العملية الزمنية.
 *  3) getDay() يتغيّر فعلاً بين المناطق ⇒ العجز كان حقيقياً لا نظرياً.
 *  4) لاController يستعمل getDay() بعد anymore (حارس ضد التراجع).
 */

import { testPool } from './helpers/calendarFixtures';

const DATES: { date: string; dow: number; name: string }[] = [
  { date: '2026-12-20', dow: 0, name: 'الأحد' },
  { date: '2026-12-21', dow: 1, name: 'الاثنين' },
  { date: '2026-12-25', dow: 5, name: 'الجمعة' },
  { date: '2026-12-26', dow: 6, name: 'السبت' },
  { date: '2027-01-01', dow: 5, name: 'الجمعة' },
  { date: '2028-02-29', dow: 2, name: 'الثلاثاء (سنة كبيسة)' },
];

const queryDow = async (date: string): Promise<number> => {
  const { rows } = await testPool.query('SELECT EXTRACT(DOW FROM $1::date)::int AS dow', [date]);
  return Number(rows[0].dow);
};

test('EXTRACT(DOW) يطابق اليوم الحقيقي للتاريخ', async () => {
  for (const item of DATES) {
    assert.equal(await queryDow(item.date), item.dow, `${item.date} يجب أن يكون ${item.name}`);
  }
});

test('EXTRACT(DOW) لا يتأثر بمنطقة العملية الزمنية (سلّم ثابت)', async () => {
  const originalTz = process.env.TZ;
  const zones = ['UTC', 'Asia/Amman', 'America/New_York', 'Pacific/Kiritimati'];
  try {
    for (const zone of zones) {
      process.env.TZ = zone;
      for (const item of DATES) {
        assert.equal(
          await queryDow(item.date),
          item.dow,
          `${item.date} تحت ${zone} يجب أن يبقى ${item.name}`
        );
      }
    }
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('getDay() ينزاح فعلاً في المناطق السالبة — العجز كان حقيقياً (contrast)', async () => {
  const originalTz = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Amman';
    const amman = new Date('2026-12-25').getDay();
    process.env.TZ = 'America/New_York';
    const newYork = new Date('2026-12-25').getDay();

    assert.equal(amman, 5, 'في توقيت الشرق (Asia/Amman) يعطي getDay() الجمعة');
    assert.equal(newYork, 4, 'في America/New_York يعطي الخميس — انزياح يوم كامل');
    assert.notEqual(amman, newYork, 'السلوك يختلف بين المناطق — هذا سبب العجز');
    assert.equal(await queryDow('2026-12-25'), 5, 'والمصدر البديل يبقى الجمعة دائماً');
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('حارس: لا Controller يستعمل getDay() anymore', () => {
  // يعمل في الحالتين: تشغيل من المصدر (tsx) وتشغيل من dist بعد البناء.
  const resolveSource = (relative: string): string => {
    const candidates = [
      path.join(__dirname, '..', 'modules', `${relative}.ts`),
      path.join(__dirname, '..', 'modules', `${relative}.js`),
      path.join(__dirname, '..', '..', 'src', 'modules', `${relative}.ts`),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    assert.ok(found, `لم يُعثر على مصدر ${relative}`);
    return found as string;
  };

  const sources = [
    resolveSource('appointments/appointments.controller'),
    resolveSource('doctorSchedules/doctorSchedules.controller'),
    resolveSource('clinical/visits.controller'),
  ];
  for (const source of sources) {
    // التعليقات تُستثنى: يذكر الكود القديم سبب العجز في تعليق.
    const code = fs
      .readFileSync(source, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    assert.ok(
      !code.includes('getDay()'),
      `${path.basename(source)} ما زال يستعمل getDay() — استخدم EXTRACT(DOW) من قاعدة البيانات`
    );
  }
});
