import './helpers/appTestEnv';
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * اختبارات تكامل لوحدة جدولة الأطباء مع التقويم:
 *  1) تداخل فترات العمل ⇒ 409 (لا 500) مع رمز CALENDAR_CONFLICT.
 *  2) تضييق نافذة العمل impacting مواعيد قائمة ⇒ 409 مع الأثر، ومع
 *     confirm_impact ⇒ يُطبَّق والمواعيد تبقى قائمة.
 *  3) availability تعلن حالة التقويم (عطلة/إجازة/استثناء) ولا تعرض خانات
 *     قابلة للحجز في يوم مغلق.
 */

import {
  createDoctorSchedule,
  updateDoctorSchedule,
  getDoctorAvailability,
} from '../modules/doctorSchedules/doctorSchedules.controller';
import { testPool, createCommittedFixtures, cleanupCommittedFixtures, futureDate } from './helpers/calendarFixtures';
import { createMockReq, createMockRes } from './helpers/controllerHarness';

const schedulerUser = (userId: number, clinicId: number) => ({
  userId,
  roleName: 'RECEPTIONIST',
  permissions: ['MANAGE_DOCTOR_SCHEDULES', 'VIEW_DOCTOR_SCHEDULES'],
  clinicId,
  clinicIds: [clinicId],
});

test('تداخل فترات العمل ⇒ 409 مع رمز واضح (لا 500)', async (t) => {
  const fx = await createCommittedFixtures('schedules-overlap');
  t.after(() => cleanupCommittedFixtures(fx));

  const first = createMockRes();
  await createDoctorSchedule(
    createMockReq({
      user: schedulerUser(fx.adminUserId, fx.clinicId),
      body: {
        doctor_id: fx.doctorId,
        clinic_id: fx.clinicId,
        day_of_week: 0,
        start_time: '09:00',
        end_time: '13:00',
      },
    }),
    first.res
  );
  assert.equal(first.captured.status, 201, JSON.stringify(first.captured.body));

  const overlapping = createMockRes();
  await createDoctorSchedule(
    createMockReq({
      user: schedulerUser(fx.adminUserId, fx.clinicId),
      body: {
        doctor_id: fx.doctorId,
        clinic_id: fx.clinicId,
        day_of_week: 0,
        start_time: '12:00',
        end_time: '16:00',
      },
    }),
    overlapping.res
  );
  assert.equal(overlapping.captured.status, 409, 'التداخل رفض تشغيلي لا خطأ خادم');
  assert.equal(overlapping.captured.body.code, 'CALENDAR_CONFLICT');
});

test('تضييق نافذة العمل: 409 مع الأثر، ومع التأكيد يُطبَّق والمواعيد تبقى', async (t) => {
  const fx = await createCommittedFixtures('schedules-impact');
  t.after(() => cleanupCommittedFixtures(fx));

  // نافذة عمل الطبيب في يوم الموعد (يوم الأسبوع محسوب من قاعدة البيانات)
  const targetDate = futureDate(100);
  const dow = await testPool.query('SELECT EXTRACT(DOW FROM $1::date)::int AS dow', [targetDate]);
  const created = await testPool.query(
    `INSERT INTO doctor_schedules (doctor_id, clinic_id, day_of_week, start_time, end_time, is_working_day)
     VALUES ($1, $2, $3, '09:00', '17:00', TRUE) RETURNING schedule_id`,
    [fx.doctorId, fx.clinicId, dow.rows[0].dow]
  );
  const scheduleId = Number(created.rows[0].schedule_id);

  // موعد قائم داخل النافذة القديمة
  await testPool.query(
    `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_date, start_time, end_time, status)
     VALUES ($1, $2, $3, $4::date, '15:00', '15:30', 'SCHEDULED')`,
    [fx.clinicId, fx.patientId, fx.doctorId, targetDate]
  );

  // تضييق النافذة إلى 09:00–14:00 ⇒ الموعد خارجها
  const rejected = createMockRes();
  await updateDoctorSchedule(
    createMockReq({
      user: schedulerUser(fx.adminUserId, fx.clinicId),
      params: { id: String(scheduleId) },
      body: { start_time: '09:00', end_time: '14:00' },
    }),
    rejected.res
  );
  assert.equal(rejected.captured.status, 409, 'تضييق النافذة impacting موعد قائم يحتاج تأكيداً');
  assert.equal(rejected.captured.body.code, 'IMPACT_CONFIRMATION_REQUIRED');
  assert.equal(rejected.captured.body.impact.appointment_count, 1);

  // لم يتغيّر الجدول
  const unchanged = await testPool.query(`SELECT start_time, end_time FROM doctor_schedules WHERE schedule_id = $1`, [
    scheduleId,
  ]);
  assert.equal(String(unchanged.rows[0].start_time), '09:00:00');
  assert.equal(String(unchanged.rows[0].end_time), '17:00:00');

  // مع التأكيد
  const confirmed = createMockRes();
  await updateDoctorSchedule(
    createMockReq({
      user: schedulerUser(fx.adminUserId, fx.clinicId),
      params: { id: String(scheduleId) },
      body: { start_time: '09:00', end_time: '14:00', confirm_impact: true },
    }),
    confirmed.res
  );
  assert.equal(confirmed.captured.status, 200, JSON.stringify(confirmed.captured.body));
  assert.equal(confirmed.captured.body.notification_status, 'PENDING_CONTACT');

  // الموعد باقٍ ولم يُلغَ
  const appointments = await testPool.query(
    `SELECT status FROM appointments WHERE doctor_id = $1 AND clinic_id = $2 AND appointment_date = $3::date`,
    [fx.doctorId, fx.clinicId, targetDate]
  );
  assert.equal(appointments.rows.length, 1, 'الموعد لم يُحذف');
  assert.equal(appointments.rows[0].status, 'SCHEDULED', 'الموعد لم يُلغَ');

  // سجلّ تقويمي + مهمة تواصل يدوية
  const change = await testPool.query(
    `SELECT change_type, notification_status FROM calendar_changes
     WHERE entity_type = 'DOCTOR_SCHEDULE' AND entity_id = $1 ORDER BY change_id DESC LIMIT 1`,
    [scheduleId]
  );
  assert.equal(change.rows[0].change_type, 'SCHEDULE_CHANGED');
  assert.equal(change.rows[0].notification_status, 'PENDING_CONTACT');

  const tasks = await testPool.query(
    `SELECT n.status FROM calendar_change_notifications n
     JOIN calendar_changes c ON c.change_id = n.change_id
     WHERE c.entity_type = 'DOCTOR_SCHEDULE' AND c.entity_id = $1`,
    [scheduleId]
  );
  assert.equal(tasks.rows.length, 1, 'مهمة تواصل واحدة');
  assert.equal(tasks.rows[0].status, 'PENDING_CONTACT');
});

