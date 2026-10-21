import './helpers/appTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * T4 — أثر تغيير تقويمي (نقل عطلة من A إلى B).
 *
 * القواعد التي يثبتها هذا الاختبار:
 *  1) نقل عطلة إلى تاريخ آخر يؤثر على مواعيد قائمة ⇒ 409 مع تقرير الأثر،
 *     ولا يتغيّر شيء في القاعدة قبل التأكيد الصريح.
 *  2) مع confirm_impact ⇒ يُطبَّق التغيير، والمواعيد تبقى SCHEDULED
 *     (لا إلغاء ولا حذف صامت)، ويُسجَّل التغيير في calendar_changes
 *     وتُنشأ مهام تواصل يدوية بحالة صريحة.
 */

import { createHoliday, updateHoliday, cancelHoliday } from '../modules/calendar/calendar.controller';
import { testPool, createCommittedFixtures, cleanupCommittedFixtures, futureDate } from './helpers/calendarFixtures';
import { createMockReq, createMockRes } from './helpers/controllerHarness';

const adminUser = (userId: number) => ({
  userId,
  roleName: 'SYSTEM_ADMIN',
  permissions: ['VIEW_HOLIDAYS', 'MANAGE_HOLIDAYS', 'APPROVE_HOLIDAYS', 'VIEW_SCHEDULE_IMPACT'],
  clinicId: null,
  clinicIds: [] as number[],
});

