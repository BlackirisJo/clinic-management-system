import './helpers/appTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * جولة إصلاح 1 — تحقّق المدخلات في تقويم العطل.
 *
 * ما يثبته هذا الملف:
 *  1) GET /api/calendar/impact بلا تاريخ (أو بتاريخ غير صالح) ⇒ 400 واضح،
 *     لا نتيجة فارغة مبنية على تاريخ افتراضي (كان 1970-01-01).
 *  2) GET /api/calendar/holidays/:id/impact بلا تاريخ يبقى صالحاً: المرجع
 *     هو تاريخ العطلة نفسها (عدم وجود تاريخ هنا ليس خطأ).
 *  3) إنشاء عطلة بـ clinic_id غير موجود ⇒ 400 (لا 500 من خطأ المفتاح
 *     الأجنبي 23503)، ولا يُنشأ أي صف.
 *
 * قاعدة الأمان: كل كتابة هنا على clinic_db_test حصراً، ويُثبَت ذلك
 * بـ SELECT current_database() قبل أول كتابة — على مجموعتَي الاتصالات:
 * مجموعة الاختبار (testPool) ومجموعة التطبيق (pool) التي تستخدمها
 * المتحكمات. إن لم يتحقق الشرط يتوقف الاختبار.
 */

import { pool as appPool } from '../config/database';
import { createHoliday, holidayImpact } from '../modules/calendar/calendar.controller';
import {
  assertTestDatabase,
  cleanupCommittedFixtures,
  createCommittedFixtures,
  futureDate,
  testPool,
} from './helpers/calendarFixtures';
import { createMockReq, createMockRes } from './helpers/controllerHarness';

const adminUser = (userId: number) => ({
  userId,
  roleName: 'SYSTEM_ADMIN',
  permissions: ['VIEW_HOLIDAYS', 'MANAGE_HOLIDAYS', 'APPROVE_HOLIDAYS', 'VIEW_SCHEDULE_IMPACT'],
  clinicId: null,
  clinicIds: [] as number[],
});

/** يثبت هوية القاعدة على كلتا مجموعتي الاتصالات قبل أي كتابة. */
const assertEveryConnectionTargetsTestDb = async (): Promise<void> => {
  const testClient = await testPool.connect();
  try {
    await assertTestDatabase(testClient);
  } finally {
    testClient.release();
  }
  const appClient = await appPool.connect();
  try {
    await assertTestDatabase(appClient);
  } finally {
    appClient.release();
  }
};

test('معاينة الأثر بلا تاريخ ⇒ 400، وبتاريخ غير صالح ⇒ 400', async (t) => {
  const fx = await createCommittedFixtures('impact-validation');
  t.after(() => cleanupCommittedFixtures(fx));
  await assertEveryConnectionTargetsTestDb();

  const missing = createMockRes();
  await holidayImpact(
    createMockReq({ user: adminUser(fx.adminUserId), query: {} }),
    missing.res
  );
  assert.equal(missing.captured.status, 400, `بلا تاريخ: ${JSON.stringify(missing.captured.body)}`);
  assert.equal(missing.captured.body.code, 'VALIDATION_ERROR');
  assert.ok(missing.captured.body.message, 'الرد يحمل رسالة عربية واضحة');
  assert.equal(missing.captured.body.impact, undefined, 'لا نتيجة أثر مزيّفة بلا تاريخ');

  const invalid = createMockRes();
  await holidayImpact(
    createMockReq({ user: adminUser(fx.adminUserId), query: { date: 'not-a-date' } }),
    invalid.res
  );
  assert.equal(invalid.captured.status, 400, `بتاريخ غير صالح: ${JSON.stringify(invalid.captured.body)}`);
  assert.equal(invalid.captured.body.code, 'VALIDATION_ERROR');

  const outOfRange = createMockRes();
  await holidayImpact(
    createMockReq({ user: adminUser(fx.adminUserId), query: { date: '2026-02-30' } }),
    outOfRange.res
  );
  assert.equal(outOfRange.captured.status, 400, 'تاريخ غير موجود فعلياً ⇒ 400');
});

test('معاينة أثر عطلة بعينها بلا تاريخ تبقى صالحة (المرجع هو تاريخ العطلة)', async (t) => {
  const fx = await createCommittedFixtures('impact-validation-holiday');
  t.after(() => cleanupCommittedFixtures(fx));
  await assertEveryConnectionTargetsTestDb();

  const date = futureDate(65);
  const created = createMockRes();
  await createHoliday(
    createMockReq({
      user: adminUser(fx.adminUserId),
      body: { holiday_date: date, clinic_id: fx.clinicId, name_ar: 'عطلة معاينة الأثر' },
    }),
    created.res
  );
  assert.equal(created.captured.status, 201, JSON.stringify(created.captured.body));
  const holidayId = Number(created.captured.body.holiday.holiday_id);

  const res = createMockRes();
  await holidayImpact(
    createMockReq({ user: adminUser(fx.adminUserId), params: { id: String(holidayId) }, query: {} }),
    res.res
  );
  assert.equal(res.captured.status, 200, JSON.stringify(res.captured.body));
  assert.equal(res.captured.body.impact.date, date, 'المرجع هو تاريخ العطلة نفسها');
});

test('إنشاء عطلة بـ clinic_id غير موجود ⇒ 400 بلا 500 وبلا صف', async (t) => {
  const fx = await createCommittedFixtures('holiday-fk-validation');
  t.after(() => cleanupCommittedFixtures(fx));
  await assertEveryConnectionTargetsTestDb();

  const date = futureDate(66);
  const missingClinicId = 9_999_999;

  const res = createMockRes();
  await createHoliday(
    createMockReq({
      user: adminUser(fx.adminUserId),
      body: { holiday_date: date, clinic_id: missingClinicId, name_ar: 'عطلة لعيادة غير موجودة' },
    }),
    res.res
  );

  assert.equal(res.captured.status, 400, `المتوقع 400 لا ${res.captured.status}: ${JSON.stringify(res.captured.body)}`);
  assert.notEqual(res.captured.status, 500, 'ليس خطأ خادم');
  assert.equal(res.captured.body.code, 'VALIDATION_ERROR');
  assert.ok(res.captured.body.message, 'الرد يحمل رسالة عربية واضحة');

  // سلبي: لا صف عطلة أُنشئ
  const rows = await testPool.query(
    `SELECT count(*)::int AS cnt FROM clinic_holidays WHERE holiday_date = $1::date`,
    [date]
  );
  assert.equal(rows.rows[0].cnt, 0, 'لم يُنشأ أي صف عطلة');
});