test('availability: تعلن حالة التقويم ولا تعرض خانات في يوم مغلق', async (t) => {
  const fx = await createCommittedFixtures('schedules-availability');
  t.after(() => cleanupCommittedFixtures(fx));

  const date = futureDate(101);
  const dow = await testPool.query('SELECT EXTRACT(DOW FROM $1::date)::int AS dow', [date]);
  await testPool.query(
    `INSERT INTO doctor_schedules (doctor_id, clinic_id, day_of_week, start_time, end_time, is_working_day)
     VALUES ($1, $2, $3, '09:00', '12:00', TRUE)`,
    [fx.doctorId, fx.clinicId, dow.rows[0].dow]
  );

  // يوم عادي: خانات متاحة
  const open = createMockRes();
  await getDoctorAvailability(
    createMockReq({
      user: schedulerUser(fx.adminUserId, fx.clinicId),
      query: { doctor_id: String(fx.doctorId), clinic_id: String(fx.clinicId), date },
    }),
    open.res
  );
  assert.equal(open.captured.status, 200, JSON.stringify(open.captured.body));
  assert.equal(open.captured.body.day_of_week, dow.rows[0].dow, 'يوم الأسبوع من قاعدة البيانات');
  assert.equal(open.captured.body.calendar_state.blocked, false);
  assert.ok(open.captured.body.available_slots.length > 0, 'يومي العادي فيه خانات');

  //Declare عطلة في نفس اليوم
  await testPool.query(
    `INSERT INTO clinic_holidays (holiday_date, clinic_id, name_ar, holiday_type, status)
     VALUES ($1::date, $2, 'عطلة يوم الاختبار', 'OFFICIAL', 'ACTIVE')`,
    [date, fx.clinicId]
  );

  const closed = createMockRes();
  await getDoctorAvailability(
    createMockReq({
      user: schedulerUser(fx.adminUserId, fx.clinicId),
      query: { doctor_id: String(fx.doctorId), clinic_id: String(fx.clinicId), date },
    }),
    closed.res
  );
  assert.equal(closed.captured.status, 200);
  assert.equal(closed.captured.body.calendar_state.blocked, true);
  assert.equal(closed.captured.body.calendar_state.block_code, 'HOLIDAY');
  assert.equal(closed.captured.body.calendar_state.holiday.name_ar, 'عطلة يوم الاختبار');
  assert.equal(closed.captured.body.calendar_state.holiday.scope, 'CLINIC');
  assert.deepEqual(closed.captured.body.available_slots, [], 'يوم مغلق: لا خانات قابلة للحجز');
});