test('نقل عطلة يؤثر على مواعيد قائمة: 409 مع الأثر، ولا يتغيّر شيء قبل التأكيد', async (t) => {
  const fx = await createCommittedFixtures('impact');
  const adminId = fx.adminUserId;
  t.after(() => cleanupCommittedFixtures(fx));

  const dateA = futureDate(70);
  const dateB = futureDate(71);

  const client = await testPool.connect();
  try {
    // موعدان: واحد على A وآخر على B — كلاهما قائم قبل النقل.
    await client.query(
      `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_date, start_time, end_time, status)
       VALUES ($1, $2, $3, $4::date, '09:00', '09:30', 'SCHEDULED')`,
      [fx.clinicId, fx.patientId, fx.doctorId, dateA]
    );
    await client.query(
      `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_date, start_time, end_time, status)
       VALUES ($1, $2, $3, $4::date, '10:00', '10:30', 'SCHEDULED')`,
      [fx.clinicId, fx.patientId, fx.doctorId, dateB]
    );
  } finally {
    client.release();
  }

  // إنشاء العطلة على A
  const createRes = createMockRes();
  await createHoliday(
    createMockReq({
      user: adminUser(adminId),
      body: { holiday_date: dateA, clinic_id: fx.clinicId, name_ar: 'عطلة اختبار الأثر' },
    }),
    createRes.res
  );
  assert.equal(createRes.captured.status, 201, JSON.stringify(createRes.captured.body));
  const holidayId = Number(createRes.captured.body.holiday.holiday_id);

  // ——— محاولة النقل بلا تأكيد ———
  const rejected = createMockRes();
  await updateHoliday(
    createMockReq({
      user: adminUser(adminId),
      params: { id: String(holidayId) },
      body: { holiday_date: dateB },
    }),
    rejected.res
  );

  assert.equal(rejected.captured.status, 409, 'النقل بلا تأكيد يجب أن يُرفض');
  assert.equal(rejected.captured.body.code, 'IMPACT_CONFIRMATION_REQUIRED');
  assert.ok(rejected.captured.body.impact?.from, 'التقرير يجب أن يصف أثر التاريخ القديم');
  assert.ok(rejected.captured.body.impact?.to, 'التقرير يجب أن يصف أثر التاريخ الجديد');
  assert.equal(rejected.captured.body.impact.from.appointment_count, 1, 'أثر التاريخ القديم: موعد واحد');
  assert.equal(rejected.captured.body.impact.to.appointment_count, 1, 'أثر التاريخ الجديد: موعد واحد');

  // T4: الأثر لا يقتصر على العدد فقط — يجب أن يُعرض العيادات، الأطباء،
  // ومعرفات المواعيد المتأثرة (لأن التقرير يُستخدم لاتخاذ قرار الانتقال).
  const fromIds = (rejected.captured.body.impact.from.appointments ?? []).map((a: any) => a.appointment_id);
  const toIds = (rejected.captured.body.impact.to.appointments ?? []).map((a: any) => a.appointment_id);
  assert.equal(fromIds.length, 1, 'أثر التاريخ القديم يعرض موعداً واحداً');
  assert.equal(toIds.length, 1, 'أثر التاريخ الجديد يعرض موعداً واحداً');
  assert.ok(Number.isInteger(fromIds[0]) && fromIds[0] > 0, 'معرّف الموعد في الأثر هو integer فعلي');
  assert.ok(Number.isInteger(toIds[0]) && toIds[0] > 0, 'معرّف الموعد في الأثر هو integer فعلي');
  assert.notEqual(fromIds[0], toIds[0], 'المواعيد على تاريخين مختلفين هي معرفات مختلفة');

const fromClinics = (rejected.captured.body.impact.from.clinics ?? []).map((c: any) => ({ id: Number(c.clinic_id), name: String(c.clinic_name ?? '') }));
  const toClinics = (rejected.captured.body.impact.to.clinics ?? []).map((c: any) => ({ id: Number(c.clinic_id), name: String(c.clinic_name ?? '') }));
  assert.equal(fromClinics.length, 1, 'أثر التاريخ القديم يعرض عيادة واحدة');
  assert.equal(toClinics.length, 1, 'أثر التاريخ الجديد يعرض عيادة واحدة');
  assert.equal(fromClinics[0].id, fx.clinicId, 'العيادة في الأثر هي العيادة التي أُنشِئَت فيها العطلة');
  assert.equal(toClinics[0].id, fx.clinicId, 'العيادة في الأثر هي العيادة التي أُنشِئَت فيها العطلة');
  assert.ok(fromClinics[0].name.length > 0, 'اسم العيادة في الأثر غير فارغ');
  assert.ok(toClinics[0].name.length > 0, 'اسم العيادة في الأثر غير فارغ');

  const fromDoctors = (rejected.captured.body.impact.from.doctors ?? []).map((d: any) => ({ id: Number(d.doctor_id), name: String(d.full_name ?? '') }));
  const toDoctors = (rejected.captured.body.impact.to.doctors ?? []).map((d: any) => ({ id: Number(d.doctor_id), name: String(d.full_name ?? '') }));
  assert.equal(Number(fromDoctors[0].id), fx.doctorId, 'طبيب في الأثر هو الطبيب الذي حُجز له الموعد');
  assert.equal(Number(toDoctors[0].id), fx.doctorId, 'طبيب في الأثر هو الطبيب الذي حُجز له الموعد');
  assert.ok(fromDoctors[0].name.length > 0, 'اسم الطبيب الكامل في الأثر غير فارغ');
  assert.ok(toDoctors[0].name.length > 0, 'اسم الطبيب الكامل في الأثر غير فارغ');

  // T4: معرفات المواعيد في الأثر تطابق ما أُدخل فعلياً (وليس فقط وجودها)
  const insertedOnA = await testPool.query(
    `SELECT appointment_id FROM appointments WHERE clinic_id = $1 AND doctor_id = $2 AND appointment_date = $3::date AND status = 'SCHEDULED'`,
    [fx.clinicId, fx.doctorId, dateA]
  );
  const insertedOnB = await testPool.query(
    `SELECT appointment_id FROM appointments WHERE clinic_id = $1 AND doctor_id = $2 AND appointment_date = $3::date AND status = 'SCHEDULED'`,
    [fx.clinicId, fx.doctorId, dateB]
  );
  assert.equal(Number(insertedOnA.rows[0].appointment_id), fromIds[0], 'معرّف الموعد في الأثر (التاريخ القديم) يطابق الموعد المُدخل فعلياً');
  assert.equal(Number(insertedOnB.rows[0].appointment_id), toIds[0], 'معرّف الموعد في الأثر (التاريخ الجديد) يطابق الموعد المُدخل فعلياً');

  // سلبي: لم يتغيّر شيء
  const check = await testPool.query(`SELECT holiday_date FROM clinic_holidays WHERE holiday_id = $1`, [holidayId]);
  assert.equal(String(check.rows[0].holiday_date), dateA, 'العطلة لم تُنقل قبل التأكيد');
  const noMove = await testPool.query(
    `SELECT count(*)::int AS cnt FROM calendar_changes WHERE change_type = 'HOLIDAY_MOVED' AND entity_id = $1`,
    [holidayId]
  );
  assert.equal(noMove.rows[0].cnt, 0, 'لا يُسجَّل نقل لم يُطبَّق');

  // ——— النقل مع التأكيد الصريح ———
  const confirmed = createMockRes();
  await updateHoliday(
    createMockReq({
      user: adminUser(adminId),
      params: { id: String(holidayId) },
      body: { holiday_date: dateB, confirm_impact: true },
    }),
    confirmed.res
  );
  assert.equal(confirmed.captured.status, 200, JSON.stringify(confirmed.captured.body));

  const moved = await testPool.query(`SELECT holiday_date FROM clinic_holidays WHERE holiday_id = $1`, [holidayId]);
  assert.equal(String(moved.rows[0].holiday_date), dateB, 'العطلة نُقلت إلى التاريخ الجديد');

  // المواعيد باقية ولم تُلغَ
  const appointments = await testPool.query(
    `SELECT appointment_date, status FROM appointments WHERE doctor_id = $1 AND clinic_id = $2 ORDER BY appointment_date`,
    [fx.doctorId, fx.clinicId]
  );
  assert.equal(appointments.rows.length, 2, 'لا يُحذف أي موعد');
  for (const row of appointments.rows) {
    assert.equal(row.status, 'SCHEDULED', 'الموعد لم يُلغَ بصمت');
  }

  // سجلّ التغيير
  const changes = await testPool.query(
    `SELECT change_type, from_date, to_date, decision, notification_status
     FROM calendar_changes WHERE entity_type = 'HOLIDAY' AND entity_id = $1 ORDER BY change_id DESC LIMIT 1`,
    [holidayId]
  );
  const change = changes.rows[0];
  assert.equal(change.change_type, 'HOLIDAY_MOVED');
  assert.equal(String(change.from_date), dateA);
  assert.equal(String(change.to_date), dateB);
  assert.equal(change.decision, 'CONFIRMED');
  assert.equal(change.notification_status, 'PENDING_CONTACT');

  // مهام التواصل اليدوية (لا ادعاء بإبلاغ المرضى)
  const moveTasks = await testPool.query(
    `SELECT n.status, n.channel, a.appointment_date
     FROM calendar_change_notifications n
     JOIN calendar_changes c ON c.change_id = n.change_id
     LEFT JOIN appointments a ON a.appointment_id = n.appointment_id
     WHERE c.entity_type = 'HOLIDAY' AND c.entity_id = $1 AND c.change_type = 'HOLIDAY_MOVED'`,
    [holidayId]
  );
  assert.equal(moveTasks.rows.length, 1, 'مهمة تواصل واحدة للموعد المتعارض بعد النقل');
  assert.equal(moveTasks.rows[0].status, 'PENDING_CONTACT');
  assert.equal(moveTasks.rows[0].channel, 'MANUAL');
  assert.equal(String(moveTasks.rows[0].appointment_date), dateB, 'المهمة تخص الموعد على التاريخ الجديد');

  // مهمة الأصل (الموعد على التاريخ القديم) لم تعد ذات معنى ⇒ تُغلق بـ'SKIPPED'
  const createTasks = await testPool.query(
    `SELECT n.status
     FROM calendar_change_notifications n
     JOIN calendar_changes c ON c.change_id = n.change_id
     WHERE c.entity_type = 'HOLIDAY' AND c.entity_id = $1 AND c.change_type = 'HOLIDAY_CREATED'`,
    [holidayId]
  );
  assert.equal(createTasks.rows.length, 1, 'مهمة عند إنشاء العطلة فوق موعد قائم');
  assert.equal(createTasks.rows[0].status, 'SKIPPED', 'زوال التعارض يُغلق المهمة المعلّقة');

  // سجل التدقيق
  const audit = await testPool.query(
    `SELECT count(*)::int AS cnt FROM audit_logs WHERE action = 'CALENDAR_HOLIDAY_MOVED' AND resource_id = $1`,
    [String(holidayId)]
  );
  assert.ok(audit.rows[0].cnt > 0, 'نقل العطلة مسجّل في audit_logs');
});

