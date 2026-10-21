import './helpers/appTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * T8 — مسار موعد المتابعة في إنهاء الزيارة.
 *
 * العجز الأصلي (R6): المسار يزرع 09:00–09:30 ثابتة بلا فحص جدول عمل الطبيب
 * ولا العطل، وداخل معاملة ROLLBACK ⇒ أي رفض future على هذا الـINSERT يُفقد
 * كامل تحديث الزيارة ويُعيد 500.
 *
 * ما يثبته هذا الاختبار:
 *  1) إنهاء زيارة بتاريخ متابعة في يوم عطلة ⇒ 409 برسالة واضحة (لا 500)،
 *     ولا أثر جزئي: حالة الزيارة لم تتغيّر ولم يُنشأ موعد متابعة.
 *  2) بعد إلغاء العطلة ⇒ ينجح المسار ويُنشئ موعد متابعة داخل نافذة عمل الطبيب.
 */

import { updateVisitClinical } from '../modules/clinical/visits.controller';
import { testPool, createCommittedFixtures, cleanupCommittedFixtures, futureDate } from './helpers/calendarFixtures';
import { createMockReq, createMockRes } from './helpers/controllerHarness';

const doctorUser = (userId: number, clinicId: number) => ({
  userId,
  roleName: 'DOCTOR',
  permissions: ['CREATE_VISIT'],
  clinicId,
  clinicIds: [clinicId],
});

test('إنهاء زيارة بمتابعة في يوم عطلة ⇒ 409 واضح بلا 500 وبلا أثر جزئي', async (t) => {
  const fx = await createCommittedFixtures('visits-followup');
  t.after(() => cleanupCommittedFixtures(fx));

  const followUpDate = futureDate(90);

  const visit = await testPool.query(
    `INSERT INTO visits (patient_id, clinic_id, doctor_id, visit_date, chief_complaint, visit_status)
     VALUES ($1, $2, $3, NOW(), 'شكوى اختبار', 'OPEN') RETURNING visit_id`,
    [fx.patientId, fx.clinicId, fx.doctorId]
  );
  const visitId = Number(visit.rows[0].visit_id);

  // عطلة رسمية في تاريخ المتابعة
  await testPool.query(
    `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
     VALUES ($1::date, $2, 'عطلة يوم المتابعة', 'OFFICIAL', 'ACTIVE')`,
    [followUpDate, fx.clinicId]
  );

  const res = createMockRes();
  await updateVisitClinical(
    createMockReq({
      user: doctorUser(fx.doctorId, fx.clinicId),
      params: { visitId: String(visitId) },
      body: {
        visit_status: 'COMPLETED',
        next_visit_date: `${followUpDate}T09:00:00.000Z`,
        follow_up_plan: 'متابعة بعد أسبوع',
      },
    }),
    res.res
  );

  assert.equal(res.captured.status, 409, `المتوقع 409 لا ${res.captured.status}: ${JSON.stringify(res.captured.body)}`);
  assert.ok(res.captured.body?.message, 'الرد يجب أن يحمل رسالة عربية واضحة');
  assert.notEqual(res.captured.status, 500, 'ليس خطأ خادم');

  // لا أثر جزئي: الزيارة لم تُغلق ولم يُنشأ موعد متابعة
  const after = await testPool.query(`SELECT visit_status FROM visits WHERE visit_id = $1`, [visitId]);
  assert.equal(after.rows[0].visit_status, 'OPEN', 'تحديث الزيارة لم يُحفظ جزئياً');

  const appointments = await testPool.query(
    `SELECT count(*)::int AS cnt FROM appointments WHERE visit_id = $1`,
    [visitId]
  );
  assert.equal(appointments.rows[0].cnt, 0, 'لم يُنشأ موعد متابعة');
});