test('إلغاء العطلة: يسري فوراً ويغلق مهام التواصل المعلّقة', async (t) => {
  const fx = await createCommittedFixtures('impact-cancel');
  const adminId = fx.adminUserId;
  t.after(() => cleanupCommittedFixtures(fx));

  const date = futureDate(72);
  const createRes = createMockRes();
  await createHoliday(
    createMockReq({
      user: adminUser(adminId),
      body: { holiday_date: date, clinic_id: fx.clinicId, name_ar: 'عطلة قابلة للإلغاء' },
    }),
    createRes.res
  );
  assert.equal(createRes.captured.status, 201, JSON.stringify(createRes.captured.body));
  const holidayId = Number(createRes.captured.body.holiday.holiday_id);

  const cancelRes = createMockRes();
  await cancelHoliday(
    createMockReq({
      user: adminUser(adminId),
      params: { id: String(holidayId) },
      body: { reason: 'إلغاء تجريبي' },
    }),
    cancelRes.res
  );
  assert.equal(cancelRes.captured.status, 200, JSON.stringify(cancelRes.captured.body));
  assert.equal(cancelRes.captured.body.holiday.status, 'CANCELLED');
  assert.equal(cancelRes.captured.body.notification_status, 'SKIPPED');

  const row = await testPool.query(`SELECT status, cancellation_reason FROM clinic_holidays WHERE holiday_id = $1`, [holidayId]);
  assert.equal(row.rows[0].status, 'CANCELLED', 'الإلغاء حالة لا حذف');
  assert.equal(row.rows[0].cancellation_reason, 'إلغاء تجريبي');
});