test('بعد إلغاء العطلة: المسار ينجح وموعد المتابعة داخل نافذة عمل الطبيب', async (t) => {
  const fx = await createCommittedFixtures('visits-followup-ok');
  t.after(() => cleanupCommittedFixtures(fx));

  const followUpDate = futureDate(91);

  const visit = await testPool.query(
    `INSERT INTO visits (patient_id, clinic_id, doctor_id, visit_date, chief_complaint, visit_status)
     VALUES ($1, $2, $3, NOW(), 'شكوى اختبار', 'OPEN') RETURNING visit_id`,
    [fx.patientId, fx.clinicId, fx.doctorId]
  );
  const visitId = Number(visit.rows[0].visit_id);

  // نافذة عمل الطبيب في ذلك اليوم: 14:00–20:00
  const dow = await testPool.query('SELECT EXTRACT(DOW FROM $1::date)::int AS dow', [followUpDate]);
  await testPool.query(
    `INSERT INTO doctor_schedules (doctor_id, clinic_id, day_of_week, start_time, end_time, is_working_day)
     VALUES ($1, $2, $3, '14:00', '20:00', TRUE)`,
    [fx.doctorId, fx.clinicId, dow.rows[0].dow]
  );

  const holiday = await testPool.query(
    `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
     VALUES ($1::date, $2, 'عطلة مؤقتة', 'OFFICIAL', 'ACTIVE') RETURNING holiday_id`,
    [followUpDate, fx.clinicId]
  );

  // أول محاولة: مرفوضة
  const rejected = createMockRes();
  await updateVisitClinical(
    createMockReq({
      user: doctorUser(fx.doctorId, fx.clinicId),
      params: { visitId: String(visitId) },
      body: { visit_status: 'COMPLETED', next_visit_date: `${followUpDate}T09:00:00.000Z` },
    }),
    rejected.res
  );
  assert.equal(rejected.captured.status, 409);

  // إلغاء العطلة
  await testPool.query(
    `UPDATE clinic_holidays SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP WHERE holiday_id = $1`,
    [holiday.rows[0].holiday_id]
  );

  // ثاني محاولة: تنجح
  const accepted = createMockRes();
  await updateVisitClinical(
    createMockReq({
      user: doctorUser(fx.doctorId, fx.clinicId),
      params: { visitId: String(visitId) },
      body: {
        visit_status: 'COMPLETED',
        next_visit_date: `${followUpDate}T09:00:00.000Z`,
        follow_up_plan: 'متابعة',
      },
    }),
    accepted.res
  );
  assert.equal(accepted.captured.status, 200, JSON.stringify(accepted.captured.body));

  const appointment = await testPool.query(
    `SELECT appointment_date, start_time, end_time, status FROM appointments WHERE visit_id = $1`,
    [visitId]
  );
  assert.equal(appointment.rows.length, 1, 'موعد متابعة واحد');
  assert.equal(String(appointment.rows[0].appointment_date), followUpDate);
  assert.equal(String(appointment.rows[0].start_time), '14:00:00', 'النافذة مشتقّة من جدول عمل الطبيب');
  assert.equal(String(appointment.rows[0].end_time), '14:30:00');
  assert.equal(appointment.rows[0].status, 'SCHEDULED');
});

test('موعد المتابعة يتوقّف عند قفل (العيادة، اليوم) — القفل مأخوذ قبل الفحص والإدراج', async (t) => {
  const fx = await createCommittedFixtures('visits-followup-lock');
  t.after(() => cleanupCommittedFixtures(fx));

  const followUpDate = futureDate(95);

  const visit = await testPool.query(
    `INSERT INTO visits (patient_id, clinic_id, doctor_id, visit_date, chief_complaint, visit_status)
     VALUES ($1, $2, $3, NOW(), 'شكوى اختبار', 'OPEN') RETURNING visit_id`,
    [fx.patientId, fx.clinicId, fx.doctorId]
  );
  const visitId = Number(visit.rows[0].visit_id);

  const dow = await testPool.query('SELECT EXTRACT(DOW FROM $1::date)::int AS dow', [followUpDate]);
  await testPool.query(
    `INSERT INTO doctor_schedules (doctor_id, clinic_id, day_of_week, start_time, end_time, is_working_day)
     VALUES ($1, $2, $3, '14:00', '20:00', TRUE)`,
    [fx.doctorId, fx.clinicId, dow.rows[0].dow]
  );

  const body = {
    visit_status: 'COMPLETED',
    next_visit_date: `${followUpDate}T09:00:00.000Z`,
    follow_up_plan: 'متابعة',
  };

  const runFollowUp = async () => {
    const res = createMockRes();
    let settled = false;
    const started = Date.now();
    const pending = updateVisitClinical(
      createMockReq({
        user: doctorUser(fx.doctorId, fx.clinicId),
        params: { visitId: String(visitId) },
        body,
      }),
      res.res
    ).then(
      () => { settled = true; },
      () => { settled = true; }
    );
    return { res, pending, isSettled: () => settled, elapsed: () => Date.now() - started };
  };

  // خط الأساس: بلا حائز القفل ⇒ المسار ينجح
  const baseline = await runFollowUp();
  await baseline.pending;
  assert.equal(baseline.res.captured.status, 200, JSON.stringify(baseline.res.captured.body));
  const baselineMs = baseline.elapsed();
  // نافذة الانتظار: ثلاثة أضعاف زمن التنفيذ المعتاد (أو 400ms، أيهما أكبر)
  const waitMs = Math.max(400, baselineMs * 3);

  // ——— الضابط: قفل على يوم آخر لا يوقف المسار ———
  // يثبت أن التوقف في الحالة التالية سببه مفتاح (العيادة، اليوم) بالذات،
  // لا بطء عام في البيئة.
  const otherDate = futureDate(96);
  const controlHolder = await testPool.connect();
  t.after(async () => {
    await controlHolder.query('ROLLBACK').catch(() => undefined);
    controlHolder.release();
  });
  await controlHolder.query('BEGIN');
  await controlHolder.query(
    'SELECT pg_advisory_xact_lock($1::int, (EXTRACT(EPOCH FROM $2::date) / 86400)::int)',
    [fx.clinicId, otherDate]
  );
  const control = await runFollowUp();
  await control.pending;
  assert.equal(control.res.captured.status, 200, 'قفل يوم آخر لا يوقف المسار');
  assert.equal(control.isSettled(), true);
  await controlHolder.query('ROLLBACK');

  // ——— الإثبات: قفل على نفس (العيادة، اليوم) يوقف المسار ———
  // نفس مفتاح القفل ونفس دالته المستعملة في مسار الحجز
  // (appointments.controller.ts) — في جلسة مختلفة عن جلسة التطبيق.
  const holder = await testPool.connect();
  t.after(async () => {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  });
  await holder.query('BEGIN');
  await holder.query(
    'SELECT pg_advisory_xact_lock($1::int, (EXTRACT(EPOCH FROM $2::date) / 86400)::int)',
    [fx.clinicId, followUpDate]
  );

  const blocked = await runFollowUp();

  await new Promise((resolve) => setTimeout(resolve, waitMs));
  assert.equal(
    blocked.isSettled(),
    false,
    `المسار لم يتوقّف عند قفل (العيادة، اليوم) — القفل غير مطبَّق أو بمفتاح مختلف (زمن خط الأساس ${baselineMs}ms، نافذة الانتظار ${waitMs}ms)`
  );

  // تحرير القفل ⇒ يكتمل المسار بلا خطأ
  await holder.query('ROLLBACK');
  await blocked.pending;
  assert.equal(blocked.res.captured.status, 200, JSON.stringify(blocked.res.captured.body));

  const appointment = await testPool.query(
    `SELECT count(*)::int AS cnt FROM appointments WHERE visit_id = $1`,
    [visitId]
  );
  assert.equal(appointment.rows[0].cnt, 1, 'موعد المتابعة موجود بعد تحرير القفل');
});
